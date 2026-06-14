import type { TraceSubject } from '../engine/pathDedup'



/** Routing profile for generate_and_trace / draw pipelines. */

export type TraceScenario = 'primitive' | 'icon_template' | 'flat_illustration' | 'complex_photo'

export type DrawPipelineMode = 'outline_only' | 'sketch_then_color' | 'stroke_reveal' | 'region_trace' | 'bitmap_trace'

/** Wanx / sketch style — flat cartoon only when user asks for it. */
export type WanxStyle = 'detailed_illustration' | 'flat_cartoon'

/** Unified pipeline v2 tunables — one path for all subjects. */
export const PIPELINE_CONFIG = {
  /** Default: outline strokes only — no fill / clipImage. */
  drawMode: 'outline_only' as DrawPipelineMode,
  /** Default Wanx output style for generate_and_trace (not flat chibi). */
  defaultWanxStyle: 'detailed_illustration' as WanxStyle,
  /** masked_reveal shows source pixels per region; polygon_fill uses sampled hex fills. */
  colorFillMode: 'masked_reveal' as 'masked_reveal' | 'polygon_fill',
  maxColorRegions: 12,
  minColorRegionAreaRatio: 0.005,
  enforceSingleSubject: true,
  revealStrokeCount: 60,
  regionColors: 8,
  posterizeColors: 8,
  /** Detailed style: more posterize buckets and fill regions. */
  detailedMaxColorRegions: 16,
  detailedPosterizeColors: 10,
  /** Morphological dilation applied to region masks before clip (px). */
  maskDilatePx: 2,
  /** Final subject-coverage pass after per-region fills. */
  enableGapFillPass: true,
  /** Max Wanx re-generations after the first reference (unified retry only). */
  maxWanxRetries: 0,
  /** Demo fast path: 128px posterize + boundary-only analysis before first stroke. */
  fastSketchMode: true,
  /** Hard cap for fast-mode prep analysis (ms); fall back to contour extract on timeout. */
  fastAnalysisMaxMs: 2000,
  /** Analysis workspace size when fastSketchMode is on. */
  fastWorkspacePx: 384,
  /** Hard cap for full-quality prep analysis; fall back to contour extract on timeout. */
  analysisMaxMs: 2000,
  /** Minimum pen strokes before sketch is considered usable. */
  minSketchStrokes: 15,
  /** Target stroke count — supplement with Sobel edges when below. */
  minSketchStrokesTarget: 15,
  /** Min fraction of subject bbox covered by stroke bboxes. */
  minSubjectBboxCoverage: 0.25,
  /** Re-extract at higher resolution when boundary strokes are sparse. */
  sketchFailureFallback: 're_extract' as 're_extract',
  /** Horizontal bands for gap-fill touch-up (subtle, not full paint). */
  gapFillBandCount: 4,
  gapFillDurationMs: 1500,
  /** @deprecated Use gapFillBandCount */
  gapFillBands: 4,
  /** @deprecated Use gapFillDurationMs / gapFillBandCount */
  gapFillMsPerBand: 375,
  finalRevealBands: 16,
  finalRevealMsPerBand: 200,
  alwaysFinalBandReveal: false,
  /** Skip legacy gap fill when dilated region fills cover this fraction of subject. */
  gapFillSkipCoverage: 0.92,
  /** Default Wanx model id (fast path). */
  wanxModelFast: 'wanx2.1-t2i-turbo',
  /** Wanx model for fine-detail (plus) when user requests 精细/高清. */
  wanxModelFine: 'wanx2.1-t2i-plus',
  /** @deprecated Use wanxModelFast */
  wanxFastModel: 'wanx2.1-t2i-turbo',
  /** Pixel workspace for all stroke/fill analysis (never full-res on main thread). */
  analysisWorkspacePx: 384,
  /** Hi-res re-extraction when semantic boundaries are sparse. */
  hiResWorkspacePx: 512,
  /** Re-run boundary extraction when stroke count falls below this. */
  sparseStrokeThreshold: 15,
  /** Larger workspace for detailed_illustration analysis. */
  detailedIllustrationWorkspacePx: 384,
  /** Fast Wanx output size when fineDetail is off (backend may override). */
  wanxFastSize: '768*768',
  /** Demo recording path: enabled when fineDetail checkbox is off. */
  demoFastMode: true,
  /** Hard abort for prep analysis — fall back to minimal contour sketch. */
  prepHardTimeoutMs: 3000,
  /** Demo prep budget (ms) — edge-only 256px workspace. */
  demoPrepBudgetMs: 800,
  /** Demo sketch stroke cap + per-path animation budget. */
  demoMaxSketchPaths: 25,
  demoSketchPathDelayMs: 80,
  /** Demo color region cap + fade timing. */
  demoMaxColorRegions: 4,
  demoColorFadeMs: 300,
  demoColorStaggerMs: 300,
  /** Analysis workspace for demo prep (edge trace only, no ImageTracer). */
  demoWorkspacePx: 256,
  /** Wanx size hint for demo (backend may override). */
  wanxSizeDemo: '768*768',
  /** Max decoded reference dimension before fitting to canvas (avoids 4MB canvases). */
  gateCanvasMaxPx: 1024,
  /** Per-region color fade duration (ms). */
  colorRegionFadeMs: 700,
  /** Stagger between region color animation starts (ms). */
  colorRegionStaggerMs: 150,
  /** Max fill regions shown in color animation (tiny regions merged). */
  maxAnimatedColorRegions: 8,
  /** Max opacity for gap-fill touch-up (subtle, not full repaint). */
  gapFillMaxOpacity: 0.3,
  /** Skip Wanx retry when first reference already passes quality gate. */
  skipRetryIfFirstImageOk: true,
  /** Max prep time before first sketch stroke (ms). */
  prepBudgetMs: 5000,
  /** Image-adaptive sketch: detect flat vs grayscale vs color before tracing. */
  adaptiveSketch: true,
  /** Max pen strokes in sketch phase (contour + edge paths). */
  maxSketchStrokes: 40,
  maxOutlineStrokes: 40,
  maxFillRegions: 12,
  sketchStrokeWidth: 1.2,
  sketchPathMinLengthPx: 20,
  maxGrayscaleSketchStrokes: 50,
  maxGrayscaleInternalLines: 50,
  /** Skip or reject fill regions larger than this fraction of canvas area. */
  maxRegionFillAreaRatio: 0.40,
  boundaryRdpEpsilon: 2.0,
  /** Minimum fill region area as fraction of canvas (semantic color fills). */
  minRegionAreaRatio: 0.005,
  /** Merge tiny noise patches below this fraction into nearest same-hue cluster. */
  smallPatchMergeRatio: 0.005,
  /** LAB ΔE threshold for merging similar palette colors (sketch boundaries only). */
  colorMergeDeltaE: 12,
  minPathLengthPx: 6,
  /** Never drop paths at or above this length during min-length filtering. */
  protectMinPathLengthPx: 50,
  /** Relaxed min length when quality floor triggers (raw≥80, final<50% raw). */
  qualityFloorMinLengthPx: 4,
  continuityGapPx: 25,
  /** Max merge sweeps per repairPathContinuity call. */
  continuityMaxPasses: 1,
  minFinalPaths: 30,
  /** @deprecated Use maxWanxRetries — kept for bitmap_trace fallback gate. */
  traceableRetry: true,
} as const

