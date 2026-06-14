import type { CanvasShape, DrawAction, PointPair } from '../types/commands'

import { createShapeId } from './shapeFactory'

import { computePathLength, bboxFromFlat } from './pathUtils'

import { parsePathDAll } from './svgPathParser'

import { CANVAS_WIDTH } from '../constants/canvas'

import { selectPathsWithSpatialCoverage } from './pathDedup'



export const DEFAULT_ANIMATE_MS = 1_300

export const PATH_DELAY_MS = 350

export const PATHS_DELAY_MS = 280

export const PATHS_MIN_MS = 1_200

export const TRACE_BASE_MS = 400

export const WANX_MIN_PATH_MS = 100
export const WANX_MAX_PATH_MS = 180
export const WANX_MIN_PATH_MS_FAST = 100
export const WANX_MIN_PATH_MS_BURST = 80
export const WANX_MIN_PATH_MS_FINE = 120

export const WANX_PATH_DELAY_MS = 120
export const WANX_PATH_DELAY_MS_FAST = 60

export const WANX_MIN_TOTAL_MS = 10_000
/** Target total animation budget for generate_and_trace (15–30s range). */
export const WANX_TRACE_BUDGET_MS = 25_000
export const WANX_TRACE_BUDGET_MS_FINE = 30_000

export const TRACE_BATCH_SIZE = 4
export const TRACE_BATCH_SIZE_FINE = 5

export const TRACE_TIMEOUT_MS = 120_000
export const TRACE_TIMEOUT_MS_FINE = 120_000

/** Two-phase draw: slow silhouette strokes, then faster detail. */
export const TWO_PHASE_SILHOUETTE_COUNT = 5
export const TWO_PHASE_SILHOUETTE_MS = 1_500

/** Fast-forward per-path duration when trace budget is exceeded — instant finish. */
export const FAST_FORWARD_PATH_MS = 0



export interface PathStrokeItem {

  flat: number[]

  closed: boolean

}



/** generate_and_trace always uses single-phase batch animation (never two-phase). */
export const WANX_TRACE_TWO_PHASE = false

/** Scale per-path duration so full trace finishes within budget (never drop paths for speed). */
export function computeWanxTraceDuration(pathCount: number, fineDetail = false): number {
  if (pathCount <= 0) return WANX_MIN_PATH_MS
  const budget = fineDetail ? WANX_TRACE_BUDGET_MS_FINE : WANX_TRACE_BUDGET_MS
  const perPath = budget / pathCount
  return Math.max(WANX_MIN_PATH_MS, Math.min(WANX_MAX_PATH_MS, perPath))
}

/** Concurrent batch size for generate_and_trace: min(8, max(3, pathCount/20)). */
export function computeWanxTraceBatchSize(pathCount: number): number {
  if (pathCount <= 0) return 3
  return Math.min(8, Math.max(3, Math.floor(pathCount / 20)))
}

/** Konva.Line tension for smooth Wanx traces. */
export const WANX_PATH_TENSION = 0.4
export const WANX_PATH_TENSION_FINE = 0.35



function lerp(a: number, b: number, t: number): number {

  return a + (b - a) * t

}



function easeOutCubic(t: number): number {

  return 1 - (1 - t) ** 3

}



export async function animateValue(

  durationMs: number,

  onFrame: (t: number) => void,

): Promise<void> {

  if (durationMs <= 0) {

    onFrame(1)

    return

  }

  const start = performance.now()

  return new Promise((resolve) => {

    const tick = (now: number) => {

      const raw = Math.min(1, (now - start) / durationMs)

      onFrame(easeOutCubic(raw))

      if (raw < 1) {

        requestAnimationFrame(tick)

      } else {

        resolve()

      }

    }

    requestAnimationFrame(tick)

  })

}



export function sleep(ms: number): Promise<void> {

  return new Promise((resolve) => setTimeout(resolve, ms))

}



/** Arc points from startAngle to endAngle (radians), Konva y-down coords. */

export function circleArcPoints(

  cx: number,

  cy: number,

  r: number,

  startAngle: number,

  endAngle: number,

  segments = 64,

): number[] {

  const points: number[] = []

  for (let i = 0; i <= segments; i++) {

    const t = i / segments

    const angle = lerp(startAngle, endAngle, t)

    points.push(cx + r * Math.cos(angle), cy + r * Math.sin(angle))

  }

  return points

}



/** Rect perimeter points up to progress 0..1 (four edges sequentially). */

