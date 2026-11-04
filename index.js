//#region src/xmp.ts
/** Generate XMP sidecar filename following Adobe/Lightroom conventions.
*  - DSC_0012.NEF → DSC_0012.xmp
*  - DSC_0012.JPG → DSC_0012_jpg.xmp (for RAW+JPEG pairs)
*/
function getXmpSidecarName(imageFilename) {
	const dot = imageFilename.lastIndexOf(".");
	if (dot === -1) return `${imageFilename}.xmp`;
	const base = imageFilename.slice(0, dot);
	const ext = imageFilename.slice(dot + 1).toLowerCase();
	if (/^(nef|cr2|cr3|crw|dng|arw|orf|raf|rw2|pef|srw|3fr|dcr|erf|kdc|mos|raw|nrw)$/i.test(ext)) return `${base}.xmp`;
	return `${base}_${ext}.xmp`;
}
const NAMESPACES = {
	rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
	xmp: "http://ns.adobe.com/xap/1.0/",
	dc: "http://purl.org/dc/elements/1.1/",
	photoshop: "http://ns.adobe.com/photoshop/1.0/",
	safelight: "http://ns.safelight.app/1.0/"
};
/** Parse XMP XML and extract metadata fields. Simple properties are read in
*  both serializations XMP allows: <xmp:Rating>4</xmp:Rating> and the
*  attribute form xmp:Rating="4" that most other apps write. Only top-level
*  Descriptions are read, never the structs nested inside them. */
function parseXmp(packet) {
	const result = {};
	const xmpXml = liftNestedDescriptions(packet).text;
	const rating = readProperty(xmpXml, "xmp:Rating");
	if (rating !== void 0 && /^\d$/.test(rating)) {
		const value = parseInt(rating, 10);
		if (value <= 5) result.rating = value;
	}
	const label = readProperty(xmpXml, "xmp:Label")?.toLowerCase();
	if (label && [
		"none",
		"red",
		"yellow",
		"green",
		"blue",
		"purple"
	].includes(label)) result.label = label;
	const urgency = readProperty(xmpXml, "photoshop:Urgency");
	if (urgency === "1") result.flag = "pick";
	else if (urgency === "8") result.flag = "reject";
	const isTrue = (v) => v !== void 0 && /^(true|1)$/i.test(v);
	if (isTrue(readProperty(xmpXml, "xmp:RejectFlag"))) result.flag = "reject";
	else if (isTrue(readProperty(xmpXml, "xmp:PickFlag"))) result.flag = "pick";
	const keywords = readBag(xmpXml, "dc:subject");
	if (keywords.length > 0) result.keywords = keywords;
	const hierarchical = readBag(xmpXml, "lr:hierarchicalSubject");
	if (hierarchical.length > 0) result.hierarchicalKeywords = hierarchical;
	return result;
}
/** A simple property's text, from its element or its attribute form. */
function readProperty(xml, tag) {
	const element = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`));
	if (element) return unescapeXml$1(element[1]).trim();
	const attribute = xml.match(new RegExp(`\\s${tag}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
	if (attribute) return unescapeXml$1(attribute[1] ?? attribute[2]).trim();
}
/** The entries of an rdf:Bag property, unescaped. */
function readBag(xml, tag) {
	const bag = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*<rdf:Bag(?:\\s[^>]*)?>([\\s\\S]*?)</rdf:Bag>\\s*</${tag}>`));
	if (!bag) return [];
	return [...bag[1].matchAll(/<rdf:li(?:\s[^>]*)?>([^<]*)<\/rdf:li>/g)].map((li) => unescapeXml$1(li[1])).filter((entry) => entry.length > 0);
}
/** Properties this extension owns and rewrites wholesale on every write. The
*  safelight: pair is owned only when the private namespace is in play, so a
*  plain rating/label write never strips the develop params an edit commit
*  saved earlier. lr:hierarchicalSubject is not ours: the catalogue keeps only
*  flat keywords, so rewriting it would flatten another app's hierarchy. */
const OWNED_TAGS = [
	"xmp:Rating",
	"xmp:Label",
	"xmp:PickFlag",
	"xmp:RejectFlag",
	"photoshop:Urgency",
	"dc:subject"
];
const PRIVATE_TAGS = ["safelight:DevelopParams", "safelight:EditHistory"];
/** Stamped on packets this extension creates, so removal can tell its own
*  sidecars from those of the other tools that share the name. */
const XMPTK = "XMP Tools for Safelight";
/** Remove every serialization of `tags`: element, empty element, attribute. */
function stripProperties(text, tags) {
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
function expandSelfClosedDescription(text) {
	const first = text.search(/<rdf:Description\b/);
	if (first === -1) return text;
	const expanded = text.slice(first).replace(/^<rdf:Description\b([^>]*?)\/\s*>/, "<rdf:Description$1></rdf:Description>");
	return text.slice(0, first) + expanded;
}
const DESCRIPTION_TAG = /<rdf:Description\b[^>]*>|<\/rdf:Description\s*>/g;
/** Lift out the Descriptions nested inside another one (Lightroom's crs:Look
*  and crs:Parameters structs), so reads and edits see only the top-level
*  properties and the first </rdf:Description> left closes the first
*  Description; `restore` puts them back verbatim. */
function liftNestedDescriptions(text) {
	const nested = [];
	let out = "";
	let from = 0;
	let depth = 0;
	let start = -1;
	const lift = (end) => {
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
		restore: (edited) => edited.replace(/\u0000(\d+)\u0000/g, (_m, i) => nested[Number(i)])
	};
}
/** Drop the hierarchy entries whose leaf (after the last "|") was removed
*  from dc:subject, so apps that rebuild keywords from the hierarchy don't
*  bring it back. Every other entry is left as it was written. */
function pruneHierarchy(text, removed) {
	if (removed.size === 0) return text;
	return text.replace(/(\s*)(<lr:hierarchicalSubject(?:\s[^>]*)?>)([\s\S]*?)(<\/lr:hierarchicalSubject>)/, (_whole, lead, open, inner, close) => {
		let kept = 0;
		const pruned = inner.replace(/\s*<rdf:li(?:\s[^>]*)?>([^<]*)<\/rdf:li>/g, (li, value) => {
			const path = unescapeXml$1(value);
			if (removed.has(path.slice(path.lastIndexOf("|") + 1))) return "";
			kept++;
			return li;
		});
		return kept > 0 ? `${lead}${open}${pruned}${close}` : "";
	});
}
/** True only for a packet this extension created that still holds nothing but
*  its own properties. Another tool that adds to our sidecar keeps our stamp,
*  so the stamp alone doesn't prove the file is ours to delete. */
function isOwnPacket(text) {
	if (!text.includes(`x:xmptk="${XMPTK}"`)) return false;
	if ((text.match(/<rdf:Description\b/g) ?? []).length !== 1) return false;
	const description = stripProperties(expandSelfClosedDescription(text), [...OWNED_TAGS, ...PRIVATE_TAGS]).match(/<rdf:Description\b([^>]*)>([\s\S]*?)<\/rdf:Description>/);
	if (!description) return false;
	return description[1].replace(/\s+(?:xmlns:[\w.-]+|rdf:about)\s*=\s*(?:"[^"]*"|'[^']*')/g, "").trim() === "" && description[2].trim() === "";
}
/** Serialize the owned properties that currently have a value, one element per
*  entry. An absent entry means "unset" — the upsert removes the property. */
function ownedElements(photo, editState, options) {
	const out = [];
	if (photo.rating > 0) out.push(`<xmp:Rating>${photo.rating}</xmp:Rating>`);
	if (photo.colorLabel && photo.colorLabel !== "none") {
		const labelTitle = photo.colorLabel.charAt(0).toUpperCase() + photo.colorLabel.slice(1);
		out.push(`<xmp:Label>${escapeXml(labelTitle)}</xmp:Label>`);
	}
	if (photo.flag === "pick") out.push("<photoshop:Urgency>1</photoshop:Urgency>");
	else if (photo.flag === "reject") out.push("<photoshop:Urgency>8</photoshop:Urgency>");
	if (photo.keywords.length > 0) {
		const items = photo.keywords.map((kw) => `<rdf:li>${escapeXml(kw)}</rdf:li>`).join("");
		out.push(`<dc:subject><rdf:Bag>${items}</rdf:Bag></dc:subject>`);
	}
	if (options?.includePrivateNamespace && editState) {
		const currentEdit = editState.stack[editState.currentIndex];
		if (currentEdit) {
			const paramsJson = JSON.stringify(currentEdit.params);
			out.push(`<safelight:DevelopParams>${escapeXml(paramsJson)}</safelight:DevelopParams>`);
			out.push(`<safelight:EditHistory>${escapeXml(JSON.stringify(editState.stack.map((s) => ({
				timestamp: s.timestamp,
				label: s.label
			}))))}</safelight:EditHistory>`);
		}
	}
	return out;
}
/** Generate XMP XML from Safelight metadata and optional edit params. */
function generateXmp(photo, editState, options) {
	const lines = [
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
		`<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${XMPTK}">`,
		"  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
		"    <rdf:Description"
	];
	lines.push(`      xmlns:xmp="${NAMESPACES.xmp}"`);
	lines.push(`      xmlns:dc="${NAMESPACES.dc}"`);
	lines.push(`      xmlns:photoshop="${NAMESPACES.photoshop}"`);
	if (options?.includePrivateNamespace) lines.push(`      xmlns:safelight="${NAMESPACES.safelight}"`);
	lines.push("      rdf:about=\"\">");
	for (const prop of ownedElements(photo, editState, options)) lines.push(`      ${prop}`);
	lines.push("    </rdf:Description>");
	lines.push("  </rdf:RDF>");
	lines.push("</x:xmpmeta>");
	return lines.join("\n");
}
/** Produce updated XMP text carrying the photo's current metadata while
*  preserving every property another writer put there (Advanced EXIF Tools'
*  caption/copyright/GPS, Lightroom develop settings, …). With no usable
*  existing packet this is generateXmp. */
function upsertXmp(existing, photo, editState, options) {
	if (!existing || !/<rdf:Description[\s/>]/.test(existing)) return generateXmp(photo, editState, options);
	const owned = options?.includePrivateNamespace ? [...OWNED_TAGS, ...PRIVATE_TAGS] : OWNED_TAGS;
	const lifted = liftNestedDescriptions(existing);
	const kept = new Set(photo.keywords);
	const removed = new Set(readBag(lifted.text, "dc:subject").filter((k) => !kept.has(k)));
	let text = stripProperties(expandSelfClosedDescription(lifted.text), owned);
	text = pruneHierarchy(text, removed);
	text = text.replace(/<rdf:Description\b([^>]*)>/, (_full, attrs) => {
		let a = attrs;
		if (!/xmlns:xmp=/.test(a)) a += ` xmlns:xmp="${NAMESPACES.xmp}"`;
		if (!/xmlns:dc=/.test(a)) a += ` xmlns:dc="${NAMESPACES.dc}"`;
		if (!/xmlns:photoshop=/.test(a)) a += ` xmlns:photoshop="${NAMESPACES.photoshop}"`;
		if (options?.includePrivateNamespace && !/xmlns:safelight=/.test(a)) a += ` xmlns:safelight="${NAMESPACES.safelight}"`;
		return `<rdf:Description${a}>`;
	});
	const props = ownedElements(photo, editState, options);
	const insertion = props.length ? `      ${props.join("\n      ")}\n    ` : "";
	return lifted.restore(text.replace(/<\/rdf:Description>/, () => `${insertion}</rdf:Description>`));
}
/** Escape special XML characters. */
function escapeXml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
const NAMED_ENTITIES = {
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'",
	amp: "&"
};
/** Undo XML escaping in one pass, so "&amp;lt;" reads back as "&lt;". */
function unescapeXml$1(text) {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (entity, body) => {
		if (!body.startsWith("#")) return NAMED_ENTITIES[body];
		const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
		return code <= 1114111 ? String.fromCodePoint(code) : entity;
	});
}
/** The browser's file API names a missing file NotFoundError; the desktop
*  bridge passes Node's error on with the errno only in its message. */
function isMissingFile(error) {
	if (typeof error !== "object" || error === null) return false;
	const { name, message } = error;
	return name === "NotFoundError" || typeof message === "string" && /\bENOENT(?=:)/.test(message);
}
/** Read XMP sidecar file for a given image file. Returns null if not found. */
async function readXmpSidecar(parentDir, imageFilename) {
	const xmpName = getXmpSidecarName(imageFilename);
	try {
		return parseXmp(await (await (await parentDir.getFileHandle(xmpName)).getFile()).text());
	} catch {
		return null;
	}
}
/** Write XMP sidecar file next to the original image. Reads any existing
*  sidecar first and upserts, so properties written by other tools survive. */
async function writeXmpSidecar(parentDir, imageFilename, photo, editState, options) {
	const xmpName = getXmpSidecarName(imageFilename);
	let existing = null;
	try {
		existing = await (await (await parentDir.getFileHandle(xmpName)).getFile()).text();
	} catch (e) {
		if (!isMissingFile(e)) throw e;
	}
	const xmpXml = upsertXmp(existing, photo, editState, options);
	const writable = await (await parentDir.getFileHandle(xmpName, { create: true })).createWritable();
	await writable.write(xmpXml);
	await writable.close();
}
/** Delete the image's sidecar only when isOwnPacket proves it holds nothing
*  but what this extension wrote; any other sidecar is left in place. */
async function deleteOwnXmpSidecar(parentDir, imageFilename) {
	const xmpName = getXmpSidecarName(imageFilename);
	try {
		if (isOwnPacket(await (await (await parentDir.getFileHandle(xmpName)).getFile()).text())) await parentDir.removeEntry(xmpName);
	} catch {}
}
/** Build the CatalogPhoto field overrides for an imported XMP (only fields
*  actually present in the sidecar), to be merged onto the photo record. */
function xmpToPhotoOverrides(xmp) {
	const updated = {};
	if (xmp.rating !== void 0) updated.rating = xmp.rating;
	if (xmp.label !== void 0) updated.colorLabel = xmp.label;
	if (xmp.flag !== void 0) updated.flag = xmp.flag;
	if (xmp.keywords !== void 0 && xmp.keywords.length > 0) updated.keywords = xmp.keywords;
	return updated;
}
//#endregion
//#region src/lightroom-import.ts
const CRS_SCALAR_MAP = {
	Exposure2012: "exposure",
	Contrast2012: "contrast",
	Highlights2012: "highlights",
	Shadows2012: "shadows",
	Whites2012: "whites",
	Blacks2012: "blacks",
	Texture: "texture",
	Clarity2012: "clarity",
	Dehaze: "dehaze",
	Vibrance: "vibrance",
	Saturation: "saturation",
	Temperature: "temperature",
	Tint: "tint",
	Sharpness: "sharpening",
	SharpenRadius: "sharpenRadius",
	SharpenDetail: "sharpenDetail",
	SharpenEdgeMasking: "sharpenMasking",
	LuminanceSmoothing: "luminanceNR",
	LuminanceNoiseReductionDetail: "luminanceNRDetail",
	LuminanceNoiseReductionContrast: "luminanceNRContrast",
	ColorNoiseReduction: "colorNR",
	ColorNoiseReductionDetail: "colorNRDetail",
	ColorNoiseReductionSmoothness: "colorNRSmoothness"
};
const HSL_COLORS = [
	{
		crs: "Red",
		ch: "red"
	},
	{
		crs: "Orange",
		ch: "orange"
	},
	{
		crs: "Yellow",
		ch: "yellow"
	},
	{
		crs: "Green",
		ch: "green"
	},
	{
		crs: "Aqua",
		ch: "aqua"
	},
	{
		crs: "Blue",
		ch: "blue"
	},
	{
		crs: "Purple",
		ch: "purple"
	},
	{
		crs: "Magenta",
		ch: "magenta"
	}
];
function readCrsRaw(xml, key) {
	const attr = xml.match(new RegExp(`crs:${key}\\s*=\\s*"([^"]*)"`));
	if (attr) return attr[1];
	const el = xml.match(new RegExp(`<crs:${key}>([^<]*)</crs:${key}>`));
	if (el) return el[1];
	return null;
}
function readCrsNum(xml, key) {
	const raw = readCrsRaw(xml, key);
	if (raw == null) return null;
	const n = parseFloat(raw.trim().replace(/^\+/, ""));
	return Number.isFinite(n) ? n : null;
}
function zeroHSL() {
	return {
		red: 0,
		orange: 0,
		yellow: 0,
		green: 0,
		aqua: 0,
		blue: 0,
		purple: 0,
		magenta: 0
	};
}
function parseCurve(xml, key) {
	const block = xml.match(new RegExp(`<crs:${key}>([\\s\\S]*?)</crs:${key}>`));
	if (!block) return null;
	const pts = [];
	const liRegex = /<rdf:li>\s*([0-9.]+)\s*,\s*([0-9.]+)\s*<\/rdf:li>/g;
	let m;
	while ((m = liRegex.exec(block[1])) !== null) pts.push({
		x: parseFloat(m[1]) / 255,
		y: parseFloat(m[2]) / 255
	});
	return pts.length >= 2 ? pts : null;
}
function readGradeRange(xml, gradeKey, splitKey) {
	let hue = readCrsNum(xml, `ColorGrade${gradeKey}Hue`);
	let sat = readCrsNum(xml, `ColorGrade${gradeKey}Sat`);
	const luma = readCrsNum(xml, `ColorGrade${gradeKey}Lum`);
	if ((hue == null || sat == null) && splitKey) {
		hue = hue ?? readCrsNum(xml, `SplitToning${splitKey}Hue`);
		sat = sat ?? readCrsNum(xml, `SplitToning${splitKey}Saturation`);
	}
	if (hue == null && sat == null && luma == null) return null;
	return {
		hue: hue ?? 0,
		sat: sat ?? 0,
		luma: luma ?? 0
	};
}
function readVignette(xml) {
	const amount = readCrsNum(xml, "PostCropVignetteAmount");
	const midpoint = readCrsNum(xml, "PostCropVignetteMidpoint");
	const roundness = readCrsNum(xml, "PostCropVignetteRoundness");
	const feather = readCrsNum(xml, "PostCropVignetteFeather");
	const highlights = readCrsNum(xml, "PostCropVignetteHighlightContrast");
	if ([
		amount,
		midpoint,
		roundness,
		feather,
		highlights
	].every((v) => v == null)) return null;
	return {
		amount: amount ?? 0,
		midpoint: midpoint ?? 50,
		roundness: roundness ?? 0,
		feather: feather ?? 50,
		highlights: highlights ?? 0
	};
}
function readGrain(xml) {
	const amount = readCrsNum(xml, "GrainAmount");
	const size = readCrsNum(xml, "GrainSize");
	const roughness = readCrsNum(xml, "GrainFrequency");
	if (amount == null && size == null && roughness == null) return null;
	return {
		amount: amount ?? 0,
		size: size ?? 25,
		roughness: roughness ?? 50,
		color: 0
	};
}
function withoutEmbeddedLook(xml) {
	return xml.replace(/<crs:Look\b[\s\S]*?<\/crs:Look>/g, "");
}
function unescapeXml(text) {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function readPresetName(xml) {
	const alt = xml.match(/<crs:Name>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/);
	if (alt) return unescapeXml(alt[1].trim());
	const plain = readCrsRaw(xml, "Name");
	return plain ? unescapeXml(plain.trim()) : null;
}
/** Parse a Lightroom/ACR .xmp preset. Returns null if it has no recognizable
*  crs: develop settings. */
function parseLightroomXmp(source, fallbackName = "Imported preset") {
	if (!source.includes("crs:")) return null;
	const xml = withoutEmbeddedLook(source);
	const params = {};
	for (const [crsKey, paramKey] of Object.entries(CRS_SCALAR_MAP)) {
		const n = readCrsNum(xml, crsKey);
		if (n != null) params[paramKey] = n;
	}
	const hue = zeroHSL();
	const saturation = zeroHSL();
	const luminance = zeroHSL();
	let hslTouched = false;
	for (const { crs, ch } of HSL_COLORS) {
		const h = readCrsNum(xml, `HueAdjustment${crs}`);
		const s = readCrsNum(xml, `SaturationAdjustment${crs}`);
		const l = readCrsNum(xml, `LuminanceAdjustment${crs}`);
		if (h != null) {
			hue[ch] = h;
			hslTouched = true;
		}
		if (s != null) {
			saturation[ch] = s;
			hslTouched = true;
		}
		if (l != null) {
			luminance[ch] = l;
			hslTouched = true;
		}
	}
	if (hslTouched) params.hsl = {
		hue,
		saturation,
		luminance
	};
	const rgb = parseCurve(xml, "ToneCurvePV2012");
	const red = parseCurve(xml, "ToneCurvePV2012Red");
	const green = parseCurve(xml, "ToneCurvePV2012Green");
	const blue = parseCurve(xml, "ToneCurvePV2012Blue");
	if (rgb || red || green || blue) {
		const identity = [{
			x: 0,
			y: 0
		}, {
			x: 1,
			y: 1
		}];
		params.toneCurve = {
			rgb: rgb ?? identity,
			red: red ?? identity,
			green: green ?? identity,
			blue: blue ?? identity
		};
	}
	const shadows = readGradeRange(xml, "Shadow", "Shadow");
	const midtones = readGradeRange(xml, "Midtone");
	const highlights = readGradeRange(xml, "Highlight", "Highlight");
	const global = readGradeRange(xml, "Global");
	if (shadows || midtones || highlights || global) {
		const zero = {
			hue: 0,
			sat: 0,
			luma: 0
		};
		params.colorGrading = {
			shadows: shadows ?? zero,
			midtones: midtones ?? zero,
			highlights: highlights ?? zero,
			global: global ?? zero,
			shadowRange: 50,
			highlightRange: 50
		};
	}
	const vignette = readVignette(xml);
	if (vignette) params.vignette = vignette;
	const grain = readGrain(xml);
	if (grain) params.grain = grain;
	if (Object.keys(params).length === 0) return null;
	return {
		name: readPresetName(xml) ?? fallbackName,
		params
	};
}
//#endregion
//#region src/sidecar-queue.ts
function createKeyedQueue(opts) {
	const waiting = /* @__PURE__ */ new Map();
	const running = /* @__PURE__ */ new Map();
	let failures = [];
	const start = (key, job) => {
		const done = Promise.resolve().then(() => opts.run(job)).catch((error) => {
			failures.push({
				job,
				error
			});
		}).finally(() => {
			running.delete(key);
			pump();
			if (running.size === 0 && waiting.size === 0) {
				const drained = failures;
				failures = [];
				opts.onDrain(drained);
			}
		});
		running.set(key, done);
	};
	const pump = () => {
		for (const [key, job] of waiting) {
			if (running.size >= opts.concurrency) return;
			if (running.has(key)) continue;
			waiting.delete(key);
			start(key, job);
		}
	};
	return {
		push(key, job) {
			const prev = waiting.get(key);
			waiting.set(key, prev === void 0 ? job : opts.merge(prev, job));
			pump();
		},
		cancel(key) {
			waiting.delete(key);
		},
		async settled(key) {
			for (let job = running.get(key); job; job = running.get(key)) await job;
		}
	};
}
//#endregion
//#region src/index.ts
const WRITE_KEY = "writeXmpSidecars";
const WRITE_CONCURRENCY = 4;
const LISTING_TTL_MS = 1e3;
const listings = /* @__PURE__ */ new WeakMap();
async function listNames(dir) {
	const names = /* @__PURE__ */ new Set();
	for await (const name of dir.keys()) names.add(name.toLowerCase());
	return names;
}
/** Whether the folder still holds `name`. The desktop build's handles open
*  lazily, so getFileHandle succeeds for a missing file; the listing can tell.
*  One listing serves a whole removal batch, and a stale one errs toward
*  reporting a deleted file as present, which keeps its sidecar. */
async function imageOnDisk(dir, name) {
	const now = Date.now();
	let listing = listings.get(dir);
	if (!listing || now - listing.at > LISTING_TTL_MS) {
		listing = {
			at: now,
			names: listNames(dir)
		};
		listings.set(dir, listing);
	}
	try {
		return (await listing.names).has(name.toLowerCase());
	} catch {
		return true;
	}
}
function activate(api) {
	const writeEnabled = () => api.settings.get(WRITE_KEY, false);
	api.registerSettings({
		title: "XMP Tools",
		fields: [{
			key: WRITE_KEY,
			label: "Write XMP sidecars",
			hint: "Save ratings, labels, keywords, and edits to .xmp files alongside your images. Enables interoperability with other photo tools.",
			type: "boolean",
			default: false
		}]
	});
	let failureNoticeShown = false;
	const writes = createKeyedQueue({
		concurrency: WRITE_CONCURRENCY,
		async run({ photo, editState }) {
			if (!writeEnabled() || !photo.directoryHandle || !photo.fileHandle) return;
			await writeXmpSidecar(photo.directoryHandle, photo.fileHandle.name, photo, editState, editState ? { includePrivateNamespace: true } : void 0);
		},
		merge: (waiting, next) => ({
			photo: next.photo,
			editState: next.editState ?? waiting.editState
		}),
		onDrain(failures) {
			if (failures.length === 0) {
				failureNoticeShown = false;
				return;
			}
			for (const { job, error } of failures) console.error(`[xmp] failed to write sidecar for ${job.photo.filename}:`, error);
			if (failureNoticeShown || !api.ui?.alertDialog) return;
			failureNoticeShown = true;
			const n = failures.length;
			api.ui.alertDialog({
				title: "XMP sidecars not saved",
				message: `${n} sidecar${n === 1 ? "" : "s"} couldn't be written. Ratings, labels and keywords are still saved in the catalogue.\n\nCheck that the folder can be written to, then change the photos again to retry.`
			});
		}
	});
	const queueWrite = (photo, editState) => {
		if (photo.copyOf) return;
		writes.push(photo.id, {
			photo,
			editState
		});
	};
	api.registerCatalogHooks({
		id: "com.safelight.xmp-tools.sidecars",
		async onPhotoImport({ dir, fileName }) {
			const xmp = await readXmpSidecar(dir, fileName);
			return xmp ? xmpToPhotoOverrides(xmp) : void 0;
		},
		async onMetadataChange({ photos }) {
			if (!writeEnabled()) return;
			for (const p of photos) queueWrite(p);
		},
		async onEditCommit({ photo, editState }) {
			if (!writeEnabled()) return;
			queueWrite(photo, editState);
		},
		async onPhotoRemove({ photo, dir, fileName }) {
			writes.cancel(photo.id);
			await writes.settled(photo.id);
			if (!writeEnabled() || photo.copyOf) return;
			if (await imageOnDisk(dir, fileName)) return;
			await deleteOwnXmpSidecar(dir, fileName);
		}
	});
	api.registerPresetImporter({
		id: "com.safelight.xmp-tools.lightroom",
		label: "Lightroom preset (.xmp)",
		extensions: [".xmp"],
		async parse(file) {
			return parseLightroomXmp(await file.text(), file.name.replace(/\.xmp$/i, ""));
		}
	});
}
function deactivate() {}
//#endregion
export { activate, deactivate };
