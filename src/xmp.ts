// XMP sidecar file support for interoperability with other photo tools.
// Implements reading and writing of XMP metadata to .xmp files alongside
// original images (DSC_0012.NEF → DSC_0012.xmp, DSC_0012.JPG → DSC_0012_jpg.xmp).
//
// Moved out of the app core (was src/catalog/xmp.ts) so XMP support is an
// optional, installable extension.

import type {
  CatalogPhoto,
  ColorLabel,
  FlagStatus,
  DevelopParams,
  EditState,
} from "./safelight";

// ── Sidecar filename generation ─────────────────────────────────────────────

/** Generate XMP sidecar filename following Adobe/Lightroom conventions.
 *  - DSC_0012.NEF → DSC_0012.xmp
 *  - DSC_0012.JPG → DSC_0012_jpg.xmp (for RAW+JPEG pairs)
 */
export function getXmpSidecarName(imageFilename: string): string {
  const dot = imageFilename.lastIndexOf(".");
  if (dot === -1) return `${imageFilename}.xmp`;
  const base = imageFilename.slice(0, dot);
  const ext = imageFilename.slice(dot + 1).toLowerCase();
  // For non-RAW extensions, append _ext to distinguish from RAW sidecar
  const isRaw = /^(nef|cr2|cr3|crw|dng|arw|orf|raf|rw2|pef|srw|3fr|dcr|erf|kdc|mos|raw|nrw)$/i.test(ext);
  if (isRaw) {
    return `${base}.xmp`;
  }
  return `${base}_${ext}.xmp`;
}

// ── XMP namespaces ──────────────────────────────────────────────────────────

const NAMESPACES = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  xmp: "http://ns.adobe.com/xap/1.0/",
  dc: "http://purl.org/dc/elements/1.1/",
  photoshop: "http://ns.adobe.com/photoshop/1.0/",
  safelight: "http://ns.safelight.app/1.0/",
} as const;

// ── XMP Data Interface ───────────────────────────────────────────────────────

export interface XmpMetadata {
  rating?: number;        // xmp:Rating (0-5)
  label?: ColorLabel;     // xmp:Label (Red/Yellow/Green/Blue/Purple)
  flag?: FlagStatus;      // photoshop:Urgency or custom pick/reject
  keywords?: string[];    // dc:subject
  hierarchicalKeywords?: string[]; // lr:hierarchicalSubject
  editParams?: DevelopParams; // safelight: namespace for full round-tripping
}

// ── XMP Parsing ─────────────────────────────────────────────────────────────

/** Parse XMP XML and extract metadata fields. Simple properties are read in
 *  both serializations XMP allows: <xmp:Rating>4</xmp:Rating> and the
 *  attribute form xmp:Rating="4" that most other apps write. Only top-level
 *  Descriptions are read, never the structs nested inside them. */
export function parseXmp(packet: string): XmpMetadata {
  const result: XmpMetadata = {};
  const xmpXml = liftNestedDescriptions(packet).text;

  const rating = readProperty(xmpXml, "xmp:Rating");
  if (rating !== undefined && /^\d$/.test(rating)) {
    const value = parseInt(rating, 10);
    if (value <= 5) result.rating = value;
  }

  const label = readProperty(xmpXml, "xmp:Label")?.toLowerCase();
  if (label && ["none", "red", "yellow", "green", "blue", "purple"].includes(label)) {
    result.label = label as ColorLabel;
  }

  // photoshop:Urgency 1 = high/pick, 8 = low/reject; the pick/reject flags win.
  const urgency = readProperty(xmpXml, "photoshop:Urgency");
  if (urgency === "1") result.flag = "pick";
  else if (urgency === "8") result.flag = "reject";
  const isTrue = (v: string | undefined) => v !== undefined && /^(true|1)$/i.test(v);
  if (isTrue(readProperty(xmpXml, "xmp:RejectFlag"))) result.flag = "reject";
  else if (isTrue(readProperty(xmpXml, "xmp:PickFlag"))) result.flag = "pick";

  const keywords = readBag(xmpXml, "dc:subject");
  if (keywords.length > 0) result.keywords = keywords;

  const hierarchical = readBag(xmpXml, "lr:hierarchicalSubject");
  if (hierarchical.length > 0) result.hierarchicalKeywords = hierarchical;

  return result;
}

/** A simple property's text, from its element or its attribute form. */
function readProperty(xml: string, tag: string): string | undefined {
  const element = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`));
  if (element) return unescapeXml(element[1]).trim();
  const attribute = xml.match(new RegExp(`\\s${tag}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  if (attribute) return unescapeXml(attribute[1] ?? attribute[2]).trim();
  return undefined;
}

