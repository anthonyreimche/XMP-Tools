// Tests for Lightroom (.xmp) preset parsing.
// Run with: node --experimental-strip-types src/lightroom-import.test.ts

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parseLightroomXmp } from "./lightroom-import.ts";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`);
    failures++;
  }
}

// A minimal preset: crs: attributes on the top-level description, plus any
// child elements.
function preset(attrs: string, body = ""): string {
  return `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      ${attrs}>
      ${body}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
}

// The profile Lightroom embeds in every preset. Its parameters describe how the
// profile renders, not what the preset adjusts.
const ADOBE_COLOR_LOOK = `<crs:Look>
        <rdf:Description crs:Name="Adobe Color" crs:Amount="1">
          <crs:Parameters>
            <rdf:Description crs:ProcessVersion="11.0" crs:Clarity2012="+40">
              <crs:ToneCurvePV2012>
                <rdf:Seq>
                  <rdf:li>0, 0</rdf:li>
                  <rdf:li>22, 16</rdf:li>
                  <rdf:li>255, 255</rdf:li>
                </rdf:Seq>
              </crs:ToneCurvePV2012>
            </rdf:Description>
          </crs:Parameters>
        </rdf:Description>
      </crs:Look>`;

// 1 — attribute form (how Lightroom usually writes presets)
function testAttributeForm() {
  console.log("Testing attribute-form crs: parsing...");
  const xml = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+1.50"
      crs:Contrast2012="+25"
      crs:Highlights2012="-40"
      crs:Saturation="-100"
      crs:Temperature="5500"
      crs:Sharpness="60">
      <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">B&amp;W Punch</rdf:li></rdf:Alt></crs:Name>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  const r = parseLightroomXmp(xml);
  check("returns a result", r != null);
  if (!r) return;
  check("exposure 1.5", r.params.exposure === 1.5);
  check("contrast 25", r.params.contrast === 25);
  check("highlights -40", r.params.highlights === -40);
  check("saturation -100", r.params.saturation === -100);
  check("temperature 5500", r.params.temperature === 5500);
  check("sharpening 60", r.params.sharpening === 60);
  check("preset name from crs:Name", r.name === "B&W Punch");
  console.log("");
}

// 2 — element form + HSL + tone curve
function testElementFormHslCurve() {
  console.log("Testing element-form + HSL + tone curve...");
  const xml = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
      <crs:Exposure2012>-0.25</crs:Exposure2012>
      <crs:SaturationAdjustmentRed>-80</crs:SaturationAdjustmentRed>
      <crs:SaturationAdjustmentAqua>+30</crs:SaturationAdjustmentAqua>
      <crs:LuminanceAdjustmentBlue>-15</crs:LuminanceAdjustmentBlue>
      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>128, 150</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  const r = parseLightroomXmp(xml);
  check("returns a result", r != null);
  if (!r) return;
  check("exposure -0.25 (element form)", r.params.exposure === -0.25);
  check("HSL red sat -80", r.params.hsl?.saturation.red === -80);
  check("HSL aqua sat +30", r.params.hsl?.saturation.aqua === 30);
  check("HSL blue luminance -15", r.params.hsl?.luminance.blue === -15);
  check("HSL untouched channel stays 0", r.params.hsl?.saturation.green === 0);
  const rgb = r.params.toneCurve?.rgb;
  check("tone curve has 3 points", rgb?.length === 3);
  check("curve x normalized to 0..1", rgb?.[1].x === 128 / 255);
  check("curve y normalized to 0..1", rgb?.[1].y === 150 / 255);
  check("untouched red channel is identity", r.params.toneCurve?.red.length === 2);
  console.log("");
}

// 3 — non-XMP / no crs content → null
function testNonXmp() {
  console.log("Testing non-preset input...");
  check("plain text → null", parseLightroomXmp("not xml at all") === null);
  check(
    "xmp without crs → null",
    parseLightroomXmp('<x:xmpmeta><rdf:Description xmlns:dc="..."/></x:xmpmeta>') === null,
  );
  console.log("");
}

