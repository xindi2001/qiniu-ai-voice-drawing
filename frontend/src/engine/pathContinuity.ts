/**
 * General path continuity repair — connect fragmented endpoints within maxGapPx.
 * Replaces subject-specific bridge/merge hacks (horse back, car wheels, etc.).
 */

import { parsePathDAll } from './svgPathParser'
import { bboxFromFlat, pairsToFlat, computePathLength } from './pathUtils'
import type { VectorPath } from './pathSorter'

function pathFromPairs(pairs: [number, number][]): VectorPath {
  const flat = pairsToFlat(pairs)
  const bbox = bboxFromFlat(flat)
  return {
    d: pairs.map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)).join(' '),
    minX: bbox.minX,
    minY: bbox.minY,
    length: computePathLength(flat),
  }
}

function pathEndpoints(path: VectorPath): {
  start: [number, number]
  end: [number, number]
  points: [number, number][]
} {
  const pts = parsePathDAll(path.d)[0]?.points ?? []
  if (pts.length === 0) {
    return { start: [path.minX, path.minY], end: [path.minX, path.minY], points: [] }
  }
  return { start: pts[0], end: pts[pts.length - 1], points: pts }
}

function joinPathsAtEndpoints(
  a: VectorPath,
  b: VectorPath,
  reverseA: boolean,
  reverseB: boolean,
): VectorPath {
  let ptsA = pathEndpoints(a).points
  let ptsB = pathEndpoints(b).points
  if (reverseA) ptsA = [...ptsA].reverse()
  if (reverseB) ptsB = [...ptsB].reverse()
  return pathFromPairs([...ptsA, ...ptsB])
}

/** One greedy merge sweep — returns merged paths and whether any merge occurred. */
function mergePass(paths: VectorPath[], maxGapPx: number): { paths: VectorPath[]; merged: boolean } {
  const merged = [...paths]
  let changed = false

  outer:
  for (let i = 0; i < merged.length; i++) {
    const epA = pathEndpoints(merged[i])
    for (let j = i + 1; j < merged.length; j++) {
      const epB = pathEndpoints(merged[j])
      const pairs: [boolean, boolean, number][] = [
        [false, false, Math.hypot(epA.end[0] - epB.start[0], epA.end[1] - epB.start[1])],
        [false, true, Math.hypot(epA.end[0] - epB.end[0], epA.end[1] - epB.end[1])],
        [true, false, Math.hypot(epA.start[0] - epB.start[0], epA.start[1] - epB.start[1])],
        [true, true, Math.hypot(epA.start[0] - epB.end[0], epA.start[1] - epB.end[1])],
      ]
      for (const [revA, revB, dist] of pairs) {
        if (dist <= maxGapPx) {
          merged[i] = joinPathsAtEndpoints(merged[i], merged[j], revA, revB)
          merged.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
  }

  return { paths: merged, merged: changed }
}

/**
 * Connect path fragments whose endpoints are within maxGapPx.
 * Runs up to maxPasses merge sweeps until no merges occur.
 */
export function repairPathContinuity(
  paths: VectorPath[],
  maxGapPx: number,
  maxPasses = 3,
): VectorPath[] {
  if (paths.length <= 1 || maxGapPx <= 0) return paths

  let result = paths
  for (let pass = 0; pass < maxPasses; pass++) {
    let mergedThisPass = false
    let changed = true
    while (changed) {
      const step = mergePass(result, maxGapPx)
      result = step.paths
      changed = step.merged
      if (changed) mergedThisPass = true
    }
    if (!mergedThisPass) break
  }

  return result
}