/** The entries of an rdf:Bag property, unescaped. */
function readBag(xml: string, tag: string): string[] {
  const bag = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*<rdf:Bag(?:\\s[^>]*)?>([\\s\\S]*?)</rdf:Bag>\\s*</${tag}>`),
  );
  if (!bag) return [];
  return [...bag[1].matchAll(/<rdf:li(?:\s[^>]*)?>([^<]*)<\/rdf:li>/g)]
    .map((li) => unescapeXml(li[1]))
    .filter((entry) => entry.length > 0);
}

// ── XMP Generation ─────────────────────────────────────────────────────────

interface XmpWriteOptions {
  includePrivateNamespace?: boolean;
}

/** Properties this extension owns and rewrites wholesale on every write. The
 *  safelight: pair is owned only when the private namespace is in play, so a
 *  plain rating/label write never strips the develop params an edit commit
 *  saved earlier. lr:hierarchicalSubject is not ours: the catalog keeps only
 *  flat keywords, so rewriting it would flatten another app's hierarchy. */
const OWNED_TAGS = [
  "xmp:Rating",
  "xmp:Label",
  "xmp:PickFlag",
  "xmp:RejectFlag",
  "photoshop:Urgency",
  "dc:subject",
] as const;
const PRIVATE_TAGS = ["safelight:DevelopParams", "safelight:EditHistory"] as const;

/** Stamped on packets this extension creates, so removal can tell its own
 *  sidecars from those of the other tools that share the name. */
const XMPTK = "XMP Tools for Safelight";

/** Remove every serialization of `tags`: element, empty element, attribute. */
function stripProperties(text: string, tags: readonly string[]): string {
  let out = text;
  for (const tag of tags) {
    out = out.replace(new RegExp(`\\s*<${tag}[\\s\\S]*?<\\/${tag}>`, "g"), "");
    out = out.replace(new RegExp(`\\s*<${tag}\\b[^>]*/>`, "g"), "");
    out = out.replace(new RegExp(`\\s+${tag}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "g"), "");
  }
  return out;
}

/** darktable/exiv2 write attribute-only Descriptions self-closed. Only the
 *  first Description is expanded, as that is where our properties go. */
function expandSelfClosedDescription(text: string): string {
  const first = text.search(/<rdf:Description\b/);
  if (first === -1) return text;
  const expanded = text
    .slice(first)
    .replace(/^<rdf:Description\b([^>]*?)\/\s*>/, "<rdf:Description$1></rdf:Description>");
  return text.slice(0, first) + expanded;
}

const DESCRIPTION_TAG = /<rdf:Description\b[^>]*>|<\/rdf:Description\s*>/g;

/** Lift out the Descriptions nested inside another one (Lightroom's crs:Look
 *  and crs:Parameters structs), so reads and edits see only the top-level
 *  properties and the first </rdf:Description> left closes the first
 *  Description; `restore` puts them back verbatim. */
function liftNestedDescriptions(text: string): { text: string; restore(edited: string): string } {
  const nested: string[] = [];
  let out = "";
  let from = 0;
  let depth = 0;
  let start = -1;
  const lift = (end: number) => {
    out += `${text.slice(from, start)}\u0000${nested.length}\u0000`;
    nested.push(text.slice(start, end));
    from = end;
    start = -1;
  };
  for (const match of text.matchAll(DESCRIPTION_TAG)) {
    const tag = match[0];
    const at = match.index;
    if (tag.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      if (depth === 1 && start !== -1) lift(at + tag.length);
    } else if (/\/\s*>$/.test(tag)) {
      if (depth >= 1 && start === -1) {
        start = at;
        lift(at + tag.length);
      }
    } else {
      if (depth === 1 && start === -1) start = at;
      depth++;
    }
  }
  out += text.slice(from);
  return {
    text: out,
    restore: (edited) => edited.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => nested[Number(i)]),
  };
}

/** Drop the hierarchy entries whose leaf (after the last "|") was removed
 *  from dc:subject, so apps that rebuild keywords from the hierarchy don't
 *  bring it back. Every other entry is left as it was written. */
function pruneHierarchy(text: string, removed: ReadonlySet<string>): string {
  if (removed.size === 0) return text;
  return text.replace(
    /(\s*)(<lr:hierarchicalSubject(?:\s[^>]*)?>)([\s\S]*?)(<\/lr:hierarchicalSubject>)/,
    (_whole, lead: string, open: string, inner: string, close: string) => {
      let kept = 0;
      const pruned = inner.replace(/\s*<rdf:li(?:\s[^>]*)?>([^<]*)<\/rdf:li>/g, (li, value: string) => {
        const path = unescapeXml(value);
        if (removed.has(path.slice(path.lastIndexOf("|") + 1))) return "";
        kept++;
        return li;
      });
      return kept > 0 ? `${lead}${open}${pruned}${close}` : "";
    },
  );
}

/** True only for a packet this extension created that still holds nothing but
 *  its own properties. Another tool that adds to our sidecar keeps our stamp,
 *  so the stamp alone doesn't prove the file is ours to delete. */