// 4 — Effects panel post-crop vignette
function testPostCropVignette() {
  console.log("Testing post-crop vignette...");
  const full = parseLightroomXmp(preset(`
      crs:PostCropVignetteAmount="-25"
      crs:PostCropVignetteMidpoint="35"
      crs:PostCropVignetteRoundness="-20"
      crs:PostCropVignetteFeather="70"
      crs:PostCropVignetteHighlightContrast="40"
      crs:VignetteAmount="-50"`));
  check(
    "all five post-crop keys map to vignette",
    isDeepStrictEqual(full?.params.vignette, {
      amount: -25, midpoint: 35, roundness: -20, feather: 70, highlights: 40,
    }),
  );

  const amountOnly = parseLightroomXmp(preset(`crs:PostCropVignetteAmount="-30"`));
  check(
    "missing post-crop keys take Lightroom's defaults",
    isDeepStrictEqual(amountOnly?.params.vignette, {
      amount: -30, midpoint: 50, roundness: 0, feather: 50, highlights: 0,
    }),
  );

  const lensOnly = parseLightroomXmp(preset(`
      crs:Exposure2012="+0.50"
      crs:VignetteAmount="-50"
      crs:VignetteMidpoint="30"`));
  check("lens vignetting correction is not a vignette", lensOnly?.params.vignette === undefined);
  console.log("");
}

// 5 — Effects panel grain
function testGrain() {
  console.log("Testing grain...");
  const full = parseLightroomXmp(preset(`
      crs:GrainAmount="35"
      crs:GrainSize="60"
      crs:GrainFrequency="70"`));
  check(
    "amount, size and frequency map to grain",
    isDeepStrictEqual(full?.params.grain, { amount: 35, size: 60, roughness: 70, color: 0 }),
  );

  const amountOnly = parseLightroomXmp(preset(`crs:GrainAmount="20"`));
  check(
    "missing grain keys take Lightroom's defaults",
    isDeepStrictEqual(amountOnly?.params.grain, { amount: 20, size: 25, roughness: 50, color: 0 }),
  );
  console.log("");
}

// 6 — the embedded profile (crs:Look) is not part of the preset's adjustments
function testEmbeddedLookIgnored() {
  console.log("Testing embedded crs:Look is ignored...");
  const noOwnCurve = parseLightroomXmp(
    preset(`crs:Exposure2012="+0.30"`, ADOBE_COLOR_LOOK),
    "Fallback",
  );
  check("profile curve is not imported as a user curve", noOwnCurve?.params.toneCurve === undefined);
  check("profile scalars are not imported", noOwnCurve?.params.clarity === undefined);
  check("profile name is not the preset name", noOwnCurve?.name === "Fallback");

  const lookFirst = parseLightroomXmp(preset(`crs:Exposure2012="+0.30"`, `${ADOBE_COLOR_LOOK}
      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 24</rdf:li>
          <rdf:li>255, 245</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>`));
  check(
    "preset's own curve wins when the Look comes first",
    isDeepStrictEqual(lookFirst?.params.toneCurve?.rgb, [
      { x: 0, y: 24 / 255 },
      { x: 1, y: 245 / 255 },
    ]),
  );
  console.log("");
}

// 7 — a real Lightroom Classic export
function testWarmMatteFixture() {
  console.log("Testing Lightroom Classic fixture (Warm Matte)...");
  const xml = readFileSync(new URL("./__fixtures__/warm-matte.xmp", import.meta.url), "utf8");
  const r = parseLightroomXmp(xml);
  check("returns a result", r != null);
  if (!r) return;
  check("name", r.name === "Warm Matte");
  check(
    "vignette",
    isDeepStrictEqual(r.params.vignette, {
      amount: -15, midpoint: 50, roundness: 0, feather: 50, highlights: 0,
    }),
  );
  check(
    "grain",
    isDeepStrictEqual(r.params.grain, { amount: 20, size: 25, roughness: 50, color: 0 }),
  );
  check(
    "rgb curve is the preset's, not the profile's",
    isDeepStrictEqual(r.params.toneCurve?.rgb, [
      { x: 0, y: 24 / 255 },
      { x: 64 / 255, y: 60 / 255 },
      { x: 192 / 255, y: 200 / 255 },
      { x: 1, y: 245 / 255 },
    ]),
  );

  const withoutOwnCurve = xml.replace(
    /<crs:ToneCurvePV2012>[\s\S]*?<\/crs:ToneCurvePV2012>/,
    "",
  );
  const stripped = parseLightroomXmp(withoutOwnCurve);
  check(
    "without its own rgb curve, rgb stays identity",
    isDeepStrictEqual(stripped?.params.toneCurve?.rgb, [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]),
  );
  console.log("");
}

console.log("=== Lightroom Import Tests ===\n");
testAttributeForm();
testElementFormHslCurve();
testNonXmp();
testPostCropVignette();
testGrain();
testEmbeddedLookIgnored();
testWarmMatteFixture();

console.log("=========================");
if (failures === 0) {
  console.log("✓ All tests passed!");
} else {
  console.log(`✗ ${failures} checks failed`);
  process.exitCode = 1;
}
