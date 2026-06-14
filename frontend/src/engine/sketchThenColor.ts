import type { CanvasShape } from '../types/commands'
import type { VectorPath } from './pathSorter'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../constants/canvas'
import { SKETCH_COLOR_CONFIG } from '../constants/traceConfig'
import { createShapeId } from './shapeFactory'
import {
  animatePathStroke,
  animateValue,
  sleep,
  WANX_PATH_TENSION,
  type PathStrokeItem,
} from './strokeAnimator'
import { parsePathDAll } from './svgPathParser'
import { pairsToFlat, computePathLength } from './pathUtils'
import { sortStrokeItemsNatural } from './pathSorter'
import {
  extractCleanOutline,
  prepareSketchPlan,
  sampleColorsFromOriginal,
  scaleColorRegionsToCanvas,
  type ColorRegion,
  type SketchPlan,
} from './regionVectorizer'

export const SKETCH_LINE_COLOR = '#2a2a2a'
export const SKETCH_STROKE_WIDTH = SKETCH_COLOR_CONFIG.strokeWidth
export const COLOR_FADE_MS = SKETCH_COLOR_CONFIG.colorFadeMs
export const SKETCH_PATH_DELAY_MS = 80

export interface SketchProgress {
  current: number
  total: number
}

export interface RegionFillShape {
  id: string
  flat: number[]
  fillColor: string
  area: number
  /** Full fitted gate canvas — reused for every clip region. */
  revealImageSrc?: string
  maskedReveal?: boolean
  clipImage?: boolean
}

export interface SketchPipelineResult {
  plan: SketchPlan
  outlinePaths: VectorPath[]
  strokeItems: PathStrokeItem[]
  fillRegions: RegionFillShape[]
  /** Optional full-canvas fidelity overlay for flat_then_reveal end phase. */
  fidelityOverlay?: RegionFillShape
  outlineColor: string
  strokeWidth: number
  analyzeMs: number
  imageDataUrl: string
}

function resolveOutlineColor(plan: SketchPlan): string {
  if (SKETCH_COLOR_CONFIG.outlineColor === 'auto') {
    return plan.outlineColor
  }
  return SKETCH_COLOR_CONFIG.outlineColor
}

function gateCanvasDataUrl(sourceCanvas: HTMLCanvasElement, override?: string): string {
  return override ?? sourceCanvas.toDataURL('image/jpeg', 0.92)
}

/** Konva clipImage fills — background (largest) first, then subject regions. */
export function buildClippedImageFills(
  plan: SketchPlan,
  regions: ColorRegion[],
  imageUrl: string,
  canvasW: number,
  canvasH: number,
): RegionFillShape[] {
  void canvasW
  void canvasH
  const scaledRegions = scaleColorRegionsToCanvas(regions, plan)
  return scaledRegions
    .slice()
    .sort((a, b) => b.area - a.area)
    .map((region) => ({
      id: createShapeId(),
      flat: region.points.flat(),
      fillColor: region.color,
      area: region.area,
      revealImageSrc: imageUrl,
      maskedReveal: true,
      clipImage: true,
    }))
}

/** Single full-canvas clip fade — guarantees complete color when region count is low. */
export function buildFullCanvasFallbackFill(
  imageUrl: string,
  canvasW: number,
  canvasH: number,
): RegionFillShape {
  return {
    id: createShapeId(),
    flat: [0, 0, canvasW, 0, canvasW, canvasH, 0, canvasH],
    fillColor: '#ffffff',
    area: canvasW * canvasH,
    revealImageSrc: imageUrl,
    maskedReveal: true,
    clipImage: true,
  }
}

