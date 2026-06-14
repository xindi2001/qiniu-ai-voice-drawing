import { parsePathDAll } from './svgPathParser'
import { pairsToFlat, bboxFromFlat } from './pathUtils'
import type { TraceSubject } from './pathDedup'

export interface VectorPath {
  d: string
  /** Bounding box min coords for sorting */
  minX: number
  minY: number
  length: number
}

const CLUSTER_CENTROID_DIST = 80
const MAX_JUMP_RATIO = 0.25
export const WANX_TOP_STROKES = 30
export const MIN_STROKE_LENGTH_PX = 30

function estimatePathLength(d: string): number {
  const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) ?? []
  let len = 0
  for (let i = 2; i < nums.length; i += 2) {
    len += Math.hypot(nums[i] - nums[i - 2], nums[i + 1] - nums[i - 1])
  }
  return len
}

function bboxFromPath(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) ?? []
  const xs = nums.filter((_, i) => i % 2 === 0)
  const ys = nums.filter((_, i) => i % 2 === 1)
  if (!xs.length || !ys.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
}

function pathCentroid(d: string): { x: number; y: number } {
  const bbox = bboxFromPath(d)
  return {
    x: (bbox.minX + bbox.maxX) / 2,
    y: (bbox.minY + bbox.maxY) / 2,
  }
}

function pathStartPoint(d: string): { x: number; y: number } {
  const subpaths = parsePathDAll(d)
  if (subpaths.length === 0 || subpaths[0].points.length === 0) {
    return pathCentroid(d)
  }
  const [x, y] = subpaths[0].points[0]
  return { x, y }
}

function bboxesOverlap(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
  margin = 4,
): boolean {
  return !(
    a.maxX + margin < b.minX
    || b.maxX + margin < a.minX
    || a.maxY + margin < b.minY
    || b.maxY + margin < a.minY
  )
}

function clusterArea(paths: VectorPath[]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of paths) {
    const b = bboxFromPath(p.d)
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
  }
  return (maxX - minX) * (maxY - minY)
}

/** Group paths into spatial clusters (bbox overlap or centroid distance < 80px). */
export function clusterPaths(paths: VectorPath[]): VectorPath[][] {
  if (paths.length <= 1) return paths.length === 1 ? [paths] : []

  const clusters: VectorPath[][] = []
  const assigned = new Set<number>()

  for (let i = 0; i < paths.length; i++) {
    if (assigned.has(i)) continue
    const cluster: VectorPath[] = [paths[i]]
    assigned.add(i)
    const queue = [i]

    while (queue.length > 0) {
      const idx = queue.pop()!
      const anchor = paths[idx]
      const anchorBbox = bboxFromPath(anchor.d)
      const anchorCentroid = pathCentroid(anchor.d)

      for (let j = 0; j < paths.length; j++) {
        if (assigned.has(j)) continue
        const candidate = paths[j]
        const candidateBbox = bboxFromPath(candidate.d)
        const candidateCentroid = pathCentroid(candidate.d)
        const centroidDist = Math.hypot(
          anchorCentroid.x - candidateCentroid.x,
          anchorCentroid.y - candidateCentroid.y,
        )
        if (bboxesOverlap(anchorBbox, candidateBbox) || centroidDist < CLUSTER_CENTROID_DIST) {
          cluster.push(candidate)
          assigned.add(j)
          queue.push(j)
        }
      }
    }
    clusters.push(cluster)
  }

  return clusters
}

/** Nearest-neighbor sort within a single cluster; reject jumps > 25% canvas diagonal. */
function nearestNeighborSortCluster(
  paths: VectorPath[],
  canvasDiag: number,
): VectorPath[] {
  if (paths.length <= 1) return paths

  const maxJump = canvasDiag * MAX_JUMP_RATIO
  const remaining = [...paths]
  const sorted: VectorPath[] = []

  let current = remaining.reduce((best, p) => (p.length > best.length ? p : best))
  remaining.splice(remaining.indexOf(current), 1)
  sorted.push(current)

  let cursor = pathStartPoint(current.d)

  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity

    for (let i = 0; i < remaining.length; i++) {
      const start = pathStartPoint(remaining[i].d)
      const dist = Math.hypot(start.x - cursor.x, start.y - cursor.y)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    }

    const next = remaining.splice(bestIdx, 1)[0]
    sorted.push(next)
    const subpaths = parsePathDAll(next.d)
    const lastSp = subpaths[subpaths.length - 1]
    if (lastSp && lastSp.points.length > 0) {
      const [lx, ly] = lastSp.points[lastSp.points.length - 1]
      cursor = { x: lx, y: ly }
    } else {
      cursor = pathStartPoint(next.d)
    }

    if (bestDist > maxJump) {
      // Do not chain across distant strokes — next path starts fresh (no connector)
      cursor = pathStartPoint(next.d)
    }
  }

  return sorted
}

