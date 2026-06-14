/**
 * Pipeline v4 — 构思 → 分析 → 勾线（仅轮廓，不上色）
 *
 * 1. analyzeOutlinePlan() — posterize + ImageTracer 主路径 + 色块边界补充 + 轮廓校验
 * 2. drawOutlineOnly() — Phase A 黑线动画，无 fill / clipImage
 */
import type { CanvasShape } from '../types/commands'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../constants/canvas'
import { PIPELINE_V4, pipelineV4Params } from '../constants/traceConfig'
import { createShapeId } from './shapeFactory'
import {
  animatePathStroke,
  sleep,
  WANX_PATH_TENSION,
  type PathStrokeItem,
} from './strokeAnimator'
import { bboxFromFlat, computePathLength, isCanvasBorderArtifact } from './pathUtils'
import { sortStrokeItemsNatural } from './pathSorter'
import {
  extractOutlineOnlyPaths,
  prepareSketchPlan,
} from './regionVectorizer'
import {
  boundaryPathsToStrokeItems,
  scaleStrokeItemsToCanvas,
} from './sketchThenColor'
import { yieldToMain } from './analysisWorkspace'

export interface ImageFitRect {
  x: number
  y: number
  w: number
  h: number
}

export interface StrokeItem {
  flat: number[]
  closed: boolean
}

export interface DrawingPlan {
  imageFit: ImageFitRect
  imageDataUrl: string
  outlineStrokes: StrokeItem[]
  stats: { rawPaths: number; strokes: number; analyzeMs: number }
  outlineColor: string
  strokeWidth: number
}

export interface PhaseProgress {
  current: number
  total: number
}

export interface DrawPlanCallbacks {
  onSketchProgress?: (p: PhaseProgress) => void
  onInitStrokes: (shapes: CanvasShape[]) => void
  onStrokeUpdate: (index: number, shape: CanvasShape) => void
}

const INK_LINE_COLOR = '#000000'

/** Detect non-white content bbox on fitted gate canvas. */
export function detectImageFit(gateCanvas: HTMLCanvasElement): ImageFitRect {
  const w = gateCanvas.width
  const h = gateCanvas.height
  const ctx = gateCanvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  const step = 2

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3]
      if (a < 128) continue
      if (r > 248 && g > 248 && b > 248) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX <= minX || maxY <= minY) {
    return { x: 0, y: 0, w, h }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Pin silhouette (longest closed stroke) first, then nearest-neighbor from last endpoint. */
function sortOutlineStrokes(
  items: PathStrokeItem[],
  canvasW: number,
  canvasH: number,
): StrokeItem[] {
  if (items.length === 0) return []

  let silhouetteIdx = -1
  let maxLen = 0
  for (let i = 0; i < items.length; i++) {
    const len = computePathLength(items[i].flat)
    if (items[i].closed && len > maxLen) {
      maxLen = len
      silhouetteIdx = i
    }
  }

  let rest = items
  let silhouette: PathStrokeItem | null = null
  if (silhouetteIdx >= 0) {
    silhouette = items[silhouetteIdx]
    rest = items.filter((_, i) => i !== silhouetteIdx)
  }

  const sortedRest = sortStrokeItemsNatural(rest, canvasW, canvasH)
  const ordered = silhouette ? [silhouette, ...sortedRest] : sortedRest
  return ordered.map(({ flat, closed }) => ({ flat, closed }))
}

/** Drop diagonal glitches and canvas-edge artifacts only. */
function isDiagonalGlitch(
  flat: number[],
  closed: boolean,
  canvasW: number,
  canvasH: number,
): boolean {
  if (flat.length < 4) return true

  const len = computePathLength(flat)
  const bbox = bboxFromFlat(flat)
  const bw = bbox.maxX - bbox.minX
  const bh = bbox.maxY - bbox.minY

  if (closed && len > canvasW * 0.35) return false

  const vertGlitch = bh > canvasH * 0.25 && bw < canvasW * 0.05 && len > canvasH * 0.2
  if (vertGlitch) return true

  if (len > canvasW * 0.4 && bw > 2 && bh > 2) {
    let angleDeg = Math.abs(Math.atan2(bh, bw) * (180 / Math.PI))
    if (angleDeg > 90) angleDeg = 180 - angleDeg
    if (angleDeg >= 30 && angleDeg <= 60) return true
  }

  return false
}

function filterGlitchStrokes(
  items: PathStrokeItem[],
  canvasW: number,
  canvasH: number,
): PathStrokeItem[] {
  return items.filter((item) => {
    if (isCanvasBorderArtifact(item.flat, canvasW, canvasH)) return false
    return !isDiagonalGlitch(item.flat, item.closed, canvasW, canvasH)
  })
}

function strokeToCanvasShape(
  item: StrokeItem,
  lineColor: string,
  strokeWidth: number,
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
    opacity: 1,
    fill: undefined,
    fillOnly: false,
  }
}

