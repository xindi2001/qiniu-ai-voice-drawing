import type { VectorPath } from './pathSorter'
import { parsePathDAll } from './svgPathParser'
import { bboxFromFlat, pairsToFlat, type FlatBbox } from './pathUtils'
import { bboxOverlapRatio } from './pathDedup'

function vectorPathBbox(path: VectorPath): FlatBbox {
  const subpaths = parsePathDAll(path.d)
  const flat = pairsToFlat(subpaths.flatMap((sp) => sp.points))
  return bboxFromFlat(flat.length >= 4 ? flat : [path.minX, path.minY, path.minX, path.minY])
}

function pathCentroid(path: VectorPath): { x: number; y: number } {
  const b = vectorPathBbox(path)
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

function pathDirection(path: VectorPath): { angle: number; len: number } {
  const subpaths = parsePathDAll(path.d)
  const pts = subpaths[0]?.points ?? []
  if (pts.length < 2) return { angle: 0, len: 0 }
  const [x0, y0] = pts[0]
  const [x1, y1] = pts[pts.length - 1]
  const dx = x1 - x0
  const dy = y1 - y0
  return { angle: Math.atan2(dy, dx), len: Math.hypot(dx, dy) }
}

function normalizeAngle(a: number): number {
  let v = a
  while (v < 0) v += Math.PI
  while (v >= Math.PI) v -= Math.PI
  return v
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b))
  return Math.min(d, Math.PI - d)
}

/** Never drop main silhouette strokes during noise filtering. */
export const SILHOUETTE_PROTECT_COUNT = 15
export const SILHOUETTE_MIN_LENGTH = 100

/** Re-inject top-N longest paths removed by aggressive filters. */
export function protectSilhouettePaths(
  original: VectorPath[],
  filtered: VectorPath[],
  count = SILHOUETTE_PROTECT_COUNT,
): VectorPath[] {
  const protectedPaths = [...original].sort((a, b) => b.length - a.length).slice(0, count)
  const seen = new Set(filtered.map((p) => p.d))
  const result = [...filtered]
  for (const p of protectedPaths) {
    if (!seen.has(p.d)) {
      result.push(p)
      seen.add(p.d)
    }
  }
  return result
}

/** Remove parallel hatching strokes (similar angle, tight spacing, short length). */
export function filterShadingNoise(
  paths: VectorPath[],
  maxSpacing = 12,
  protectMinLen = SILHOUETTE_MIN_LENGTH,
): VectorPath[] {
  const sorted = [...paths].sort((a, b) => b.length - a.length)
  const kept: VectorPath[] = []

  for (const candidate of sorted) {
    if (candidate.length >= protectMinLen) {
      kept.push(candidate)
      continue
    }

    const dirC = pathDirection(candidate)
    if (dirC.len < 6) continue

    const cc = pathCentroid(candidate)
    let parallelNeighbor = 0

    for (const other of sorted) {
      if (other === candidate) continue
      if (other.length >= protectMinLen) continue
      const dirO = pathDirection(other)
      if (dirO.len < 6) continue
      if (angleDiff(dirC.angle, dirO.angle) > 0.18) continue

      const co = pathCentroid(other)
      const spacing = Math.hypot(cc.x - co.x, cc.y - co.y)
      if (spacing > 0 && spacing < maxSpacing) {
        parallelNeighbor++
        if (parallelNeighbor >= 3) break
      }
    }

    if (parallelNeighbor < 3) kept.push(candidate)
  }

  return kept
}

function isNearClosed(path: VectorPath, gapPx = 12): boolean {
  const subpaths = parsePathDAll(path.d)
  for (const sp of subpaths) {
    if (sp.points.length < 4) continue
    const [x0, y0] = sp.points[0]
    const [x1, y1] = sp.points[sp.points.length - 1]
    if (Math.hypot(x1 - x0, y1 - y0) <= gapPx || sp.closed) return true
  }
  return false
}