export function rectEdgePoints(

  x: number,

  y: number,

  w: number,

  h: number,

  progress: number,

): number[] {

  const edges: [number, number, number, number][] = [

    [x, y, x + w, y],

    [x + w, y, x + w, y + h],

    [x + w, y + h, x, y + h],

    [x, y + h, x, y],

  ]

  const clamped = Math.max(0, Math.min(1, progress))

  const totalEdges = 4

  const edgeProgress = clamped * totalEdges

  const fullEdges = Math.floor(edgeProgress)

  const partial = edgeProgress - fullEdges



  const points: number[] = []

  for (let e = 0; e < fullEdges && e < totalEdges; e++) {

    const [x1, y1, x2, y2] = edges[e]

    if (points.length === 0) {

      points.push(x1, y1)

    }

    points.push(x2, y2)

  }

  if (fullEdges < totalEdges && partial > 0) {

    const [x1, y1, x2, y2] = edges[fullEdges]

    if (points.length === 0) {

      points.push(x1, y1)

    }

    points.push(lerp(x1, x2, partial), lerp(y1, y2, partial))

  }

  if (points.length < 4 && progress >= 1) {

    return [x, y, x + w, y, x + w, y + h, x, y + h, x, y]

  }

  return points

}



export function pointsToFlat(pairs: PointPair[]): number[] {

  return pairs.flat()

}



export function pathShapeFromFlat(

  flat: number[],

  color: string,

  closed = false,

  tension?: number,

): CanvasShape {

  const pathLength = computePathLength(flat)

  return {

    id: createShapeId(),

    type: 'path',

    color,

    x: 0,

    y: 0,

    points: flat,

    closed,

    pathLength,

    dashOffset: pathLength,

    tension,

  }

}



/** Animate circle with 0→360° arc sweep; filled circle unless strokeOnly. */

export async function animateCircleStroke(

  cx: number,

  cy: number,

  radius: number,

  color: string,

  durationMs: number,

  onUpdate: (shape: CanvasShape | null) => void,

  strokeOnly = false,

): Promise<CanvasShape> {

  const startAngle = -Math.PI / 2

  const animShape = pathShapeFromFlat(

    circleArcPoints(cx, cy, radius, startAngle, startAngle),

    color,

    false,

  )

  onUpdate(animShape)



  await animateValue(durationMs, (t) => {

    const endAngle = startAngle + t * Math.PI * 2

    animShape.points = circleArcPoints(cx, cy, radius, startAngle, endAngle)

    animShape.pathLength = computePathLength(animShape.points)

    animShape.dashOffset = lerp(animShape.pathLength, 0, t)

    onUpdate({ ...animShape })

  })



  if (strokeOnly) {

    const ringShape: CanvasShape = {

      id: animShape.id,

      type: 'circle',

      color,

      x: cx,

      y: cy,

      radius,

      strokeOnly: true,

    }

    onUpdate(ringShape)

    return ringShape

  }



  const finalShape: CanvasShape = {

    id: animShape.id,

    type: 'circle',

    color,

    x: cx,

    y: cy,

    radius,

  }

  onUpdate(finalShape)

  return finalShape

}



/** Animate rectangle as four sequential edges, then settle as filled rect. */

export async function animateRectStroke(

  x: number,

  y: number,

  width: number,

  height: number,

  color: string,

  durationMs: number,

  onUpdate: (shape: CanvasShape | null) => void,

): Promise<CanvasShape> {

  const animShape = pathShapeFromFlat(rectEdgePoints(x, y, width, height, 0), color, false)

  onUpdate(animShape)



  await animateValue(durationMs, (t) => {

    animShape.points = rectEdgePoints(x, y, width, height, t)

    animShape.pathLength = computePathLength(animShape.points)

    animShape.dashOffset = lerp(animShape.pathLength, 0, t)

    onUpdate({ ...animShape })

  })



  const finalShape: CanvasShape = {

    id: animShape.id,

    type: 'rect',

    color,

    x,

    y,

    width,

    height,

  }

  onUpdate(finalShape)

  return finalShape

}



/** Animate line from point A to B. */

export async function animateLineStroke(

  x1: number,

  y1: number,

  x2: number,

  y2: number,

  color: string,

  durationMs: number,

  onUpdate: (shape: CanvasShape | null) => void,

): Promise<CanvasShape> {

  const animShape: CanvasShape = {

    id: createShapeId(),

    type: 'line',

    color,

    x: x1,

    y: y1,

    x2: x1,

    y2: y1,

  }

  onUpdate(animShape)



  await animateValue(durationMs, (t) => {

    animShape.x2 = lerp(x1, x2, t)

    animShape.y2 = lerp(y1, y2, t)

    onUpdate({ ...animShape })

  })



  animShape.x2 = x2

  animShape.y2 = y2

  onUpdate(animShape)

  return animShape

}



