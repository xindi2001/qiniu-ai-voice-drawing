import type { TraceSubject } from './pathDedup'

import { bboxOverlapRatio } from './pathDedup'

import { parsePathDAll } from './svgPathParser'

import { bboxFromFlat, pairsToFlat, computePathLength, type FlatBbox } from './pathUtils'

import type { VectorPath } from './pathSorter'

import { rdpSimplify } from './pathSmoother'



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



function pathBbox(path: VectorPath): FlatBbox {

  const flat = pairsToFlat(parsePathDAll(path.d).flatMap((sp) => sp.points))

  return bboxFromFlat(flat.length >= 4 ? flat : [path.minX, path.minY, path.minX, path.minY])

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

  const merged: [number, number][] = [...ptsA, ...ptsB]

  return pathFromPairs(merged)

}



/** RDP simplify each subpath — gentle epsilon preserves silhouettes. */

export function smoothPathsForDrawing(paths: VectorPath[], epsilon = 1.5): VectorPath[] {

  const result: VectorPath[] = []

  for (const path of paths) {

    for (const sp of parsePathDAll(path.d)) {

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

      result.push(pathFromPairs(simplified))

    }

  }

  return result

}



function pathDominantAngle(path: VectorPath): number {

  const pts = pathEndpoints(path).points

  if (pts.length < 2) return 0

  const [x0, y0] = pts[0]

  const [x1, y1] = pts[pts.length - 1]

  return Math.atan2(y1 - y0, x1 - x0)

}



function pathCentroid(path: VectorPath): { x: number; y: number } {

  const bbox = pathBbox(path)

  return { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 }

}



function anglesParallel(a1: number, a2: number, thresholdRad: number): boolean {

  let diff = Math.abs(a1 - a2) % Math.PI

  if (diff > Math.PI / 2) diff = Math.PI - diff

  return diff <= thresholdRad

}



/** Merge only when bbox overlap > 0.9 AND similar length — avoids deleting back contours. */

export function mergeParallelConservative(paths: VectorPath[]): VectorPath[] {

  if (paths.length <= 1) return paths



  const kept = paths.map(() => true)

  const thresholdRad = (12 * Math.PI) / 180



  for (let i = 0; i < paths.length; i++) {

    if (!kept[i]) continue

    const bboxI = pathBbox(paths[i])

    const angleI = pathDominantAngle(paths[i])



    for (let j = i + 1; j < paths.length; j++) {

      if (!kept[j]) continue

      const overlap = bboxOverlapRatio(bboxI, pathBbox(paths[j]))

      if (overlap < 0.9) continue



      const lenRatio = Math.min(paths[i].length, paths[j].length)

        / Math.max(paths[i].length, paths[j].length, 1)

      if (lenRatio < 0.65) continue



      const angleJ = pathDominantAngle(paths[j])

      if (!anglesParallel(angleI, angleJ, thresholdRad)) continue



      if (paths[i].length >= paths[j].length) {

        kept[j] = false

      } else {

        kept[i] = false

        break

      }

    }

  }



  return paths.filter((_, idx) => kept[idx])

}



/** @deprecated Use mergeParallelConservative for Wanx pipeline. */

export function mergeParallelNearbyPaths(

  paths: VectorPath[],

  _angleThresholdDeg = 15,

  _distancePx = 5,

): VectorPath[] {

  return mergeParallelConservative(paths)

}



/** Connect path fragments whose endpoints are within maxGapPx (wheel arc dots → strokes). */

export function mergeNearbyEndpoints(paths: VectorPath[], maxGapPx = 12): VectorPath[] {

  if (paths.length <= 1) return paths



  const merged = [...paths]

  let changed = true



  while (changed) {

    changed = false

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

  }



  return merged

}



/**
 * @deprecated Use repairPathContinuity from pathContinuity.ts — vehicle-only hack.
 * Merge short arc fragments whose centroids cluster in wheel-sized circular regions.
 */
export function detectCircularClusters(paths: VectorPath[]): VectorPath[] {

  const used = new Set<number>()

  const result: VectorPath[] = []



  for (let i = 0; i < paths.length; i++) {

    if (used.has(i)) continue



    const pi = paths[i]

    const bi = pathBbox(pi)

    const w = bi.maxX - bi.minX

    const h = bi.maxY - bi.minY

    const maxDim = Math.max(w, h)



    if (maxDim > 100 || pi.length > 120) {

      result.push(pi)

      used.add(i)

      continue

    }



    const clusterIdx = [i]

    const ci = pathCentroid(pi)



    for (let j = i + 1; j < paths.length; j++) {

      if (used.has(j)) continue

      const pj = paths[j]

      if (pj.length > 120) continue

      const cj = pathCentroid(pj)

      if (Math.hypot(ci.x - cj.x, ci.y - cj.y) <= 50) {

        clusterIdx.push(j)

      }

    }



    if (clusterIdx.length >= 3) {

      const members = clusterIdx.map((idx) => paths[idx])

      let minX = Infinity

      let minY = Infinity

      let maxX = -Infinity

      let maxY = -Infinity

      for (const m of members) {

        const b = pathBbox(m)

        minX = Math.min(minX, b.minX)

        minY = Math.min(minY, b.minY)

        maxX = Math.max(maxX, b.maxX)

        maxY = Math.max(maxY, b.maxY)

      }

      const cw = maxX - minX

      const ch = maxY - minY

      const aspect = Math.max(cw, ch) / Math.max(Math.min(cw, ch), 1)



      if (aspect < 2.0 && cw >= 15 && cw <= 120) {

        for (const idx of clusterIdx) used.add(idx)

        const merged = mergeNearbyEndpoints(members, 12)

        result.push(...merged)

        continue

      }

    }



    result.push(pi)

    used.add(i)

  }



  return result

}



