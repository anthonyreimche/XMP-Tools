// Tests for XMP sidecar functionality.
// Run with: node --experimental-strip-types src/xmp.test.ts

import { parseXmp, generateXmp, getXmpSidecarName, applyXmpToPhoto, upsertXmp, writeXmpSidecar } from "./xmp.ts";
import type { CatalogPhoto, ColorLabel, FlagStatus } from "./safelight";

// Test getXmpSidecarName
function testSidecarNames() {
  console.log("Testing sidecar name generation...");
  const tests = [
    { input: "DSC_0012.NEF", expected: "DSC_0012.xmp" },
    { input: "DSC_0012.JPG", expected: "DSC_0012_jpg.xmp" },
    { input: "IMG_1234.cr2", expected: "IMG_1234.xmp" },
    { input: "photo.dng", expected: "photo.xmp" },
    { input: "IMG_1234.jpg", expected: "IMG_1234_jpg.xmp" },
    { input: "no_extension", expected: "no_extension.xmp" },
  ];

  let passed = 0;
  for (const t of tests) {
    const result = getXmpSidecarName(t.input);
    if (result === t.expected) {
      console.log(`  ✓ ${t.input} → ${result}`);
      passed++;
    } else {
      console.log(`  ✗ ${t.input} → ${result} (expected ${t.expected})`);
    }
  }
  console.log(`  ${passed}/${tests.length} passed\n`);
  return passed === tests.length;
}

// Test parseXmp
function testParseXmp() {
  console.log("Testing XMP parsing...");

  const xmpXml = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
      rdf:about="">
      <xmp:Rating>4</xmp:Rating>
      <xmp:Label>Red</xmp:Label>
      <photoshop:Urgency>1</photoshop:Urgency>
      <dc:subject>
        <rdf:Bag>
          <rdf:li>landscape</rdf:li>
          <rdf:li>sunset</rdf:li>
        </rdf:Bag>
      </dc:subject>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;

  const result = parseXmp(xmpXml);
  let passed = true;

  if (result.rating === 4) {
    console.log("  ✓ Rating parsed correctly");
  } else {
    console.log(`  ✗ Rating: ${result.rating} (expected 4)`);
    passed = false;
  }

  if (result.label === "red") {
    console.log("  ✓ Label parsed correctly");
  } else {
    console.log(`  ✗ Label: ${result.label} (expected red)`);
    passed = false;
  }

  if (result.flag === "pick") {
    console.log("  ✓ Flag parsed correctly");
  } else {
    console.log(`  ✗ Flag: ${result.flag} (expected pick)`);
    passed = false;
  }

  if (result.keywords?.length === 2 && result.keywords[0] === "landscape") {
    console.log("  ✓ Keywords parsed correctly");
  } else {
    console.log(`  ✗ Keywords: ${JSON.stringify(result.keywords)}`);
    passed = false;
  }

  console.log(passed ? "  All parsing tests passed\n" : "  Some parsing tests failed\n");
  return passed;
}

// Test generateXmp
function testGenerateXmp() {
  console.log("Testing XMP generation...");

  const photo: CatalogPhoto = {
    id: "test-123",
    filename: "DSC_0012.NEF",
    directoryHandle: null,
    fileHandle: null,
    rating: 3,
    colorLabel: "blue" as ColorLabel,
    flag: "pick" as FlagStatus,
    keywords: ["portrait", "studio"],
  };

  const xmp = generateXmp(photo);
  let passed = true;

  if (xmp.includes("<xmp:Rating>3</xmp:Rating>")) {
    console.log("  ✓ Rating generated correctly");
  } else {
    console.log("  ✗ Rating not found in generated XMP");
    passed = false;
  }

  if (xmp.includes("<xmp:Label>Blue</xmp:Label>")) {
    console.log("  ✓ Label generated correctly");
  } else {
    console.log("  ✗ Label not found in generated XMP");
    passed = false;
  }

  if (xmp.includes("<photoshop:Urgency>1</photoshop:Urgency>")) {
    console.log("  ✓ Pick flag generated correctly");
  } else {
    console.log("  ✗ Pick flag not found in generated XMP");
    passed = false;
  }

  if (xmp.includes("<rdf:li>portrait</rdf:li>") && xmp.includes("<rdf:li>studio</rdf:li>")) {
    console.log("  ✓ Keywords generated correctly");
  } else {
    console.log("  ✗ Keywords not found in generated XMP");
    passed = false;
  }

  console.log(passed ? "  All generation tests passed\n" : "  Some generation tests failed\n");
  return passed;
}