export function isOwnPacket(text: string): boolean {
  if (!text.includes(`x:xmptk="${XMPTK}"`)) return false;
  if ((text.match(/<rdf:Description\b/g) ?? []).length !== 1) return false;
  const rest = stripProperties(expandSelfClosedDescription(text), [...OWNED_TAGS, ...PRIVATE_TAGS]);
  const description = rest.match(/<rdf:Description\b([^>]*)>([\s\S]*?)<\/rdf:Description>/);
  if (!description) return false;
  const foreignAttributes = description[1].replace(
    /\s+(?:xmlns:[\w.-]+|rdf:about)\s*=\s*(?:"[^"]*"|'[^']*')/g,
    "",
  );
  return foreignAttributes.trim() === "" && description[2].trim() === "";
}

/** Serialize the owned properties that currently have a value, one element per
 *  entry. An absent entry means "unset" — the upsert removes the property. */
function ownedElements(
  photo: CatalogPhoto,
  editState?: EditState,
  options?: XmpWriteOptions
): string[] {
  const out: string[] = [];

  // Rating
  if (photo.rating > 0) {
    out.push(`<xmp:Rating>${photo.rating}</xmp:Rating>`);
  }

  // Label (convert "none" to empty, others to Title Case)
  if (photo.colorLabel && photo.colorLabel !== "none") {
    const labelTitle = photo.colorLabel.charAt(0).toUpperCase() + photo.colorLabel.slice(1);
    out.push(`<xmp:Label>${escapeXml(labelTitle)}</xmp:Label>`);
  }

  // Flag - use photoshop:Urgency (1=pick/high, 8=reject/low)
  if (photo.flag === "pick") {
    out.push('<photoshop:Urgency>1</photoshop:Urgency>');
  } else if (photo.flag === "reject") {
    out.push('<photoshop:Urgency>8</photoshop:Urgency>');
  }

  // Keywords
  if (photo.keywords.length > 0) {
    const items = photo.keywords.map((kw) => `<rdf:li>${escapeXml(kw)}</rdf:li>`).join("");
    out.push(`<dc:subject><rdf:Bag>${items}</rdf:Bag></dc:subject>`);
  }

  // Private Safelight namespace for edit params (round-tripping)
  if (options?.includePrivateNamespace && editState) {
    const currentEdit = editState.stack[editState.currentIndex];
    if (currentEdit) {
      const paramsJson = JSON.stringify(currentEdit.params);
      out.push(`<safelight:DevelopParams>${escapeXml(paramsJson)}</safelight:DevelopParams>`);
      out.push(`<safelight:EditHistory>${escapeXml(JSON.stringify(editState.stack.map(s => ({ timestamp: s.timestamp, label: s.label }))))}</safelight:EditHistory>`);
    }
  }

  return out;
}

/** Generate XMP XML from Safelight metadata and optional edit params. */
export function generateXmp(
  photo: CatalogPhoto,
  editState?: EditState,
  options?: XmpWriteOptions
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${XMPTK}">`,
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description',
  ];

  // Add namespace declarations
  lines.push(`      xmlns:xmp="${NAMESPACES.xmp}"`);
  lines.push(`      xmlns:dc="${NAMESPACES.dc}"`);
  lines.push(`      xmlns:photoshop="${NAMESPACES.photoshop}"`);
  if (options?.includePrivateNamespace) {
    lines.push(`      xmlns:safelight="${NAMESPACES.safelight}"`);
  }
  lines.push('      rdf:about="">');

  for (const prop of ownedElements(photo, editState, options)) {
    lines.push(`      ${prop}`);
  }

  lines.push('    </rdf:Description>');
  lines.push('  </rdf:RDF>');
  lines.push('</x:xmpmeta>');

  return lines.join('\n');
}

/** Produce updated XMP text carrying the photo's current metadata while
 *  preserving every property another writer put there (Advanced EXIF Tools'
 *  caption/copyright/GPS, Lightroom develop settings, …). With no usable
 *  existing packet this is generateXmp. */