/** Demo-fast prep when fineDetail is off and demoFastMode is enabled. */
export function isDemoFastMode(fineDetail?: boolean): boolean {
  return PIPELINE_CONFIG.demoFastMode && fineDetail !== true
}

/** User-facing tunables — only these three matter for Wanx trace quality. */
export const TRACE_TUNING = {
  minPathLengthPx: PIPELINE_CONFIG.minPathLengthPx,
  minFinalPaths: PIPELINE_CONFIG.minFinalPaths,
  silhouetteKeepCount: 15,
} as const



/** Per-scenario vectorize + quality overrides (see TRACE_SCENARIOS). */

export interface TraceScenarioProfile {

  label: string

  rdpEpsilon: number

  /** Apply layeredPathFilter only when raw path count exceeds this. */

  layeredFilterMinRaw: number

  useEdgeTrace: boolean

  configOverrides: Partial<TraceConfig>

}



export const TRACE_SCENARIOS: Record<TraceScenario, TraceScenarioProfile> = {

  primitive: {

    label: 'primitive stroke',

    rdpEpsilon: 1.5,

    layeredFilterMinRaw: Infinity,

    useEdgeTrace: false,

    configOverrides: {},

  },

  icon_template: {

    label: 'icon/template SVG',

    rdpEpsilon: 1.2,

    layeredFilterMinRaw: Infinity,

    useEdgeTrace: false,

    configOverrides: { tracerPathOmit: 6 },

  },

  flat_illustration: {

    label: 'flat illustration',

    rdpEpsilon: 1.5,

    layeredFilterMinRaw: 200,

    useEdgeTrace: false,

    configOverrides: {

      binarizeThreshold: 175,

      tracerPathOmit: 8,

    },

  },

  complex_photo: {

    label: 'complex photo',

    rdpEpsilon: 1.5,

    layeredFilterMinRaw: Infinity,

    useEdgeTrace: true,

    configOverrides: {

      binarizeThreshold: 165,

      edgeThreshold: 0.11,

      tracerPathOmit: 8,

    },

  },

}