// Test reject flag
function testRejectFlag() {
  console.log("Testing reject flag...");

  const xmpXml = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" rdf:about="">
      <photoshop:Urgency>8</photoshop:Urgency>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;

  const result = parseXmp(xmpXml);
  if (result.flag === "reject") {
    console.log("  ✓ Reject flag parsed correctly\n");
    return true;
  } else {
    console.log(`  ✗ Flag: ${result.flag} (expected reject)\n`);
    return false;
  }
}

// Test round-trip
function testRoundTrip() {
  console.log("Testing round-trip (parse → generate → parse)...");

  const photo: CatalogPhoto = {
    id: "test-456",
    filename: "IMG_5678.jpg",
    directoryHandle: null,
    fileHandle: null,
    rating: 5,
    colorLabel: "purple" as ColorLabel,
    flag: "none" as FlagStatus,
    keywords: ["nature", "macro", "flowers"],
  };

  // Generate XMP
  const xmp = generateXmp(photo);

  // Parse it back
  const parsed = parseXmp(xmp);

  // Apply to a new photo
  const basePhoto: CatalogPhoto = { ...photo, rating: 0, colorLabel: "none", flag: "none", keywords: [] };
  const updated = applyXmpToPhoto(basePhoto, parsed);

  let passed = true;

  if (updated.rating === 5) {
    console.log("  ✓ Rating round-tripped correctly");
  } else {
    console.log(`  ✗ Rating: ${updated.rating} (expected 5)`);
    passed = false;
  }

  if (updated.colorLabel === "purple") {
    console.log("  ✓ Label round-tripped correctly");
  } else {
    console.log(`  ✗ Label: ${updated.colorLabel} (expected purple)`);
    passed = false;
  }

  if (updated.keywords.length === 3 && updated.keywords.includes("nature")) {
    console.log("  ✓ Keywords round-tripped correctly");
  } else {
    console.log(`  ✗ Keywords: ${JSON.stringify(updated.keywords)}`);
    passed = false;
  }

  console.log(passed ? "  All round-trip tests passed\n" : "  Some round-trip tests failed\n");
  return passed;
}

