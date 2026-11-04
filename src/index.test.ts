// Tests for the catalogue hooks: when a sidecar may be deleted, and background
// writing that never holds the core's commit hook open.
// Run with: node --experimental-strip-types src/index.test.ts

import { activate } from "./index.ts";
import { generateXmp } from "./xmp.ts";
import type { CatalogHooksContribution, CatalogPhoto, ColorLabel, FlagStatus, SafelightAPI } from "./safelight";

let passed = true;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.log(`  ✗ ${name}`);
    passed = false;
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > deadline) return false;
    await sleep(5);
  }
  return true;
}

interface FakeDirOptions {
  closeDelayMs?: number;
  failWrite?: (name: string) => boolean;
}

// Opens lazily like the desktop build's handles: getFileHandle succeeds for a
// missing file and only reading it fails.
function fakeDir(files: Map<string, string>, opts: FakeDirOptions = {}) {
  const stats = { writes: 0, inFlight: 0, maxInFlight: 0 };
  const dir = {
    async *keys() {
      yield* [...files.keys()];
    },
    async getFileHandle(name: string) {
      return {
        name,
        async getFile() {
          const text = files.get(name);
          if (text === undefined) throw new DOMException("missing", "NotFoundError");
          return { text: async () => text };
        },
        async createWritable() {
          let buf = "";
          stats.inFlight++;
          stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
          return {
            async write(data: string) {
              buf += data;
            },
            async close() {
              try {
                if (opts.closeDelayMs) await sleep(opts.closeDelayMs);
                if (opts.failWrite?.(name)) throw new DOMException("read-only", "NoModificationAllowedError");
                files.set(name, buf);
                stats.writes++;
              } finally {
                stats.inFlight--;
              }
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException("missing", "NotFoundError");
    },
  } as unknown as FileSystemDirectoryHandle;
  return { dir, stats };
}

function photoIn(dir: FileSystemDirectoryHandle, filename: string, extra: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: filename,
    filename,
    directoryHandle: dir,
    fileHandle: { name: filename } as FileSystemFileHandle,
    rating: 3,
    colorLabel: "none" as ColorLabel,
    flag: "none" as FlagStatus,
    keywords: [],
    ...extra,
  };
}

function setup(writeOn: boolean) {
  const values = new Map<string, unknown>([["writeXmpSidecars", writeOn]]);
  const alerts: { title: string; message: string }[] = [];
  let hooks: CatalogHooksContribution | undefined;
  const api = {
    version: 1,
    extensionId: "com.safelight.xmp-tools",
    registerSettings() {},
    registerPresetImporter() {},
    registerCatalogHooks(c: CatalogHooksContribution) {
      hooks = c;
    },
    settings: {
      get: <T,>(key: string, fallback: T) => (values.has(key) ? (values.get(key) as T) : fallback),
      set: (key: string, value: unknown) => values.set(key, value),
      onChange: () => () => {},
    },
    ui: {
      async alertDialog(o: { title: string; message: string }) {
        alerts.push(o);
      },
    },
  } as unknown as SafelightAPI;
  activate(api);
  if (!hooks) throw new Error("no catalogue hooks registered");
  return { hooks, alerts };
}

const OWN = (name: string) => generateXmp(photoIn(null as unknown as FileSystemDirectoryHandle, name));
const FOREIGN = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/></rdf:RDF></x:xmpmeta>`;

async function removeCase(opts: {
  writeOn: boolean;
  sidecar: string;
  imageOnDisk: boolean;
  copyOf?: string;
}): Promise<boolean> {
  const files = new Map<string, string>([["DSC_0012.xmp", opts.sidecar]]);
  if (opts.imageOnDisk) files.set("DSC_0012.NEF", "raw");
  const { dir } = fakeDir(files);
  const { hooks } = setup(opts.writeOn);
  const photo = photoIn(dir, "DSC_0012.NEF", opts.copyOf ? { id: "copy-1", copyOf: opts.copyOf } : {});
  await hooks.onPhotoRemove?.({ photo, dir, fileName: "DSC_0012.NEF" });
  return files.has("DSC_0012.xmp");
}

async function testRemove() {
  console.log("Testing sidecar deletion on removal...");
  check(
    "writing off: own sidecar of a deleted file is kept",
    await removeCase({ writeOn: false, sidecar: OWN("DSC_0012.NEF"), imageOnDisk: false }),
  );
  check(
    "virtual copy: the master's sidecar is kept",
    await removeCase({ writeOn: true, sidecar: OWN("DSC_0012.NEF"), imageOnDisk: false, copyOf: "DSC_0012.NEF" }),
  );
  check(
    "foreign packet is kept",
    await removeCase({ writeOn: true, sidecar: FOREIGN, imageOnDisk: false }),
  );
  check(
    "catalogue-only removal (file still on disk) keeps the sidecar",
    await removeCase({ writeOn: true, sidecar: OWN("DSC_0012.NEF"), imageOnDisk: true }),
  );
  const shared = OWN("DSC_0012.NEF").replace(
    "</rdf:Description>",
    '<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Seq><rdf:li>Robin</rdf:li></rdf:Seq></dc:creator></rdf:Description>',
  );
  check(
    "our packet that another tool added to is kept",
    await removeCase({ writeOn: true, sidecar: shared, imageOnDisk: false }),
  );
  check(
    "our own sidecar of a file deleted from disk goes",
    !(await removeCase({ writeOn: true, sidecar: OWN("DSC_0012.NEF"), imageOnDisk: false })),
  );

  const files = new Map<string, string>();
  const { dir, stats } = fakeDir(files, { closeDelayMs: 30 });
  const { hooks } = setup(true);
  const photo = photoIn(dir, "DSC_0012.NEF");
  await hooks.onMetadataChange?.({ photos: [photo], getEditState: async () => null });
  await until(() => stats.inFlight > 0, 2000);
  await hooks.onPhotoRemove?.({ photo, dir, fileName: "DSC_0012.NEF" });
  await sleep(60);
  check("a write in flight at removal doesn't bring the sidecar back", !files.has("DSC_0012.xmp"));
}

async function testBackgroundWrites() {
  console.log("Testing background sidecar writes...");
  const files = new Map<string, string>();
  const { dir, stats } = fakeDir(files, { closeDelayMs: 1 });
  const { hooks } = setup(true);
  const photos = Array.from({ length: 3000 }, (_, i) => photoIn(dir, `IMG_${i}.NEF`, { rating: 2 }));
  const getEditState = async () => null;

  const t0 = performance.now();
  await hooks.onMetadataChange?.({ photos, getEditState });
  const elapsed = performance.now() - t0;
  check(`3,000-photo hook returns at once (${elapsed.toFixed(0)} ms)`, elapsed < 250);
  check("writes still pending when the hook returns", stats.writes < 3000);

  await hooks.onMetadataChange?.({ photos: photos.map((p) => ({ ...p, rating: 5 })), getEditState });
  const done = await until(() => stats.inFlight === 0 && files.size === 3000 && [...files.values()].every((t) => t.includes("<xmp:Rating>5</xmp:Rating>")));
  check("every sidecar ends with the latest rating", done);
  check(`repeated ids coalesce (${stats.writes} writes)`, stats.writes <= 3000 + 8);
  check(`writes run concurrently but bounded (max ${stats.maxInFlight})`, stats.maxInFlight > 1 && stats.maxInFlight <= 4);
}

async function testCopiesAndEdits() {
  console.log("Testing copies and edit commits...");
  const files = new Map<string, string>([["DSC_0012.NEF", "raw"]]);
  const { dir } = fakeDir(files);
  const { hooks } = setup(true);
  const master = photoIn(dir, "DSC_0012.NEF", { rating: 2 });
  const copy = photoIn(dir, "DSC_0012.NEF", { id: "copy-1", copyOf: master.id, rating: 5 });
  await hooks.onMetadataChange?.({ photos: [master, copy], getEditState: async () => null });
  await until(() => files.has("DSC_0012.xmp"));
  await sleep(20);
  check("a virtual copy's rating stays out of the master's sidecar", files.get("DSC_0012.xmp")?.includes("<xmp:Rating>2</xmp:Rating>") === true);

  const editState = {
    photoId: master.id,
    currentIndex: 0,
    stack: [{ timestamp: 1, label: "Exposure", params: { exposure: 1 } }],
  } as unknown as Parameters<NonNullable<CatalogHooksContribution["onEditCommit"]>>[0]["editState"];
  await hooks.onEditCommit?.({ photo: master, editState });
  check("edit commit writes the develop params", await until(() => files.get("DSC_0012.xmp")?.includes("safelight:DevelopParams") === true, 2000));
}

async function testFailures() {
  console.log("Testing write failure reporting...");
  const files = new Map<string, string>();
  const { dir } = fakeDir(files, { failWrite: (name) => /^IMG_[0-4]\.xmp$/.test(name) });
  const { hooks, alerts } = setup(true);
  const photos = Array.from({ length: 20 }, (_, i) => photoIn(dir, `IMG_${i}.NEF`));
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await hooks.onMetadataChange?.({ photos, getEditState: async () => null });
    await until(() => alerts.length > 0, 2000);
    await sleep(20);
  } finally {
    console.error = realError;
  }
  check("the other sidecars are written", files.size === 15);
  check("one notice for the batch", alerts.length === 1);
  check("the notice counts the failures", alerts[0]?.message.includes("5 ") === true);
  check("failures are logged", errors.length > 0);
}

console.log("=== XMP catalogue hook tests ===\n");
await testRemove();
await testBackgroundWrites();
await testCopiesAndEdits();
await testFailures();
console.log(passed ? "\n✓ All tests passed!" : "\n✗ Some tests failed");
if (!passed) process.exitCode = 1;
