import type { TraceConfig } from '../constants/traceConfig'
import { parsePathDAll } from './svgPathParser'
import { pairsToFlat, bboxFromFlat, trimOriginJump, removeOriginConnectorSegments, computePathLength } from './pathUtils'
import type { VectorPath } from './pathSorter'
import { splitPathDIntoItems } from './pathSorter'

function pathCentroid(path: VectorPath): { x: number; y: number } {
  const flat = pairsToFlat(parsePathDAll(path.d).flatMap((sp) => sp.points))
  if (flat.length < 4) return { x: path.minX, y: path.minY }
  const bbox = bboxFromFlat(flat)
  return { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 }
}

function bboxOverlapRatio(a: VectorPath, b: VectorPath): number {
  const flatA = pairsToFlat(parsePathDAll(a.d).flatMap((sp) => sp.points))
  const flatB = pairsToFlat(parsePathDAll(b.d).flatMap((sp) => sp.points))
  if (flatA.length < 4 || flatB.length < 4) return 0
  const ba = bboxFromFlat(flatA)
  const bb = bboxFromFlat(flatB)
  const minX = Math.max(ba.minX, bb.minX)
  const minY = Math.max(ba.minY, bb.minY)
  const maxX = Math.min(ba.maxX, bb.maxX)
  const maxY = Math.min(ba.maxY, bb.maxY)
  if (maxX <= minX || maxY <= minY) return 0
  const inter = (maxX - minX) * (maxY - minY)
  const areaA = (ba.maxX - ba.minX) * (ba.maxY - ba.minY)
  const areaB = (bb.maxX - bb.minX) * (bb.maxY - bb.minY)
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

/** Principle 4 — merge strokes with high bbox overlap and similar length. */
export function mergeCoincidentPaths(
  path: VectorPath[],
  overlapThreshold: number,
): VectorPath[] {
  const kept: VectorPath[] = []
  const used = new Set<number>()

  for (let i = 0; i < path.length; i++) {
    if (used.has(i)) continue
    let best = path[i]
    used.add(i)

    for (let j = i + 1; j < path.length; j++) {
      if (used.has(j)) continue
      const overlap = bboxOverlapRatio(best, path[j])
      if (overlap < overlapThreshold) continue

      const lenRatio = Math.min(best.length, path[j].length) / Math.max(best.length, path[j].length, 1)
      const ca = pathCentroid(best)
      const cb = pathCentroid(path[j])
      const centerDist = Math.hypot(ca.x - cb.x, ca.y - cb.y)

      if (lenRatio >= 0.5 && centerDist <= 24) {
        used.add(j)
        if (path[j].length > best.length) best = path[j]
      }
    }
    kept.push(best)
  }
  return kept
}

function pointOnSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tolerance: number,
): boolean {
  const segLen = Math.hypot(x1 - x0, y1 - y0)
  if (segLen < 1) return Math.hypot(px - x0, py - y0) <= tolerance
  const t = Math.max(0, Math.min(1, ((px - x0) * (x1 - x0) + (py - y0) * (y1 - y0)) / (segLen * segLen)))
  const projX = x0 + t * (x1 - x0)
  const projY = y0 + t * (y1 - y0)
  return Math.hypot(px - projX, py - projY) <= tolerance
}

function endpointOnPath(endpoint: [number, number], target: VectorPath, tolerance: number): boolean {
  const flat = pairsToFlat(parsePathDAll(target.d).flatMap((sp) => sp.points))
  for (let i = 0; i + 3 < flat.length; i += 2) {
    if (pointOnSegment(endpoint[0], endpoint[1], flat[i], flat[i + 1], flat[i + 2], flat[i + 3], tolerance)) {
      return true
    }
  }
  return false
}

/** Principle 4 — drop short spurs that only re-trace an existing longer stroke (T-junction). */
export function removeRedundantCrossings(path: VectorPath[]): VectorPath[] {
  const sorted = [...path].sort((a, b) => b.length - a.length)
  const kept: VectorPath[] = []

  for (const candidate of sorted) {
    if (candidate.length >= 40) {
      kept.push(candidate)
      continue
    }

    const { start, end } = (() => {
      const subpaths = parsePathDAll(candidate.d)
      const pts = subpaths[0]?.points ?? []
      if (pts.length === 0) return { start: [0, 0] as [number, number], end: [0, 0] as [number, number] }
      return { start: pts[0] as [number, number], end: pts[pts.length - 1] as [number, number] }
    })()

    let redundant = false
    for (const longer of kept) {
      if (longer.length <= candidate.length * 1.2) continue
      const startOn = endpointOnPath(start, longer, 6)
      const endOn = endpointOnPath(end, longer, 6)
      if (startOn && endOn) {
        redundant = true
        break
      }
      if ((startOn || endOn) && candidate.length < longer.length * 0.35) {
        redundant = true
        break
      }
    }
    if (!redundant) kept.push(candidate)
  }
  return kept
}

function flatToPathD(flat: number[]): string {
  if (flat.length < 4) return ''
  const parts: string[] = [`M ${flat[0]} ${flat[1]}`]
  for (let i = 2; i < flat.length; i += 2) {
    parts.push(`L ${flat[i]} ${flat[i + 1]}`)
  }
  return parts.join(' ')
}

/** Principle 4 — split compound d, trim origin connectors, emit continuous sub-strokes. */
export function validateDrawingTrajectories(path: VectorPath[]): VectorPath[] {
  const result: VectorPath[] = []

  for (const p of path) {
    const items = splitPathDIntoItems(p.d)
    const sources = items.length > 0 ? items : [p]

    for (const item of sources) {
      const flat = pairsToFlat(parsePathDAll(item.d).flatMap((sp) => sp.points))
      if (flat.length < 4) continue

      let cleaned = trimOriginJump(flat)
      cleaned = removeOriginConnectorSegments(cleaned)
      if (cleaned.length < 4) continue

      const bbox = bboxFromFlat(cleaned)
      result.push({
        d: flatToPathD(cleaned),
        minX: bbox.minX,
        minY: bbox.minY,
        length: computePathLength(cleaned),
      })
    }
  }
  return result
}

/** Full topology pass after layered filtering. */
export function applyPathTopology(
  path: VectorPath[],
  config: TraceConfig,
): VectorPath[] {
  let working = validateDrawingTrajectories(path)
  working = mergeCoincidentPaths(working, config.mergeOverlapThreshold)
  working = removeRedundantCrossings(working)
  working = validateDrawingTrajectories(working)
  return working
}
