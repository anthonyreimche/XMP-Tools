# XMP Tools

Keep your ratings, labels, keywords, and edits in standard `.xmp` sidecar files
so your photo library stays portable — and bring your Lightroom looks with you.

## What it does

- **Reads your existing metadata.** When SafeLight imports a photo that already
  has an `.xmp` sidecar, your star rating, color label, flag, and keywords come
  along automatically.
- **Writes sidecars as you work.** Ratings, labels, keywords, and develop edits
  can be saved back to `.xmp` files next to your images, so other apps —
  Lightroom, Adobe Camera Raw, Darktable, Bridge — see the same metadata.
  Writes merge into the existing sidecar, so captions, copyright, GPS, and
  anything else another tool put there stay untouched.
- **Imports Lightroom presets.** Drop a Lightroom / Adobe Camera Raw `.xmp`
  preset into the Presets panel and apply it like any built-in preset.
- **Cleans up after itself.** When you remove a photo from SafeLight, its
  sidecar goes too.

## Turning on sidecar writing

Writing is **off by default**, so SafeLight never touches the files alongside
your photos until you say so. To enable it, open the Extensions panel, click the
⚙ settings icon on **XMP Tools**, and switch on **Write XMP sidecars**.

Reading existing sidecars on import always works — only writing is gated by this
setting.

## What gets imported from Lightroom presets

Tone and color adjustments are mapped on import: basic tone/color sliders,
sharpening, noise reduction, the 8-channel HSL mix, Process-2012 tone curves,
and best-effort color grading.

Crop, transform, lens corrections, and masks are **not** imported. Older
`.lrtemplate` presets and Capture One `.costyle` styles aren't supported — use
the `.xmp` preset format.

## Compatibility

Requires SafeLight 1.0.0 or newer. MIT licensed.

---

### For developers

This extension is built to a single ESM bundle and installed into SafeLight's
plugins directory like any external extension.

```sh
node scripts/build.mjs        # bundle only → dist/index.js
node scripts/install.mjs      # bundle + copy into the plugins dir
npm test                      # run the XMP + Lightroom-import test scripts
```

The installer auto-detects SafeLight's `userData/plugins` directory; override
with `SAFELIGHT_PLUGINS_DIR=/path/to/plugins` or `--dir /path/to/plugins`.
Restart SafeLight (or toggle the extension in the Extensions manager) to load
it. The app core knows nothing about XMP — it emits catalog lifecycle hooks
(`onPhotoImport`, `onMetadataChange`, `onEditCommit`, `onPhotoRemove`) plus a
pluggable preset importer, which this extension subscribes to.