/** Internal config for layered filter (only when raw > 200). */

export interface TraceConfig {

  minPathLengthPx: number

  topNClosedContours: number

  closedContourAreaRatio: number

  closedContourGapPx: number

  detailConnectionDistancePx: number

  mergeOverlapThreshold: number

  edgeThreshold: number

  binarizeThreshold: number

  maxTraceDimension: number

  traceUpscale: number

  minPathPoints: number

  minComponentArea: number

  tracerPathOmit: number

  tracerLtres: number

  skeletonLongPathMinPx: number

  minFinalPathsVehicle: number

  photoDetectionRetry: boolean

}



export const DEFAULT_TRACE_CONFIG: TraceConfig = {

  minPathLengthPx: TRACE_TUNING.minPathLengthPx,

  topNClosedContours: TRACE_TUNING.silhouetteKeepCount,

  closedContourAreaRatio: 0.005,

  closedContourGapPx: 10,

  detailConnectionDistancePx: 14,

  mergeOverlapThreshold: 0.9,

  edgeThreshold: 0.14,

  binarizeThreshold: 175,

  maxTraceDimension: 768,

  traceUpscale: 1.5,

  minPathPoints: 3,

  minComponentArea: 16,

  tracerPathOmit: 4,

  tracerLtres: 0.8,

  skeletonLongPathMinPx: 40,

  minFinalPathsVehicle: 50,

  photoDetectionRetry: true,

}



const SUBJECT_OVERRIDES: Partial<Record<TraceSubject, Partial<TraceConfig>>> = {

  vehicle: {

    topNClosedContours: TRACE_TUNING.silhouetteKeepCount,

    closedContourAreaRatio: 0.004,

    detailConnectionDistancePx: 20,

    binarizeThreshold: 185,

    minFinalPathsVehicle: 50,

  },

  portrait: {

    topNClosedContours: TRACE_TUNING.silhouetteKeepCount,

    closedContourAreaRatio: 0.003,

    detailConnectionDistancePx: 12,

    binarizeThreshold: 165,

  },

  animal: {

    topNClosedContours: TRACE_TUNING.silhouetteKeepCount,

    closedContourAreaRatio: 0.005,

    detailConnectionDistancePx: 14,

  },

}



export function traceConfigForSubject(subject: TraceSubject = 'default'): TraceConfig {

  const overrides = SUBJECT_OVERRIDES[subject] ?? {}

  return { ...DEFAULT_TRACE_CONFIG, ...overrides }

}



