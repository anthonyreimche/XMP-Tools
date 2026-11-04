// XMP Tools — optional SafeLight extension.
//
// Owns everything XMP: reads sidecar metadata on import, writes sidecars on
// metadata/edit changes, deletes its own when their image is deleted, and
// teaches the Presets panel to import Lightroom (.xmp) presets. The app core no
// longer knows about XMP — it just emits catalogue lifecycle hooks this extension
// subscribes to.

import type { CatalogPhoto, EditState, SafelightAPI } from "./safelight";
import {
  readXmpSidecar,
  writeXmpSidecar,
  deleteOwnXmpSidecar,
  xmpToPhotoOverrides,
} from "./xmp.ts";
import { parseLightroomXmp } from "./lightroom-import.ts";
import { createKeyedQueue } from "./sidecar-queue.ts";

const WRITE_KEY = "writeXmpSidecars";
const WRITE_CONCURRENCY = 4;

/** A queued sidecar write; `editState` is set by an edit commit and also
 *  writes the develop params. */
interface SidecarJob {
  photo: CatalogPhoto;
  editState?: EditState;
}

interface ListableDirectory {
  keys(): AsyncIterable<string>;
}

const LISTING_TTL_MS = 1000;
const listings = new WeakMap<FileSystemDirectoryHandle, { at: number; names: Promise<Set<string>> }>();

async function listNames(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const names = new Set<string>();
  for await (const name of (dir as unknown as ListableDirectory).keys()) names.add(name.toLowerCase());
  return names;
}

/** Whether the folder still holds `name`. The desktop build's handles open
 *  lazily, so getFileHandle succeeds for a missing file; the listing can tell.
 *  One listing serves a whole removal batch, and a stale one errs toward
 *  reporting a deleted file as present, which keeps its sidecar. */
async function imageOnDisk(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  const now = Date.now();
  let listing = listings.get(dir);
  if (!listing || now - listing.at > LISTING_TTL_MS) {
    listing = { at: now, names: listNames(dir) };
    listings.set(dir, listing);
  }
  try {
    return (await listing.names).has(name.toLowerCase());
  } catch {
    return true;
  }
}

export function activate(api: SafelightAPI): void {
  const writeEnabled = () => api.settings.get(WRITE_KEY, false);

  // Settings dialogue (⚙ in the Extensions panel) — replaces the old core toggle.
  api.registerSettings({
    title: "XMP Tools",
    fields: [
      {
        key: WRITE_KEY,
        label: "Write XMP sidecars",
        hint: "Save ratings, labels, keywords, and edits to .xmp files alongside your images. Enables interoperability with other photo tools.",
        type: "boolean",
        default: false,
      },
    ],
  });

  // Until a batch writes cleanly again, later failures only reach the console.
  let failureNoticeShown = false;
  const writes = createKeyedQueue<SidecarJob>({
    concurrency: WRITE_CONCURRENCY,
    async run({ photo, editState }) {
      if (!writeEnabled() || !photo.directoryHandle || !photo.fileHandle) return;
      await writeXmpSidecar(
        photo.directoryHandle,
        photo.fileHandle.name,
        photo,
        editState,
        editState ? { includePrivateNamespace: true } : undefined,
      );
    },
    merge: (waiting, next) => ({ photo: next.photo, editState: next.editState ?? waiting.editState }),
    onDrain(failures) {
      if (failures.length === 0) {
        failureNoticeShown = false;
        return;
      }
      for (const { job, error } of failures) {
        console.error(`[xmp] failed to write sidecar for ${job.photo.filename}:`, error);
      }
      if (failureNoticeShown || !api.ui?.alertDialog) return;
      failureNoticeShown = true;
      const n = failures.length;
      void api.ui.alertDialog({
        title: "XMP sidecars not saved",
        message: `${n} sidecar${n === 1 ? "" : "s"} couldn't be written. Ratings, labels and keywords are still saved in the catalogue.\n\nCheck that the folder can be written to, then change the photos again to retry.`,
      });
    },
  });

  // A virtual copy carries its master's handles; writing it would overwrite
  // the master's sidecar with the copy's metadata.
  const queueWrite = (photo: CatalogPhoto, editState?: EditState) => {
    if (photo.copyOf) return;
    writes.push(photo.id, { photo, editState });
  };

  api.registerCatalogHooks({
    id: "com.safelight.xmp-tools.sidecars",

    // Read sidecar metadata when a photo is discovered; merged with precedence.
    async onPhotoImport({ dir, fileName }) {
      const xmp = await readXmpSidecar(dir, fileName);
      return xmp ? xmpToPhotoOverrides(xmp) : undefined;
    },

    // These run inside the core's commit under its hook timeout, so the writes
    // are queued and drained in the background.
    async onMetadataChange({ photos }) {
      if (!writeEnabled()) return;
      for (const p of photos) queueWrite(p);
    },

    async onEditCommit({ photo, editState }) {
      if (!writeEnabled()) return;
      queueWrite(photo, editState);
    },

    // The hook fires for removal from the catalogue and for deletion from disk
    // alike, so only a sidecar whose image is gone and that holds nothing but
    // our own properties goes with it.
    async onPhotoRemove({ photo, dir, fileName }) {
      writes.cancel(photo.id);
      await writes.settled(photo.id);
      if (!writeEnabled() || photo.copyOf) return;
      if (await imageOnDisk(dir, fileName)) return;
      await deleteOwnXmpSidecar(dir, fileName);
    },
  });

  // Lightroom preset import for the Presets panel.
  api.registerPresetImporter({
    id: "com.safelight.xmp-tools.lightroom",
    label: "Lightroom preset (.xmp)",
    extensions: [".xmp"],
    async parse(file) {
      const text = await file.text();
      const fallback = file.name.replace(/\.xmp$/i, "");
      return parseLightroomXmp(text, fallback);
    },
  });
}

export function deactivate(): void {
  // No standing side effects: the host sweeps our registry contributions
  // (settings, hooks, importer) on disable/uninstall.
}
