import type { PathItem } from '../types/commands'
import { CANVAS_WIDTH } from '../constants/canvas'
import { bboxFromFlat, computePathLength, pairsToFlat, type FlatBbox } from './pathUtils'
import type { VectorPath } from './pathSorter'
import { parsePathDAll } from './svgPathParser'

export type TraceSubject = 'vehicle' | 'portrait' | 'animal' | 'default'

const VEHICLE_KEYWORDS = [
  '车', '超跑', '跑车', '汽车', '轿车', '赛车', '摩托', '卡车', '巴士',
  'car', 'sports car', 'supercar', 'vehicle', 'automobile',
]
const PORTRAIT_KEYWORDS = [
  '头像', '动漫', '人像', '自拍', '肖像', '脸', '面部',
  'avatar', 'anime', 'portrait', 'face',
]
const ANIMAL_KEYWORDS = [
  '马', '斑马', '牛', '羊', '猪', '鸡', '鸭', '鹅', '兔', '鼠', '虎', '狮',
  '豹', '熊', '狼', '狐', '鹿', '象', '猴', '猫', '狗', '鸟', '鱼', '龙', '蛇',
  '长颈鹿', '海豚', '鲸', '企鹅', 'horse', 'zebra', 'cow', 'animal',
]

/** Wanx generate_and_trace: only drop near-exact bbox duplicates — keep 60–80% of raw paths. */
export const TRACE_OVERLAP_THRESHOLD = 0.98
/** Hybrid full+edge merge: drop edge paths that duplicate an existing full-trace stroke. */
export const TRACE_HYBRID_OVERLAP_THRESHOLD = 0.85
/** Max centroid distance (px) to treat hybrid paths as the same contour. */
export const TRACE_HYBRID_CENTROID_PX = 28

/** Soft safety ceiling — hybrid merge caps here; full trace keeps all deduped paths below this. */
export const SUBJECT_MAX_PATHS: Record<TraceSubject, number> = {
  vehicle: 180,
  portrait: 180,
  animal: 180,
  default: 180,
}

/** Max edge supplement paths added as gap-fill during vehicle hybrid merge. */
export const MAX_EDGE_GAP_FILL = 50

/** Minimum paths to keep from each horizontal third when capping stroke count. */
export const SPATIAL_MIN_PER_THIRD = 2

export const SUBJECT_MIN_LENGTH: Record<TraceSubject, number> = {
  vehicle: 8,
  portrait: 8,
  animal: 20,
  default: 15,
}

/** Relaxed min length for fineDetail mode — keep small wheel/window strokes. */
export const SUBJECT_MIN_LENGTH_FINE: Record<TraceSubject, number> = {
  vehicle: 6,
  portrait: 6,
  animal: 12,
  default: 10,
}

export function detectTraceSubject(prompt: string): TraceSubject {
  const p = prompt.toLowerCase()
  if (VEHICLE_KEYWORDS.some((k) => prompt.includes(k) || p.includes(k.toLowerCase()))) {
    return 'vehicle'
  }
  if (PORTRAIT_KEYWORDS.some((k) => prompt.includes(k) || p.includes(k.toLowerCase()))) {
    return 'portrait'
  }
  if (ANIMAL_KEYWORDS.some((k) => prompt.includes(k) || p.includes(k.toLowerCase()))) {
    return 'animal'
  }
  return 'default'
}

function vectorPathBbox(path: VectorPath): FlatBbox {
  const subpaths = parsePathDAll(path.d)
  const flat = pairsToFlat(subpaths.flatMap((sp) => sp.points))
  return bboxFromFlat(flat.length >= 4 ? flat : [path.minX, path.minY, path.minX, path.minY])
}

function bboxIntersectionArea(a: FlatBbox, b: FlatBbox): number {
  const minX = Math.max(a.minX, b.minX)
  const minY = Math.max(a.minY, b.minY)
  const maxX = Math.min(a.maxX, b.maxX)
  const maxY = Math.min(a.maxY, b.maxY)
  if (maxX <= minX || maxY <= minY) return 0
  return (maxX - minX) * (maxY - minY)
}