/** v3: posterize + boundaries + region masks in one workspace pass (<500ms target). */
export function prepareSketchPipeline(
  sourceCanvas: HTMLCanvasElement,
  fineDetail = false,
  imageUrl?: string,
): SketchPipelineResult {
  const t0 = performance.now()
  const plan = prepareSketchPlan(sourceCanvas, {
    fineDetail,
    workspace: fineDetail
      ? SKETCH_COLOR_CONFIG.analysisMaxPxFine
      : SKETCH_COLOR_CONFIG.analysisMaxPx,
    colors: fineDetail
      ? SKETCH_COLOR_CONFIG.posterizeColorsFine
      : SKETCH_COLOR_CONFIG.posterizeColors,
  })

  const outlinePaths = extractCleanOutline(plan)
  const wsStrokeItems = boundaryPathsToStrokeItems(
    outlinePaths,
    plan.w,
    plan.h,
    plan.maxOutlineStrokes,
  )
  const strokeItems = scaleStrokeItemsToCanvas(wsStrokeItems, plan)

  console.log(
    `[pipeline] outlinePaths=${outlinePaths.length} → strokeItems=${strokeItems.length}`
    + ` (cap=${plan.maxOutlineStrokes})`,
  )

  const rawRegions = sampleColorsFromOriginal(plan, sourceCanvas)
  const imageDataUrl = gateCanvasDataUrl(sourceCanvas, imageUrl)
  const colorMode = SKETCH_COLOR_CONFIG.colorMode

  let fillRegions: RegionFillShape[]
  let fidelityOverlay: RegionFillShape | undefined

  if (colorMode === 'clipped_original') {
    fillRegions = buildClippedImageFills(
      plan, rawRegions, imageDataUrl, sourceCanvas.width, sourceCanvas.height,
    )
  } else {
    fillRegions = regionFillShapes(scaleColorRegionsToCanvas(rawRegions, plan))
    if (
      colorMode === 'flat_then_reveal'
      && SKETCH_COLOR_CONFIG.fidelityRevealOpacity > 0
    ) {
      fidelityOverlay = buildFullCanvasFallbackFill(
        imageDataUrl, sourceCanvas.width, sourceCanvas.height,
      )
    }
  }

  if (fillRegions.length < 3) {
    console.warn(
      `[pipeline] only ${fillRegions.length} fill regions — using full-canvas fallback`,
    )
    if (colorMode === 'clipped_original') {
      fillRegions = [buildFullCanvasFallbackFill(imageDataUrl, sourceCanvas.width, sourceCanvas.height)]
    }
  }

  const analyzeMs = performance.now() - t0
  const outlineColor = resolveOutlineColor(plan)

  console.log(
    `[pipeline] analyze=${analyzeMs.toFixed(0)}ms strokes=${strokeItems.length}`
    + ` fills=${fillRegions.length} outline=${outlineColor}`
    + ` colorMode=${colorMode}`
    + (fidelityOverlay ? ' +fidelityOverlay' : ''),
  )

  return {
    plan,
    outlinePaths,
    strokeItems,
    fillRegions,
    fidelityOverlay,
    outlineColor,
    strokeWidth: SKETCH_COLOR_CONFIG.strokeWidth,
    analyzeMs,
    imageDataUrl,
  }
}

/** Convert clean outline paths (workspace coords) to pen-stroke items. */
export function boundaryPathsToStrokeItems(
  paths: VectorPath[],
  canvasW: number,
  canvasH: number,
  maxStrokes: number = SKETCH_COLOR_CONFIG.maxOutlineStrokes,
): PathStrokeItem[] {
  const minLen = 8
  const strokeItems: PathStrokeItem[] = []

  for (const path of paths) {
    for (const sp of parsePathDAll(path.d)) {
      if (sp.points.length < 2) continue
      const flat = pairsToFlat(sp.points)
      if (computePathLength(flat) < minLen) continue
      strokeItems.push({ flat, closed: sp.closed })
    }
  }

  const sorted = sortStrokeItemsNatural(strokeItems, canvasW, canvasH)
  sorted.sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? -1 : 1
    return computePathLength(b.flat) - computePathLength(a.flat)
  })

  const capped = sorted.slice(0, maxStrokes)
  if (capped.length < sorted.length) {
    console.log(
      `[pipeline] boundaryPathsToStrokeItems: ${paths.length} paths → ${sorted.length} strokes`
      + ` → capped ${capped.length} (max=${maxStrokes})`,
    )
  }
  return capped
}

/** Scale workspace stroke flats to full canvas coordinates. */
export function scaleStrokeItemsToCanvas(
  items: PathStrokeItem[],
  plan: SketchPlan,
): PathStrokeItem[] {
  const { scaleX, scaleY, offsetX, offsetY } = plan
  return items.map((item) => ({
    ...item,
    flat: item.flat.map((v, i) => (i % 2 === 0 ? v * scaleX + offsetX : v * scaleY + offsetY)),
  }))
}

/** Build Konva-ready flat polygon fills — large regions first. */
export function regionFillShapes(regions: ColorRegion[]): RegionFillShape[] {
  return regions
    .slice()
    .sort((a, b) => b.area - a.area)
    .map((region) => ({
      id: createShapeId(),
      flat: region.points.flat(),
      fillColor: region.color,
      area: region.area,
    }))
}

export function fillShapeToCanvasShape(
  shape: RegionFillShape,
  opacity = 0,
): CanvasShape {
  if (
    shape.clipImage
    && shape.maskedReveal
    && shape.revealImageSrc
    && shape.flat.length >= 6
  ) {
    return {
      id: shape.id,
      type: 'clipImage',
      color: shape.fillColor,
      x: 0,
      y: 0,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      imageSrc: shape.revealImageSrc,
      revealImageSrc: shape.revealImageSrc,
      maskClipPoints: shape.flat,
      maskedReveal: true,
      opacity,
    }
  }

  if (shape.maskedReveal && shape.revealImageSrc && shape.flat.length >= 6) {
    return {
      id: shape.id,
      type: 'clipImage',
      color: shape.fillColor,
      x: 0,
      y: 0,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      imageSrc: shape.revealImageSrc,
      revealImageSrc: shape.revealImageSrc,
      maskClipPoints: shape.flat,
      maskedReveal: true,
      opacity,
    }
  }

  return {
    id: shape.id,
    type: 'path',
    color: shape.fillColor,
    fill: shape.fillColor,
    x: 0,
    y: 0,
    points: shape.flat,
    closed: true,
    opacity,
    strokeWidth: 0,
    fillOnly: true,
  }
}

