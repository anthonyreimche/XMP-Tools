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
	lr: "http://ns.adobe.com/lightroom/1.0/",
	safelight: "http://ns.safelight.app/1.0/"
};
/** Parse XMP XML and extract metadata fields. */
function parseXmp(xmpXml) {
	const result = {};
	const ratingMatch = xmpXml.match(/<xmp:Rating>(\d)<\/xmp:Rating>/);
	if (ratingMatch) {
		const rating = parseInt(ratingMatch[1], 10);
		if (rating >= 0 && rating <= 5) result.rating = rating;
	}
	const labelMatch = xmpXml.match(/<xmp:Label>([^<]+)<\/xmp:Label>/);
	if (labelMatch) {
		const label = labelMatch[1].toLowerCase();
		if ([
			"none",
			"red",
			"yellow",
			"green",
			"blue",
			"purple"
		].includes(label)) result.label = label;
	}
	const urgencyMatch = xmpXml.match(/<photoshop:Urgency>(\d)<\/photoshop:Urgency>/);
	if (urgencyMatch) {
		const urgency = parseInt(urgencyMatch[1], 10);
		if (urgency === 1) result.flag = "pick";
		else if (urgency === 8) result.flag = "reject";
	}
	const pickMatch = xmpXml.match(/<xmp:PickFlag>(true|1)<\/xmp:PickFlag>/i);
	if (xmpXml.match(/<xmp:RejectFlag>(true|1)<\/xmp:RejectFlag>/i)) result.flag = "reject";
	else if (pickMatch) result.flag = "pick";
	const subjectMatch = xmpXml.match(/<dc:subject>\s*<rdf:Bag>([\s\S]*?)<\/rdf:Bag>\s*<\/dc:subject>/);
	if (subjectMatch) {
		const bagContent = subjectMatch[1];
		const keywords = [];
		const liRegex = /<rdf:li>([^<]+)<\/rdf:li>/g;
		let liMatch;
		while ((liMatch = liRegex.exec(bagContent)) !== null) keywords.push(liMatch[1]);
		if (keywords.length > 0) result.keywords = keywords;
	}
	const hierMatch = xmpXml.match(/<lr:hierarchicalSubject>\s*<rdf:Bag>([\s\S]*?)<\/rdf:Bag>\s*<\/lr:hierarchicalSubject>/);
	if (hierMatch) {
		const bagContent = hierMatch[1];
		const keywords = [];
		const liRegex = /<rdf:li>([^<]+)<\/rdf:li>/g;
		let liMatch;
		while ((liMatch = liRegex.exec(bagContent)) !== null) keywords.push(liMatch[1]);
		if (keywords.length > 0) result.hierarchicalKeywords = keywords;
	}
	return result;
}
/** Properties this extension owns and rewrites wholesale on every write. The
*  safelight: pair is owned only when the private namespace is in play, so a
*  plain rating/label write never strips the develop params an edit commit
*  saved earlier. */
const OWNED_TAGS = [
	"xmp:Rating",
	"xmp:Label",
	"xmp:PickFlag",
	"xmp:RejectFlag",
	"photoshop:Urgency",
	"dc:subject",
	"lr:hierarchicalSubject"
];
const PRIVATE_TAGS = ["safelight:DevelopParams", "safelight:EditHistory"];
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
		out.push(`<lr:hierarchicalSubject><rdf:Bag>${items}</rdf:Bag></lr:hierarchicalSubject>`);
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
		"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
		"  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
		"    <rdf:Description"
	];
	lines.push(`      xmlns:xmp="${NAMESPACES.xmp}"`);
	lines.push(`      xmlns:dc="${NAMESPACES.dc}"`);
	lines.push(`      xmlns:photoshop="${NAMESPACES.photoshop}"`);
	lines.push(`      xmlns:lr="${NAMESPACES.lr}"`);
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
	let text = existing;
	text = text.replace(/<rdf:Description\b([^>]*?)\/\s*>/, "<rdf:Description$1></rdf:Description>");
	const owned = options?.includePrivateNamespace ? [...OWNED_TAGS, ...PRIVATE_TAGS] : OWNED_TAGS;
	for (const tag of owned) {
		text = text.replace(new RegExp(`\\s*<${tag}[\\s\\S]*?<\\/${tag}>`, "g"), "");
		text = text.replace(new RegExp(`\\s*<${tag}\\b[^>]*/>`, "g"), "");
		text = text.replace(new RegExp(`\\s+${tag}="[^"]*"`, "g"), "");
	}
	text = text.replace(/<rdf:Description\b([^>]*)>/, (_full, attrs) => {
		let a = attrs;
		if (!/xmlns:xmp=/.test(a)) a += ` xmlns:xmp="${NAMESPACES.xmp}"`;
		if (!/xmlns:dc=/.test(a)) a += ` xmlns:dc="${NAMESPACES.dc}"`;
		if (!/xmlns:photoshop=/.test(a)) a += ` xmlns:photoshop="${NAMESPACES.photoshop}"`;
		if (!/xmlns:lr=/.test(a)) a += ` xmlns:lr="${NAMESPACES.lr}"`;
		if (options?.includePrivateNamespace && !/xmlns:safelight=/.test(a)) a += ` xmlns:safelight="${NAMESPACES.safelight}"`;
		return `<rdf:Description${a}>`;
	});
	const props = ownedElements(photo, editState, options);
	const insertion = props.length ? `      ${props.join("\n      ")}\n    ` : "";
	return text.replace(/<\/rdf:Description>/, () => `${insertion}</rdf:Description>`);
}
/** Escape special XML characters. */
function escapeXml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
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
	} catch {
		existing = null;
	}
	const xmpXml = upsertXmp(existing, photo, editState, options);
	const writable = await (await parentDir.getFileHandle(xmpName, { create: true })).createWritable();
	await writable.write(xmpXml);
	await writable.close();
}
/** Delete XMP sidecar file (used when removing photos). */
async function deleteXmpSidecar(parentDir, imageFilename) {
	const xmpName = getXmpSidecarName(imageFilename);
	try {
		await parentDir.removeEntry(xmpName);
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
//#region src/index.ts
const WRITE_KEY = "writeXmpSidecars";
function activate(api) {
	const writeEnabled = () => api.settings.get(WRITE_KEY, false);
	api.registerSettings({
		title: "XMP Tools",
		fields: [{
			key: WRITE_KEY,
			label: "Write XMP sidecars",
			hint: "Save ratings, labels, keywords, and edits to .xmp files alongside your images. Enables interoperability with Lightroom, Darktable, and other photo tools.",
			type: "boolean",
			default: false
		}]
	});
	api.registerCatalogHooks({
		id: "com.safelight.xmp-tools.sidecars",
		async onPhotoImport({ dir, fileName }) {
			const xmp = await readXmpSidecar(dir, fileName);
			return xmp ? xmpToPhotoOverrides(xmp) : void 0;
		},
		async onMetadataChange({ photos, getEditState }) {
			if (!writeEnabled()) return;
			for (const p of photos) {
				if (!p.directoryHandle || !p.fileHandle) continue;
				try {
					const editState = await getEditState(p.id);
					await writeXmpSidecar(p.directoryHandle, p.fileHandle.name, p, editState ?? void 0);
				} catch (e) {
					console.warn(`[xmp] failed to write sidecar for ${p.filename}:`, e);
				}
			}
		},
		async onEditCommit({ photo, editState }) {
			if (!writeEnabled()) return;
			if (!photo.directoryHandle || !photo.fileHandle) return;
			try {
				await writeXmpSidecar(photo.directoryHandle, photo.fileHandle.name, photo, editState, { includePrivateNamespace: true });
			} catch (e) {
				console.warn(`[xmp] failed to write sidecar for ${photo.filename}:`, e);
			}
		},
		async onPhotoRemove({ dir, fileName }) {
			await deleteXmpSidecar(dir, fileName);
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
