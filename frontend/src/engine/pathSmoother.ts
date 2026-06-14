import type { PointPair } from '../types/commands'
import { deduplicatePaths } from './pathDedup'
import { computePathLength, flatToPairs, pairsToFlat, bboxFromFlat } from './pathUtils'
import type { VectorPath } from './pathSorter'
import { parsePathDAll } from './svgPathParser'

/** Perpendicular distance from point P to segment AB. */
function perpDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  const projX = ax + t * dx
  const projY = ay + t * dy
  return Math.hypot(px - projX, py - projY)
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function rdpSimplify(pairs: PointPair[], epsilon: number): PointPair[] {
  if (pairs.length <= 2) return pairs

  const first = pairs[0]
  const last = pairs[pairs.length - 1]
  let maxDist = 0
  let maxIdx = 0

  for (let i = 1; i < pairs.length - 1; i++) {
    const [px, py] = pairs[i]
    const d = perpDistance(px, py, first[0], first[1], last[0], last[1])
    if (d > maxDist) {
      maxDist = d
      maxIdx = i
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(pairs.slice(0, maxIdx + 1), epsilon)
    const right = rdpSimplify(pairs.slice(maxIdx), epsilon)
    return [...left.slice(0, -1), ...right]
  }
  return [first, last]
}

export function rdpSimplifyFlat(flat: number[], epsilon: number): number[] {
  return pairsToFlat(rdpSimplify(flatToPairs(flat), epsilon))
}

/** Angle in radians between segment directions at index i. */
function segmentAngle(pairs: PointPair[], i: number): number {
  if (i <= 0 || i >= pairs.length - 1) return 0
  const [x0, y0] = pairs[i - 1]
  const [x1, y1] = pairs[i]
  const [x2, y2] = pairs[i + 1]
  const a1 = Math.atan2(y1 - y0, x1 - x0)
  const a2 = Math.atan2(y2 - y1, x2 - x1)
  return Math.abs(a2 - a1)
}

function pathFromPairs(pairs: PointPair[]): VectorPath {
  const flat = pairsToFlat(pairs)
  const bbox = bboxFromFlat(flat)
  return {
    d: pairs.map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)).join(' '),
    minX: bbox.minX,
    minY: bbox.minY,
    length: computePathLength(flat),
  }
}

/** Merge consecutive path segments that are close and similarly directed. */
export function mergeNearbyPaths(paths: VectorPath[], maxGap = 6, maxAngleDiff = 0.35): VectorPath[] {
  if (paths.length <= 1) return paths

  const merged: VectorPath[] = []
  let current = parsePathDAll(paths[0].d)[0]?.points ?? []
  if (current.length < 2) return paths

  for (let i = 1; i < paths.length; i++) {
    const next = parsePathDAll(paths[i].d)[0]?.points ?? []
    if (next.length < 2) continue

    const [cx, cy] = current[current.length - 1]
    const [nx, ny] = next[0]
    const gap = Math.hypot(nx - cx, ny - cy)

    const curAngle = segmentAngle(current, current.length - 2)
    const nextAngle = segmentAngle(next, 1)
    const angleDiff = Math.abs(curAngle - nextAngle)

    if (gap <= maxGap && angleDiff <= maxAngleDiff && current.length >= 2 && next.length >= 2) {
      current = [...current, ...next.slice(1)]
    } else {
      merged.push(pathFromPairs(current))
      current = next
    }
  }
  merged.push(pathFromPairs(current))
  return merged
}

/** Detect hatching: many short, nearly-parallel segments clustered in a small bbox. */
export function isHatchingPath(path: VectorPath, canvasW: number, canvasH: number): boolean {
  const subpaths = parsePathDAll(path.d)
  for (const sp of subpaths) {
    if (sp.points.length < 2) continue
    const flat = pairsToFlat(sp.points)
    const len = computePathLength(flat)
    const bbox = bboxFromFlat(flat)
    const w = bbox.maxX - bbox.minX
    const h = bbox.maxY - bbox.minY
    const area = w * h
    const canvasArea = canvasW * canvasH

    // Short segment in a small region
    if (len < 45 && area < canvasArea * 0.008 && sp.points.length <= 4) {
      // Nearly horizontal or vertical hatch line
      const aspect = Math.max(w, h) / (Math.min(w, h) + 0.01)
      if (aspect > 4) return true
    }

    // Zigzag scribble: many points, low total length
    if (sp.points.length >= 6 && len < 35) return true
  }
  return false
}