/** Animate polyline/path with dashOffset pen effect. Each flat array is ONE independent stroke. */
export async function animatePathStroke(

  flat: number[],

  color: string,

  closed: boolean,

  durationMs: number,

  onUpdate: (shape: CanvasShape | null) => void,

  tension?: number,

): Promise<CanvasShape> {

  const pathLength = computePathLength(flat)

  const animShape: CanvasShape = {

    id: createShapeId(),

    type: 'path',

    color,

    x: 0,

    y: 0,

    points: flat,

    closed,

    pathLength,

    dashOffset: pathLength,

    tension,

  }

  onUpdate(animShape)



  await animateValue(durationMs, (t) => {

    animShape.dashOffset = lerp(pathLength, 0, t)

    onUpdate({ ...animShape })

  })



  animShape.dashOffset = undefined

  animShape.pathLength = undefined

  onUpdate(animShape)

  return animShape

}



/**

 * Animate paths one-by-one (legacy sequential mode).

 */

export async function animatePathsSequential(

  items: PathStrokeItem[],

  color: string,

  durationMs: number,

  onShapeUpdate: (index: number, shape: CanvasShape) => void,

  onProgress?: (completed: number, total: number) => void,

  shouldAbort?: () => boolean,

  pathDelayMs = PATH_DELAY_MS,

  onFastForward?: () => void,

): Promise<number> {

  if (items.length === 0) return 0



  let fastForward = false

  let completed = 0



  for (let i = 0; i < items.length; i++) {

    if (shouldAbort?.() && !fastForward) {

      fastForward = true

      onFastForward?.()

    }



    const item = items[i]

    const perPathMs = fastForward

      ? FAST_FORWARD_PATH_MS

      : Math.max(durationMs, WANX_MIN_PATH_MS)

    const finalShape = await animatePathStroke(

      item.flat,

      color,

      item.closed,

      perPathMs,

      (shape) => {

        if (shape) onShapeUpdate(i, shape)

      },

    )

    onShapeUpdate(i, finalShape)

    completed = i + 1

    onProgress?.(completed, items.length)



    if (i < items.length - 1) {

      await sleep(fastForward ? Math.min(40, pathDelayMs * 0.3) : pathDelayMs)

    }

  }



  return completed

}



/** Final path shape with dash animation cleared — used for timeout fast-forward. */
function finalizedPathShape(
  flat: number[],
  color: string,
  closed: boolean,
  tension?: number,
): CanvasShape {
  const shape = pathShapeFromFlat(flat, color, closed, tension)
  shape.dashOffset = undefined
  shape.pathLength = undefined
  return shape
}

/** Complex subjects: phase 1 draws longest N strokes slowly; phase 2 draws rest faster. */
export async function animatePathsTwoPhase(
  items: PathStrokeItem[],
  color: string,
  detailDurationMs: number,
  silhouetteCount: number,
  silhouetteMs: number,
  onShapeUpdate: (index: number, shape: CanvasShape) => void,
  onProgress?: (completed: number, total: number) => void,
  shouldAbort?: () => boolean,
  pathDelayMs = WANX_PATH_DELAY_MS,
  tension?: number,
  onFastForward?: () => void,
): Promise<number> {
  if (items.length === 0) return 0

  const candidates = items.map((item, index) => {
    const bbox = bboxFromFlat(item.flat)
    return {
      item,
      index,
      length: computePathLength(item.flat),
      centroidX: (bbox.minX + bbox.maxX) / 2,
    }
  })
  const silhouetteN = Math.min(silhouetteCount, candidates.length)
  const phase1Picked = selectPathsWithSpatialCoverage(candidates, silhouetteN, CANVAS_WIDTH)
  const phase1IndexSet = new Set(phase1Picked.map((p) => p.index))
  const phase1 = phase1Picked.map((p) => ({ item: p.item, index: p.index }))
  const phase2 = candidates
    .filter((p) => !phase1IndexSet.has(p.index))
    .map((p) => ({ item: p.item, index: p.index }))

  let fastForward = false
  let completed = 0

  const animateOne = async (
    item: PathStrokeItem,
    index: number,
    duration: number,
    delayAfter: number,
  ): Promise<void> => {
    if (shouldAbort?.() && !fastForward) {
      fastForward = true
      onFastForward?.()
    }
    if (fastForward) {
      onShapeUpdate(index, finalizedPathShape(item.flat, color, item.closed, tension))
      completed++
      onProgress?.(completed, items.length)
      return
    }
    const finalShape = await animatePathStroke(
      item.flat, color, item.closed, duration,
      (shape) => { if (shape) onShapeUpdate(index, shape) },
      tension,
    )
    onShapeUpdate(index, finalShape)
    completed++
    onProgress?.(completed, items.length)
    if (completed < items.length) {
      await sleep(delayAfter)
    }
  }

  for (const { item, index } of phase1) {
    await animateOne(item, index, silhouetteMs, pathDelayMs)
  }

  const fastMs = Math.max(detailDurationMs, WANX_MIN_PATH_MS_FAST)
  for (const { item, index } of phase2) {
    await animateOne(item, index, fastMs, Math.max(80, pathDelayMs * 0.6))
  }

  return completed
}