export function detectTraceScenario(

  subject: TraceSubject,

  photographic: boolean,

): TraceScenario {

  if (photographic) return 'complex_photo'

  void subject

  return 'flat_illustration'

}



export function traceConfigForScenario(

  scenario: TraceScenario,

  subject: TraceSubject = 'default',

): TraceConfig {

  const profile = TRACE_SCENARIOS[scenario]

  const base = traceConfigForSubject(subject)

  return { ...base, ...profile.configOverrides }

}



export function scenarioProfile(scenario: TraceScenario): TraceScenarioProfile {

  return TRACE_SCENARIOS[scenario]

}

/** v3 sketch-then-color tunables — fast analysis + clean outlines + original-color fills. */
export const SKETCH_COLOR_CONFIG = {
  analysisMaxPx: 384,
  /** Fine-detail mode: higher-res analysis workspace. */
  analysisMaxPxFine: 512,
  posterizeColors: 8,
  posterizeColorsFine: 10,
  /** flat_then_reveal = flat median fills then optional fidelity overlay; clipped_original = Wanx pixels per region. */
  colorMode: 'flat_then_reveal' as 'clipped_original' | 'flat_median' | 'flat_then_reveal',
  /** Final full-image overlay opacity after flat fills (0 = disabled). */
  fidelityRevealOpacity: 0.25,
  /** Flat color region fade — faster than clipImage loads. */
  flatColorFadeMs: 250,
  flatColorStaggerMs: 40,
  maxOutlineStrokes: 45,
  maxOutlineStrokesFine: 55,
  outlineColor: 'auto' as 'auto' | string,
  strokeWidth: 1.5,
  colorFadeMs: 400,
  /** Disabled — semi-transparent overlay caused double-image ghosting. */
  colorFidelityBoost: 0,
  sketchMsPerStroke: 100,
  /** RDP simplify epsilon for outline paths (workspace px). */
  outlineRdpEpsilon: 1.5,
  /** Min LAB ΔE between adjacent regions to keep a boundary stroke. */
  minBoundaryDeltaE: 14,
  /** Path continuity merge gap (workspace px); 0 = disabled (prevents spurious diagonals). */
  continuityGapPx: 0,
  /** ImageTracer supplement: path length band at 384px workspace. */
  supplementMinLengthPx: 30,
  supplementMaxLengthPx: 120,
  supplementMaxPaths: 20,
  /** Drop open paths whose bbox diagonal exceeds this fraction of canvas. */
  maxBboxDiagonalRatio: 0.70,
} as const