export function filterHatchingPaths(
  paths: VectorPath[],
  canvasW: number,
  canvasH: number,
): VectorPath[] {
  return paths.filter((p) => !isHatchingPath(p, canvasW, canvasH))
}

const HORIZONTAL_ANGLE_TOL = (15 * Math.PI) / 180

/** True if segment direction is within 15° of horizontal (0° or 180°). */
function isNearHorizontalSegment(x0: number, y0: number, x1: number, y1: number): boolean {
  const angle = Math.abs(Math.atan2(y1 - y0, x1 - x0))
  return angle <= HORIZONTAL_ANGLE_TOL || Math.abs(angle - Math.PI) <= HORIZONTAL_ANGLE_TOL
}

/** Wide flat stroke spanning canvas — orphan scan-line / base-line artifact. */
export function isOrphanHorizontalLine(path: VectorPath, canvasW: number): boolean {
  const subpaths = parsePathDAll(path.d)
  for (const sp of subpaths) {
    if (sp.points.length < 2) continue
    const flat = pairsToFlat(sp.points)
    const bbox = bboxFromFlat(flat)
    const w = bbox.maxX - bbox.minX
    const h = bbox.maxY - bbox.minY
    if (w > canvasW * 0.35 && h < Math.max(6, w * 0.08) && path.length < w * 0.6) {
      return true
    }
  }
  return false
}

export function filterOrphanHorizontalLines(
  paths: VectorPath[],
  canvasW: number,
): VectorPath[] {
  return paths.filter((p) => !isOrphanHorizontalLine(p, canvasW))
}

/** Short nearly-vertical segment — interior hair hatch scribble. */
export function isVerticalHatchPath(path: VectorPath): boolean {
  const subpaths = parsePathDAll(path.d)
  for (const sp of subpaths) {
    if (sp.points.length < 2) continue
    const flat = pairsToFlat(sp.points)
    const bbox = bboxFromFlat(flat)
    const w = bbox.maxX - bbox.minX
    const h = bbox.maxY - bbox.minY
    if (h < 12 || w > 12 || path.length > 75) continue
    const [x0, y0] = sp.points[0]
    const [x1, y1] = sp.points[sp.points.length - 1]
    const angle = Math.abs(Math.atan2(y1 - y0, x1 - x0))
    if (Math.abs(angle - Math.PI / 2) < 0.4) return true
  }
  return false
}

export function filterPortraitHatchLines(paths: VectorPath[]): VectorPath[] {
  return paths.filter((p) => !isVerticalHatchPath(p) && !isHorizontalHatchPath(p))
}

/** Drop short paths where >60% of segments are nearly horizontal (zebra hatch). */
export function isHorizontalHatchPath(path: VectorPath): boolean {
  const subpaths = parsePathDAll(path.d)
  for (const sp of subpaths) {
    if (sp.points.length < 3) continue
    let horizontal = 0
    let total = 0
    for (let i = 1; i < sp.points.length; i++) {
      const [x0, y0] = sp.points[i - 1]
      const [x1, y1] = sp.points[i]
      const segLen = Math.hypot(x1 - x0, y1 - y0)
      if (segLen < 0.5) continue
      total++
      if (isNearHorizontalSegment(x0, y0, x1, y1)) horizontal++
    }
    if (total > 0 && horizontal / total > 0.6 && path.length < 40) return true
  }
  return false
}

/** Central 60% bbox of the union of all path bboxes. */
function centralBboxOfPaths(paths: VectorPath[]): FlatBbox | null {
  if (paths.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const path of paths) {
    const subpaths = parsePathDAll(path.d)
    for (const sp of subpaths) {
      if (sp.points.length < 2) continue
      const bbox = bboxFromFlat(pairsToFlat(sp.points))
      minX = Math.min(minX, bbox.minX)
      minY = Math.min(minY, bbox.minY)
      maxX = Math.max(maxX, bbox.maxX)
      maxY = Math.max(maxY, bbox.maxY)
    }
  }
  if (!Number.isFinite(minX)) return null
  const w = maxX - minX
  const h = maxY - minY
  const marginX = w * 0.2
  const marginY = h * 0.2
  return {
    minX: minX + marginX,
    minY: minY + marginY,
    maxX: maxX - marginX,
    maxY: maxY - marginY,
  }
}

type FlatBbox = { minX: number; minY: number; maxX: number; maxY: number }

