import type { VectorPath } from './pathSorter'

import type { PointPair } from '../types/commands'

import ImageTracer from 'imagetracerjs'

import { PIPELINE_CONFIG, PIPELINE_V4, SKETCH_COLOR_CONFIG } from '../constants/traceConfig'
import { extractEdgePathsFromCanvas } from './edgeVectorizer'
import { createAnalysisWorkspace, type AnalysisWorkspace } from './analysisWorkspace'
import { normalizeToLineArt } from './lineArtNormalize'
import { filterShadingNoise } from './pathNoiseFilters'
import {
  isHorizontalHatchPath,
  isOrphanHorizontalLine,
  isVerticalHatchPath,
} from './pathSmoother'
import { parsePathDAll } from './svgPathParser'
import { extractPathsFromSvg, splitPathDIntoItems } from './pathSorter'
import { isCanvasBorderArtifact } from './pathUtils'

export interface RegionVectorizeResult {

  paths: VectorPath[]

  colorCount: number

  regionCount: number

}

/** One semantic color region ??closed polygon for fill animation. */

export interface ColorRegion {

  colorIndex: number

  color: string

  points: PointPair[]

  area: number

}

export interface ColorRegionExtractResult {

  boundaryPaths: VectorPath[]

  regions: ColorRegion[]

  palette: string[]

  colorCount: number

  outlineColor: string

}

function luminance(r: number, g: number, b: number): number {

  return 0.299 * r + 0.587 * g + 0.114 * b

}

function hexLuminance(hex: string): number {

  const h = hex.replace('#', '')

  if (h.length < 6) return 128

  const r = parseInt(h.slice(0, 2), 16)

  const g = parseInt(h.slice(2, 4), 16)

  const b = parseInt(h.slice(4, 6), 16)

  return luminance(r, g, b)

}

const DARK_FILL_FALLBACK = '#3d2b1f'

const BG_LUMINANCE_THRESHOLD = 240

const MIN_SEMANTIC_FILL_REGIONS = 4

const MAX_SEMANTIC_FILL_REGIONS = 12

/** Only darken fills when the sampled source color is genuinely dark (not vibrant dark greens/blues). */
export function safeRegionFillColor(hex: string): string {

  const normalized = hex.trim().toLowerCase()

  const lum = hexLuminance(hex)

  if (normalized === '#000' || normalized === '#000000') {

    return lum < 20 ? '#1a1a1a' : hex

  }

  if (lum < 18) return DARK_FILL_FALLBACK

  return hex

}

function parseHexRgb(hex: string): [number, number, number] | null {

  const h = hex.replace('#', '')

  if (h.length < 6) return null

  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]

}

function rgbSaturation(r: number, g: number, b: number): number {

  const max = Math.max(r, g, b)

  const min = Math.min(r, g, b)

  return max === 0 ? 0 : (max - min) / max

}

function rgbHue(r: number, g: number, b: number): number {

  const max = Math.max(r, g, b)

  const min = Math.min(r, g, b)

  const d = max - min

  if (d < 1e-6) return 0

  let h = 0

  if (max === r) h = ((g - b) / d) % 6

  else if (max === g) h = (b - r) / d + 2

  else h = (r - g) / d + 4

  return ((h * 60) + 360) % 360

}

function hueDiff(a: number, b: number): number {

  const d = Math.abs(a - b)

  return d > 180 ? 360 - d : d

}

function hexHue(hex: string): number {

  const rgb = parseHexRgb(hex)

  return rgb ? rgbHue(rgb[0], rgb[1], rgb[2]) : 0

}

function isNearBackground(r: number, g: number, b: number, threshold = BG_LUMINANCE_THRESHOLD): boolean {

  return luminance(r, g, b) > threshold

}

function huesCompatible(

  palette: [number, number, number][],

  fromIdx: number,

  toIdx: number,

): boolean {

  const [r1, g1, b1] = palette[fromIdx]

  const [r2, g2, b2] = palette[toIdx]

  const sat1 = rgbSaturation(r1, g1, b1)

  const sat2 = rgbSaturation(r2, g2, b2)

  if (sat1 < 0.12 && sat2 < 0.12) return true

  return hueDiff(rgbHue(r1, g1, b1), rgbHue(r2, g2, b2)) < 35

}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {

  let rr = r / 255

  let gg = g / 255

  let bb = b / 255

  rr = rr > 0.04045 ? ((rr + 0.055) / 1.055) ** 2.4 : rr / 12.92

  gg = gg > 0.04045 ? ((gg + 0.055) / 1.055) ** 2.4 : gg / 12.92

  bb = bb > 0.04045 ? ((bb + 0.055) / 1.055) ** 2.4 : bb / 12.92

  const x = (rr * 0.4124 + gg * 0.3576 + bb * 0.1805) / 0.95047

  const y = (rr * 0.2126 + gg * 0.7152 + bb * 0.0722) / 1.0

  const z = (rr * 0.0193 + gg * 0.1192 + bb * 0.9505) / 1.08883

  const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116

  const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116

  const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]

}

function deltaE(

  a: [number, number, number],

  b: [number, number, number],

): number {

  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

}

/** Simple k-means on RGB samples ??good enough for flat Wanx art. */

function buildPalette(

  data: Uint8ClampedArray,

  w: number,

  h: number,

  k: number,

): [number, number, number][] {

  const samples: [number, number, number][] = []

  const step = Math.max(1, Math.floor((w * h) / 2000))

  for (let i = 0; i < w * h; i += step) {

    const p = i * 4

    if (data[p + 3] < 128) continue

    samples.push([data[p], data[p + 1], data[p + 2]])

  }

  if (samples.length === 0) return [[0, 0, 0]]

  let centroids = samples.slice(0, Math.min(k, samples.length))

  while (centroids.length < k) {

    centroids.push(samples[Math.floor(Math.random() * samples.length)])

  }

  for (let iter = 0; iter < 8; iter++) {

    const buckets: [number, number, number][][] = Array.from({ length: k }, () => [])

    for (const s of samples) {

      let best = 0

      let bestDist = Infinity

      for (let c = 0; c < k; c++) {

        const [cr, cg, cb] = centroids[c]

        const d = (s[0] - cr) ** 2 + (s[1] - cg) ** 2 + (s[2] - cb) ** 2

        if (d < bestDist) {

          bestDist = d

          best = c

        }

      }

      buckets[best].push(s)

    }

    centroids = centroids.map((c, ci) => {

      const b = buckets[ci]

      if (b.length === 0) return c

      const sum = b.reduce(

        (acc, [r, g, bb]) => [acc[0] + r, acc[1] + g, acc[2] + bb] as [number, number, number],

        [0, 0, 0],

      )

      return [

        Math.round(sum[0] / b.length),

        Math.round(sum[1] / b.length),

        Math.round(sum[2] / b.length),

      ]

    })

  }

  return centroids

}

function assignColorIndex(

  data: Uint8ClampedArray,

  w: number,

  h: number,

  palette: [number, number, number][],

): Int32Array {

  const out = new Int32Array(w * h).fill(-1)

  for (let y = 0; y < h; y++) {

    for (let x = 0; x < w; x++) {

      const p = (y * w + x) * 4

      const r = data[p]

      const g = data[p + 1]

      const b = data[p + 2]

      if (data[p + 3] < 128) {

        out[y * w + x] = -1

        continue

      }

      let best = 0

      let bestDist = Infinity

      for (let c = 0; c < palette.length; c++) {

        const [cr, cg, cb] = palette[c]

        const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2

        if (d < bestDist) {

          bestDist = d

          best = c

        }

      }

      out[y * w + x] = best

    }

  }

  return out

}

/** Merge palette entries with ?E < threshold and remap pixel indices. */

function mergeSimilarPaletteColors(

  palette: [number, number, number][],

  colorIndex: Int32Array,

  maxDeltaE: number,

): [number, number, number][] {

  const n = palette.length

  const remap = new Array<number>(n).fill(-1)

  const newPalette: [number, number, number][] = []

  const labs = palette.map(([r, g, b]) => rgbToLab(r, g, b))

  for (let i = 0; i < n; i++) {

    if (remap[i] >= 0) continue

    const group = [i]

    for (let j = i + 1; j < n; j++) {

      if (remap[j] >= 0) continue

      if (deltaE(labs[i], labs[j]) < maxDeltaE && huesCompatible(palette, i, j)) group.push(j)

    }

    const newIdx = newPalette.length

    let sr = 0

    let sg = 0

    let sb = 0

    for (const gi of group) {

      remap[gi] = newIdx

      sr += palette[gi][0]

      sg += palette[gi][1]

      sb += palette[gi][2]

    }

    newPalette.push([

      Math.round(sr / group.length),

      Math.round(sg / group.length),

      Math.round(sb / group.length),

    ])

  }

  for (let i = 0; i < colorIndex.length; i++) {

    const c = colorIndex[i]

    if (c >= 0) colorIndex[i] = remap[c]

  }

  return newPalette

}

function floodFillComponentPixels(

  colorIndex: Int32Array,

  w: number,

  h: number,

  startX: number,

  startY: number,

  targetColor: number,

  globalVisited: Uint8Array,

): Set<number> {

  const stack: [number, number][] = [[startX, startY]]

  const local = new Set<number>()

  while (stack.length > 0) {

    const [x, y] = stack.pop()!

    const idx = y * w + x

    if (x < 0 || y < 0 || x >= w || y >= h) continue

    if (globalVisited[idx] || colorIndex[idx] !== targetColor) continue

    globalVisited[idx] = 1

    local.add(idx)

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])

  }

  return local

}

/** Merge connected components smaller than minAreaRatio into the most common neighbor (hue-aware). */

function mergeSmallComponents(

  colorIndex: Int32Array,

  w: number,

  h: number,

  minAreaRatio: number,

  palette?: [number, number, number][],

): void {

  const minPixels = Math.max(8, Math.floor(w * h * minAreaRatio))

  for (let pass = 0; pass < 8; pass++) {

    const globalVisited = new Uint8Array(w * h)

    let changed = false

    for (let y = 0; y < h; y++) {

      for (let x = 0; x < w; x++) {

        const idx = y * w + x

        const c = colorIndex[idx]

        if (c < 0 || globalVisited[idx]) continue

        const component = floodFillComponentPixels(colorIndex, w, h, x, y, c, globalVisited)

        if (component.size >= minPixels) continue

        const neighborCounts = new Map<number, number>()

        for (const pi of component) {

          const px = pi % w

          const py = Math.floor(pi / w)

          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {

            const nx = px + dx

            const ny = py + dy

            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue

            const ni = ny * w + nx

            const nc = colorIndex[ni]

            if (nc >= 0 && nc !== c && !component.has(ni)) {

              neighborCounts.set(nc, (neighborCounts.get(nc) ?? 0) + 1)

            }

          }

        }

        if (neighborCounts.size === 0) continue

        let bestNeighbor = -1

        let bestCount = 0

        for (const [nc, cnt] of neighborCounts) {

          if (palette && !huesCompatible(palette, c, nc)) continue

          if (cnt > bestCount) {

            bestCount = cnt

            bestNeighbor = nc

          }

        }

        if (bestNeighbor < 0) continue

        for (const pi of component) colorIndex[pi] = bestNeighbor

        changed = true

      }

    }

    if (!changed) break

  }

}

function isBoundary(

  index: Int32Array,

  w: number,

  h: number,

  x: number,

  y: number,

): boolean {

  const c = index[y * w + x]

  if (c < 0) return false

  const neighbors = [

    [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],

  ]

  for (const [nx, ny] of neighbors) {

    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return true

    const nc = index[ny * w + nx]

    if (nc < 0 || nc !== c) return true

  }

  return false

}

const MOORE = [

  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],

]

function traceBoundaryLoop(

  index: Int32Array,

  w: number,

  h: number,

  startX: number,

  startY: number,

  visited: Uint8Array,

): PointPair[] {

  const points: PointPair[] = [[startX + 0.5, startY + 0.5]]

  visited[startY * w + startX] = 1

  let x = startX

  let y = startY

  let dir = 0

  const maxSteps = w * h * 2

  let steps = 0

  while (steps++ < maxSteps) {

    let moved = false

    for (let d = 0; d < 8; d++) {

      const nd = (dir + d) % 8

      const [dx, dy] = MOORE[nd]

      const nx = x + dx

      const ny = y + dy

      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue

      if (!isBoundary(index, w, h, nx, ny)) continue

      if (visited[ny * w + nx] && (nx !== startX || ny !== startY)) continue

      x = nx

      y = ny

      dir = (nd + 6) % 8

      if (x === startX && y === startY && points.length > 3) {

        return points

      }

      if (!visited[y * w + x]) {

        visited[y * w + x] = 1

        points.push([x + 0.5, y + 0.5])

      }

      moved = true

      break

    }

    if (!moved) break

    if (x === startX && y === startY && points.length > 3) break

  }

  return points

}