/** Pipeline v4 — fast quantize analysis + strict sequential sketch-then-color. */
export const PIPELINE_V4 = {
  analysisPx: 448,
  analysisPxFine: 576,
  quantizeColors: 14,
  quantizeColorsFine: 22,
  /** Target clean outline strokes after filtering (default / fine). */
  maxOutlineStrokes: 70,
  maxOutlineStrokesFine: 110,
  maxFillRegions: 18,
  maxFillRegionsFine: 26,
  /** Min fill region area — 0.3% of canvas (keeps small detail patches). */
  minRegionAreaRatio: 0.003,
  /** Only keep boundaries between labels with ΔE ≥ this (lower = more internal edges). */
  minBoundaryDeltaE: 14,
  minBoundaryDeltaEFine: 10,
  outlineRdpEpsilon: 1.5,
  outlineRdpEpsilonFine: 1.2,
  sketchStrokeWidth: 1.5,
  sketchStrokeWidthFine: 1.2,
  sketchMsPerStroke: 100,
  fillFadeMs: 300,
  /** Flat median base layer opacity before per-region Wanx clip. */
  flatFillMaxOpacity: 0.85,
  preciseClipFadeMs: 400,
  /** Disabled — semi-transparent full-canvas Wanx overlay caused ghosting. */
  finalFidelityOpacity: 0,
  strictPhaseGate: true,
  /** ImageTracer detail supplement — merged after structure paths. */
  supplementMaxPaths: 30,
  supplementMaxPathsFine: 40,
  /** Min fraction of outline budget reserved for structure boundaries (rest = detail). */
  structurePathBudgetRatio: 0.62,
  /** Horizontal bands — min stroke bbox overlap before edge fallback kicks in. */
  outlineBandCoverageMin: 0.22,
  detailMinLengthPx: 15,
  detailMaxLengthPx: 200,
  /** Merge tiny regions into body when subject fill coverage falls below this. */
  subjectFillCoverageMin: 0.70,
  /** Hybrid: flat median base + per-region Wanx clipImage (no full-canvas ghost). */
  colorMode: 'precise_fill' as 'flat_median' | 'clipped_original' | 'precise_fill',
  /** Subject blob union threshold for silhouette (includes legs/tail). */
  subjectBlobMinRatio: 0.008,
  /** Luminance cutoff for silhouette fallback when quant mask is sparse. */
  silhouetteLuminanceThreshold: 200,
  /** Luminance for light head/neck pixels merged into silhouette union. */
  silhouetteLightHeadLuminance: 235,
  /** Fraction of short horizontal runs that marks hatch-heavy Wanx output. */
  hatchHeavyRunRatio: 0.38,
  /** Min meaningful outline paths — below this triggers ImageTracer posterize fallback. */
  minMeaningfulOutlinePaths: 5,
  /** Outline-only mode: target min paths after filtering (default / fine). */
  outlineOnlyMinPaths: 20,
  outlineOnlyMinPathsFine: 40,
  /** Posterize bucket count for primary ImageTracer trace. */
  outlinePosterizeColors: 10,
  outlinePosterizeColorsFine: 14,
  /** Structure paths below this → prefer posterize-primary merge. */
  sparseStructureThreshold: 12,
  /** Disable Sobel edge band fallback (causes canvas-edge diagonals on flat art). */
  enableEdgeBandFallback: false,
  /** Detail supplement cap multiplier when hatch-heavy (0 = skip ImageTracer detail). */
  hatchHeavyDetailBudgetRatio: 0,
  /** Structure budget multiplier when hatch-heavy (prefer silhouette + major boundaries). */
  hatchHeavyStructureBudgetBoost: 1.12,
} as const

export interface PipelineV4Params {
  analysisPx: number
  quantizeColors: number
  maxOutlineStrokes: number
  maxFillRegions: number
  minRegionAreaRatio: number
  minBoundaryDeltaE: number
  outlineRdpEpsilon: number
  supplementMaxPaths: number
  strokeWidth: number
}

/** Resolve v4 caps from default vs fine-detail mode. */
export function pipelineV4Params(fineDetail?: boolean): PipelineV4Params {
  const fine = fineDetail === true
  return {
    analysisPx: fine ? PIPELINE_V4.analysisPxFine : PIPELINE_V4.analysisPx,
    quantizeColors: fine ? PIPELINE_V4.quantizeColorsFine : PIPELINE_V4.quantizeColors,
    maxOutlineStrokes: fine ? PIPELINE_V4.maxOutlineStrokesFine : PIPELINE_V4.maxOutlineStrokes,
    maxFillRegions: fine ? PIPELINE_V4.maxFillRegionsFine : PIPELINE_V4.maxFillRegions,
    minRegionAreaRatio: PIPELINE_V4.minRegionAreaRatio,
    minBoundaryDeltaE: fine ? PIPELINE_V4.minBoundaryDeltaEFine : PIPELINE_V4.minBoundaryDeltaE,
    outlineRdpEpsilon: fine ? PIPELINE_V4.outlineRdpEpsilonFine : PIPELINE_V4.outlineRdpEpsilon,
    supplementMaxPaths: fine ? PIPELINE_V4.supplementMaxPathsFine : PIPELINE_V4.supplementMaxPaths,
    strokeWidth: fine ? PIPELINE_V4.sketchStrokeWidthFine : PIPELINE_V4.sketchStrokeWidth,
  }
}