function pathEndPoint(d: string): { x: number; y: number } {
  const subpaths = parsePathDAll(d)
  if (subpaths.length === 0) return pathCentroid(d)
  const lastSp = subpaths[subpaths.length - 1]
  if (lastSp.points.length === 0) return pathCentroid(d)
  const [x, y] = lastSp.points[lastSp.points.length - 1]
  return { x, y }
}

/** Portrait: prefer strokes higher on canvas (hair → face → neck). */
function portraitOrderBias(path: VectorPath): number {
  const bbox = bboxFromPath(path.d)
  return bbox.minY * 2 + (bbox.minX + bbox.maxX) / 2 * 0.01
}

/** Vehicle: left-to-right, small closed loops (wheels) before long body strokes. */
function vehicleOrderBias(path: VectorPath, canvasW: number): number {
  const bbox = bboxFromPath(path.d)
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const aspect = w / (h + 0.01)
  const closed = isNearClosedPath(path)
  const wheelBonus = closed && w < canvasW * 0.18 && h < canvasW * 0.18 ? -500 : 0
  const leftBias = bbox.minX
  const compactBonus = aspect > 0.6 && aspect < 1.6 && path.length < 80 ? -200 : 0
  return leftBias + wheelBonus + compactBonus
}

function isNearClosedPath(path: VectorPath): boolean {
  const subpaths = parsePathDAll(path.d)
  if (subpaths.length === 0) return false
  const sp = subpaths[0]
  if (sp.closed) return true
  if (sp.points.length < 3) return false
  const [sx, sy] = sp.points[0]
  const [ex, ey] = sp.points[sp.points.length - 1]
  return Math.hypot(ex - sx, ey - sy) <= 12
}

/** Sort silhouette strokes (longest first) with subject-specific bias. */
function sortSilhouetteGroup(
  paths: VectorPath[],
  subject: TraceSubject,
  canvasW: number,
): VectorPath[] {
  const sorted = [...paths].sort((a, b) => b.length - a.length)
  if (subject === 'portrait') {
    return sorted.sort((a, b) => portraitOrderBias(a) - portraitOrderBias(b) || b.length - a.length)
  }
  if (subject === 'vehicle') {
    return sorted.sort((a, b) => vehicleOrderBias(a, canvasW) - vehicleOrderBias(b, canvasW) || b.length - a.length)
  }
  return sorted
}