// Run all tests
// Test upsertXmp — read-modify-write that must not clobber properties written
// by other tools (Advanced EXIF Tools' caption/copyright/GPS, Lightroom, …).
function testUpsert() {
  console.log("Testing XMP upsert...");
  let passed = true;
  const check = (name: string, cond: boolean) => {
    if (cond) console.log(`  ✓ ${name}`);
    else {
      console.log(`  ✗ ${name}`);
      passed = false;
    }
  };

  const photo: CatalogPhoto = {
    id: "u1",
    filename: "DSC_0012.NEF",
    directoryHandle: null,
    fileHandle: null,
    rating: 5,
    colorLabel: "none" as ColorLabel,
    flag: "none" as FlagStatus,
    keywords: ["sunset"],
  } as unknown as CatalogPhoto;

  check("fresh packet matches generateXmp", upsertXmp(null, photo) === generateXmp(photo));

  const foreign = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Advanced EXIF Tools">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:safelight="http://ns.safelight.app/1.0/">
   <dc:creator><rdf:Seq><rdf:li>Robin</rdf:li></rdf:Seq></dc:creator>
   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© Robin</rdf:li></rdf:Alt></dc:rights>
   <exif:GPSLatitude>49,30.0000N</exif:GPSLatitude>
   <xmp:Rating>1</xmp:Rating>
   <xmp:RejectFlag>true</xmp:RejectFlag>
   <dc:subject><rdf:Bag><rdf:li>old-keyword</rdf:li></rdf:Bag></dc:subject>
   <safelight:DevelopParams>{"exposure":1}</safelight:DevelopParams>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

  const updated = upsertXmp(foreign, photo);
  check("foreign creator preserved", updated.includes("<rdf:li>Robin</rdf:li>"));
  check("foreign rights preserved", updated.includes("© Robin"));
  check("foreign GPS preserved", updated.includes("<exif:GPSLatitude>49,30.0000N</exif:GPSLatitude>"));
  check("rating replaced", updated.includes("<xmp:Rating>5</xmp:Rating>"));
  check("stale rating removed", !updated.includes("<xmp:Rating>1</xmp:Rating>"));
  check("only one rating", (updated.match(/<xmp:Rating>/g) ?? []).length === 1);
  check("stale reject flag removed", !updated.includes("xmp:RejectFlag"));
  check("keywords replaced", updated.includes("<rdf:li>sunset</rdf:li>") && !updated.includes("old-keyword"));
  check("develop params preserved without private ns", updated.includes("safelight:DevelopParams"));
  check("parses back", parseXmp(updated).rating === 5);

  // Clearing: rating 0 / no keywords removes our properties, keeps foreign ones.
  const cleared = upsertXmp(foreign, {
    ...photo,
    rating: 0,
    keywords: [],
  } as unknown as CatalogPhoto);
  check("rating cleared", !cleared.includes("<xmp:Rating>"));
  check("keywords cleared", !cleared.includes("<dc:subject>"));
  check("foreign creator still there", cleared.includes("<rdf:li>Robin</rdf:li>"));

  // Missing namespace declarations get added to the Description tag.
  const bare = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><dc:creator><rdf:Seq><rdf:li>K</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const withNs = upsertXmp(bare, photo);
  check("xmp namespace declared", /rdf:Description[^>]*xmlns:xmp=/.test(withNs));
  check("rating landed", withNs.includes("<xmp:Rating>5</xmp:Rating>"));

  // darktable-style self-closed Description still accepts our properties.
  const dt = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:darktable="http://darktable.sf.net/" darktable:history_end="7"/>
 </rdf:RDF>
</x:xmpmeta>`;
  const dtUp = upsertXmp(dt, photo);
  check("self-closed Description gains rating", dtUp.includes("<xmp:Rating>5</xmp:Rating>"));
  check("darktable attribute survives", dtUp.includes('darktable:history_end="7"'));

  // "$&"-style keywords must not trip String.replace's $-pattern expansion.
  const dollar = upsertXmp(bare, {
    ...photo,
    keywords: ["fish$&chips"],
  } as unknown as CatalogPhoto);
  check("dollar keyword inserted verbatim", dollar.includes("fish$&amp;chips"));
  check("packet still well-terminated", dollar.includes("</rdf:Description>"));

  console.log(passed ? "  All upsert tests passed\n" : "  Some upsert tests failed\n");
  return passed;
}

// Test writeXmpSidecar read-modify-write against an in-memory directory.
async function testSidecarReadModifyWrite() {
  console.log("Testing sidecar read-modify-write...");
  let passed = true;
  const check = (name: string, cond: boolean) => {
    if (cond) console.log(`  ✓ ${name}`);
    else {
      console.log(`  ✗ ${name}`);
      passed = false;
    }
  };

  const files = new Map<string, string>();
  files.set(
    "DSC_0012.xmp",
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Robin</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`,
  );
  const dir = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!opts?.create) throw new Error("NotFound");
        files.set(name, "");
      }
      return {
        async getFile() {
          return { text: async () => files.get(name)! };
        },
        async createWritable() {
          let buf = "";
          return {
            async write(data: unknown) {
              buf += typeof data === "string" ? data : String(data);
            },
            async close() {
              files.set(name, buf);
            },
          };
        },
      };
    },
    async removeEntry() {},
  } as unknown as FileSystemDirectoryHandle;

  const photo: CatalogPhoto = {
    id: "w1",
    filename: "DSC_0012.NEF",
    directoryHandle: null,
    fileHandle: null,
    rating: 4,
    colorLabel: "none" as ColorLabel,
    flag: "none" as FlagStatus,
    keywords: [],
  } as unknown as CatalogPhoto;

  await writeXmpSidecar(dir, "DSC_0012.NEF", photo);
  const out = files.get("DSC_0012.xmp") ?? "";
  check("foreign creator survives a rating write", out.includes("<rdf:li>Robin</rdf:li>"));
  check("rating written", out.includes("<xmp:Rating>4</xmp:Rating>"));

  console.log(passed ? "  All read-modify-write tests passed\n" : "  Some read-modify-write tests failed\n");
  return passed;
}