/**
 * 分析阶段 — posterize + ImageTracer 主路径 + 色块边界 + 轮廓完整性校验。
 */
export async function analyzeOutlinePlan(
  gateCanvas: HTMLCanvasElement,
  imageUrl?: string,
  fineDetail?: boolean,
): Promise<DrawingPlan> {
  const t0 = performance.now()
  await yieldToMain()

  const params = pipelineV4Params(fineDetail)
  const imageFit = detectImageFit(gateCanvas)
  const imageDataUrl = imageUrl ?? gateCanvas.toDataURL('image/jpeg', 0.92)

  const plan = prepareSketchPlan(gateCanvas, {
    fineDetail,
    workspace: params.analysisPx,
    colors: params.quantizeColors,
    maxOutlineStrokes: params.maxOutlineStrokes,
    minBoundaryDeltaE: params.minBoundaryDeltaE,
    outlineRdpEpsilon: params.outlineRdpEpsilon,
    supplementMaxPaths: params.supplementMaxPaths,
    strictOutlines: true,
  })

  const rawPaths = extractOutlineOnlyPaths(plan)
  const wsStrokeItems = boundaryPathsToStrokeItems(
    rawPaths,
    plan.w,
    plan.h,
    rawPaths.length,
  )
  const scaledItems = scaleStrokeItemsToCanvas(wsStrokeItems, plan)
  const filteredItems = filterGlitchStrokes(scaledItems, CANVAS_WIDTH, CANVAS_HEIGHT)
  const outlineStrokes = sortOutlineStrokes(filteredItems, CANVAS_WIDTH, CANVAS_HEIGHT)

  const analyzeMs = performance.now() - t0

  console.log(
    `[pipeline-v4] analyze=${analyzeMs.toFixed(0)}ms`
    + ` workspace=${params.analysisPx}px quantizeColors=${params.quantizeColors}`
    + ` strokes=${outlineStrokes.length}/${params.maxOutlineStrokes}`
    + ` rawPaths=${rawPaths.length} filtered=${filteredItems.length}`
    + ` fit=${imageFit.w}x${imageFit.h}`
    + ` fine=${fineDetail === true}`,
  )

  return {
    imageFit,
    imageDataUrl,
    outlineStrokes,
    stats: {
      rawPaths: rawPaths.length,
      strokes: outlineStrokes.length,
      analyzeMs,
    },
    outlineColor: INK_LINE_COLOR,
    strokeWidth: params.strokeWidth,
  }
}

/** @deprecated Use analyzeOutlinePlan */
export const analyzeDrawingPlan = analyzeOutlinePlan

/** @deprecated Use analyzeOutlinePlan */
export const analyzeQuantizedImage = analyzeOutlinePlan

/**
 * Outline-only draw — black strokes animated sequentially, no fills.
 */
export async function drawOutlineOnly(
  plan: DrawingPlan,
  callbacks: DrawPlanCallbacks,
): Promise<{ sketched: number }> {
  const { outlineStrokes, outlineColor, strokeWidth } = plan
  const totalStrokes = outlineStrokes.length

  const strokeShapes = outlineStrokes.map((item) =>
    strokeToCanvasShape(item, outlineColor, strokeWidth),
  )
  callbacks.onInitStrokes(strokeShapes)
  console.log(`[pipeline-v4] sketch 0/${totalStrokes} (paths only)`)

  let sketched = 0
  for (let i = 0; i < totalStrokes; i++) {
    const item = outlineStrokes[i]
    const finalShape = await animatePathStroke(
      item.flat,
      outlineColor,
      item.closed,
      PIPELINE_V4.sketchMsPerStroke,
      (shape) => {
        if (shape) {
          callbacks.onStrokeUpdate(i, { ...shape, color: outlineColor, strokeWidth, fill: undefined })
        }
      },
      WANX_PATH_TENSION,
    )
    callbacks.onStrokeUpdate(i, { ...finalShape, color: outlineColor, strokeWidth, fill: undefined })
    sketched = i + 1
    callbacks.onSketchProgress?.({ current: sketched, total: totalStrokes })
    console.log(`[pipeline-v4] sketch ${sketched}/${totalStrokes}`)
    if (i < totalStrokes - 1) await sleep(20)
  }

  if (PIPELINE_V4.strictPhaseGate && sketched !== totalStrokes) {
    throw new Error(`勾线未完成: ${sketched}/${totalStrokes}`)
  }

  console.log(`[pipeline-v4] complete ${sketched}/${totalStrokes} strokes`)
  return { sketched }
}

/** @deprecated Use drawOutlineOnly */
export const drawFromPlan = drawOutlineOnly
