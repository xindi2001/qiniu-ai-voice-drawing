import type { TraceConfig } from '../constants/traceConfig'
import { parsePathDAll } from './svgPathParser'
import { pairsToFlat, bboxFromFlat } from './pathUtils'
import type { VectorPath } from './pathSorter'

export interface LayeredFilterResult {
  skeleton: VectorPath[]
  details: VectorPath[]
  final: VectorPath[]
  droppedIsolated: number
}

interface ScoredContour {
  path: VectorPath
  areaRatio: number
  perimeter: number
  closed: boolean
}

function pathEndpoints(path: VectorPath): { start: [number, number]; end: [number, number] } {
  const subpaths = parsePathDAll(path.d)
  if (subpaths.length === 0 || subpaths[0].points.length === 0) {
    return { start: [path.minX, path.minY], end: [path.minX, path.minY] }
  }
  const pts = subpaths[0].points
  const [sx, sy] = pts[0]
  const [ex, ey] = pts[pts.length - 1]
  return { start: [sx, sy], end: [ex, ey] }
}

function isNearClosed(path: VectorPath, config: TraceConfig): boolean {
  const subpaths = parsePathDAll(path.d)
  if (subpaths.length === 0) return false
  const sp = subpaths[0]
  if (sp.closed) return true
  if (sp.points.length < 3) return false
  const [sx, sy] = sp.points[0]
  const [ex, ey] = sp.points[sp.points.length - 1]
  return Math.hypot(ex - sx, ey - sy) <= config.closedContourGapPx
}

function bboxAreaRatio(path: VectorPath, canvasW: number, canvasH: number): number {
  const flat = pairsToFlat(parsePathDAll(path.d).flatMap((sp) => sp.points))
  if (flat.length < 4) return 0
  const bbox = bboxFromFlat(flat)
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  return (w * h) / (canvasW * canvasH)
}

/** Principle 3.1 — TopN near-close contours PLUS all long paths as skeleton candidates. */
export function extractTopNClosedContours(
  path: VectorPath[],
  canvasW: number,
  canvasH: number,
  config: TraceConfig,
): VectorPath[] {
  const scored: ScoredContour[] = []

  for (const p of path) {
    if (!isNearClosed(p, config)) continue
    const areaRatio = bboxAreaRatio(p, canvasW, canvasH)
    if (areaRatio < config.closedContourAreaRatio) continue
    scored.push({
      path: p,
      areaRatio,
      perimeter: p.length,
      closed: true,
    })
  }

  scored.sort((a, b) => b.perimeter - a.perimeter || b.areaRatio - a.areaRatio)
  const topN = scored.slice(0, config.topNClosedContours).map((s) => s.path)

  const longPaths = path.filter((p) => p.length >= config.skeletonLongPathMinPx)
  const seen = new Set<string>()
  const merged: VectorPath[] = []
  for (const p of [...topN, ...longPaths]) {
    if (seen.has(p.d)) continue
    seen.add(p.d)
    merged.push(p)
  }
  return merged
}

function minDistToPath(point: [number, number], skeleton: VectorPath): number {
  const flat = pairsToFlat(parsePathDAll(skeleton.d).flatMap((sp) => sp.points))
  let min = Infinity
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const d = Math.hypot(point[0] - flat[i], point[1] - flat[i + 1])
    if (d < min) min = d
  }
  return min
}

function isConnectedToSkeleton(
  path: VectorPath,
  skeleton: VectorPath[],
  config: TraceConfig,
): boolean {
  if (skeleton.length === 0) return false
  const { start, end } = pathEndpoints(path)
  for (const sk of skeleton) {
    const ds = minDistToPath(start, sk)
    const de = minDistToPath(end, sk)
    if (ds <= config.detailConnectionDistancePx || de <= config.detailConnectionDistancePx) {
      return true
    }
  }
  return false
}

/** Principle 3.2 — keep short strokes attached to skeleton as detail. */
export function filterDetailPathsConnectedToSkeleton(
  candidates: VectorPath[],
  skeleton: VectorPath[],
  config: TraceConfig,
): VectorPath[] {
  return candidates.filter((p) => isConnectedToSkeleton(p, skeleton, config))
}

/** Principle 3.3 — drop isolated strokes shorter than minPathLengthPx. */
export function filterIsolatedShortPaths(
  path: VectorPath[],
  minLengthPx: number,
  skeleton: VectorPath[],
  config: TraceConfig,
): { kept: VectorPath[]; dropped: number } {
  let dropped = 0
  const kept: VectorPath[] = []
  for (const p of path) {
    if (p.length >= minLengthPx) {
      kept.push(p)
      continue
    }
    if (isConnectedToSkeleton(p, skeleton, config)) {
      kept.push(p)
      continue
    }
    dropped++
  }
  return { kept, dropped }
}

/** Full layered filter: skeleton → details → drop isolated short. */
export function applyLayeredPathFilter(
  rawPaths: VectorPath[],
  canvasW: number,
  canvasH: number,
  config: TraceConfig,
): LayeredFilterResult {
  const skeleton = extractTopNClosedContours(rawPaths, canvasW, canvasH, config)
  const skeletonKeys = new Set(skeleton.map((p) => p.d))

  const nonSkeleton = rawPaths.filter((p) => !skeletonKeys.has(p.d))
  const maxSkeletonLen = skeleton.reduce((m, s) => Math.max(m, s.length), 0)
  const detailCandidates = nonSkeleton.filter((p) =>
    p.length < maxSkeletonLen * 0.65 || !isNearClosed(p, config),
  )

  const details = filterDetailPathsConnectedToSkeleton(detailCandidates, skeleton, config)
  const detailKeys = new Set(details.map((p) => p.d))

  const remainder = nonSkeleton.filter((p) => !detailKeys.has(p.d) && p.length >= config.minPathLengthPx)
  const merged = [...skeleton, ...details, ...remainder]
  const { kept, dropped } = filterIsolatedShortPaths(merged, config.minPathLengthPx, skeleton, config)

  return {
    skeleton,
    details,
    final: kept,
    droppedIsolated: dropped,
  }
}