// Other apps write simple properties as attributes and escape keywords; both
// must survive our read-modify-write untouched.
function testForeignPacketRoundTrip() {
  console.log("Testing a Lightroom-style sidecar round trip...");
  let passed = true;
  const check = (name: string, cond: boolean) => {
    if (cond) console.log(`  ✓ ${name}`);
    else {
      console.log(`  ✗ ${name}`);
      passed = false;
    }
  };

  const lr = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:lr="http://ns.adobe.com/lightroom/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="4"
   xmp:Label="Red"
   photoshop:Urgency='1'
   crs:Exposure2012="+0.50">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>Animals</rdf:li>
     <rdf:li>Dogs &amp; Cats</rdf:li>
    </rdf:Bag>
   </dc:subject>
   <lr:hierarchicalSubject>
    <rdf:Bag>
     <rdf:li>Animals|Birds|Eagle</rdf:li>
     <rdf:li>Pets|Dogs &amp; Cats</rdf:li>
    </rdf:Bag>
   </lr:hierarchicalSubject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

  const parsed = parseXmp(lr);
  check("attribute rating read", parsed.rating === 4);
  check("attribute label read", parsed.label === "red");
  check("single-quoted attribute urgency read", parsed.flag === "pick");
  check(
    "escaped keyword unescaped on read",
    JSON.stringify(parsed.keywords) === JSON.stringify(["Animals", "Dogs & Cats"]),
  );

  const base = {
    id: "lr1",
    filename: "DSC_0012.NEF",
    directoryHandle: null,
    fileHandle: null,
    rating: 0,
    colorLabel: "none" as ColorLabel,
    flag: "none" as FlagStatus,
    keywords: [],
  } as unknown as CatalogPhoto;
  const imported = applyXmpToPhoto(base, parsed);
  const once = upsertXmp(lr, { ...imported, keywords: [...imported.keywords, "Eagle"] });
  const reread = parseXmp(once);
  check("rating survives a keyword write", reread.rating === 4);
  check("label survives a keyword write", reread.label === "red");
  check("new keyword written", reread.keywords?.includes("Eagle") === true);
  check("foreign develop attribute kept", once.includes('crs:Exposure2012="+0.50"'));
  check("hierarchy left untouched", once.includes("<rdf:li>Animals|Birds|Eagle</rdf:li>"));
  check("escaped hierarchy entry untouched", once.includes("<rdf:li>Pets|Dogs &amp; Cats</rdf:li>"));
  check("only one hierarchicalSubject", (once.match(/<lr:hierarchicalSubject>/g) ?? []).length === 1);

  const twice = upsertXmp(once, applyXmpToPhoto(base, parseXmp(once)));
  const thrice = upsertXmp(twice, applyXmpToPhoto(base, parseXmp(twice)));
  check(
    "ampersand keyword stable over two more round trips",
    JSON.stringify(parseXmp(thrice).keywords) === JSON.stringify(["Animals", "Dogs & Cats", "Eagle"]),
  );
  check("no double escaping", !thrice.includes("&amp;amp;"));

  console.log(passed ? "  All Lightroom round-trip tests passed\n" : "  Some Lightroom round-trip tests failed\n");
  return passed;
}