export function strokeItemToCanvasShape(
  item: PathStrokeItem,
  lineColor = SKETCH_LINE_COLOR,
  strokeWidth: number = SKETCH_STROKE_WIDTH,
): CanvasShape {
  const pathLength = computePathLength(item.flat)
  return {
    id: createShapeId(),
    type: 'path',
    color: lineColor,
    x: 0,
    y: 0,
    points: item.flat,
    closed: item.closed,
    pathLength,
    dashOffset: pathLength,
    tension: WANX_PATH_TENSION,
    strokeWidth,
    opacity: 0.9,
  }
}

/** Phase 1: animate contour strokes one-by-one (pen drawing). */
export async function animateSketchPhase(
  strokeItems: PathStrokeItem[],
  onShapeUpdate: (index: number, shape: CanvasShape) => void,
  onProgress?: (progress: SketchProgress) => void,
  lineColor = SKETCH_LINE_COLOR,
  strokeWidth: number = SKETCH_STROKE_WIDTH,
): Promise<number> {
  console.log(`[pipeline] animateSketchPhase start: strokeItems=${strokeItems.length}`)
  if (strokeItems.length === 0) return 0

  const perPathMs = SKETCH_COLOR_CONFIG.sketchMsPerStroke
  let completed = 0

  for (let i = 0; i < strokeItems.length; i++) {
    const item = strokeItems[i]
    const finalShape = await animatePathStroke(
      item.flat,
      lineColor,
      item.closed,
      perPathMs,
      (shape) => {
        if (shape) {
          onShapeUpdate(i, { ...shape, color: lineColor, strokeWidth })
        }
      },
      WANX_PATH_TENSION,
    )
    onShapeUpdate(i, { ...finalShape, color: lineColor, strokeWidth })
    completed = i + 1
    onProgress?.({ current: completed, total: strokeItems.length })
    if (i < strokeItems.length - 1) {
      await sleep(SKETCH_PATH_DELAY_MS)
    }
  }

  if (completed !== strokeItems.length) {
    console.warn(
      `[pipeline] sketch phase incomplete: sketched=${completed}/${strokeItems.length}`,
    )
  } else {
    console.log(`[pipeline] sketch phase complete: sketched=${completed}/${strokeItems.length}`)
  }

  return completed
}

/** Phase 2: fade in each color region (flat hex or clipped Wanx pixels). */
export async function animateColorPhase(
  fillShapes: RegionFillShape[],
  onShapeUpdate: (index: number, shape: CanvasShape) => void,
  onProgress?: (progress: SketchProgress) => void,
  fadeMs = COLOR_FADE_MS,
): Promise<number> {
  if (fillShapes.length === 0) return 0

  const isFlat = SKETCH_COLOR_CONFIG.colorMode !== 'clipped_original'
  const perRegionMs = isFlat
    ? SKETCH_COLOR_CONFIG.flatColorFadeMs
    : fadeMs
  const staggerMs = isFlat
    ? SKETCH_COLOR_CONFIG.flatColorStaggerMs
    : 60

  let completed = 0
  onProgress?.({ current: 0, total: fillShapes.length })

  for (let i = 0; i < fillShapes.length; i++) {
    const base = fillShapeToCanvasShape(fillShapes[i], 0)
    onShapeUpdate(i, base)

    await animateValue(perRegionMs, (t) => {
      onShapeUpdate(i, { ...base, opacity: t })
    })

    onShapeUpdate(i, { ...base, opacity: 1 })
    completed = i + 1
    onProgress?.({ current: completed, total: fillShapes.length })

    if (i < fillShapes.length - 1) {
      await sleep(staggerMs)
    }
  }

  if (completed !== fillShapes.length) {
    console.warn(
      `[pipeline] color phase incomplete: filled=${completed}/${fillShapes.length}`,
    )
  } else {
    console.log(`[pipeline] color phase complete: filled=${completed}/${fillShapes.length}`)
  }

  return completed
}

/** Phase 2b: subtle full-image fidelity overlay after flat fills. */
export async function animateFidelityReveal(
  overlay: RegionFillShape,
  onShapeAdd: (shape: CanvasShape) => void,
  targetOpacity = SKETCH_COLOR_CONFIG.fidelityRevealOpacity,
  fadeMs = SKETCH_COLOR_CONFIG.flatColorFadeMs * 2,
): Promise<void> {
  if (targetOpacity <= 0) return

  const base = fillShapeToCanvasShape(overlay, 0)
  onShapeAdd(base)

  await animateValue(fadeMs, (t) => {
    onShapeAdd({ ...base, opacity: t * targetOpacity })
  })
  onShapeAdd({ ...base, opacity: targetOpacity })
  console.log(`[pipeline] fidelity reveal complete: opacity=${targetOpacity}`)
}