/** Remove short paths fully inside a large closed silhouette bbox. */
export function filterInteriorScribble(
  paths: VectorPath[],
  canvasW: number,
  canvasH: number,
  maxInteriorLen = 30,
): VectorPath[] {
  const canvasArea = canvasW * canvasH
  const silhouettes = paths
    .filter((p) => p.length >= 80 && isNearClosed(p))
    .map((p) => ({ path: p, bbox: vectorPathBbox(p), area: bboxArea(vectorPathBbox(p)) }))
    .filter((s) => s.area >= canvasArea * 0.04)
    .sort((a, b) => b.area - a.area)

  if (silhouettes.length === 0) return paths

  return paths.filter((p) => {
    if (p.length >= maxInteriorLen) return true
    const pb = vectorPathBbox(p)
    for (const sil of silhouettes) {
      if (p === sil.path) return true
      const overlap = bboxOverlapRatio(pb, sil.bbox)
      if (overlap >= 0.92 && sil.area > bboxArea(pb) * 2.5) return false
    }
    return true
  })
}

function bboxArea(b: { minX: number; minY: number; maxX: number; maxY: number }): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qy - py) * (rx - qx) - (qx - px) * (ry - qy)
  const o1 = orient(ax, ay, bx, by, cx, cy)
  const o2 = orient(ax, ay, bx, by, dx, dy)
  const o3 = orient(cx, cy, dx, dy, ax, ay)
  const o4 = orient(cx, cy, dx, dy, bx, by)
  if (o1 * o2 < 0 && o3 * o4 < 0) return true
  return false
}

function pathIntersectionCount(path: VectorPath, others: VectorPath[]): number {
  const subA = parsePathDAll(path.d)[0]
  if (!subA || subA.points.length < 2) return 0
  let count = 0

  for (const other of others) {
    if (other === path) continue
    const subB = parsePathDAll(other.d)[0]
    if (!subB || subB.points.length < 2) continue

    const bbA = bboxFromFlat(pairsToFlat(subA.points))
    const bbB = bboxFromFlat(pairsToFlat(subB.points))
    if (bboxOverlapRatio(bbA, bbB) < 0.05) continue

    outer:
    for (let i = 1; i < subA.points.length; i++) {
      const [ax, ay] = subA.points[i - 1]
      const [bx, by] = subA.points[i]
      for (let j = 1; j < subB.points.length; j++) {
        const [cx, cy] = subB.points[j - 1]
        const [dx, dy] = subB.points[j]
        if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) {
          count++
          break outer
        }
      }
    }
  }
  return count
}

/** Drop very short paths that cross many other strokes (chaotic scribble). */
export function filterCrossingNoise(
  paths: VectorPath[],
  maxLen = 12,
  maxIntersections = 5,
): VectorPath[] {
  return paths.filter((p) => {
    if (p.length >= SILHOUETTE_MIN_LENGTH) return true
    if (p.length >= maxLen) return true
    const crossings = pathIntersectionCount(p, paths)
    return crossings < maxIntersections
  })
}

export interface NoiseFilterStats {
  before: number
  afterShading: number
  afterScribble: number
  afterCrossing: number
  removed: number
}

export interface FilterTraceNoiseOptions {
  /** Skip all noise filters (exact dedup handled elsewhere). */
  skip?: boolean
}

/** Run all anti-mess filters in sequence; return stats for logging. */
export function filterTraceNoise(
  paths: VectorPath[],
  canvasW: number,
  canvasH: number,
  opts: FilterTraceNoiseOptions = {},
): { paths: VectorPath[]; stats: NoiseFilterStats } {
  const before = paths.length
  if (opts.skip) {
    return {
      paths,
      stats: {
        before,
        afterShading: before,
        afterScribble: before,
        afterCrossing: before,
        removed: 0,
      },
    }
  }

  let current = filterShadingNoise(paths)
  const afterShading = current.length
  current = filterInteriorScribble(current, canvasW, canvasH)
  const afterScribble = current.length
  current = filterCrossingNoise(current)
  const afterCrossing = current.length
  current = protectSilhouettePaths(paths, current)

  return {
    paths: current,
    stats: {
      before,
      afterShading,
      afterScribble,
      afterCrossing,
      removed: before - afterCrossing,
    },
  }
}

/** Keep circular / wheel-like closed contours (eyes, wheels). */
export function isCircularFeature(path: VectorPath): boolean {
  if (!isNearClosed(path, 18)) return false
  const b = vectorPathBbox(path)
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  if (w < 6 || h < 6) return false
  const aspect = Math.max(w, h) / Math.min(w, h)
  return aspect < 1.6 && path.length >= 18 && path.length <= 220
}