// Lightroom Classic nests Descriptions inside crs:Look / crs:Parameters; our
// properties belong on the outer one, and the nested block must stay intact.
function testNestedDescriptions() {
  console.log("Testing nested Descriptions...");
  let passed = true;
  const check = (name: string, cond: boolean) => {
    if (cond) console.log(`  ✓ ${name}`);
    else {
      console.log(`  ✗ ${name}`);
      passed = false;
    }
  };

  const look = `<crs:Look>
    <rdf:Description
     crs:Name="Adobe Color"
     crs:Amount="1">
    <xmp:Label>Blue</xmp:Label>
    <crs:Parameters>
     <rdf:Description
      crs:Version="14.0"
      crs:ConvertToGrayscale="False"/>
    </crs:Parameters>
    </rdf:Description>
   </crs:Look>`;
  const lr = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="2"
   crs:Exposure2012="+0.50">
   ${look}
   <xmp:Label>Red</xmp:Label>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

  check("label read from the top-level Description", parseXmp(lr).label === "red");

  const photo = {
    id: "n1",
    filename: "DSC_0012.NEF",
    directoryHandle: null,
    fileHandle: null,
    rating: 5,
    colorLabel: "red" as ColorLabel,
    flag: "none" as FlagStatus,
    keywords: ["a"],
  } as unknown as CatalogPhoto;
  const out = upsertXmp(lr, photo);
  const lookAt = out.indexOf(look);
  check("Look block kept verbatim", lookAt !== -1);
  const rest = lookAt === -1 ? out : out.slice(0, lookAt) + out.slice(lookAt + look.length);
  check("rating lands on the outer Description", parseXmp(rest).rating === 5);
  check("keywords land on the outer Description", parseXmp(rest).keywords?.[0] === "a");
  check("one Description closed per opened", (out.match(/<\/rdf:Description>/g) ?? []).length === 2);

  console.log(passed ? "  All nested Description tests passed\n" : "  Some nested Description tests failed\n");
  return passed;
}

// Apps that build keywords from the hierarchy would bring a removed keyword back.
function testHierarchyPruning() {
  console.log("Testing hierarchy pruning...");
  let passed = true;
  const check = (name: string, cond: boolean) => {
    if (cond) console.log(`  ✓ ${name}`);
    else {
      console.log(`  ✗ ${name}`);
      passed = false;
    }
  };

  const packet = (hierarchy: string[]) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:lr="http://ns.adobe.com/lightroom/1.0/">
   <dc:subject><rdf:Bag><rdf:li>Animals</rdf:li><rdf:li>Birds</rdf:li><rdf:li>Eagle</rdf:li><rdf:li>Dogs &amp; Cats</rdf:li></rdf:Bag></dc:subject>
   <lr:hierarchicalSubject><rdf:Bag>${hierarchy.map((h) => `<rdf:li>${h}</rdf:li>`).join("")}</rdf:Bag></lr:hierarchicalSubject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
  const photo = (keywords: string[]) =>
    ({
      id: "h1",
      filename: "DSC_0012.NEF",
      directoryHandle: null,
      fileHandle: null,
      rating: 0,
      colorLabel: "none" as ColorLabel,
      flag: "none" as FlagStatus,
      keywords,
    }) as unknown as CatalogPhoto;

  const out = upsertXmp(
    packet(["Animals|Birds|Eagle", "Animals|Birds", "Pets|Dogs &amp; Cats"]),
    photo(["Animals", "Birds", "Dogs & Cats"]),
  );
  check("entry whose leaf was removed is dropped", !out.includes("Animals|Birds|Eagle"));
  check("other entries kept verbatim", out.includes("<rdf:li>Animals|Birds</rdf:li><rdf:li>Pets|Dogs &amp; Cats</rdf:li>"));

  const emptied = upsertXmp(packet(["Animals|Birds|Eagle"]), photo(["Animals", "Birds", "Dogs & Cats"]));
  check("hierarchy with nothing left is removed", !emptied.includes("lr:hierarchicalSubject>"));

  const unchanged = packet(["Animals|Birds|Eagle"]);
  const same = upsertXmp(unchanged, photo(["Animals", "Birds", "Eagle", "Dogs & Cats"]));
  check("nothing removed leaves the hierarchy alone", same.includes("<rdf:li>Animals|Birds|Eagle</rdf:li>"));

  console.log(passed ? "  All hierarchy pruning tests passed\n" : "  Some hierarchy pruning tests failed\n");
  return passed;
}