/** Animate paths in small concurrent batches (Wanx trace — 2 paths per batch). */

export async function animatePathsBatch(

  items: PathStrokeItem[],

  color: string,

  durationMs: number,

  batchSize: number,

  onShapeUpdate: (index: number, shape: CanvasShape) => void,

  onProgress?: (completed: number, total: number) => void,

  shouldAbort?: () => boolean,

  batchDelayMs = WANX_PATH_DELAY_MS,

  tension?: number,

  onFastForward?: () => void,

): Promise<number> {

  if (items.length === 0) return 0



  let fastForward = false

  let completed = 0



  for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {

    if (shouldAbort?.() && !fastForward) {
      fastForward = true
      onFastForward?.()
    }

    const batch = items.slice(batchStart, batchStart + batchSize)
    const perPathMs = fastForward
      ? FAST_FORWARD_PATH_MS
      : (durationMs > 0 ? durationMs : WANX_MIN_PATH_MS_BURST)

    await Promise.all(
      batch.map(async (item, batchIdx) => {
        const idx = batchStart + batchIdx
        if (fastForward) {
          const shape = finalizedPathShape(item.flat, color, item.closed, tension)
          onShapeUpdate(idx, shape)
          return
        }
        const finalShape = await animatePathStroke(
          item.flat,
          color,
          item.closed,
          perPathMs,
          (shape) => {
            if (shape) onShapeUpdate(idx, shape)
          },
          tension,
        )
        onShapeUpdate(idx, finalShape)
      }),
    )



    completed = Math.min(batchStart + batch.length, items.length)

    onProgress?.(completed, items.length)



    if (batchStart + batchSize < items.length) {
      await sleep(fastForward ? 0 : batchDelayMs)
    }

  }

  if (completed !== items.length) {
    console.warn(`[strokeAnimator] batch incomplete: ${completed}/${items.length}`)
  }

  return completed

}



/** Resolve draw_stroke / draw action into stroke animation. */

export async function animateDrawStrokeAction(

  action: DrawAction,

  onUpdate: (shape: CanvasShape | null) => void,

): Promise<CanvasShape | null> {

  const duration = action.animateMs ?? DEFAULT_ANIMATE_MS

  const color = action.color ?? '#6366f1'



  if (action.paths && action.paths.length > 0) {

    let last: CanvasShape | null = null

    const ox = action.x ?? 0

    const oy = action.y ?? 0

    for (const d of action.paths) {

      for (const parsed of parsePathDAll(d)) {

        const flat = parsed.points.flatMap(([px, py]) => [px + ox, py + oy])

        if (flat.length < 4) continue

        last = await animatePathStroke(flat, color, parsed.closed, duration, onUpdate)

        await sleep(PATH_DELAY_MS)

      }

    }

    return last

  }



  if (action.points && action.points.length >= 2) {

    return animatePathStroke(

      pointsToFlat(action.points),

      color,

      action.closed ?? false,

      duration,

      onUpdate,

    )

  }



  if (!action.shape) return null



  switch (action.shape) {

    case 'circle':

      return animateCircleStroke(

        action.x ?? 300,

        action.y ?? 200,

        action.radius ?? 50,

        color,

        duration,

        onUpdate,

        action.strokeOnly === true,

      )

    case 'rect':

      return animateRectStroke(

        action.x ?? 250,

        action.y ?? 150,

        action.width ?? 120,

        action.height ?? 80,

        color,

        duration,

        onUpdate,

      )

    case 'line':

      return animateLineStroke(

        action.x1 ?? 100,

        action.y1 ?? 100,

        action.x2 ?? 400,

        action.y2 ?? 300,

        color,

        duration,

        onUpdate,

      )

    default:

      return null

  }

}