/** Connect endpoints on the longest skeleton paths to bridge small silhouette gaps. */

export function bridgeSmallGaps(paths: VectorPath[], maxGapPx = 25): VectorPath[] {

  if (paths.length <= 1) return paths

  const sorted = [...paths].sort((a, b) => b.length - a.length)

  const skeletonCount = Math.min(15, sorted.length)

  const skeleton = sorted.slice(0, skeletonCount)

  const rest = sorted.slice(skeletonCount)

  const bridged = mergeNearbyEndpoints(skeleton, maxGapPx)

  return [...bridged, ...rest]

}



/** Drop isolated fragments shorter than minPx; never drop strokes >= protectMinPx. */

export function dropIsolatedShortPaths(

  paths: VectorPath[],

  minPx = 8,

  protectMinPx = 40,

): VectorPath[] {

  return paths.filter((p) => p.length >= protectMinPx || p.length >= minPx)

}



/** Re-inject top-N longest paths removed by filters. */

export function protectSilhouettePaths(

  original: VectorPath[],

  filtered: VectorPath[],

  count = 15,

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



/** Pad output up to minFinal by adding longest paths from pool. */

export function enforceMinFinalPaths(

  paths: VectorPath[],

  pool: VectorPath[],

  minFinal: number,

): VectorPath[] {

  if (paths.length >= minFinal) return paths

  const seen = new Set(paths.map((p) => p.d))

  const extras = [...pool]

    .sort((a, b) => b.length - a.length)

    .filter((p) => !seen.has(p.d))

  const result = [...paths]

  for (const p of extras) {

    if (result.length >= minFinal) break

    result.push(p)

    seen.add(p.d)

  }

  return result

}



export interface CanvasCoverageReport {

  bbox: FlatBbox

  canvasW: number

  canvasH: number

  verticalCoverage: number

  horizontalCoverage: number

  incompleteBottom: boolean

  incompleteTop: boolean

}



export function computePathsBbox(paths: VectorPath[]): FlatBbox | null {

  if (paths.length === 0) return null

  let minX = Infinity

  let minY = Infinity

  let maxX = -Infinity

  let maxY = -Infinity

  for (const path of paths) {

    const flat = pairsToFlat(parsePathDAll(path.d).flatMap((sp) => sp.points))

    if (flat.length < 4) continue

    const b = bboxFromFlat(flat)

    minX = Math.min(minX, b.minX)

    minY = Math.min(minY, b.minY)

    maxX = Math.max(maxX, b.maxX)

    maxY = Math.max(maxY, b.maxY)

  }

  if (!Number.isFinite(minX)) return null

  return { minX, minY, maxX, maxY }

}



export function computeCoverageReport(

  paths: VectorPath[],

  canvasW: number,

  canvasH: number,

  subject: TraceSubject = 'default',

): CanvasCoverageReport | null {

  const bbox = computePathsBbox(paths)

  if (!bbox) return null



  const verticalCoverage = (bbox.maxY - bbox.minY) / canvasH

  const horizontalCoverage = (bbox.maxX - bbox.minX) / canvasW

  const bottomMargin = canvasH - bbox.maxY

  const topMargin = bbox.minY



  const incompleteBottom = subject === 'portrait'

    ? bbox.maxY < canvasH * 0.55 || bottomMargin > canvasH * 0.35

    : bbox.maxY < canvasH * 0.45

  const incompleteTop = topMargin > canvasH * 0.25



  return {

    bbox,

    canvasW,

    canvasH,

    verticalCoverage,

    horizontalCoverage,

    incompleteBottom,

    incompleteTop,

  }

}



export function coverageStatus(report: CanvasCoverageReport | null): 'OK' | 'LOW' {

  if (!report) return 'LOW'

  if (report.incompleteBottom || report.incompleteTop) return 'LOW'

  if (report.verticalCoverage < 0.5 || report.horizontalCoverage < 0.4) return 'LOW'

  return 'OK'

}



/** @deprecated Silent — use computeCoverageReport + coverageStatus for logging. */

export function ensureCanvasCoverage(

  paths: VectorPath[],

  canvasW: number,

  canvasH: number,

  subject: TraceSubject = 'default',

): CanvasCoverageReport | null {

  return computeCoverageReport(paths, canvasW, canvasH, subject)

}