// Only a missing sidecar may be replaced by a fresh packet; a locked or
// unreadable one must fail the write rather than be overwritten.
async function testUnreadableSidecar() {
  console.log("Testing unreadable sidecars...");
  let passed = true;
  const check = (name: string, cond: boolean) => {
    if (cond) console.log(`  ✓ ${name}`);
    else {
      console.log(`  ✗ ${name}`);
      passed = false;
    }
  };

  const attempt = async (readError: Error) => {
    let written: string | null = null;
    const dir = {
      async getFileHandle() {
        return {
          async getFile() {
            throw readError;
          },
          async createWritable() {
            return {
              async write(data: string) {
                written = data;
              },
              async close() {},
            };
          },
        };
      },
    } as unknown as FileSystemDirectoryHandle;
    const photo = { id: "r1", filename: "DSC_0012.NEF", rating: 4, colorLabel: "none", flag: "none", keywords: [] } as unknown as CatalogPhoto;
    let threw = false;
    try {
      await writeXmpSidecar(dir, "DSC_0012.NEF", photo);
    } catch {
      threw = true;
    }
    return { threw, written };
  };

  const busy = await attempt(
    new Error("Error invoking remote method 'fs:read': Error: EBUSY: resource busy or locked, open 'D:\\x\\DSC_0012.xmp'"),
  );
  check("locked sidecar fails the write", busy.threw);
  check("locked sidecar not overwritten", busy.written === null);

  const denied = await attempt(new DOMException("denied", "NotAllowedError"));
  check("access error not overwritten", denied.threw && denied.written === null);

  const enoent = await attempt(
    new Error("Error invoking remote method 'fs:read': Error: ENOENT: no such file or directory, open 'D:\\x\\DSC_0012.xmp'"),
  );
  check("missing sidecar (ENOENT) is created", !enoent.threw && enoent.written !== null);

  const notFound = await attempt(new DOMException("missing", "NotFoundError"));
  check("missing sidecar (NotFoundError) is created", !notFound.threw && notFound.written !== null);

  console.log(passed ? "  All unreadable sidecar tests passed\n" : "  Some unreadable sidecar tests failed\n");
  return passed;
}

async function runTests() {
  console.log("=== XMP Sidecar Tests ===\n");

  const results = [
    testSidecarNames(),
    testParseXmp(),
    testGenerateXmp(),
    testRejectFlag(),
    testRoundTrip(),
    testUpsert(),
    testForeignPacketRoundTrip(),
    testNestedDescriptions(),
    testHierarchyPruning(),
    await testUnreadableSidecar(),
    await testSidecarReadModifyWrite(),
  ];

  const passed = results.filter((r) => r).length;
  const total = results.length;

  console.log("=========================");
  console.log(`Total: ${passed}/${total} test suites passed`);

  if (passed === total) {
    console.log("✓ All tests passed!");
  } else {
    console.log("✗ Some tests failed");
    process.exitCode = 1;
  }
  return passed === total;
}

await runTests();