function bboxArea(b: FlatBbox): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

/** Intersection over min-area — high when smaller path sits mostly inside larger. */
export function bboxOverlapRatio(a: FlatBbox, b: FlatBbox): number {
  const inter = bboxIntersectionArea(a, b)
  const minArea = Math.min(bboxArea(a), bboxArea(b))
  if (minArea <= 0) return 0
  return inter / minArea
}

function pathDirection(path: VectorPath): { dx: number; dy: number; len: number } {
  const subpaths = parsePathDAll(path.d)
  const pts = subpaths[0]?.points ?? []
  if (pts.length < 2) return { dx: 0, dy: 0, len: 0 }
  const [x0, y0] = pts[0]
  const [x1, y1] = pts[pts.length - 1]
  const dx = x1 - x0
  const dy = y1 - y0
  return { dx, dy, len: Math.hypot(dx, dy) }
}

function pathCentroid(path: VectorPath): { x: number; y: number } {
  const b = vectorPathBbox(path)
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

/** Parallel strokes offset < maxOffset px with similar length — keep longer only. */
export function areParallelDuplicates(
  a: VectorPath,
  b: VectorPath,
  maxOffset = 5,
  minLengthRatio = 0.65,
): boolean {
  const lenA = a.length
  const lenB = b.length
  const ratio = Math.min(lenA, lenB) / Math.max(lenA, lenB, 1)
  if (ratio < minLengthRatio) return false

  const ca = pathCentroid(a)
  const cb = pathCentroid(b)
  const offset = Math.hypot(ca.x - cb.x, ca.y - cb.y)
  if (offset > maxOffset) return false

  const dirA = pathDirection(a)
  const dirB = pathDirection(b)
  if (dirA.len < 8 || dirB.len < 8) return offset <= maxOffset * 0.6

  const dot = dirA.dx * dirB.dx + dirA.dy * dirB.dy
  const cosAngle = dot / (dirA.len * dirB.len)
  return Math.abs(cosAngle) >= 0.85
}

/**
 * Drop paths overlapping > overlapThreshold with a longer path; merge parallel duplicates.
 * Always sorted longest-first on return.
 */
export function deduplicatePaths(
  paths: VectorPath[],
  overlapThreshold = 0.85,
  maxParallelOffset = 5,
  skipParallelDedup = false,
): VectorPath[] {
  const sorted = [...paths].sort((a, b) => b.length - a.length)
  const kept: VectorPath[] = []

  for (const candidate of sorted) {
    let drop = false
    for (const longer of kept) {
      const overlap = bboxOverlapRatio(vectorPathBbox(candidate), vectorPathBbox(longer))
      if (overlap >= overlapThreshold) {
        const lenRatio = Math.min(candidate.length, longer.length)
          / Math.max(candidate.length, longer.length, 1)
        // Only drop when paths are similar size — avoids culling small detail inside larger bboxes.
        if (lenRatio >= 0.45) {
          drop = true
          break
        }
      }
      if (!skipParallelDedup && areParallelDuplicates(candidate, longer, maxParallelOffset)) {
        drop = true
        break
      }
    }
    if (!drop) kept.push(candidate)
  }

  return kept
}

function normalizePathKey(d: string): string {
  return d.replace(/\s+/g, ' ').trim()
}

/** Wanx full trace: drop only paths with identical `d` strings — no spatial dedup. */
export function deduplicateExactPaths(paths: VectorPath[]): VectorPath[] {
  const seen = new Set<string>()
  const kept: VectorPath[] = []
  for (const path of paths) {
    const key = normalizePathKey(path.d)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(path)
  }
  return kept
}

/** True when supplement path re-traces a region already covered by a primary path. */
function isHybridDuplicateOfPrimary(
  supplement: VectorPath,
  primaries: VectorPath[],
  overlapThreshold = TRACE_HYBRID_OVERLAP_THRESHOLD,
  maxCentroidPx = TRACE_HYBRID_CENTROID_PX,
): boolean {
  const sb = vectorPathBbox(supplement)
  const sc = pathCentroid(supplement)

  for (const primary of primaries) {
    const pb = vectorPathBbox(primary)
    const pc = pathCentroid(primary)
    const overlap = bboxOverlapRatio(sb, pb)
    if (overlap < overlapThreshold) continue

    const centerDist = Math.hypot(sc.x - pc.x, sc.y - pc.y)
    const lenRatio = Math.min(supplement.length, primary.length)
      / Math.max(supplement.length, primary.length, 1)

    if (centerDist <= maxCentroidPx && lenRatio >= 0.45) return true
    if (overlap >= 0.92 && primary.length >= supplement.length * 0.85) return true
    if (areParallelDuplicates(supplement, primary, maxCentroidPx * 0.6)) return true
  }
  return false
}

/** Log sample bbox centers to detect coordinate-offset duplicates. */
export function logPathBboxSample(
  label: string,
  paths: VectorPath[],
  sampleCount = 3,
): void {
  if (paths.length === 0) {
    console.log(`[pathDedup] ${label}: (empty)`)
    return
  }
  const sample = paths.slice(0, sampleCount)
  const parts = sample.map((p, i) => {
    const b = vectorPathBbox(p)
    const c = pathCentroid(p)
    return `#${i} c=(${c.x.toFixed(0)},${c.y.toFixed(0)}) bbox=(${b.minX.toFixed(0)},${b.minY.toFixed(0)}-${b.maxX.toFixed(0)},${b.maxY.toFixed(0)}) len=${p.length.toFixed(0)}`
  })
  console.log(`[pathDedup] ${label} sample (${paths.length} total): ${parts.join('; ')}`)
}

/**
 * Merge full ImageTracer paths with edge supplement — primary paths kept;
 * edge paths only added as gap-fill when not spatially covered.
 */
export function mergeTracePathsUnion(
  fullPaths: VectorPath[],
  supplementPaths: VectorPath[],
  subject: TraceSubject = 'vehicle',
): VectorPath[] {
  const normalize = normalizePathKey
  const seen = new Set<string>()
  const primary: VectorPath[] = []

  for (const path of fullPaths) {
    const key = normalize(path.d)
    if (seen.has(key)) continue
    seen.add(key)
    primary.push(path)
  }

  const edgeCandidates = [...supplementPaths].sort((a, b) => b.length - a.length)
  let gapFillAdded = 0
  for (const path of edgeCandidates) {
    if (gapFillAdded >= MAX_EDGE_GAP_FILL) break
    const key = normalize(path.d)
    if (seen.has(key)) continue
    if (isHybridDuplicateOfPrimary(path, primary)) continue
    seen.add(key)
    primary.push(path)
    gapFillAdded++
  }

  const deduped = deduplicatePaths(primary, TRACE_HYBRID_OVERLAP_THRESHOLD, 6)
  const maxPaths = SUBJECT_MAX_PATHS[subject]
  const capped = deduped.length <= maxPaths
    ? deduped
    : selectPathsWithSpatialCoverage(
      deduped.map((p) => {
        const c = pathCentroid(p)
        return { path: p, length: p.length, centroidX: c.x }
      }),
      maxPaths,
    ).map((s) => s.path)

  console.log(
    `[pathDedup] hybrid merge: full=${fullPaths.length} edge=${supplementPaths.length}`
    + ` gapFill=${gapFillAdded} deduped=${deduped.length} final=${capped.length}`,
  )

  return capped.sort((a, b) => b.length - a.length)
}

/** Spatial dedup for merged trace paths (bbox overlap + parallel strokes). */
export function deduplicateOverlappingPaths(
  paths: VectorPath[],
  overlapThreshold = TRACE_HYBRID_OVERLAP_THRESHOLD,
): VectorPath[] {
  return deduplicatePaths(paths, overlapThreshold, 6)
}

export interface SpatialPathCandidate {
  length: number
  centroidX: number
}

function globalCentroidSpanX<T extends SpatialPathCandidate>(
  paths: T[],
  canvasW: number,
): { minX: number; maxX: number } {
  if (paths.length === 0) return { minX: 0, maxX: canvasW }
  let minX = Infinity
  let maxX = -Infinity
  for (const p of paths) {
    minX = Math.min(minX, p.centroidX)
    maxX = Math.max(maxX, p.centroidX)
  }
  if (!Number.isFinite(minX) || maxX <= minX) return { minX: 0, maxX: canvasW }
  return { minX, maxX }
}

/**
 * Cap paths while preserving left/center/right coverage — longest per horizontal third first.
 */
export function selectPathsWithSpatialCoverage<T extends SpatialPathCandidate>(
  paths: T[],
  maxCount: number,
  canvasW = CANVAS_WIDTH,
  minPerThird = SPATIAL_MIN_PER_THIRD,
): T[] {
  if (paths.length <= maxCount) return paths

  const sorted = [...paths].sort((a, b) => b.length - a.length)
  const { minX, maxX } = globalCentroidSpanX(sorted, canvasW)
  const span = Math.max(maxX - minX, canvasW * 0.2)
  const third = span / 3
  const colBounds: [number, number][] = [
    [minX, minX + third],
    [minX + third, minX + 2 * third],
    [minX + 2 * third, maxX + 0.001],
  ]
  const perColumn = Math.max(minPerThird, Math.ceil(maxCount / 3))

  const selected: T[] = []
  const used = new Set<T>()

  for (const [colMin, colMax] of colBounds) {
    const inColumn = sorted.filter(
      (p) => p.centroidX >= colMin && p.centroidX < colMax,
    )
    let taken = 0
    for (const p of inColumn) {
      if (taken >= perColumn) break
      if (!used.has(p)) {
        selected.push(p)
        used.add(p)
        taken++
      }
    }
  }

  for (const p of sorted) {
    if (selected.length >= maxCount) break
    if (!used.has(p)) {
      selected.push(p)
      used.add(p)
    }
  }

  return selected.slice(0, maxCount)
}

/** Apply subject min-length + light dedup — keep 60–90% of traced paths. */
export function filterPathsForSubject(
  paths: VectorPath[],
  subject: TraceSubject,
  fineDetail = false,
): VectorPath[] {
  const minLen = fineDetail
    ? SUBJECT_MIN_LENGTH_FINE[subject]
    : SUBJECT_MIN_LENGTH[subject]
  const filtered = paths.filter((p) => p.length >= minLen)
  const overlap = subject === 'vehicle' || subject === 'portrait'
    ? TRACE_OVERLAP_THRESHOLD
    : 0.85
  const deduped = deduplicatePaths(filtered, overlap, 5, subject === 'vehicle' || subject === 'portrait')
  if (deduped.length < filtered.length) {
    console.log(
      `[pathDedup] subject filter: ${deduped.length}/${filtered.length}`
      + ` (min ${minLen}px, subject=${subject}, fine=${fineDetail})`,
    )
  }
  return deduped
}

/** Deduplicate PathItem[] by flat bbox overlap (for draw_paths tier). */
export function deduplicatePathItems(items: PathItem[]): PathItem[] {
  type Scored = { item: PathItem; len: number; bbox: FlatBbox }
  const scored: Scored[] = items
    .filter((item) => item.points && item.points.length >= 2)
    .map((item) => {
      const flat = pairsToFlat(item.points!)
      return { item, len: computePathLength(flat), bbox: bboxFromFlat(flat) }
    })
    .sort((a, b) => b.len - a.len)

  const kept: Scored[] = []
  for (const candidate of scored) {
    const dominated = kept.some(
      (k) => bboxOverlapRatio(candidate.bbox, k.bbox) >= 0.85,
    )
    if (!dominated) kept.push(candidate)
  }
  return kept.map((k) => k.item)
}