/** Path bbox fully inside the central 60% region — likely interior hatch clutter. */
export function isInteriorClutterPath(path: VectorPath, central: FlatBbox): boolean {
  const subpaths = parsePathDAll(path.d)
  for (const sp of subpaths) {
    if (sp.points.length < 2) continue
    const bbox = bboxFromFlat(pairsToFlat(sp.points))
    if (
      bbox.minX >= central.minX
      && bbox.maxX <= central.maxX
      && bbox.minY >= central.minY
      && bbox.maxY <= central.maxY
      && path.length < 80
    ) {
      return true
    }
  }
  return false
}

export function filterAggressiveHatching(paths: VectorPath[]): VectorPath[] {
  const central = centralBboxOfPaths(paths)
  return paths.filter((p) => {
    if (isHorizontalHatchPath(p)) return false
    if (central && isInteriorClutterPath(p, central)) return false
    return true
  })
}

export interface SmoothPathOptions {
  rdpEpsilon?: number
  mergeGap?: number
  canvasW?: number
  canvasH?: number
  dropHatching?: boolean
  aggressiveHatchFilter?: boolean
  skipDedup?: boolean
  dedupOverlap?: number
}

const DEFAULT_RDP = 1.8
const DEFAULT_RDP_FINE = 1.2

/** Full post-trace path cleanup: RDP simplify, optional merge, hatching filter. */
export function smoothVectorPaths(
  paths: VectorPath[],
  fineDetail = false,
  opts: SmoothPathOptions = {},
): VectorPath[] {
  const epsilon = opts.rdpEpsilon ?? (fineDetail ? DEFAULT_RDP_FINE : DEFAULT_RDP)
  const canvasW = opts.canvasW ?? 600
  const canvasH = opts.canvasH ?? 400
  const dropHatching = opts.dropHatching !== false
  const aggressiveHatchFilter = opts.aggressiveHatchFilter === true

  let result: VectorPath[] = []

  for (const path of paths) {
    const subpaths = parsePathDAll(path.d)
    for (const sp of subpaths) {
      if (sp.points.length < 2) continue
      let simplified = rdpSimplify(sp.points, epsilon)
      if (simplified.length < 2) continue
      if (sp.closed && simplified.length >= 3) {
        const [fx, fy] = simplified[0]
        const [lx, ly] = simplified[simplified.length - 1]
        if (Math.hypot(fx - lx, fy - ly) > 2) {
          simplified = [...simplified, [fx, fy]]
        }
      }
      const simplifiedPath = pathFromPairs(simplified)
      if (aggressiveHatchFilter && simplifiedPath.length < 30) continue
      result.push(simplifiedPath)
    }
  }

  if (dropHatching) {
    result = filterHatchingPaths(result, canvasW, canvasH)
  }

  if (aggressiveHatchFilter) {
    result = filterAggressiveHatching(result)
  }

  // Never merge distant subpaths — merging caused cross-canvas connector lines.
  const mergeGap = opts.mergeGap ?? 5
  if (mergeGap > 0 && !aggressiveHatchFilter) {
    result = mergeNearbyPaths(result, mergeGap)
  }
  if (opts.skipDedup) return result
  return deduplicatePaths(result, opts.dedupOverlap ?? 0.85)
}

/** Scale path coordinates back after trace upscale — one VectorPath per subpath (no cross-subpath connectors). */
export function scalePaths(paths: VectorPath[], factor: number): VectorPath[] {
  if (factor === 1) return paths
  const result: VectorPath[] = []
  for (const path of paths) {
    for (const sp of parsePathDAll(path.d)) {
      if (sp.points.length < 2) continue
      const scaled = sp.points.map(([x, y]) => [x / factor, y / factor] as PointPair)
      result.push(pathFromPairs(scaled))
    }
  }
  return result.length > 0 ? result : paths
}

/** Count paths that are short (< minLen px). */
export function countShortPaths(paths: VectorPath[], minLen = 25): number {
  return paths.filter((p) => p.length < minLen).length
}

/** Chaikin corner-cutting smooth for closed/open polygon contours (mask clip paths). */
export function chaikinSmoothPairs(points: PointPair[], iterations = 1, closed = true): PointPair[] {
  if (points.length < 3) return points
  let result = points
  const count = closed ? result.length : result.length - 1
  for (let iter = 0; iter < iterations; iter++) {
    const next: PointPair[] = []
    for (let i = 0; i < count; i++) {
      const p0 = result[i]
      const p1 = result[(i + 1) % result.length]
      next.push(
        [0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]],
        [0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]],
      )
    }
    result = next
  }
  return result
}