/** Within one cluster: silhouette (long) first, then details by nearest-neighbor from last endpoint. */
function sortClusterNatural(
  paths: VectorPath[],
  canvasDiag: number,
  subject: TraceSubject,
  canvasW: number,
): VectorPath[] {
  if (paths.length <= 1) return paths

  const medianLen = paths.map((p) => p.length).sort((a, b) => a - b)[Math.floor(paths.length / 2)] ?? 0
  const silhouetteCutoff = Math.max(medianLen * 1.2, MIN_STROKE_LENGTH_PX * 0.8)

  const silhouette: VectorPath[] = []
  const details: VectorPath[] = []
  for (const p of paths) {
    if (p.length >= silhouetteCutoff) silhouette.push(p)
    else details.push(p)
  }

  const orderedSilhouette = sortSilhouetteGroup(
    silhouette.length > 0 ? silhouette : [paths.reduce((best, p) => (p.length > best.length ? p : best))],
    subject,
    canvasW,
  )

  if (details.length === 0) return orderedSilhouette

  const maxJump = canvasDiag * MAX_JUMP_RATIO
  const remaining = [...details]
  const result = [...orderedSilhouette]
  let cursor = pathEndPoint(result[result.length - 1].d)

  while (remaining.length > 0) {
    let bestIdx = 0
    let bestScore = Infinity

    for (let i = 0; i < remaining.length; i++) {
      const start = pathStartPoint(remaining[i].d)
      const dist = Math.hypot(start.x - cursor.x, start.y - cursor.y)
      let score = dist
      if (subject === 'portrait') {
        score += portraitOrderBias(remaining[i]) * 0.15
      } else if (subject === 'vehicle') {
        score += vehicleOrderBias(remaining[i], canvasW) * 0.05
      }
      if (score < bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    const next = remaining.splice(bestIdx, 1)[0]
    result.push(next)
    cursor = pathEndPoint(next.d)
    if (bestScore > maxJump) {
      cursor = pathStartPoint(next.d)
    }
  }

  return result
}

/**
 * Natural drawing order: cluster → silhouette (longest + subject bias) → detail NN chain.
 * Portrait: top-to-bottom; vehicle: left-to-right / wheel-first.
 */
export function sortForNaturalDrawing(
  paths: VectorPath[],
  canvasW = 600,
  canvasH = 400,
  subject: TraceSubject = 'default',
): VectorPath[] {
  const canvasDiag = Math.hypot(canvasW, canvasH)
  const outer: VectorPath[] = []
  const interior: VectorPath[] = []

  for (const p of paths) {
    if (isInteriorDetail(p, canvasW, canvasH)) interior.push(p)
    else outer.push(p)
  }

  const sortGroup = (group: VectorPath[]): VectorPath[] => {
    const clusters = clusterPaths(group)
    clusters.sort((a, b) => clusterArea(b) - clusterArea(a))
    const result: VectorPath[] = []
    for (const cluster of clusters) {
      result.push(...sortClusterNatural(cluster, canvasDiag, subject, canvasW))
    }
    return result
  }

  return [...sortGroup(outer), ...sortGroup(interior)]
}

/** Sort flat stroke items using natural drawing order. */
export function sortStrokeItemsNatural(
  items: { flat: number[]; closed: boolean }[],
  canvasW = 600,
  canvasH = 400,
  subject: TraceSubject = 'default',
): { flat: number[]; closed: boolean }[] {
  const asPaths: VectorPath[] = items.map((item) => {
    const bbox = bboxFromFlat(item.flat)
    const pairs: [number, number][] = []
    for (let i = 0; i < item.flat.length; i += 2) {
      pairs.push([item.flat[i], item.flat[i + 1]])
    }
    const d = pairs
      .map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`))
      .join(' ')
    return {
      d,
      minX: bbox.minX,
      minY: bbox.minY,
      length: computePathLengthFromFlat(item.flat),
    }
  })

  const sorted = sortForNaturalDrawing(asPaths, canvasW, canvasH, subject)
  const dToItem = new Map<string, { flat: number[]; closed: boolean }>()
  for (const item of items) {
    const pairs: [number, number][] = []
    for (let i = 0; i < item.flat.length; i += 2) {
      pairs.push([item.flat[i], item.flat[i + 1]])
    }
    const d = pairs
      .map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`))
      .join(' ')
    dToItem.set(d, item)
  }

  const result: { flat: number[]; closed: boolean }[] = []
  for (const p of sorted) {
    const found = dToItem.get(p.d)
    if (found) result.push(found)
  }
  return result.length === items.length ? result : items
}

/** Split compound SVG path d at every M/m into independent VectorPath items. */
export function splitPathDIntoItems(d: string): VectorPath[] {
  const items: VectorPath[] = []
  for (const sp of parsePathDAll(d)) {
    if (sp.points.length < 2) continue
    const flat = pairsToFlat(sp.points)
    const bbox = bboxFromFlat(flat)
    let length = 0
    for (let i = 1; i < sp.points.length; i++) {
      const [x0, y0] = sp.points[i - 1]
      const [x1, y1] = sp.points[i]
      length += Math.hypot(x1 - x0, y1 - y0)
    }
    items.push({
      d: sp.points
        .map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`))
        .join(' '),
      minX: bbox.minX,
      minY: bbox.minY,
      length,
    })
  }
  return items
}

export function extractPathsFromSvg(svgString: string): VectorPath[] {
  const paths: VectorPath[] = []
  const regex = /<path[^>]*\sd=["']([^"']+)["'][^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(svgString)) !== null) {
    const d = match[1]
    const subItems = splitPathDIntoItems(d)
    if (subItems.length > 0) {
      paths.push(...subItems)
    } else {
      const bbox = bboxFromPath(d)
      paths.push({ d, minX: bbox.minX, minY: bbox.minY, length: estimatePathLength(d) })
    }
  }
  return paths
}

export function sortPathsTopLeft(paths: VectorPath[]): VectorPath[] {
  return [...paths].sort((a, b) => {
    const dy = a.minY - b.minY
    if (Math.abs(dy) > 5) return dy
    return a.minX - b.minX
  })
}

export function sortPathsByLength(paths: VectorPath[]): VectorPath[] {
  return [...paths].sort((a, b) => a.length - b.length)
}

/** Small interior detail or hatch-like stroke — draw last or drop. */
function isInteriorDetail(path: VectorPath, canvasW: number, canvasH: number): boolean {
  const bbox = bboxFromPath(path.d)
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const area = w * h
  const canvasArea = canvasW * canvasH

  if (path.length < MIN_STROKE_LENGTH_PX && area < canvasArea * 0.003) return true
  if (area < canvasArea * 0.0015 && path.length < 50) return true
  return false
}

/**
 * Spatial cluster sort: largest cluster first, nearest-neighbor within cluster.
 * Never connects strokes across clusters; rejects jumps > 25% canvas diagonal.
 */
export function sortPaths(
  paths: VectorPath[],
  canvasW = 600,
  canvasH = 400,
): VectorPath[] {
  const canvasDiag = Math.hypot(canvasW, canvasH)
  const outer: VectorPath[] = []
  const interior: VectorPath[] = []

  for (const p of paths) {
    if (isInteriorDetail(p, canvasW, canvasH)) {
      interior.push(p)
    } else {
      outer.push(p)
    }
  }

  const sortGroup = (group: VectorPath[]): VectorPath[] => {
    const clusters = clusterPaths(group)
    clusters.sort((a, b) => clusterArea(b) - clusterArea(a))
    const result: VectorPath[] = []
    for (const cluster of clusters) {
      result.push(...nearestNeighborSortCluster(cluster, canvasDiag))
    }
    return result
  }

  return [...sortGroup(outer), ...sortGroup(interior)]
}

/** Keep top N longest individual strokes (after subpath split). */
export function keepTopLongestStrokes(
  paths: VectorPath[],
  maxCount = WANX_TOP_STROKES,
  minLength = MIN_STROKE_LENGTH_PX,
): VectorPath[] {
  return [...paths]
    .filter((p) => p.length >= minLength)
    .sort((a, b) => b.length - a.length)
    .slice(0, maxCount)
}

/** Sort flat stroke items using spatial cluster + nearest-neighbor order. */
export function sortStrokeItemsCluster(
  items: { flat: number[]; closed: boolean }[],
  canvasW = 600,
  canvasH = 400,
): { flat: number[]; closed: boolean }[] {
  const asPaths: VectorPath[] = items.map((item) => {
    const bbox = bboxFromFlat(item.flat)
    const pairs: [number, number][] = []
    for (let i = 0; i < item.flat.length; i += 2) {
      pairs.push([item.flat[i], item.flat[i + 1]])
    }
    const d = pairs
      .map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`))
      .join(' ')
    return {
      d,
      minX: bbox.minX,
      minY: bbox.minY,
      length: computePathLengthFromFlat(item.flat),
    }
  })

  const sorted = sortPaths(asPaths, canvasW, canvasH)
  const dToItem = new Map<string, { flat: number[]; closed: boolean }>()
  for (const item of items) {
    const pairs: [number, number][] = []
    for (let i = 0; i < item.flat.length; i += 2) {
      pairs.push([item.flat[i], item.flat[i + 1]])
    }
    const d = pairs
      .map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`))
      .join(' ')
    dToItem.set(d, item)
  }

  const result: { flat: number[]; closed: boolean }[] = []
  for (const p of sorted) {
    const found = dToItem.get(p.d)
    if (found) result.push(found)
  }
  return result.length === items.length ? result : items
}

function computePathLengthFromFlat(flat: number[]): number {
  let len = 0
  for (let i = 2; i < flat.length; i += 2) {
    len += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1])
  }
  return len
}

export const OUTLINE_MAX_PATHS = 18

/** Outline-only mode: keep longest paths only, capped for clean silhouette animation. */
export function sortPathsOutlineOnly(paths: VectorPath[]): VectorPath[] {
  return keepTopLongestStrokes(paths, OUTLINE_MAX_PATHS, MIN_STROKE_LENGTH_PX)
}