export function upsertXmp(
  existing: string | null,
  photo: CatalogPhoto,
  editState?: EditState,
  options?: XmpWriteOptions
): string {
  if (!existing || !/<rdf:Description[\s/>]/.test(existing)) {
    return generateXmp(photo, editState, options);
  }

  const owned: readonly string[] = options?.includePrivateNamespace
    ? [...OWNED_TAGS, ...PRIVATE_TAGS]
    : OWNED_TAGS;
  const lifted = liftNestedDescriptions(existing);
  const kept = new Set(photo.keywords);
  const removed = new Set(readBag(lifted.text, "dc:subject").filter((k) => !kept.has(k)));
  // Expanded so the element insertion below has a closing tag to land in.
  let text = stripProperties(expandSelfClosedDescription(lifted.text), owned);
  text = pruneHierarchy(text, removed);

  // Make sure the namespaces we write are declared on the first Description.
  text = text.replace(/<rdf:Description\b([^>]*)>/, (_full, attrs: string) => {
    let a = attrs;
    if (!/xmlns:xmp=/.test(a)) a += ` xmlns:xmp="${NAMESPACES.xmp}"`;
    if (!/xmlns:dc=/.test(a)) a += ` xmlns:dc="${NAMESPACES.dc}"`;
    if (!/xmlns:photoshop=/.test(a)) a += ` xmlns:photoshop="${NAMESPACES.photoshop}"`;
    if (options?.includePrivateNamespace && !/xmlns:safelight=/.test(a)) {
      a += ` xmlns:safelight="${NAMESPACES.safelight}"`;
    }
    return `<rdf:Description${a}>`;
  });

  const props = ownedElements(photo, editState, options);
  const insertion = props.length ? `      ${props.join("\n      ")}\n    ` : "";
  // Function form: user text (keywords, params JSON) may contain "$&"-style
  // sequences a replacement string would expand.
  return lifted.restore(text.replace(/<\/rdf:Description>/, () => `${insertion}</rdf:Description>`));
}

/** Escape special XML characters. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** Undo XML escaping in one pass, so "&amp;lt;" reads back as "&lt;". */
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (entity, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES[body];
    const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

// ── File I/O Helpers ────────────────────────────────────────────────────────

/** The browser's file API names a missing file NotFoundError; the desktop
 *  bridge passes Node's error on with the errno only in its message. */
function isMissingFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === "NotFoundError" || (typeof message === "string" && /\bENOENT(?=:)/.test(message));
}

/** Read XMP sidecar file for a given image file. Returns null if not found. */
export async function readXmpSidecar(
  parentDir: FileSystemDirectoryHandle,
  imageFilename: string
): Promise<XmpMetadata | null> {
  const xmpName = getXmpSidecarName(imageFilename);
  try {
    const handle = await parentDir.getFileHandle(xmpName);
    const file = await handle.getFile();
    const xml = await file.text();
    return parseXmp(xml);
  } catch {
    return null;
  }
}

/** Write XMP sidecar file next to the original image. Reads any existing
 *  sidecar first and upserts, so properties written by other tools survive. */
export async function writeXmpSidecar(
  parentDir: FileSystemDirectoryHandle,
  imageFilename: string,
  photo: CatalogPhoto,
  editState?: EditState,
  options?: XmpWriteOptions
): Promise<void> {
  const xmpName = getXmpSidecarName(imageFilename);
  // A sidecar that is there but can't be read (locked by another app, access
  // denied, a network share dropping out) must fail the write, or a fresh
  // packet would replace whatever another app keeps in it.
  let existing: string | null = null;
  try {
    const handle = await parentDir.getFileHandle(xmpName);
    existing = await (await handle.getFile()).text();
  } catch (e) {
    if (!isMissingFile(e)) throw e;
  }
  const xmpXml = upsertXmp(existing, photo, editState, options);

  const handle = await parentDir.getFileHandle(xmpName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(xmpXml);
  await writable.close();
}

/** Delete the image's sidecar only when isOwnPacket proves it holds nothing
 *  but what this extension wrote; any other sidecar is left in place. */
export async function deleteOwnXmpSidecar(
  parentDir: FileSystemDirectoryHandle,
  imageFilename: string
): Promise<void> {
  const xmpName = getXmpSidecarName(imageFilename);
  try {
    const text = await (await (await parentDir.getFileHandle(xmpName)).getFile()).text();
    if (isOwnPacket(text)) await parentDir.removeEntry(xmpName);
  } catch {
    // No sidecar, or it can't be read or removed: nothing to clean up.
  }
}

// ── Import Helpers ───────────────────────────────────────────────────────────

/** Build the CatalogPhoto field overrides for an imported XMP (only fields
 *  actually present in the sidecar), to be merged onto the photo record. */
export function xmpToPhotoOverrides(xmp: XmpMetadata): Partial<CatalogPhoto> {
  const updated: Partial<CatalogPhoto> = {};
  if (xmp.rating !== undefined) updated.rating = xmp.rating;
  if (xmp.label !== undefined) updated.colorLabel = xmp.label;
  if (xmp.flag !== undefined) updated.flag = xmp.flag;
  if (xmp.keywords !== undefined && xmp.keywords.length > 0) updated.keywords = xmp.keywords;
  return updated;
}

/** Apply XMP metadata to a CatalogPhoto (non-destructive: only sets if present). */
export function applyXmpToPhoto(photo: CatalogPhoto, xmp: XmpMetadata): CatalogPhoto {
  return { ...photo, ...xmpToPhotoOverrides(xmp) };
}
