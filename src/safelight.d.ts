// Minimal type surface SafeLight exposes to this extension. This package is
// built separately from the app (the repo-root `extensions/` folder is outside
// the main tsconfig), so it can't import "@/..." — it vendors the shapes it
// needs. These mirror the core types in src/catalog/types.ts and
// src/extensions/types.ts; only the fields this extension touches are declared.

// ── Catalogue data ────────────────────────────────────────────────────────────

export type ColorLabel = "none" | "red" | "yellow" | "green" | "blue" | "purple";
export type FlagStatus = "none" | "pick" | "reject";

export interface CatalogPhoto {
  id: string;
  filename: string;
  rating: number;
  colorLabel: ColorLabel;
  flag: FlagStatus;
  keywords: string[];
  directoryHandle: FileSystemDirectoryHandle | null;
  fileHandle: FileSystemFileHandle | null;
  /** Set on a virtual copy: the master photo id. A copy shares its master's
   *  file and directory handles. */
  copyOf?: string;
  // …other fields exist in core but aren't used here.
  [key: string]: unknown;
}

export interface EditSnapshot {
  timestamp: number;
  label: string;
  params: DevelopParams;
}

export interface EditState {
  photoId: string;
  stack: EditSnapshot[];
  currentIndex: number;
}

// ── Develop params (subset produced by the Lightroom importer) ───────────────

export interface CurvePoint {
  x: number; // 0..1
  y: number; // 0..1
}

export interface ToneCurves {
  rgb: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export type HSLChannel =
  | "red" | "orange" | "yellow" | "green"
  | "aqua" | "blue" | "purple" | "magenta";

export type HSLValues = Record<HSLChannel, number>;

export interface HSLAdjustments {
  hue: HSLValues;
  saturation: HSLValues;
  luminance: HSLValues;
}

export interface ColorGradingRange {
  hue: number;  // 0..360
  sat: number;  // 0..100
  luma: number; // -100..100
}

export interface ColorGradingParams {
  shadows: ColorGradingRange;
  midtones: ColorGradingRange;
  highlights: ColorGradingRange;
  global: ColorGradingRange;
  shadowRange: number;
  highlightRange: number;
}

export interface VignetteParams {
  amount: number;     // -100..100 (negative darkens the edges)
  midpoint: number;   // 0..100
  roundness: number;  // -100..100
  feather: number;    // 0..100
  highlights: number; // 0..100 highlight priority
}

export interface GrainParams {
  amount: number;    // 0..100
  size: number;      // 25..100
  roughness: number; // 0..100
  color: number;     // 0..100 (0 = mono)
}

/** Full develop params. The importer only ever produces a Partial; core's
 *  normalizeParams() fills everything else with defaults. */
export interface DevelopParams {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  sharpening: number;
  sharpenRadius: number;
  sharpenDetail: number;
  sharpenMasking: number;
  luminanceNR: number;
  luminanceNRDetail: number;
  luminanceNRContrast: number;
  colorNR: number;
  colorNRDetail: number;
  colorNRSmoothness: number;
  vibrance: number;
  saturation: number;
  temperature: number;
  tint: number;
  toneCurve: ToneCurves;
  hsl: HSLAdjustments;
  colorGrading: ColorGradingParams;
  vignette: VignetteParams;
  grain: GrainParams;
  [key: string]: unknown;
}

// ── Extension API (subset used by this extension) ────────────────────────────

export type SettingsField = {
  key: string;
  label: string;
  hint?: string;
  type: "boolean";
  default: boolean;
};

export interface SettingsContribution {
  title?: string;
  fields: SettingsField[];
}

export interface CatalogHooksContribution {
  id: string;
  onPhotoImport?(ctx: {
    photo: CatalogPhoto;
    dir: FileSystemDirectoryHandle;
    fileName: string;
  }): Promise<Partial<CatalogPhoto> | void>;
  onMetadataChange?(ctx: {
    photos: CatalogPhoto[];
    getEditState(id: string): Promise<EditState | null>;
  }): Promise<void>;
  onEditCommit?(ctx: { photo: CatalogPhoto; editState: EditState }): Promise<void>;
  onPhotoRemove?(ctx: {
    photo: CatalogPhoto;
    dir: FileSystemDirectoryHandle;
    fileName: string;
  }): Promise<void>;
}

export interface PresetImporterContribution {
  id: string;
  label: string;
  extensions: string[];
  parse(file: File): Promise<{ name: string; params: Partial<DevelopParams> } | null>;
}

export interface SafelightAPI {
  version: 1;
  extensionId: string;
  registerSettings(c: SettingsContribution): void;
  registerCatalogHooks(c: CatalogHooksContribution): void;
  registerPresetImporter(c: PresetImporterContribution): void;
  /** Feature-detected: an older host may not provide it. */
  ui?: {
    alertDialog?(options: { title: string; message: string }): Promise<void>;
  };
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    onChange(cb: (key: string, value: unknown) => void): () => void;
  };
  // …the full API has more; only what this extension uses is declared.
}

export interface ExtensionModule {
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}