function simplifyRdp(points: PointPair[], epsilon: number): PointPair[] {

  if (points.length <= 2) return points

  function perpDist(p: PointPair, a: PointPair, b: PointPair): number {

    const dx = b[0] - a[0]

    const dy = b[1] - a[1]

    const len = Math.hypot(dx, dy)

    if (len < 1e-6) return Math.hypot(p[0] - a[0], p[1] - a[1])

    return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len

  }

  function rdp(pts: PointPair[]): PointPair[] {

    if (pts.length <= 2) return pts

    let maxD = 0

    let idx = 0

    const first = pts[0]

    const last = pts[pts.length - 1]

    for (let i = 1; i < pts.length - 1; i++) {

      const d = perpDist(pts[i], first, last)

      if (d > maxD) {

        maxD = d

        idx = i

      }

    }

    if (maxD <= epsilon) return [first, last]

    const left = rdp(pts.slice(0, idx + 1))

    const right = rdp(pts.slice(idx))

    return [...left.slice(0, -1), ...right]

  }

  return rdp(points)

}

function pairsToPathD(points: PointPair[], closed: boolean): string {

  if (points.length === 0) return ''

  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`

  for (let i = 1; i < points.length; i++) {

    d += ` L ${points[i][0].toFixed(1)} ${points[i][1].toFixed(1)}`

  }

  if (closed) d += ' Z'

  return d

}

function pathLengthFromPairs(points: PointPair[]): number {

  let len = 0

  for (let i = 1; i < points.length; i++) {

    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])

  }

  return len

}

function bboxFromPairs(points: PointPair[]): { minX: number; minY: number; maxX: number; maxY: number } {

  const xs = points.map((p) => p[0])

  const ys = points.map((p) => p[1])

  return {

    minX: Math.min(...xs),

    minY: Math.min(...ys),

    maxX: Math.max(...xs),

    maxY: Math.max(...ys),

  }

}

function edgeCanonicalKey(d: string): string {

  const parts = d.replace(/[MLZ]/gi, ' ').trim().split(/\s+/).filter(Boolean)

  if (parts.length < 4) return d.replace(/\s+/g, ' ').trim()

  const coords: string[] = []

  for (let i = 0; i + 1 < parts.length; i += 2) {

    coords.push(`${Math.round(parseFloat(parts[i]))},${Math.round(parseFloat(parts[i + 1]))}`)

  }

  const forward = coords.join('|')

  const reverse = [...coords].reverse().join('|')

  return forward < reverse ? forward : reverse

}

function dedupePaths(paths: VectorPath[]): VectorPath[] {

  const seen = new Set<string>()

  const out: VectorPath[] = []

  for (const p of paths) {

    const key = edgeCanonicalKey(p.d)

    if (seen.has(key)) continue

    seen.add(key)

    out.push(p)

  }

  return out

}

/** Prefer long paths but spread picks across a 3×3 grid so head/hind regions are not dropped. */
function selectPathsWithSpatialCoverage(
  paths: VectorPath[],
  maxStrokes: number,
  w: number,
  h: number,
): VectorPath[] {
  if (paths.length <= maxStrokes) return paths

  const cols = 3
  const rows = 3
  const buckets: VectorPath[][] = Array.from({ length: cols * rows }, () => [])

  for (const p of paths) {
    const subs = parsePathDAll(p.d)[0]?.points ?? []
    if (subs.length === 0) {
      buckets[0].push(p)
      continue
    }
    const bbox = bboxFromPairs(subs)
    const cx = (bbox.minX + bbox.maxX) / 2
    const cy = (bbox.minY + bbox.maxY) / 2
    const col = Math.min(cols - 1, Math.max(0, Math.floor((cx / w) * cols)))
    const row = Math.min(rows - 1, Math.max(0, Math.floor((cy / h) * rows)))
    buckets[row * cols + col].push(p)
  }

  for (const bucket of buckets) {
    bucket.sort((a, b) => b.length - a.length || (b.minX + b.minY) - (a.minX + a.minY))
  }

  const selected: VectorPath[] = []
  const selectedKeys = new Set<string>()
  let round = 0
  while (selected.length < maxStrokes) {
    let added = false
    for (const bucket of buckets) {
      if (round >= bucket.length || selected.length >= maxStrokes) continue
      const p = bucket[round]
      const key = edgeCanonicalKey(p.d)
      if (selectedKeys.has(key)) continue
      selectedKeys.add(key)
      selected.push(p)
      added = true
    }
    if (!added) break
    round++
  }

  if (selected.length < maxStrokes) {
    const rest = paths
      .filter((p) => !selectedKeys.has(edgeCanonicalKey(p.d)))
      .sort((a, b) => b.length - a.length || (b.minX + b.minY) - (a.minX + a.minY))
    for (const p of rest) {
      if (selected.length >= maxStrokes) break
      selected.push(p)
    }
  }

  return selected
}

function loopsToBoundaryPaths(

  rawLoops: PointPair[][],

  minLengthPx: number,

  rdpEpsilon: number,

  maxStrokes: number,

  w: number,

  h: number,

): VectorPath[] {

  const paths: VectorPath[] = []

  for (const loop of rawLoops) {

    const simplified = simplifyRdp(loop, rdpEpsilon)

    if (simplified.length < 2) continue

    const len = pathLengthFromPairs(simplified)

    if (len < minLengthPx) continue

    const closed = Math.hypot(

      simplified[0][0] - simplified[simplified.length - 1][0],

      simplified[0][1] - simplified[simplified.length - 1][1],

    ) < 3

    const d = pairsToPathD(simplified, closed)

    const bbox = bboxFromPairs(simplified)

    paths.push({

      d,

      minX: bbox.minX,

      minY: bbox.minY,

      length: len,

    })

  }

  const deduped = dedupePaths(paths)

  deduped.sort((a, b) => b.length - a.length || (b.minX + b.minY) - (a.minX + a.minY))

  return selectPathsWithSpatialCoverage(deduped, maxStrokes, w, h)

}

function traceSemanticBoundaries(

  colorIndex: Int32Array,

  w: number,

  h: number,

  minLengthPx: number,

): PointPair[][] {

  const visited = new Uint8Array(w * h)

  const rawLoops: PointPair[][] = []

  for (let y = 0; y < h; y++) {

    for (let x = 0; x < w; x++) {

      const i = y * w + x

      if (visited[i] || !isBoundary(colorIndex, w, h, x, y)) continue

      const loop = traceBoundaryLoop(colorIndex, w, h, x, y, visited)

      if (loop.length >= 4 && pathLengthFromPairs(loop) >= minLengthPx) {

        rawLoops.push(loop)

      }

    }

  }

  return rawLoops

}

function traceComponentOutline(

  component: Set<number>,

  w: number,

  h: number,

): PointPair[] {

  const mask = new Int32Array(w * h).fill(-1)

  for (const idx of component) {

    mask[idx] = 0

  }

  const visited = new Uint8Array(w * h)

  for (let y = 0; y < h; y++) {

    for (let x = 0; x < w; x++) {

      const i = y * w + x

      if (visited[i] || !isBoundary(mask, w, h, x, y)) continue

      const loop = traceBoundaryLoop(mask, w, h, x, y, visited)

      if (loop.length >= 4 && pathLengthFromPairs(loop) >= 8) {

        const simplified = simplifyRdp(loop, 1.5)

        if (simplified.length >= 3) return simplified

      }

    }

  }

  return []

}

function findAllComponentsForColor(

  colorIndex: Int32Array,

  w: number,

  h: number,

  targetColor: number,

): Set<number>[] {

  const globalVisited = new Uint8Array(w * h)

  const components: Set<number>[] = []

  for (let y = 0; y < h; y++) {

    for (let x = 0; x < w; x++) {

      const idx = y * w + x

      if (globalVisited[idx] || colorIndex[idx] !== targetColor) continue

      components.push(

        floodFillComponentPixels(colorIndex, w, h, x, y, targetColor, globalVisited),

      )

    }

  }

  return components

}

function kMeansOnSamples(

  samples: [number, number, number][],

  k: number,

): [number, number, number][] {

  if (samples.length === 0) return [[128, 128, 128]]

  let centroids = samples.slice(0, Math.min(k, samples.length))

  while (centroids.length < k) {

    centroids.push(samples[Math.floor(Math.random() * samples.length)])

  }

  for (let iter = 0; iter < 6; iter++) {

    const buckets: [number, number, number][][] = Array.from({ length: k }, () => [])

    for (const s of samples) {

      let best = 0

      let bestDist = Infinity

      for (let c = 0; c < k; c++) {

        const [cr, cg, cb] = centroids[c]

        const d = (s[0] - cr) ** 2 + (s[1] - cg) ** 2 + (s[2] - cb) ** 2

        if (d < bestDist) {

          bestDist = d

          best = c

        }

      }

      buckets[best].push(s)

    }

    centroids = centroids.map((c, ci) => {

      const b = buckets[ci]

      if (b.length === 0) return c

      const sum = b.reduce(

        (acc, [r, g, bb]) => [acc[0] + r, acc[1] + g, acc[2] + bb] as [number, number, number],

        [0, 0, 0],

      )

      return [Math.round(sum[0] / b.length), Math.round(sum[1] / b.length), Math.round(sum[2] / b.length)]

    })

  }

  return centroids

}

function splitOversizedComponent(

  component: Set<number>,

  originalData: Uint8ClampedArray,

  w: number,

  h: number,

  minPixels: number,

): ColorRegion[] {

  const samples: [number, number, number][] = []

  const indices: number[] = []

  for (const idx of component) {

    const p = idx * 4

    if (originalData[p + 3] < 128) continue

    samples.push([originalData[p], originalData[p + 1], originalData[p + 2]])

    indices.push(idx)

  }

  if (samples.length < minPixels * 2) return []

  const k = Math.min(4, Math.max(2, Math.ceil(component.size / (minPixels * 3))))

  const centroids = kMeansOnSamples(samples, k)

  const subComponents: Set<number>[] = Array.from({ length: k }, () => new Set())

  for (let i = 0; i < samples.length; i++) {

    const s = samples[i]

    let best = 0

    let bestDist = Infinity

    for (let c = 0; c < k; c++) {

      const [cr, cg, cb] = centroids[c]

      const d = (s[0] - cr) ** 2 + (s[1] - cg) ** 2 + (s[2] - cb) ** 2

      if (d < bestDist) {

        bestDist = d

        best = c

      }

    }

    subComponents[best].add(indices[i])

  }

  const regions: ColorRegion[] = []

  for (let ci = 0; ci < k; ci++) {

    const sub = subComponents[ci]

    if (sub.size < minPixels) continue

    const points = traceComponentOutline(sub, w, h)

    if (points.length < 3) continue

    const color = medianColorFromComponent(sub, originalData)

    regions.push({ colorIndex: ci, color, points, area: sub.size })

  }

  return regions

}

function logFillRegion(index: number, color: string, areaPct: string): void {

  console.log(

    `[regionVectorizer] fill[${index}] color=${color} area=${areaPct}% hue=${hexHue(color).toFixed(0)}`,

  )

}

function medianColorFromComponent(

  component: Set<number>,

  data: Uint8ClampedArray,

): string {

  const rs: number[] = []

  const gs: number[] = []

  const bs: number[] = []

  for (const idx of component) {

    const p = idx * 4

    if (data[p + 3] < 128) continue

    rs.push(data[p])

    gs.push(data[p + 1])

    bs.push(data[p + 2])

  }

  if (rs.length === 0) return '#888888'

  rs.sort((a, b) => a - b)

  gs.sort((a, b) => a - b)

  bs.sort((a, b) => a - b)

  const mid = Math.floor(rs.length / 2)

  return rgbToHex(rs[mid], gs[mid], bs[mid])

}

function sampleDarkestOutlineColor(

  data: Uint8ClampedArray,

  colorIndex: Int32Array,

  w: number,

  h: number,

): string {

  let darkest = 255

  let rgb: [number, number, number] = [42, 42, 42]

  for (let y = 0; y < h; y++) {

    for (let x = 0; x < w; x++) {

      if (!isBoundary(colorIndex, w, h, x, y)) continue

      const p = (y * w + x) * 4

      const r = data[p]

      const g = data[p + 1]

      const b = data[p + 2]

      const lum = luminance(r, g, b)

      if (lum > 240) continue

      if (lum < darkest) {

        darkest = lum

        rgb = [r, g, b]

      }

    }

  }

  if (darkest > 100) return '#2a2a2a'

  return rgbToHex(rgb[0], rgb[1], rgb[2])

}

/** One fill polygon per connected color component ? sample median from original pixels. */

function extractSemanticFillRegions(

  colorIndex: Int32Array,

  w: number,

  h: number,

  originalData: Uint8ClampedArray,

  minAreaRatio: number,

  maxAreaRatio = PIPELINE_CONFIG.maxRegionFillAreaRatio,

): ColorRegion[] {

  const minPixels = Math.max(16, Math.floor(w * h * minAreaRatio))

  const maxPixels = Math.floor(w * h * maxAreaRatio)

  const canvasArea = w * h

  const colorIds = new Set<number>()

  for (let i = 0; i < w * h; i++) {

    if (colorIndex[i] >= 0) colorIds.add(colorIndex[i])

  }

  const regions: ColorRegion[] = []

  for (const c of colorIds) {

    const components = findAllComponentsForColor(colorIndex, w, h, c)

    for (const component of components) {

      if (component.size < minPixels) continue

      if (component.size > maxPixels) {

        const median = medianColorFromComponent(component, originalData)

        const medianLum = hexLuminance(median)

        if (medianLum > 200) {

          console.warn(

            `[regionVectorizer] skip background-like giant fill color=${median}`

            + ` area=${((component.size / canvasArea) * 100).toFixed(1)}%`,

          )

          continue

        }

        const splitRegions = splitOversizedComponent(component, originalData, w, h, minPixels)

        if (splitRegions.length > 0) {

          regions.push(...splitRegions)

          continue

        }

        console.warn(

          `[regionVectorizer] split failed for giant fill color=${c}`

          + ` area=${((component.size / canvasArea) * 100).toFixed(1)}%`,

        )

        continue

      }

      const points = traceComponentOutline(component, w, h)

      if (points.length < 3) continue

      const color = medianColorFromComponent(component, originalData)

      regions.push({ colorIndex: c, color, points, area: component.size })

    }

  }

  regions.sort((a, b) => hexLuminance(a.color) - hexLuminance(b.color))

  regions.forEach((r, i) => {

    logFillRegion(i, r.color, ((r.area / canvasArea) * 100).toFixed(1))

  })

  return regions

}

function rgbToHex(r: number, g: number, b: number): string {

  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

}

export interface AdaptiveRegionOptions {

  style: 'flat_cartoon' | 'grayscale_illustration' | 'color_illustration' | 'photo_like'

  maxFillRegions: number

  maxOutlineStrokes: number

  minAreaRatio: number

  simplifyEpsilon: number

  includeBoundaries: boolean

}

/** k-means on luminance samples ? tone layers for grayscale illustrations. */

function buildLuminancePalette(

  data: Uint8ClampedArray,

  w: number,

  h: number,

  k: number,

): number[] {

  const samples: number[] = []

  const step = Math.max(1, Math.floor((w * h) / 2000))

  for (let i = 0; i < w * h; i += step) {

    const p = i * 4

    if (data[p + 3] < 128) continue

    samples.push(luminance(data[p], data[p + 1], data[p + 2]))

  }

  if (samples.length === 0) return [48, 96, 144, 192]

  samples.sort((a, b) => a - b)

  let centroids: number[] = []

  for (let c = 0; c < k; c++) {

    const idx = Math.floor(((c + 0.5) * samples.length) / k)

    centroids.push(samples[Math.min(idx, samples.length - 1)])

  }

  for (let iter = 0; iter < 6; iter++) {

    const buckets: number[][] = Array.from({ length: k }, () => [])

    for (const s of samples) {

      let best = 0

      let bestDist = Infinity

      for (let c = 0; c < k; c++) {

        const d = Math.abs(s - centroids[c])

        if (d < bestDist) {

          bestDist = d

          best = c

        }

      }

      buckets[best].push(s)

    }

    centroids = centroids.map((c, ci) => {

      const b = buckets[ci]

      return b.length > 0 ? b.reduce((acc, v) => acc + v, 0) / b.length : c

    })

  }

  return [...centroids].sort((a, b) => a - b)

}

function assignLuminanceIndex(

  data: Uint8ClampedArray,

  w: number,

  h: number,

  tones: number[],

): Int32Array {

  const out = new Int32Array(w * h).fill(-1)

  for (let y = 0; y < h; y++) {

    for (let x = 0; x < w; x++) {

      const p = (y * w + x) * 4

      const r = data[p]

      const g = data[p + 1]

      const b = data[p + 2]

      if (data[p + 3] < 128) {

        out[y * w + x] = -1

        continue

      }

      const lum = luminance(r, g, b)

      let best = 0

      let bestDist = Infinity

      for (let c = 0; c < tones.length; c++) {

        const d = Math.abs(lum - tones[c])

        if (d < bestDist) {

          bestDist = d

          best = c

        }

      }

      out[y * w + x] = best

    }

  }

  return out

}

function isolateLargestForegroundComponent(

  data: Uint8ClampedArray,

  w: number,

  h: number,

  threshold = 175,

): Set<number> {

  const mask = new Uint8Array(w * h)

  for (let i = 0; i < w * h; i++) {

    const p = i * 4

    const lum = luminance(data[p], data[p + 1], data[p + 2])

    mask[i] = (data[p + 3] >= 128 && lum < threshold && lum < 248) ? 1 : 0

  }

  const labels = new Int32Array(w * h)

  let nextLabel = 1

  const sizes = new Map<number, number>()

  for (let y = 0; y < h; y++) {

    for (let x = 0; x < w; x++) {

      const idx = y * w + x

      if (mask[idx] !== 1 || labels[idx] !== 0) continue

      const label = nextLabel++

      const queue = [idx]

      labels[idx] = label

      let size = 0

      while (queue.length > 0) {

        const cur = queue.pop()!

        size++

        const cx = cur % w

        const cy = Math.floor(cur / w)

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {

          const nx = cx + dx

          const ny = cy + dy

          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue

          const nIdx = ny * w + nx

          if (mask[nIdx] === 1 && labels[nIdx] === 0) {

            labels[nIdx] = label

            queue.push(nIdx)

          }

        }

      }

      sizes.set(label, size)

    }

  }

  if (sizes.size === 0) return new Set()

  let bestLabel = 1

  let bestSize = 0

  for (const [label, size] of sizes) {

    if (size > bestSize) {

      bestSize = size

      bestLabel = label

    }

  }

  const component = new Set<number>()

  for (let i = 0; i < labels.length; i++) {

    if (labels[i] === bestLabel) component.add(i)

  }

  return component

}

const MIN_SUBJECT_COMPONENT_RATIO = 0.02

/** Union of all foreground blobs >= minAreaRatio (keeps legs, tail, etc.). */
function isolateSignificantForegroundComponents(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  minAreaRatio = MIN_SUBJECT_COMPONENT_RATIO,
  threshold = 175,
): Set<number> {
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    const lum = luminance(data[p], data[p + 1], data[p + 2])
    mask[i] = (data[p + 3] >= 128 && lum < threshold && lum < 248) ? 1 : 0
  }

  const minPixels = Math.max(24, Math.floor(w * h * minAreaRatio))
  const union = new Set<number>()
  const labels = new Int32Array(w * h)
  let nextLabel = 1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (mask[idx] !== 1 || labels[idx] !== 0) continue
      const label = nextLabel++
      const queue = [idx]
      const component = new Set<number>()
      labels[idx] = label
      while (queue.length > 0) {
        const cur = queue.pop()!
        component.add(cur)
        const cx = cur % w
        const cy = Math.floor(cur / w)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const nIdx = ny * w + nx
          if (mask[nIdx] === 1 && labels[nIdx] === 0) {
            labels[nIdx] = label
            queue.push(nIdx)
          }
        }
      }
      if (component.size >= minPixels) {
        for (const cur of component) union.add(cur)
      }
    }
  }

  if (union.size > 0) return union
  return isolateLargestForegroundComponent(data, w, h, threshold)
}

export interface SubjectBlobInfo {

  count: number

  /** Pixel indices per blob >= minAreaRatio. */

  blobs: Set<number>[]

}

/** Detect disconnected foreground blobs (multi-character Wanx output). */

export function detectLargeSubjectBlobs(

  canvas: HTMLCanvasElement,

  minAreaRatio = 0.05,

): SubjectBlobInfo {

  const w = canvas.width

  const h = canvas.height

  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const data = ctx.getImageData(0, 0, w, h).data

  const minPixels = Math.floor(w * h * minAreaRatio)

  const mask = new Uint8Array(w * h)

  for (let i = 0; i < w * h; i++) {

    const p = i * 4

    mask[i] = (data[p + 3] >= 128 && !isNearBackground(data[p], data[p + 1], data[p + 2])) ? 1 : 0

  }

  const labels = new Int32Array(w * h)

  const blobs: Set<number>[] = []

  let nextLabel = 1

  for (let y = 0; y < h; y++) {

    for (let x = 0; x < w; x++) {

      const idx = y * w + x

      if (mask[idx] !== 1 || labels[idx] !== 0) continue

      const label = nextLabel++

      const queue = [idx]

      labels[idx] = label

      const blob = new Set<number>()

      while (queue.length > 0) {

        const cur = queue.pop()!

        blob.add(cur)

        const cx = cur % w

        const cy = Math.floor(cur / w)

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {

          const nx = cx + dx

          const ny = cy + dy

          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue

          const nIdx = ny * w + nx

          if (mask[nIdx] === 1 && labels[nIdx] === 0) {

            labels[nIdx] = label

            queue.push(nIdx)

          }

        }

      }

      if (blob.size >= minPixels) blobs.push(blob)

    }

  }

  if (blobs.length > 1) {

    console.warn(

      `[regionVectorizer] multi-subject detected: ${blobs.length} blobs >= ${(minAreaRatio * 100).toFixed(0)}%`,

    )

  }

  return { count: blobs.length, blobs }

}

/** Keep pixels inside every foreground blob >= minAreaRatio (not just the largest). */

export function maskColorIndexToLargestSubject(

  colorIndex: Int32Array,

  canvas: HTMLCanvasElement,

  minAreaRatio = MIN_SUBJECT_COMPONENT_RATIO,

): void {

  const { blobs } = detectLargeSubjectBlobs(canvas, minAreaRatio)

  if (blobs.length === 0) return

  const keep = new Set<number>()

  for (const blob of blobs) {

    for (const idx of blob) keep.add(idx)

  }

  for (let i = 0; i < colorIndex.length; i++) {

    if (colorIndex[i] >= 0 && !keep.has(i)) colorIndex[i] = -1

  }

}

/** Semantic color fill extraction ? k-means zones, per-component polygons, vibrant sampled colors. */

export function extractSemanticColorFills(

  canvas: HTMLCanvasElement,

): ColorRegionExtractResult {

  const w = canvas.width

  const h = canvas.height

  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const data = ctx.getImageData(0, 0, w, h).data

  const k = Math.min(MAX_SEMANTIC_FILL_REGIONS, Math.max(MIN_SEMANTIC_FILL_REGIONS, PIPELINE_CONFIG.regionColors))

  const paletteRgb = buildPalette(data, w, h, k)

  const colorIndex = assignColorIndex(data, w, h, paletteRgb)

  mergeSmallComponents(colorIndex, w, h, PIPELINE_CONFIG.smallPatchMergeRatio, paletteRgb)

  maskColorIndexToLargestSubject(colorIndex, canvas)

  let regions = extractSemanticFillRegions(

    colorIndex,

    w,

    h,

    data,

    PIPELINE_CONFIG.minRegionAreaRatio,

  )

  if (regions.length > MAX_SEMANTIC_FILL_REGIONS) {

    regions = regions.slice(0, MAX_SEMANTIC_FILL_REGIONS)

  }

  const outlineColor = sampleDarkestOutlineColor(data, colorIndex, w, h)

  const usedColors = new Set<number>()

  for (let i = 0; i < w * h; i++) {

    const c = colorIndex[i]

    if (c >= 0) usedColors.add(c)

  }

  console.log(

    `[regionVectorizer] semanticColorFills regions=${regions.length} palette=${k} colors=${usedColors.size}`,

  )

  return {

    boundaryPaths: [],

    regions,

    palette: paletteRgb.map(([r, g, b]) => rgbToHex(r, g, b)),

    colorCount: usedColors.size,

    outlineColor,

  }

}

/** Largest foreground blob outer boundary ? one continuous silhouette path. */

function convexHull(points: PointPair[]): PointPair[] {
  if (points.length < 3) return points
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: PointPair, a: PointPair, b: PointPair) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const lower: PointPair[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper: PointPair[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return [...lower, ...upper]
}

function unionBlobCornerSamples(component: Set<number>, w: number, step = 3): PointPair[] {
  const pts: PointPair[] = []
  for (const idx of component) {
    const x = idx % w
    const y = Math.floor(idx / w)
    if (x % step === 0 && y % step === 0) pts.push([x + 0.5, y + 0.5])
  }
  return pts
}

export function extractSubjectSilhouette(

  canvas: HTMLCanvasElement,

  threshold = PIPELINE_V4.silhouetteLuminanceThreshold,

  minAreaRatio = PIPELINE_V4.subjectBlobMinRatio,

): PointPair[] {

  const w = canvas.width

  const h = canvas.height

  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const data = ctx.getImageData(0, 0, w, h).data

  const component = isolateSignificantForegroundComponents(data, w, h, minAreaRatio, threshold)

  if (component.size < 24) return []

  const outline = traceComponentOutline(component, w, h)
  if (outline.length >= 3) {
    const ob = bboxFromPairs(outline)
    const outlineArea = (ob.maxX - ob.minX) * (ob.maxY - ob.minY)
    let minX = w
    let minY = h
    let maxX = 0
    let maxY = 0
    for (const idx of component) {
      const x = idx % w
      const y = Math.floor(idx / w)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    const unionArea = (maxX - minX + 1) * (maxY - minY + 1)
    if (unionArea > 0 && outlineArea / unionArea >= 0.55) return outline
  }

  const samples = unionBlobCornerSamples(component, w)
  const hull = convexHull(samples)
  return hull.length >= 3 ? hull : outline

}

/** Scan for short horizontal dark runs — woodcut/cross-hatch Wanx shading. */
function detectHatchHeavySource(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { hatchHeavy: boolean; score: number } {
  let shortHorizRuns = 0
  let longHorizRuns = 0
  let totalHorizRuns = 0
  let shortRunLenSum = 0
  const minRun = 3
  const maxRun = Math.max(12, Math.floor(w * 0.12))
  const longRunMin = Math.max(maxRun + 4, Math.floor(w * 0.18))
  const stepY = Math.max(1, Math.floor(h / 120))

  for (let y = 0; y < h; y += stepY) {
    let runLen = 0
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      const lum = luminance(data[p], data[p + 1], data[p + 2])
      const dark = data[p + 3] >= 128 && lum < 200
      if (dark) {
        runLen++
      } else if (runLen > 0) {
        totalHorizRuns++
        if (runLen >= minRun && runLen <= maxRun) {
          shortHorizRuns++
          shortRunLenSum += runLen
        } else if (runLen >= longRunMin) {
          longHorizRuns++
        }
        runLen = 0
      }
    }
    if (runLen > 0) {
      totalHorizRuns++
      if (runLen >= minRun && runLen <= maxRun) {
        shortHorizRuns++
        shortRunLenSum += runLen
      } else if (runLen >= longRunMin) {
        longHorizRuns++
      }
    }
  }

  const score = totalHorizRuns > 0 ? shortHorizRuns / totalHorizRuns : 0
  const avgShortRun = shortHorizRuns > 0 ? shortRunLenSum / shortHorizRuns : 0
  const longDominant = totalHorizRuns > 0 && longHorizRuns / totalHorizRuns > 0.22

  const hatchHeavy = !longDominant
    && score >= PIPELINE_V4.hatchHeavyRunRatio
    && shortHorizRuns > 40
    && avgShortRun <= maxRun * 0.75

  return { hatchHeavy, score }
}

/** Merge light head/neck pixels (missed by quant) into subject union via luminance + proximity. */
function expandUnionWithLightHeadPixels(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  union: Set<number>,
  lightLum = PIPELINE_V4.silhouetteLightHeadLuminance,
): Set<number> {
  if (union.size < 24) return union

  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  for (const idx of union) {
    const x = idx % w
    const y = Math.floor(idx / w)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  const topBandEnd = minY + Math.floor((maxY - minY + 1) * 0.42)
  const expanded = new Set(union)

  for (let y = minY; y <= topBandEnd; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = y * w + x
      if (expanded.has(idx)) continue
      const p = idx * 4
      if (data[p + 3] < 128) continue
      const lum = luminance(data[p], data[p + 1], data[p + 2])
      if (lum >= lightLum) continue

      let touches = false
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue
        if (expanded.has(ny * w + nx)) {
          touches = true
          break
        }
      }
      if (touches) expanded.add(idx)
    }
  }

  return expanded
}

/** Silhouette from full quantized subject union — catches lighter hindquarters missed by luminance mask. */
function extractSubjectSilhouetteFromPlan(plan: SketchPlan): PointPair[] {
  const { colorIndex, w, h, workspace } = plan
  const { analysisCanvas } = workspace
  const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data

  let quantUnion = new Set<number>()
  for (let i = 0; i < colorIndex.length; i++) {
    if (colorIndex[i] >= 0) quantUnion.add(i)
  }
  quantUnion = expandUnionWithLightHeadPixels(data, w, h, quantUnion)

  if (quantUnion.size >= 24) {
    const outline = traceComponentOutline(quantUnion, w, h)
    if (outline.length >= 3) {
      const ob = bboxFromPairs(outline)
      const outlineArea = (ob.maxX - ob.minX) * (ob.maxY - ob.minY)
      let minX = w
      let minY = h
      let maxX = 0
      let maxY = 0
      for (const idx of quantUnion) {
        const x = idx % w
        const y = Math.floor(idx / w)
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      const unionArea = (maxX - minX + 1) * (maxY - minY + 1)
      if (unionArea > 0 && outlineArea / unionArea >= 0.42) return outline
    }
  }

  return extractSubjectSilhouette(
    analysisCanvas,
    PIPELINE_V4.silhouetteLuminanceThreshold,
    PIPELINE_V4.subjectBlobMinRatio,
  )

}

/** Profile-aware region extraction ? grayscale tones or merged color posterize. */

export function extractAdaptiveRegions(

  canvas: HTMLCanvasElement,

  opts: AdaptiveRegionOptions,

): ColorRegionExtractResult {

  const w = canvas.width

  const h = canvas.height

  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const data = ctx.getImageData(0, 0, w, h).data

  const useGrayscaleTones =

    opts.style === 'grayscale_illustration' || opts.style === 'photo_like'

  let paletteRgb: [number, number, number][]

  let colorIndex: Int32Array

  if (useGrayscaleTones) {

    const tones = buildLuminancePalette(data, w, h, opts.maxFillRegions)

    colorIndex = assignLuminanceIndex(data, w, h, tones)

    paletteRgb = tones.map((t) => [t, t, t] as [number, number, number])

  } else {

    paletteRgb = buildPalette(data, w, h, opts.maxFillRegions)

    colorIndex = assignColorIndex(data, w, h, paletteRgb)

    paletteRgb = mergeSimilarPaletteColors(

      paletteRgb,

      colorIndex,

      PIPELINE_CONFIG.colorMergeDeltaE,

    )

  }

  mergeSmallComponents(colorIndex, w, h, opts.minAreaRatio, paletteRgb)

  const minLen = PIPELINE_CONFIG.sketchPathMinLengthPx

  let boundaryPaths: VectorPath[] = []

  if (opts.includeBoundaries) {

    const rawLoops = traceSemanticBoundaries(colorIndex, w, h, minLen)

    boundaryPaths = loopsToBoundaryPaths(

      rawLoops,

      minLen,

      opts.simplifyEpsilon,

      opts.maxOutlineStrokes,

      w,

      h,

    )

  }

  let regions = extractSemanticFillRegions(

    colorIndex,

    w,

    h,

    data,

    opts.minAreaRatio,

  )

  regions = regions.slice(0, opts.maxFillRegions)

  const outlineColor = useGrayscaleTones

    ? '#3d3d3d'

    : sampleDarkestOutlineColor(data, colorIndex, w, h)

  const usedColors = new Set<number>()

  for (let i = 0; i < w * h; i++) {

    const c = colorIndex[i]

    if (c >= 0) usedColors.add(c)

  }

  console.log(

    `[regionVectorizer] adaptive style=${opts.style} regions=${regions.length}`

    + ` boundaries=${boundaryPaths.length} colors=${usedColors.size}`,

  )

  return {

    boundaryPaths,

    regions,

    palette: paletteRgb.map(([r, g, b]) => rgbToHex(r, g, b)),

    colorCount: usedColors.size,

    outlineColor,

  }

}

/**

 * Posterize image into semantic color regions + shared boundary strokes for sketch-then-color.

 */

export function extractColorRegions(

  canvas: HTMLCanvasElement,

  numColors: number = PIPELINE_CONFIG.regionColors,

): ColorRegionExtractResult {

  return extractAdaptiveRegions(canvas, {

    style: 'color_illustration',

    maxFillRegions: numColors,

    maxOutlineStrokes: PIPELINE_CONFIG.maxSketchStrokes,

    minAreaRatio: PIPELINE_CONFIG.minRegionAreaRatio,

    simplifyEpsilon: PIPELINE_CONFIG.boundaryRdpEpsilon,

    includeBoundaries: true,

  })

}

/**

 * Posterize + color-region boundary tracing ??reliable on flat Wanx illustrations.

 */

export function vectorizeByColorRegions(

  canvas: HTMLCanvasElement,

  numColors: number = PIPELINE_CONFIG.regionColors,

): RegionVectorizeResult {

  const result = extractColorRegions(canvas, numColors)

  return {

    paths: result.boundaryPaths,

    colorCount: result.colorCount,

    regionCount: result.regions.length,

  }

}

// ─── v3 pipeline: prepareSketchPlan → extractCleanOutline → sampleColorsFromOriginal ───

export interface SketchPlanOptions {
  workspace?: number
  colors?: number
  fineDetail?: boolean
  maxOutlineStrokes?: number
  minBoundaryDeltaE?: number
  outlineRdpEpsilon?: number
  supplementMaxPaths?: number
  /** Skip low-stroke relaxation that re-admits noisy paths (v4). */
  strictOutlines?: boolean
  maxFillRegions?: number
  minFillAreaRatio?: number
}

export interface SketchPlan {
  w: number
  h: number
  fullW: number
  fullH: number
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
  /** Fitted Wanx image rect on full canvas — clip fills use the same coords. */
  fitBounds: { x: number; y: number; width: number; height: number }
  colorIndex: Int32Array
  palette: [number, number, number][]
  outlineColor: string
  useGrayscale: boolean
  fineDetail: boolean
  maxOutlineStrokes: number
  minBoundaryDeltaE: number
  outlineRdpEpsilon: number
  supplementMaxPaths: number
  strictOutlines: boolean
  maxFillRegions: number
  minFillAreaRatio: number
  workspace: AnalysisWorkspace
}

function isMajorBoundary(
  colorIndex: Int32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  palette: [number, number, number][],
  minDeltaE: number,
): boolean {
  const c = colorIndex[y * w + x]
  if (c < 0) return false
  const labA = rgbToLab(palette[c][0], palette[c][1], palette[c][2])
  let maxDe = 0
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
    const nc = colorIndex[ny * w + nx]
    if (nc < 0 || nc === c) continue
    const labB = rgbToLab(palette[nc][0], palette[nc][1], palette[nc][2])
    maxDe = Math.max(maxDe, deltaE(labA, labB))
  }
  return maxDe >= minDeltaE
}

function traceMajorBoundaries(
  colorIndex: Int32Array,
  w: number,
  h: number,
  palette: [number, number, number][],
  minLengthPx: number,
  minDeltaE: number,
): PointPair[][] {
  const visited = new Uint8Array(w * h)
  const rawLoops: PointPair[][] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (visited[i] || !isBoundary(colorIndex, w, h, x, y)) continue
      if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) continue
      if (!isMajorBoundary(colorIndex, w, h, x, y, palette, minDeltaE)) continue
      const loop = traceBoundaryLoop(colorIndex, w, h, x, y, visited)
      if (loop.length >= 4 && pathLengthFromPairs(loop) >= minLengthPx) {
        rawLoops.push(loop)
      }
    }
  }

  return rawLoops
}

function pairsToVectorPath(points: PointPair[], closed: boolean): VectorPath {
  const d = pairsToPathD(points, closed)
  const bbox = bboxFromPairs(points)
  return {
    d,
    minX: bbox.minX,
    minY: bbox.minY,
    length: pathLengthFromPairs(points),
  }
}

function silhouetteToVectorPath(points: PointPair[], rdpEpsilon: number): VectorPath | null {
  if (points.length < 3) return null
  const simplified = simplifyRdp(points, rdpEpsilon)
  if (simplified.length < 3) return null
  return pairsToVectorPath(simplified, true)
}

/**
 * Single-pass prep: posterize + palette + color labels on 384px workspace.
 * One canvas read; paths scaled to full canvas later.
 */
export function prepareSketchPlan(
  sourceCanvas: HTMLCanvasElement,
  opts: SketchPlanOptions = {},
): SketchPlan {
  const fineDetail = opts.fineDetail === true
  const workspacePx = opts.workspace
    ?? (fineDetail ? SKETCH_COLOR_CONFIG.analysisMaxPxFine : SKETCH_COLOR_CONFIG.analysisMaxPx)
  const numColors = opts.colors
    ?? (fineDetail ? SKETCH_COLOR_CONFIG.posterizeColorsFine : SKETCH_COLOR_CONFIG.posterizeColors)
  const maxOutlineStrokes = opts.maxOutlineStrokes
    ?? (fineDetail ? SKETCH_COLOR_CONFIG.maxOutlineStrokesFine : SKETCH_COLOR_CONFIG.maxOutlineStrokes)
  const minBoundaryDeltaE = opts.minBoundaryDeltaE ?? SKETCH_COLOR_CONFIG.minBoundaryDeltaE
  const outlineRdpEpsilon = opts.outlineRdpEpsilon ?? SKETCH_COLOR_CONFIG.outlineRdpEpsilon
  const supplementMaxPaths = opts.supplementMaxPaths ?? SKETCH_COLOR_CONFIG.supplementMaxPaths
  const strictOutlines = opts.strictOutlines === true
  const maxFillRegions = opts.maxFillRegions ?? PIPELINE_CONFIG.maxFillRegions
  const minFillAreaRatio = opts.minFillAreaRatio ?? PIPELINE_CONFIG.minRegionAreaRatio
  const workspace = createAnalysisWorkspace(sourceCanvas, workspacePx)
  const { analysisCanvas } = workspace
  const w = analysisCanvas.width
  const h = analysisCanvas.height
  const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data

  let grayCount = 0
  let sampled = 0
  const step = Math.max(1, Math.floor((w * h) / 1500))
  for (let i = 0; i < w * h; i += step) {
    const p = i * 4
    if (data[p + 3] < 128) continue
    sampled++
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20) grayCount++
  }
  const useGrayscale = sampled > 0 && grayCount / sampled > 0.55

  let paletteRgb: [number, number, number][]
  let colorIndex: Int32Array

  if (useGrayscale) {
    const tones = buildLuminancePalette(data, w, h, numColors)
    colorIndex = assignLuminanceIndex(data, w, h, tones)
    paletteRgb = tones.map((t) => [t, t, t] as [number, number, number])
  } else {
    paletteRgb = buildPalette(data, w, h, numColors)
    colorIndex = assignColorIndex(data, w, h, paletteRgb)
    paletteRgb = mergeSimilarPaletteColors(
      paletteRgb,
      colorIndex,
      PIPELINE_CONFIG.colorMergeDeltaE,
    )
  }

  mergeSmallComponents(colorIndex, w, h, PIPELINE_CONFIG.minColorRegionAreaRatio, paletteRgb)
  maskColorIndexToLargestSubject(colorIndex, analysisCanvas, PIPELINE_V4.subjectBlobMinRatio)

  logQuantizationCoverage(colorIndex, w, h, paletteRgb.length)

  const fitBounds = {
    x: 0,
    y: 0,
    width: sourceCanvas.width,
    height: sourceCanvas.height,
  }

  const outlineColor = useGrayscale
    ? '#3d3d3d'
    : sampleDarkestOutlineColor(data, colorIndex, w, h)

  console.log(
    `[regionVectorizer] prepareSketchPlan ${w}x${h} colors=${numColors}`
    + ` grayscale=${useGrayscale} palette=${paletteRgb.length}`,
  )

  return {
    w,
    h,
    fullW: sourceCanvas.width,
    fullH: sourceCanvas.height,
    scaleX: workspace.scaleX,
    scaleY: workspace.scaleY,
    offsetX: workspace.offsetX ?? 0,
    offsetY: workspace.offsetY ?? 0,
    fitBounds,
    colorIndex,
    palette: paletteRgb,
    outlineColor,
    useGrayscale,
    fineDetail,
    maxOutlineStrokes,
    minBoundaryDeltaE,
    outlineRdpEpsilon,
    supplementMaxPaths,
    strictOutlines,
    maxFillRegions,
    minFillAreaRatio,
    workspace,
  }
}

function scaleVectorPath(path: VectorPath, sx: number, sy: number): VectorPath {
  const subs = parsePathDAll(path.d)
  const sub = subs[0]
  if (!sub || sub.points.length < 2) return path
  const scaled = sub.points.map(([x, y]) => [x * sx, y * sy] as PointPair)
  return pairsToVectorPath(scaled, sub.closed)
}

function expandSupplementSubpaths(raw: VectorPath[]): VectorPath[] {
  const expanded: VectorPath[] = []
  for (const path of raw) {
    const items = splitPathDIntoItems(path.d)
    expanded.push(...(items.length > 0 ? items : [path]))
  }
  return expanded
}

const DETAIL_TRACER_OPTS = {
  ltres: 0.9,
  qtres: 1.0,
  pathomit: 4,
  colorsampling: 0,
  numberofcolors: 2,
  strokewidth: 1,
  linefilter: true,
  scale: 1,
  roundcoords: true,
  rightangleenhance: false,
  viewbox: false,
  desc: false,
}

interface SubjectBbox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Drop spurious paths: oversized diagonals, center-crossing spans, vertical center artifacts. */
function isSpuriousDiagonalPath(
  path: VectorPath,
  w: number,
  h: number,
  canvasDiag: number,
  subjectWidth: number,
  subjectBbox?: SubjectBbox,
): boolean {
  const subs = parsePathDAll(path.d)
  const sub = subs[0]
  const pts = sub?.points ?? []
  if (pts.length < 2) return true

  const bbox = bboxFromPairs(pts)
  const bboxDiag = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY)
  const bboxH = bbox.maxY - bbox.minY
  const bboxW = bbox.maxX - bbox.minX
  const ratio = bboxDiag / canvasDiag
  const closed = sub?.closed ?? path.d.trimEnd().endsWith('Z')
  const pathLen = pathLengthFromPairs(pts)
  const centerY = h / 2
  const centerX = w / 2

  if (ratio > SKETCH_COLOR_CONFIG.maxBboxDiagonalRatio) {
    if (closed) {
      const aspect = bboxW / Math.max(1, bboxH)
      return aspect > 3.5 || aspect < 0.28
    }
    return true
  }

  const start = pts[0]
  const end = pts[pts.length - 1]

  // Open path crossing bbox center with length > 40% canvas width.
  if (!closed && pathLen > w * 0.4) {
    const crossesCenterX = (start[0] < centerX && end[0] > centerX)
      || (start[0] > centerX && end[0] < centerX)
    const crossesCenterY = (start[1] < centerY && end[1] > centerY)
      || (start[1] > centerY && end[1] < centerY)
    if (crossesCenterX && crossesCenterY) return true
    const midX = (start[0] + end[0]) / 2
    const midY = (start[1] + end[1]) / 2
    if (Math.abs(midX - centerX) < w * 0.15 && Math.abs(midY - centerY) < h * 0.15) return true
  }

  // Diagonal 45–135° spanning >50% of subject width.
  const dx = bbox.maxX - bbox.minX
  const dy = bbox.maxY - bbox.minY
  if (dx > 4 && dy > 4) {
    const angleDeg = Math.abs(Math.atan2(dy, dx) * (180 / Math.PI))
    const diagAngle = angleDeg > 90 ? 180 - angleDeg : angleDeg
    if (diagAngle >= 35 && diagAngle <= 55 && bboxDiag > subjectWidth * 0.5) return true
  }

  const ySpan = Math.abs(end[1] - start[1])
  const crossesCenter = (start[1] < centerY && end[1] > centerY)
    || (start[1] > centerY && end[1] < centerY)
  if (crossesCenter && ySpan > h * 0.35) {
    const midX = (bbox.minX + bbox.maxX) / 2
    const midY = (bbox.minY + bbox.maxY) / 2
    if (Math.abs(midX - centerX) < w * 0.25 && Math.abs(midY - centerY) < h * 0.25) return true
  }

  const pathCenterX = (bbox.minX + bbox.maxX) / 2
  if (bboxH > 8 && bboxW < bboxH * 0.2 && Math.abs(pathCenterX - centerX) < w * 0.12) {
    if (pts.length === 2) {
      const segH = Math.abs(end[1] - start[1])
      if (segH > bboxH * 0.6) return true
    }
    if (bboxH > h * 0.45) return true
  }

  // Tall narrow vertical glitch: >70% subject height span, <5% subject width.
  if (subjectBbox) {
    const subW = subjectBbox.maxX - subjectBbox.minX
    const subH = subjectBbox.maxY - subjectBbox.minY
    if (subW > 0 && subH > 0) {
      const vertSpan = bboxH / subH
      const widthRatio = bboxW / subW
      if (vertSpan > 0.7 && widthRatio < 0.05) return true
    }
  }

  return false
}

function segmentAngleDeg(p1: PointPair, p2: PointPair): number {
  const rad = Math.atan2(p2[1] - p1[1], p2[0] - p1[0])
  let deg = rad * (180 / Math.PI)
  if (deg < 0) deg += 180
  return deg
}

function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b)
  return d > 90 ? 180 - d : d
}

/** Cross-hatch: 3+ nearly-parallel segments within 8px (ImageTracer shading artifact). */
function isCrossHatchPath(path: VectorPath): boolean {
  const subs = parsePathDAll(path.d)
  const pts = subs[0]?.points ?? []
  if (pts.length < 4) return false

  const segments: { angle: number; midX: number; midY: number }[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
    if (len < 4) continue
    segments.push({
      angle: segmentAngleDeg(pts[i], pts[i + 1]),
      midX: (pts[i][0] + pts[i + 1][0]) / 2,
      midY: (pts[i][1] + pts[i + 1][1]) / 2,
    })
  }
  if (segments.length < 3) return false

  let parallelPairs = 0
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (angleDiffDeg(segments[i].angle, segments[j].angle) > 15) continue
      const dist = Math.hypot(
        segments[i].midX - segments[j].midX,
        segments[i].midY - segments[j].midY,
      )
      if (dist < 8) parallelPairs++
    }
  }
  return parallelPairs >= 3
}

/** Long thin horizontal/vertical stripe — woodcut hatch line traced as a stroke. */
function isParallelStripePath(path: VectorPath, w: number, h: number): boolean {
  const subs = parsePathDAll(path.d)
  const pts = subs[0]?.points ?? []
  if (pts.length < 2) return false

  const bbox = bboxFromPairs(pts)
  const bboxW = bbox.maxX - bbox.minX
  const bboxH = bbox.maxY - bbox.minY
  if (bboxW < 4 && bboxH < 4) return false

  const aspect = bboxW / Math.max(1, bboxH)
  const invAspect = bboxH / Math.max(1, bboxW)
  const isHorizStripe = aspect > 5 && bboxW > w * 0.08 && bboxH < Math.max(6, bboxW * 0.12)
  const isVertStripe = invAspect > 5 && bboxH > h * 0.08 && bboxW < Math.max(6, bboxH * 0.12)
  if (!isHorizStripe && !isVertStripe) return false

  let alignedSegs = 0
  let totalSegs = 0
  for (let i = 1; i < pts.length; i++) {
    const segLen = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (segLen < 2) continue
    totalSegs++
    const angle = segmentAngleDeg(pts[i - 1], pts[i])
    const horiz = angle <= 15 || angle >= 165
    const vert = angle >= 75 && angle <= 105
    if ((isHorizStripe && horiz) || (isVertStripe && vert)) alignedSegs++
  }
  return totalSegs > 0 && alignedSegs / totalSegs >= 0.65 && path.length < Math.max(bboxW, bboxH) * 1.4
}

/** Open path spanning subject with large heading change — edge/Sobel bridge artifact. */
function isBridgeDiagonalPath(
  path: VectorPath,
  w: number,
  h: number,
  subjectBbox?: SubjectBbox,
): boolean {
  const subs = parsePathDAll(path.d)
  const sub = subs[0]
  const pts = sub?.points ?? []
  if (pts.length < 2 || (sub?.closed ?? path.d.trimEnd().endsWith('Z'))) return false

  const pathLen = pathLengthFromPairs(pts)
  const canvasDiag = Math.hypot(w, h)
  if (pathLen < canvasDiag * 0.22) return false

  const start = pts[0]
  const end = pts[pts.length - 1]
  const span = Math.hypot(end[0] - start[0], end[1] - start[1])
  if (span < canvasDiag * 0.28) return false

  let minAngle = 180
  let maxAngle = 0
  for (let i = 1; i < pts.length; i++) {
    const segLen = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (segLen < 3) continue
    const a = segmentAngleDeg(pts[i - 1], pts[i])
    minAngle = Math.min(minAngle, a)
    maxAngle = Math.max(maxAngle, a)
  }
  const angleSpan = maxAngle - minAngle
  if (angleSpan > 55 && span > canvasDiag * 0.35) return true

  if (subjectBbox) {
    const subW = subjectBbox.maxX - subjectBbox.minX
    const subH = subjectBbox.maxY - subjectBbox.minY
    const midX = (start[0] + end[0]) / 2
    const midY = (start[1] + end[1]) / 2
    const insideSubject = midX >= subjectBbox.minX && midX <= subjectBbox.maxX
      && midY >= subjectBbox.minY && midY <= subjectBbox.maxY
    if (insideSubject && span > Math.max(subW, subH) * 0.55 && angleSpan > 40) return true
  }

  return false
}

function pathBboxIoU(a: VectorPath, b: VectorPath): number {
  const pa = parsePathDAll(a.d)[0]?.points ?? []
  const pb = parsePathDAll(b.d)[0]?.points ?? []
  if (pa.length < 2 || pb.length < 2) return 0
  const ba = bboxFromPairs(pa)
  const bb = bboxFromPairs(pb)
  const ix0 = Math.max(ba.minX, bb.minX)
  const iy0 = Math.max(ba.minY, bb.minY)
  const ix1 = Math.min(ba.maxX, bb.maxX)
  const iy1 = Math.min(ba.maxY, bb.maxY)
  if (ix1 <= ix0 || iy1 <= iy0) return 0
  const inter = (ix1 - ix0) * (iy1 - iy0)
  const areaA = (ba.maxX - ba.minX) * (ba.maxY - ba.minY)
  const areaB = (bb.maxX - bb.minX) * (bb.maxY - bb.minY)
  const uni = areaA + areaB - inter
  return uni > 0 ? inter / uni : 0
}

function dedupeNearDuplicatePaths(paths: VectorPath[], iouThreshold = 0.85): VectorPath[] {
  const kept: VectorPath[] = []
  for (const p of paths) {
    let dup = false
    for (const k of kept) {
      if (pathBboxIoU(p, k) > iouThreshold) {
        const lenRatio = Math.min(p.length, k.length) / Math.max(p.length, k.length, 1)
        if (lenRatio > 0.85) {
          dup = true
          break
        }
      }
    }
    if (!dup) kept.push(p)
  }
  return kept
}

/** Dedup against existing paths — exact key match or bbox IoU > threshold. */
function dedupeAgainstExisting(
  candidates: VectorPath[],
  existing: VectorPath[],
  iouThreshold = 0.9,
): VectorPath[] {
  const existingKeys = new Set(existing.map((p) => edgeCanonicalKey(p.d)))
  const kept: VectorPath[] = []
  for (const p of candidates) {
    const key = edgeCanonicalKey(p.d)
    if (existingKeys.has(key)) continue
    let dup = false
    for (const e of [...existing, ...kept]) {
      if (pathBboxIoU(p, e) > iouThreshold) {
        dup = true
        break
      }
    }
    if (!dup) kept.push(p)
  }
  return kept
}

interface OutlineFilterOpts {
  crossHatch: boolean
  nearDup: boolean
  diagonal: boolean
  aggressiveHatch?: boolean
}

function applyOutlineFilters(
  paths: VectorPath[],
  w: number,
  h: number,
  canvasDiag: number,
  subjectWidth: number,
  opts: OutlineFilterOpts,
  subjectBbox?: SubjectBbox,
): VectorPath[] {
  let out = paths.filter((p) => pathOverlapsSubject(p, subjectBbox))
  if (opts.diagonal) {
    out = out.filter((p) => !isSpuriousDiagonalPath(p, w, h, canvasDiag, subjectWidth, subjectBbox))
    out = out.filter((p) => !isBridgeDiagonalPath(p, w, h, subjectBbox))
  }
  out = out.filter((p) => {
    const pts = parsePathDAll(p.d)[0]?.points ?? []
    if (pts.length < 2) return false
    return !isCanvasBorderArtifact(pts.flat(), w, h)
  })
  if (opts.crossHatch || opts.aggressiveHatch) {
    out = out.filter((p) => !isCrossHatchPath(p))
    out = out.filter((p) => !isParallelStripePath(p, w, h))
    out = out.filter((p) => !isHorizontalHatchPath(p))
    out = out.filter((p) => !isVerticalHatchPath(p))
    out = out.filter((p) => !isOrphanHorizontalLine(p, w))
  }
  if (opts.aggressiveHatch) {
    out = filterShadingNoise(out, 14, 120)
  }
  if (opts.nearDup) {
    out = dedupeNearDuplicatePaths(out)
  }
  return out
}

/** ImageTracer on line-art — interior detail strokes (mane, muscle, leg lines). */
export function supplementDetailStrokes(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  existingPaths: VectorPath[],
  maxDetailPaths: number,
  canvasDiag: number,
  subjectWidth: number,
  subjectBbox?: SubjectBbox,
  hatchHeavy = false,
): VectorPath[] {
  if (maxDetailPaths <= 0 || hatchHeavy) return []

  const wsScale = w / 384
  const minLen = PIPELINE_V4.detailMinLengthPx * wsScale
  const maxLen = PIPELINE_V4.detailMaxLengthPx * wsScale

  const posterizeColors = hatchHeavy
    ? Math.max(4, Math.floor(PIPELINE_V4.quantizeColors / 3))
    : PIPELINE_V4.quantizeColors
  const normalized = normalizeToLineArt(canvas, posterizeColors)
  const normW = normalized.width
  const normH = normalized.height
  const sx = w / normW
  const sy = h / normH

  const ctx = normalized.getContext('2d', { willReadFrequently: true })!
  const imgd = ctx.getImageData(0, 0, normW, normH)
  const svgString = ImageTracer.imagedataToSVG(imgd, DETAIL_TRACER_OPTS)
  const raw = expandSupplementSubpaths(extractPathsFromSvg(svgString))

  const existingKeys = new Set(existingPaths.map((p) => edgeCanonicalKey(p.d)))
  const candidates: VectorPath[] = []
  for (const p of raw) {
    const scaled = scaleVectorPath(p, sx, sy)
    if (scaled.length < minLen || scaled.length > maxLen) continue
    const key = edgeCanonicalKey(scaled.d)
    if (existingKeys.has(key)) continue
    candidates.push(scaled)
  }

  const strictFilter: OutlineFilterOpts = {
    crossHatch: true,
    nearDup: false,
    diagonal: true,
    aggressiveHatch: hatchHeavy,
  }
  let filtered = applyOutlineFilters(
    candidates, w, h, canvasDiag, subjectWidth, strictFilter, subjectBbox,
  )
  filtered = dedupeAgainstExisting(filtered, existingPaths, 0.9)
  filtered.sort((a, b) => b.length - a.length)
  return filtered.slice(0, maxDetailPaths)
}

function sortPathsNearestNeighbor(paths: VectorPath[], startFrom?: PointPair): VectorPath[] {
  if (paths.length <= 1) return paths
  const remaining = [...paths]
  const ordered: VectorPath[] = []
  let lastEnd: PointPair = startFrom ?? (() => {
    const pts = parsePathDAll(remaining[0].d)[0]?.points ?? []
    return pts.length > 0 ? pts[0] : [0, 0] as PointPair
  })()

  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const pts = parsePathDAll(remaining[i].d)[0]?.points ?? []
      if (pts.length === 0) continue
      const start = pts[0]
      const end = pts[pts.length - 1]
      const dStart = Math.hypot(start[0] - lastEnd[0], start[1] - lastEnd[1])
      const dEnd = Math.hypot(end[0] - lastEnd[0], end[1] - lastEnd[1])
      const d = Math.min(dStart, dEnd)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    const next = remaining.splice(bestIdx, 1)[0]
    ordered.push(next)
    const pts = parsePathDAll(next.d)[0]?.points ?? []
    if (pts.length > 0) lastEnd = pts[pts.length - 1]
  }
  return ordered
}

function flatPolylineToVectorPath(flat: number[], rdpEpsilon: number): VectorPath | null {
  if (flat.length < 4) return null
  const points: PointPair[] = []
  for (let i = 0; i < flat.length; i += 2) {
    points.push([flat[i], flat[i + 1]])
  }
  const simplified = simplifyRdp(points, rdpEpsilon)
  if (simplified.length < 2) return null
  return pairsToVectorPath(simplified, false)
}

function measureHorizontalBandCoverage(
  paths: VectorPath[],
  bbox: SubjectBbox,
  bands = 4,
): number[] {
  const bandWidth = Math.max(1, (bbox.maxX - bbox.minX + 1) / bands)
  const covered = new Array(bands).fill(0)
  for (const p of paths) {
    const pts = parsePathDAll(p.d)[0]?.points ?? []
    if (pts.length === 0) continue
    const pb = bboxFromPairs(pts)
    const cx = (pb.minX + pb.maxX) / 2
    if (cx < bbox.minX - 2 || cx > bbox.maxX + 2) continue
    const band = Math.min(bands - 1, Math.max(0, Math.floor((cx - bbox.minX) / bandWidth)))
    covered[band] = 1
  }
  return covered
}

function measureVerticalBandCoverage(
  paths: VectorPath[],
  bbox: SubjectBbox,
  bands = 3,
): number[] {
  const bandHeight = Math.max(1, (bbox.maxY - bbox.minY + 1) / bands)
  const covered = new Array(bands).fill(0)
  for (const p of paths) {
    const pts = parsePathDAll(p.d)[0]?.points ?? []
    if (pts.length === 0) continue
    const pb = bboxFromPairs(pts)
    const cy = (pb.minY + pb.maxY) / 2
    if (cy < bbox.minY - 2 || cy > bbox.maxY + 2) continue
    const band = Math.min(bands - 1, Math.max(0, Math.floor((cy - bbox.minY) / bandHeight)))
    covered[band] = 1
  }
  return covered
}

function subjectBandsNeedFallback(
  paths: VectorPath[],
  subjectBbox: SubjectBbox,
): boolean {
  const xBands = measureHorizontalBandCoverage(paths, subjectBbox, 4)
  const yBands = measureVerticalBandCoverage(paths, subjectBbox, 3)
  const xMiss = xBands.filter((c) => c < 1).length
  const yMiss = yBands.filter((c) => c < 1).length
  return xMiss > 0 || yMiss > 0
}

/** Sobel edge paths for horizontal/vertical bands missed by structure/detail strokes. */
function supplementEdgeFallback(
  canvas: HTMLCanvasElement,
  existing: VectorPath[],
  subjectBbox: SubjectBbox,
  maxPaths: number,
  rdpEpsilon: number,
  w: number,
  h: number,
  canvasDiag: number,
  subjectWidth: number,
  hatchHeavy: boolean,
): VectorPath[] {
  if (maxPaths <= 0 || hatchHeavy) return []
  if (!subjectBandsNeedFallback(existing, subjectBbox)) return []

  const xBands = measureHorizontalBandCoverage(existing, subjectBbox, 4)
  const yBands = measureVerticalBandCoverage(existing, subjectBbox, 3)

  const edgeFlats = extractEdgePathsFromCanvas(canvas, {
    peakRatio: 0.32,
    maxStrokes: maxPaths * 3,
    minLengthPx: 14,
    fineDetail: true,
  })

  const xBandWidth = Math.max(1, (subjectBbox.maxX - subjectBbox.minX + 1) / xBands.length)
  const yBandHeight = Math.max(1, (subjectBbox.maxY - subjectBbox.minY + 1) / yBands.length)
  const candidates: VectorPath[] = []
  for (const flat of edgeFlats) {
    const vp = flatPolylineToVectorPath(flat, rdpEpsilon)
    if (!vp) continue
    const pts = parsePathDAll(vp.d)[0]?.points ?? []
    if (pts.length === 0) continue
    const pb = bboxFromPairs(pts)
    const cx = (pb.minX + pb.maxX) / 2
    const cy = (pb.minY + pb.maxY) / 2
    if (cx < subjectBbox.minX - 4 || cx > subjectBbox.maxX + 4) continue
    if (cy < subjectBbox.minY - 4 || cy > subjectBbox.maxY + 4) continue
    const xBand = Math.min(xBands.length - 1, Math.max(0, Math.floor((cx - subjectBbox.minX) / xBandWidth)))
    const yBand = Math.min(yBands.length - 1, Math.max(0, Math.floor((cy - subjectBbox.minY) / yBandHeight)))
    if (xBands[xBand] >= 1 && yBands[yBand] >= 1) continue
    candidates.push(vp)
  }

  const edgeFilter: OutlineFilterOpts = {
    crossHatch: true,
    nearDup: false,
    diagonal: true,
    aggressiveHatch: true,
  }
  let filtered = applyOutlineFilters(
    candidates, w, h, canvasDiag, subjectWidth, edgeFilter, subjectBbox,
  )
  filtered.sort((a, b) => b.length - a.length)
  filtered = dedupeAgainstExisting(filtered.slice(0, maxPaths), existing, 0.85)
  return filtered
}

function pathOverlapsSubject(
  path: VectorPath,
  subjectBbox?: SubjectBbox,
  minOverlapRatio = 0.12,
): boolean {
  if (!subjectBbox) return true
  const pts = parsePathDAll(path.d)[0]?.points ?? []
  if (pts.length < 2) return false
  const pb = bboxFromPairs(pts)
  const ix0 = Math.max(pb.minX, subjectBbox.minX)
  const iy0 = Math.max(pb.minY, subjectBbox.minY)
  const ix1 = Math.min(pb.maxX, subjectBbox.maxX)
  const iy1 = Math.min(pb.maxY, subjectBbox.maxY)
  if (ix1 <= ix0 || iy1 <= iy0) return false
  const inter = (ix1 - ix0) * (iy1 - iy0)
  const pathArea = Math.max(1, (pb.maxX - pb.minX) * (pb.maxY - pb.minY))
  return inter / pathArea >= minOverlapRatio
}

/** Last-resort outline when structure extraction yields too few paths. */
function posterizeImageTracerFallback(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  maxPaths: number,
  _rdpEpsilon: number,
  subjectBbox?: SubjectBbox,
): VectorPath[] {
  const normalized = normalizeToLineArt(canvas, Math.max(6, PIPELINE_V4.quantizeColors))
  const normW = normalized.width
  const normH = normalized.height
  const sx = w / normW
  const sy = h / normH
  const ctx = normalized.getContext('2d', { willReadFrequently: true })!
  const imgd = ctx.getImageData(0, 0, normW, normH)
  const svgString = ImageTracer.imagedataToSVG(imgd, {
    ...DETAIL_TRACER_OPTS,
    pathomit: 6,
    ltres: 1.0,
  })
  const raw = expandSupplementSubpaths(extractPathsFromSvg(svgString))
  const canvasDiag = Math.hypot(w, h)
  const subjectWidth = subjectBbox
    ? subjectBbox.maxX - subjectBbox.minX
    : w * 0.6

  const candidates: VectorPath[] = []
  for (const p of raw) {
    const scaled = scaleVectorPath(p, sx, sy)
    if (scaled.length < 10) continue
    const flatPts = parsePathDAll(scaled.d)[0]?.points ?? []
    if (flatPts.length < 2) continue
    const flat = flatPts.flat()
    if (isCanvasBorderArtifact(flat, w, h)) continue
    if (!pathOverlapsSubject(scaled, subjectBbox)) continue
    candidates.push(scaled)
  }

  const filtered = applyOutlineFilters(
    candidates,
    w,
    h,
    canvasDiag,
    subjectWidth,
    { crossHatch: true, nearDup: true, diagonal: true, aggressiveHatch: false },
    subjectBbox,
  )
  filtered.sort((a, b) => b.length - a.length)
  console.warn(
    `[regionVectorizer] posterize ImageTracer fallback: ${filtered.length}/${raw.length} paths`,
  )
  return filtered.slice(0, maxPaths)
}

function logQuantizationCoverage(
  colorIndex: Int32Array,
  w: number,
  h: number,
  paletteSize: number,
): void {
  const canvasArea = w * h
  let mapped = 0
  const usedColors = new Set<number>()
  for (let i = 0; i < canvasArea; i++) {
    const c = colorIndex[i]
    if (c >= 0) {
      mapped++
      usedColors.add(c)
    }
  }
  const mappedPct = (mapped / canvasArea) * 100
  const subjectBbox = subjectBboxFromColorIndex(colorIndex, w, h)
  let subjectMapped = mapped
  if (subjectBbox) {
    subjectMapped = 0
    for (let y = subjectBbox.minY; y <= subjectBbox.maxY; y++) {
      for (let x = subjectBbox.minX; x <= subjectBbox.maxX; x++) {
        if (colorIndex[y * w + x] >= 0) subjectMapped++
      }
    }
  }
  const subjectArea = subjectBbox
    ? (subjectBbox.maxX - subjectBbox.minX + 1) * (subjectBbox.maxY - subjectBbox.minY + 1)
    : canvasArea
  const subjectPct = subjectArea > 0 ? (subjectMapped / subjectArea) * 100 : 0
  console.log(
    `[regionVectorizer] quantCoverage canvas=${mappedPct.toFixed(1)}%`
    + ` subject=${subjectPct.toFixed(1)}% palette=${paletteSize} used=${usedColors.size}`,
  )
}

/** Primary ImageTracer trace on posterized line-art — light filtering, keeps detail paths. */
function tracePosterizedPrimary(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  maxPaths: number,
  posterizeColors: number,
  subjectBbox?: SubjectBbox,
  pathOmit = 4,
): VectorPath[] {
  const normalized = normalizeToLineArt(canvas, posterizeColors)
  const normW = normalized.width
  const normH = normalized.height
  const sx = w / normW
  const sy = h / normH
  const ctx = normalized.getContext('2d', { willReadFrequently: true })!
  const imgd = ctx.getImageData(0, 0, normW, normH)
  const svgString = ImageTracer.imagedataToSVG(imgd, {
    ...DETAIL_TRACER_OPTS,
    pathomit: pathOmit,
    ltres: 0.85,
  })
  const raw = expandSupplementSubpaths(extractPathsFromSvg(svgString))

  const candidates: VectorPath[] = []
  for (const p of raw) {
    const scaled = scaleVectorPath(p, sx, sy)
    if (scaled.length < 6) continue
    const flatPts = parsePathDAll(scaled.d)[0]?.points ?? []
    if (flatPts.length < 2) continue
    const flat = flatPts.flat()
    if (isCanvasBorderArtifact(flat, w, h)) continue
    if (!pathOverlapsSubject(scaled, subjectBbox, 0.08)) continue
    candidates.push(scaled)
  }

  candidates.sort((a, b) => b.length - a.length)
  return candidates.slice(0, maxPaths)
}

/**
 * Outline-only extraction: posterize ImageTracer (primary) + color boundaries (secondary) + silhouette.
 * Keeps 20–80 meaningful strokes; avoids over-filtering that drops cars/subjects.
 */
export function extractOutlineOnlyPaths(plan: SketchPlan): VectorPath[] {
  const {
    colorIndex, w, h, palette, workspace, maxOutlineStrokes, useGrayscale,
    minBoundaryDeltaE, outlineRdpEpsilon,
  } = plan
  const { analysisCanvas } = workspace
  const canvasDiag = Math.hypot(w, h)
  const minLen = Math.max(8, PIPELINE_CONFIG.sketchPathMinLengthPx * w / 384 * 0.65)
  const posterizeColors = plan.fineDetail
    ? PIPELINE_V4.outlinePosterizeColorsFine
    : PIPELINE_V4.outlinePosterizeColors
  const minTargetPaths = plan.fineDetail
    ? PIPELINE_V4.outlineOnlyMinPathsFine
    : PIPELINE_V4.outlineOnlyMinPaths

  const silhouettePts = extractSubjectSilhouetteFromPlan(plan)
  const silhouettePath = silhouettePts.length >= 3
    ? silhouetteToVectorPath(silhouettePts, outlineRdpEpsilon)
    : null
  const subjectBbox: SubjectBbox | undefined = silhouettePts.length >= 3
    ? bboxFromPairs(silhouettePts)
    : undefined
  const subjectWidth = subjectBbox
    ? subjectBbox.maxX - subjectBbox.minX
    : w * 0.6

  const primaryCap = Math.floor(maxOutlineStrokes * 0.72)
  let primaryPaths = tracePosterizedPrimary(
    analysisCanvas, w, h, primaryCap, posterizeColors, subjectBbox,
  )

  const structureDeltaE = useGrayscale
    ? minBoundaryDeltaE
    : Math.max(8, minBoundaryDeltaE - 6)
  const rawLoops = traceMajorBoundaries(
    colorIndex, w, h, palette, minLen, structureDeltaE,
  )
  const structureCap = Math.min(30, maxOutlineStrokes - (silhouettePath ? 1 : 0))
  let structurePaths = loopsToBoundaryPaths(
    rawLoops, minLen * 0.75, outlineRdpEpsilon, structureCap, w, h,
  )

  const lightFilter: OutlineFilterOpts = {
    crossHatch: false,
    nearDup: true,
    diagonal: true,
    aggressiveHatch: false,
  }
  structurePaths = applyOutlineFilters(
    structurePaths, w, h, canvasDiag, subjectWidth, lightFilter, subjectBbox,
  )

  const silKey = silhouettePath ? edgeCanonicalKey(silhouettePath.d) : null
  if (silKey) {
    structurePaths = structurePaths.filter((p) => edgeCanonicalKey(p.d) !== silKey)
  }

  const existingKeys = new Set<string>()
  const merged: VectorPath[] = []
  const pushUnique = (p: VectorPath): void => {
    const key = edgeCanonicalKey(p.d)
    if (existingKeys.has(key)) return
    existingKeys.add(key)
    merged.push(p)
  }

  if (silhouettePath) pushUnique(silhouettePath)

  for (const p of primaryPaths) pushUnique(p)

  for (const p of structurePaths) {
    pushUnique(p)
  }

  let paths = merged
  if (paths.length < minTargetPaths) {
    const retry = tracePosterizedPrimary(
      analysisCanvas, w, h, maxOutlineStrokes, posterizeColors, subjectBbox, 2,
    )
    for (const p of retry) pushUnique(p)
    paths = merged
  }

  if (structurePaths.length < PIPELINE_V4.sparseStructureThreshold && paths.length < minTargetPaths) {
    const extra = tracePosterizedPrimary(
      analysisCanvas, w, h, maxOutlineStrokes, Math.max(6, posterizeColors - 2), subjectBbox, 2,
    )
    for (const p of extra) pushUnique(p)
    paths = merged
  }

  paths.sort((a, b) => b.length - a.length)
  if (silhouettePath) {
    const silIdx = paths.findIndex((p) => edgeCanonicalKey(p.d) === silKey)
    if (silIdx > 0) {
      const [sil] = paths.splice(silIdx, 1)
      paths.unshift(sil)
    } else if (silIdx < 0) {
      paths.unshift(silhouettePath)
    }
  }

  if (paths.length > maxOutlineStrokes) {
    const silPart = silhouettePath ? [paths[0]] : []
    const rest = paths.slice(silPart.length)
    paths = [...silPart, ...rest.slice(0, maxOutlineStrokes - silPart.length)]
  }

  console.log(
    `[regionVectorizer] extractOutlineOnlyPaths silhouette=${silhouettePath ? 1 : 0}`
    + ` primary=${primaryPaths.length} structure=${structurePaths.length}`
    + ` total=${paths.length} target≥${minTargetPaths} cap=${maxOutlineStrokes}`
    + ` posterize=${posterizeColors} ΔE=${structureDeltaE}`,
  )

  return paths
}

/**
 * Hybrid outline: silhouette + major boundaries (structure) + ImageTracer detail supplement.
 * Sort: silhouette → structure boundaries (NN) → detail paths (NN).
 */
export function extractCleanOutline(plan: SketchPlan): VectorPath[] {
  const {
    colorIndex, w, h, palette, workspace, maxOutlineStrokes, useGrayscale,
    minBoundaryDeltaE, outlineRdpEpsilon, supplementMaxPaths,
  } = plan
  const { analysisCanvas } = workspace
  const minLen = Math.max(12, PIPELINE_CONFIG.sketchPathMinLengthPx * w / 384)
  const canvasDiag = Math.hypot(w, h)

  const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true })!
  const analysisData = analysisCtx.getImageData(0, 0, w, h).data
  const { hatchHeavy, score: hatchScore } = detectHatchHeavySource(analysisData, w, h)
  const effectiveMinDeltaE = hatchHeavy ? minBoundaryDeltaE + 4 : minBoundaryDeltaE

  const silhouettePts = extractSubjectSilhouetteFromPlan(plan)
  const silhouettePath = silhouettePts.length >= 3 ? silhouetteToVectorPath(silhouettePts, outlineRdpEpsilon) : null
  const subjectBbox: SubjectBbox | undefined = silhouettePts.length >= 3
    ? bboxFromPairs(silhouettePts)
    : undefined
  const subjectWidth = subjectBbox
    ? subjectBbox.maxX - subjectBbox.minX
    : w * 0.6

  const silReserve = silhouettePath ? 1 : 0
  const available = maxOutlineStrokes - silReserve
  let structureCap = Math.max(
    Math.ceil(available * PIPELINE_V4.structurePathBudgetRatio),
    available - supplementMaxPaths,
  )
  let detailBudget = supplementMaxPaths > 0 && !useGrayscale
    ? Math.min(supplementMaxPaths, Math.max(0, available - structureCap))
    : 0

  if (hatchHeavy) {
    structureCap = Math.min(
      available,
      Math.ceil(structureCap * PIPELINE_V4.hatchHeavyStructureBudgetBoost),
    )
    detailBudget = Math.floor(detailBudget * PIPELINE_V4.hatchHeavyDetailBudgetRatio)
    console.warn(
      `[regionVectorizer] hatch-heavy source score=${hatchScore.toFixed(2)}`
      + ` — detailBudget=${detailBudget} structureCap=${structureCap}`,
    )
  }

  const rawLoops = traceMajorBoundaries(
    colorIndex,
    w,
    h,
    palette,
    minLen,
    effectiveMinDeltaE,
  )

  let structurePaths = loopsToBoundaryPaths(
    rawLoops,
    minLen,
    outlineRdpEpsilon,
    structureCap,
    w,
    h,
  )

  const silKey = silhouettePath ? edgeCanonicalKey(silhouettePath.d) : null
  if (silKey) {
    structurePaths = structurePaths.filter((p) => edgeCanonicalKey(p.d) !== silKey)
  }

  const strictFilter: OutlineFilterOpts = {
    crossHatch: true,
    nearDup: true,
    diagonal: true,
    aggressiveHatch: hatchHeavy,
  }
  const relaxedFilter: OutlineFilterOpts = {
    crossHatch: false,
    nearDup: false,
    diagonal: true,
    aggressiveHatch: hatchHeavy,
  }

  structurePaths = applyOutlineFilters(
    structurePaths, w, h, canvasDiag, subjectWidth, strictFilter, subjectBbox,
  )

  const structureCount = structurePaths.length
  const structurePlusSil = silhouettePath ? [silhouettePath, ...structurePaths] : structurePaths

  let detailPaths: VectorPath[] = []
  const structureThreshold = Math.max(
    12,
    Math.floor(maxOutlineStrokes * PIPELINE_V4.structurePathBudgetRatio * 0.45),
  )
  const needsDetail = !hatchHeavy && structurePaths.length < structureThreshold
  const effectiveDetailBudget = needsDetail
    ? Math.max(detailBudget, supplementMaxPaths)
    : detailBudget

  if (effectiveDetailBudget > 0 && !useGrayscale) {
    detailPaths = supplementDetailStrokes(
      analysisCanvas,
      w,
      h,
      structurePlusSil,
      effectiveDetailBudget,
      canvasDiag,
      subjectWidth,
      subjectBbox,
      hatchHeavy,
    )
  }

  if (!plan.strictOutlines && !hatchHeavy && structurePaths.length + detailPaths.length < PIPELINE_CONFIG.minSketchStrokes) {
    console.warn(
      `[regionVectorizer] only ${structurePaths.length + detailPaths.length} strokes after filter — relaxing once`,
    )
    structurePaths = loopsToBoundaryPaths(
      rawLoops,
      minLen * 0.7,
      outlineRdpEpsilon,
      structureCap,
      w,
      h,
    )
    if (silKey) {
      structurePaths = structurePaths.filter((p) => edgeCanonicalKey(p.d) !== silKey)
    }
    structurePaths = applyOutlineFilters(
      structurePaths, w, h, canvasDiag, subjectWidth, relaxedFilter, subjectBbox,
    )
    if (detailBudget > 0 && !useGrayscale) {
      const base = silhouettePath ? [silhouettePath, ...structurePaths] : structurePaths
      detailPaths = supplementDetailStrokes(
        analysisCanvas, w, h, base, detailBudget, canvasDiag, subjectWidth, subjectBbox, hatchHeavy,
      )
    }
  }

  let silOut: VectorPath | null = silhouettePath
  let structOut = structurePaths
  if (silOut) {
    structOut = sortPathsNearestNeighbor(structOut, (() => {
      const pts = parsePathDAll(silOut!.d)[0]?.points ?? []
      return pts.length > 0 ? pts[pts.length - 1] : undefined
    })())
  } else {
    structOut = sortPathsNearestNeighbor(structOut)
  }

  let detailOut = detailPaths
  if (detailOut.length > 0) {
    detailOut = applyOutlineFilters(
      detailOut, w, h, canvasDiag, subjectWidth, strictFilter, subjectBbox,
    )
    const lastStruct = structOut[structOut.length - 1] ?? silOut
    const startFrom = lastStruct
      ? (parsePathDAll(lastStruct.d)[0]?.points.slice(-1)[0] as PointPair | undefined)
      : undefined
    detailOut = sortPathsNearestNeighbor(detailOut, startFrom)
  }

  let edgeFallbackPaths: VectorPath[] = []
  if (PIPELINE_V4.enableEdgeBandFallback && subjectBbox) {
    const preMerge = [
      ...(silOut ? [silOut] : []),
      ...structOut,
      ...detailOut,
    ]
    const edgeBudget = Math.max(0, maxOutlineStrokes - preMerge.length)
    if (edgeBudget > 0) {
      edgeFallbackPaths = supplementEdgeFallback(
        analysisCanvas,
        preMerge,
        subjectBbox,
        Math.min(edgeBudget, hatchHeavy ? 0 : 12),
        outlineRdpEpsilon,
        w,
        h,
        canvasDiag,
        subjectWidth,
        hatchHeavy,
      )
    }
  }

  let paths = [
    ...(silOut ? [silOut] : []),
    ...structOut,
    ...detailOut,
    ...edgeFallbackPaths,
  ]

  const minMeaningful = PIPELINE_V4.minMeaningfulOutlinePaths
  if (paths.length < minMeaningful) {
    const fallback = posterizeImageTracerFallback(
      analysisCanvas,
      w,
      h,
      maxOutlineStrokes,
      outlineRdpEpsilon,
      subjectBbox,
    )
    if (fallback.length > paths.length) {
      console.warn(
        `[regionVectorizer] outline sparse (${paths.length}) — using posterize fallback (${fallback.length})`,
      )
      const silKeyFb = silOut ? edgeCanonicalKey(silOut.d) : null
      const merged = silOut ? [silOut] : []
      for (const p of fallback) {
        if (silKeyFb && edgeCanonicalKey(p.d) === silKeyFb) continue
        merged.push(p)
      }
      paths = merged.slice(0, maxOutlineStrokes)
    }
  }

  if (paths.length > maxOutlineStrokes) {
    const silPart = silOut ? [silOut] : []
    const rest = paths.slice(silPart.length)
    const keepRest = maxOutlineStrokes - silPart.length
    paths = [...silPart, ...rest.slice(0, keepRest)]
  }

  console.log(
    `[regionVectorizer] extractCleanOutline silhouette=${silOut ? 1 : 0}`
    + ` structure=${structureCount} detail=${detailOut.length} edgeFallback=${edgeFallbackPaths.length}`
    + ` total=${paths.length} cap=${maxOutlineStrokes}`
    + ` structureCap=${structureCap} detailBudget=${detailBudget} grayscale=${useGrayscale}`
    + ` hatchHeavy=${hatchHeavy} hatchScore=${hatchScore.toFixed(2)}`,
  )

  return paths
}

function medianColorFromOriginalSamples(
  component: Set<number>,
  plan: SketchPlan,
  originalData: Uint8ClampedArray,
  origW: number,
  origH: number,
): string {
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const { w, scaleX, scaleY, offsetX, offsetY } = plan
  const step = component.size > 800 ? Math.ceil(component.size / 400) : 1
  let n = 0

  for (const idx of component) {
    n++
    if (step > 1 && n % step !== 0) continue
    const wx = idx % w
    const wy = Math.floor(idx / w)
    const ox = Math.min(origW - 1, Math.max(0, Math.round(wx * scaleX + offsetX)))
    const oy = Math.min(origH - 1, Math.max(0, Math.round(wy * scaleY + offsetY)))
    const p = (oy * origW + ox) * 4
    if (originalData[p + 3] < 128) continue
    rs.push(originalData[p])
    gs.push(originalData[p + 1])
    bs.push(originalData[p + 2])
  }

  if (rs.length === 0) return '#888888'
  rs.sort((a, b) => a - b)
  gs.sort((a, b) => a - b)
  bs.sort((a, b) => a - b)
  const mid = Math.floor(rs.length / 2)
  return safeRegionFillColor(rgbToHex(rs[mid], gs[mid], bs[mid]))
}

/** Min fill region area — 0.5% of workspace canvas (v4 default). */
const MIN_FILL_AREA_RATIO = 0.005

function regionCentroid(points: PointPair[]): PointPair {
  let sx = 0
  let sy = 0
  for (const [x, y] of points) {
    sx += x
    sy += y
  }
  return [sx / points.length, sy / points.length]
}

function mergeFillRegionsToMax(
  regions: ColorRegion[],
  maxRegions: number,
  minAreaRatio: number,
  canvasArea: number,
): ColorRegion[] {
  const minArea = canvasArea * minAreaRatio
  let merged = regions.filter((r) => r.area >= minArea)
  merged.sort((a, b) => b.area - a.area)

  while (merged.length > maxRegions) {
    const smallest = merged.pop()!
    if (merged.length === 0) break
    let bestIdx = 0
    let bestDist = Infinity
    const sc = regionCentroid(smallest.points)
    for (let i = 0; i < merged.length; i++) {
      const tc = regionCentroid(merged[i].points)
      const dist = Math.hypot(sc[0] - tc[0], sc[1] - tc[1])
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    }
    merged[bestIdx] = {
      ...merged[bestIdx],
      area: merged[bestIdx].area + smallest.area,
    }
  }

  return merged
}

function extractBackgroundFillRegion(
  colorIndex: Int32Array,
  w: number,
  h: number,
  originalData: Uint8ClampedArray,
  origW: number,
  origH: number,
  plan: SketchPlan,
): ColorRegion | null {
  const canvasArea = w * h
  const minPixels = Math.max(16, Math.floor(canvasArea * MIN_FILL_AREA_RATIO))
  const visited = new Uint8Array(w * h)
  let largest: Set<number> | null = null

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (colorIndex[idx] >= 0 || visited[idx]) continue
      const component = floodFillComponentPixels(colorIndex, w, h, x, y, -1, visited)
      if (component.size >= minPixels && (!largest || component.size > largest.size)) {
        largest = component
      }
    }
  }

  if (!largest || largest.size < minPixels) return null

  const points = traceComponentOutline(largest, w, h)
  if (points.length < 3) return null

  const color = medianColorFromOriginalSamples(largest, plan, originalData, origW, origH)
  return { colorIndex: -1, color, points, area: largest.size }
}

function subjectBboxFromColorIndex(colorIndex: Int32Array, w: number, h: number): SubjectBbox | null {
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  let found = false
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (colorIndex[y * w + x] < 0) continue
      found = true
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  if (!found || maxX <= minX || maxY <= minY) return null
  return { minX, minY, maxX, maxY }
}

/** Merge smallest fill regions into the largest subject region when coverage is sparse. */
function ensureFillCompleteness(
  regions: ColorRegion[],
  colorIndex: Int32Array,
  w: number,
  h: number,
  minCoverage: number,
): ColorRegion[] {
  if (regions.length < 2) return regions

  const canvasArea = w * h
  const subjectBbox = subjectBboxFromColorIndex(colorIndex, w, h)
  if (!subjectBbox) return regions

  const subjectArea = (subjectBbox.maxX - subjectBbox.minX + 1) * (subjectBbox.maxY - subjectBbox.minY + 1)
  let bgIdx = regions.reduce((best, r, i, arr) => {
    const lum = hexLuminance(r.color)
    const score = r.area + (lum > 230 ? canvasArea * 0.5 : 0)
    const bestScore = arr[best].area + (hexLuminance(arr[best].color) > 230 ? canvasArea * 0.5 : 0)
    return score > bestScore ? i : best
  }, 0)
  let subjectFillArea = 0
  for (let i = 0; i < regions.length; i++) {
    if (i === bgIdx) continue
    subjectFillArea += regions[i].area
  }

  const coveragePct = subjectArea > 0 ? (subjectFillArea / subjectArea) * 100 : 0
  const totalFillPct = regions.reduce((s, r) => s + r.area, 0) / canvasArea * 100

  console.log(
    `[regionVectorizer] fillCoverage subject=${coveragePct.toFixed(1)}%`
    + ` canvas=${totalFillPct.toFixed(1)}% regions=${regions.length}`,
  )

  if (totalFillPct < 95 || totalFillPct > 102) {
    console.warn(
      `[regionVectorizer] fill regions sum to ${totalFillPct.toFixed(1)}% of canvas (expected ~100%)`,
    )
  }

  if (coveragePct / 100 >= minCoverage) return regions

  console.warn(
    `[regionVectorizer] subject fill coverage ${coveragePct.toFixed(1)}% < ${(minCoverage * 100).toFixed(0)}%`
    + ` — merging smallest regions into body`,
  )

  let merged = regions.map((r) => ({ ...r, points: r.points }))
  let bodyIdx = -1
  for (let i = 0; i < merged.length; i++) {
    if (i === bgIdx) continue
    if (bodyIdx < 0 || merged[i].area > merged[bodyIdx].area) bodyIdx = i
  }
  if (bodyIdx < 0) return merged

  while (merged.length > 2) {
    subjectFillArea = merged.reduce((s, r, i) => (i === bgIdx ? s : s + r.area), 0)
    if (subjectFillArea / subjectArea >= minCoverage) break

    let smallestIdx = -1
    for (let i = 0; i < merged.length; i++) {
      if (i === bgIdx || i === bodyIdx) continue
      if (smallestIdx < 0 || merged[i].area < merged[smallestIdx].area) smallestIdx = i
    }
    if (smallestIdx < 0) break

    merged[bodyIdx] = {
      ...merged[bodyIdx],
      area: merged[bodyIdx].area + merged[smallestIdx].area,
    }
    merged.splice(smallestIdx, 1)
    if (smallestIdx < bodyIdx) bodyIdx--
    if (smallestIdx < bgIdx) bgIdx--
  }

  return merged.sort((a, b) => b.area - a.area)
}

/**
 * Build fill regions with median colors sampled from the ORIGINAL full-res Wanx image.
 * Includes background (largest) first, then all posterize regions >= min area.
 */
export function sampleColorsFromOriginal(
  plan: SketchPlan,
  originalCanvas: HTMLCanvasElement,
): ColorRegion[] {
  const { colorIndex, w, h, minFillAreaRatio, maxFillRegions } = plan
  const ctx = originalCanvas.getContext('2d', { willReadFrequently: true })!
  const originalData = ctx.getImageData(0, 0, originalCanvas.width, originalCanvas.height).data
  const minPixels = Math.max(16, Math.floor(w * h * minFillAreaRatio))
  const canvasArea = w * h
  const colorIds = new Set<number>()

  for (let i = 0; i < w * h; i++) {
    if (colorIndex[i] >= 0) colorIds.add(colorIndex[i])
  }

  const regions: ColorRegion[] = []

  const bgRegion = extractBackgroundFillRegion(
    colorIndex, w, h, originalData, originalCanvas.width, originalCanvas.height, plan,
  )
  if (bgRegion) regions.push(bgRegion)

  for (const c of colorIds) {
    const components = findAllComponentsForColor(colorIndex, w, h, c)
    for (const component of components) {
      if (component.size < minPixels) continue
      const points = traceComponentOutline(component, w, h)
      if (points.length < 3) continue
      const color = medianColorFromOriginalSamples(
        component,
        plan,
        originalData,
        originalCanvas.width,
        originalCanvas.height,
      )
      regions.push({ colorIndex: c, color, points, area: component.size })
    }
  }

  regions.sort((a, b) => b.area - a.area)

  const completenessChecked = ensureFillCompleteness(
    regions,
    colorIndex,
    w,
    h,
    PIPELINE_V4.subjectFillCoverageMin,
  )

  const capped = mergeFillRegionsToMax(
    completenessChecked,
    maxFillRegions,
    minFillAreaRatio,
    canvasArea,
  )

  capped.forEach((r, i) => {
    logFillRegion(i, r.color, ((r.area / canvasArea) * 100).toFixed(1))
  })

  console.log(
    `[regionVectorizer] sampleColorsFromOriginal regions=${capped.length}`
    + ` (bg=${bgRegion ? 1 : 0}) max=${maxFillRegions} from original ${originalCanvas.width}x${originalCanvas.height}`,
  )

  return capped
}

/** Scale workspace-region polygons to full canvas coordinates. */
export function scaleColorRegionsToCanvas(
  regions: ColorRegion[],
  plan: SketchPlan,
): ColorRegion[] {
  const { scaleX, scaleY, offsetX, offsetY } = plan
  return regions.map((r) => ({
    ...r,
    points: r.points.map(([x, y]) => [x * scaleX + offsetX, y * scaleY + offsetY] as PointPair),
    area: Math.round(r.area * scaleX * scaleY),
  }))
}
