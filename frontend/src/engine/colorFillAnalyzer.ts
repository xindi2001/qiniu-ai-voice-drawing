import type { PointPair } from '../types/commands'
import type { VectorPath } from './pathSorter'
import { PIPELINE_CONFIG } from '../constants/traceConfig'
import { yieldIfDue, yieldToMain } from './analysisWorkspace'

export type FillRegionRole = 'background' | 'body' | 'detail' | 'accent'

export interface SemanticFillRegion {
  id: string
  mask: Uint8Array
  color: string
  area: number
  bbox: { x: number; y: number; w: number; h: number }
  role: FillRegionRole
  sortOrder: number
  /** Closed contour for clip / polygon fill */
  contour: PointPair[]
}

export interface ColorAnalyzeOptions {
  maxRegions?: number
  minAreaRatio?: number
  mergeSimilarDeltaE?: number
  enforceSingleSubject?: boolean
  posterizeColors?: number
}

export interface PrimarySubjectInfo {
  bbox: { x: number; y: number; w: number; h: number }
  discardedSecondaryBlobs: number
  subjectMask: Uint8Array
}

const BG_LUMINANCE = 240
const MAX_BG_FILL_RATIO = 0.40
const MAX_BODY_FILL_RATIO = 0.35

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function hexLuminance(hex: string): number {
  const h = hex.replace('#', '')
  if (h.length < 6) return 128
  return luminance(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))
}

function rgbSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
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

function deltaE(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function isNearBackground(r: number, g: number, b: number): boolean {
  return luminance(r, g, b) > BG_LUMINANCE
}

function medianColorFromIndices(indices: number[], data: Uint8ClampedArray): string {
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (const idx of indices) {
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

function bboxFromIndices(indices: number[], w: number): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const idx of indices) {
    const x = idx % w
    const y = Math.floor(idx / w)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Largest non-background connected component — crop analysis to primary subject. */
function detectPrimarySubjectFromData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  minAreaRatio = 0.03,
): PrimarySubjectInfo {
  const minPixels = Math.floor(w * h * minAreaRatio)

  const fg = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    fg[i] = (data[p + 3] >= 128 && !isNearBackground(data[p], data[p + 1], data[p + 2])) ? 1 : 0
  }

  const labels = new Int32Array(w * h)
  const blobs: { label: number; pixels: number[]; size: number }[] = []
  let nextLabel = 1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (fg[idx] !== 1 || labels[idx] !== 0) continue
      const label = nextLabel++
      const queue = [idx]
      labels[idx] = label
      const pixels: number[] = []
      while (queue.length > 0) {
        const cur = queue.pop()!
        pixels.push(cur)
        const cx = cur % w
        const cy = Math.floor(cur / w)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const nIdx = ny * w + nx
          if (fg[nIdx] === 1 && labels[nIdx] === 0) {
            labels[nIdx] = label
            queue.push(nIdx)
          }
        }
      }
      if (pixels.length >= minPixels) {
        blobs.push({ label, pixels, size: pixels.length })
      }
    }
  }

  const subjectMask = new Uint8Array(w * h)
  if (blobs.length === 0) {
    return {
      bbox: { x: 0, y: 0, w, h },
      discardedSecondaryBlobs: 0,
      subjectMask,
    }
  }

  blobs.sort((a, b) => b.size - a.size)
  const primary = blobs[0]
  for (const blob of blobs) {
    for (const idx of blob.pixels) subjectMask[idx] = 1
  }
  const bbox = bboxFromIndices(primary.pixels, w)
  const discarded = Math.max(0, blobs.length - 1)
  const areaPct = ((bbox.w * bbox.h) / (w * h) * 100).toFixed(1)

  console.log(
    `[color] primarySubject bbox=${bbox.x},${bbox.y},${bbox.w}x${bbox.h}`
    + ` area=${areaPct}% discarded=${discarded} secondary blobs`,
  )

  return { bbox, discardedSecondaryBlobs: discarded, subjectMask }
}

export function detectPrimarySubjectBBox(
  canvas: HTMLCanvasElement,
  minAreaRatio = 0.03,
): PrimarySubjectInfo {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data
  return detectPrimarySubjectFromData(data, w, h, minAreaRatio)
}

function buildLabPalette(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  subjectMask: Uint8Array,
  k: number,
): [number, number, number][] {
  const samples: [number, number, number][] = []
  const step = Math.max(1, Math.floor((w * h) / 2500))
  for (let i = 0; i < w * h; i += step) {
    if (!subjectMask[i]) continue
    const p = i * 4
    if (data[p + 3] < 128) continue
    samples.push([data[p], data[p + 1], data[p + 2]])
  }
  if (samples.length === 0) return [[128, 128, 128]]
  return runKMeansRgb(samples, k)
}

async function buildLabPaletteAsync(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  subjectMask: Uint8Array,
  k: number,
  signal?: AbortSignal,
): Promise<[number, number, number][]> {
  const samples: [number, number, number][] = []
  const step = Math.max(1, Math.floor((w * h) / 2500))
  for (let i = 0; i < w * h; i += step) {
    if (!subjectMask[i]) continue
    const p = i * 4
    if (data[p + 3] < 128) continue
    samples.push([data[p], data[p + 1], data[p + 2]])
    if (i % (step * 64) === 0) {
      await yieldIfDue()
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    }
  }
  if (samples.length === 0) return [[128, 128, 128]]
  return runKMeansRgbAsync(samples, k, signal)
}

function runKMeansRgb(samples: [number, number, number][], k: number): [number, number, number][] {
  let centroids = samples.slice(0, Math.min(k, samples.length))
  while (centroids.length < k) {
    centroids.push(samples[Math.floor(Math.random() * samples.length)])
  }

  for (let iter = 0; iter < 10; iter++) {
    const buckets: [number, number, number][][] = Array.from({ length: k }, () => [])
    for (const s of samples) {
      const lab = rgbToLab(s[0], s[1], s[2])
      let best = 0
      let bestDist = Infinity
      for (let c = 0; c < k; c++) {
        const clab = rgbToLab(centroids[c][0], centroids[c][1], centroids[c][2])
        const d = deltaE(lab, clab)
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

async function runKMeansRgbAsync(
  samples: [number, number, number][],
  k: number,
  signal?: AbortSignal,
): Promise<[number, number, number][]> {
  let centroids = samples.slice(0, Math.min(k, samples.length))
  while (centroids.length < k) {
    centroids.push(samples[Math.floor(Math.random() * samples.length)])
  }

  for (let iter = 0; iter < 10; iter++) {
    await yieldIfDue()
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const buckets: [number, number, number][][] = Array.from({ length: k }, () => [])
    for (let si = 0; si < samples.length; si++) {
      const s = samples[si]
      const lab = rgbToLab(s[0], s[1], s[2])
      let best = 0
      let bestDist = Infinity
      for (let c = 0; c < k; c++) {
        const clab = rgbToLab(centroids[c][0], centroids[c][1], centroids[c][2])
        const d = deltaE(lab, clab)
        if (d < bestDist) {
          bestDist = d
          best = c
        }
      }
      buckets[best].push(s)
      if (si % 256 === 0) {
        await yieldIfDue()
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      }
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

function assignPosterIndex(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  subjectMask: Uint8Array,
  palette: [number, number, number][],
): Int32Array {
  const out = new Int32Array(w * h).fill(-1)
  const labs = palette.map(([r, g, b]) => rgbToLab(r, g, b))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (!subjectMask[idx]) continue
      const p = idx * 4
      const r = data[p]
      const g = data[p + 1]
      const b = data[p + 2]
      if (data[p + 3] < 128 || isNearBackground(r, g, b)) continue
      const lab = rgbToLab(r, g, b)
      let best = 0
      let bestDist = Infinity
      for (let c = 0; c < labs.length; c++) {
        const d = deltaE(lab, labs[c])
        if (d < bestDist) {
          bestDist = d
          best = c
        }
      }
      out[idx] = best
    }
  }
  return out
}

async function assignPosterIndexAsync(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  subjectMask: Uint8Array,
  palette: [number, number, number][],
  signal?: AbortSignal,
): Promise<Int32Array> {
  const out = new Int32Array(w * h).fill(-1)
  const labs = palette.map(([r, g, b]) => rgbToLab(r, g, b))
  for (let y = 0; y < h; y++) {
    if (y % 8 === 0) {
      await yieldIfDue()
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    }
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (!subjectMask[idx]) continue
      const p = idx * 4
      const r = data[p]
      const g = data[p + 1]
      const b = data[p + 2]
      if (data[p + 3] < 128 || isNearBackground(r, g, b)) continue
      const lab = rgbToLab(r, g, b)
      let best = 0
      let bestDist = Infinity
      for (let c = 0; c < labs.length; c++) {
        const d = deltaE(lab, labs[c])
        if (d < bestDist) {
          bestDist = d
          best = c
        }
      }
      out[idx] = best
    }
  }
  return out
}

function floodFillComponent(
  colorIndex: Int32Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  target: number,
  visited: Uint8Array,
): number[] {
  const stack: [number, number][] = [[sx, sy]]
  const pixels: number[] = []
  while (stack.length > 0) {
    const [x, y] = stack.pop()!
    const idx = y * w + x
    if (x < 0 || y < 0 || x >= w || y >= h) continue
    if (visited[idx] || colorIndex[idx] !== target) continue
    visited[idx] = 1
    pixels.push(idx)
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
  }
  return pixels
}

function subdivideOversizedRegion(
  pixels: number[],
  data: Uint8ClampedArray,
  minPixels: number,
): number[][] {
  const samples: [number, number, number][] = []
  for (const idx of pixels) {
    const p = idx * 4
    samples.push([data[p], data[p + 1], data[p + 2]])
  }
  const k = Math.min(4, Math.max(2, Math.ceil(pixels.length / (minPixels * 3))))
  let centroids = samples.slice(0, k)
  while (centroids.length < k) {
    centroids.push(samples[Math.floor(Math.random() * samples.length)])
  }
  for (let iter = 0; iter < 6; iter++) {
    const buckets: [number, number, number][][] = Array.from({ length: k }, () => [])
    for (const s of samples) {
      let best = 0
      let bestDist = Infinity
      for (let c = 0; c < k; c++) {
        const d = (s[0] - centroids[c][0]) ** 2 + (s[1] - centroids[c][1]) ** 2 + (s[2] - centroids[c][2]) ** 2
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
  const subGroups: number[][] = Array.from({ length: k }, () => [])
  for (let i = 0; i < pixels.length; i++) {
    const s = samples[i]
    let best = 0
    let bestDist = Infinity
    for (let c = 0; c < k; c++) {
      const d = (s[0] - centroids[c][0]) ** 2 + (s[1] - centroids[c][1]) ** 2 + (s[2] - centroids[c][2]) ** 2
      if (d < bestDist) {
        bestDist = d
        best = c
      }
    }
    subGroups[best].push(pixels[i])
  }
  return subGroups.filter((g) => g.length >= minPixels)
}

const MOORE = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]

function isRegionBoundary(index: Int32Array, w: number, h: number, x: number, y: number): boolean {
  const c = index[y * w + x]
  if (c < 0) return false
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return true
    if (index[ny * w + nx] !== c) return true
  }
  return false
}

function traceMaskContour(w: number, h: number, regionPixels: number[]): PointPair[] {
  const label = new Int32Array(w * h).fill(-1)
  for (const idx of regionPixels) label[idx] = 0
  const visited = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (visited[i] || !isRegionBoundary(label, w, h, x, y)) continue
      const points: PointPair[] = [[x + 0.5, y + 0.5]]
      visited[i] = 1
      let cx = x
      let cy = y
      let dir = 0
      const startX = x
      const startY = y
      for (let steps = 0; steps < w * h * 2; steps++) {
        let moved = false
        for (let d = 0; d < 8; d++) {
          const nd = (dir + d) % 8
          const [dx, dy] = MOORE[nd]
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          if (!isRegionBoundary(label, w, h, nx, ny)) continue
          cx = nx
          cy = ny
          dir = (nd + 6) % 8
          if (cx === startX && cy === startY && points.length > 3) return points
          if (!visited[ny * w + nx]) {
            visited[ny * w + nx] = 1
            points.push([cx + 0.5, cy + 0.5])
          }
          moved = true
          break
        }
        if (!moved) break
        if (cx === startX && cy === startY && points.length > 3) break
      }
      if (points.length >= 3) return points
    }
  }
  return []
}

function classifyRole(
  color: string,
  areaRatio: number,
  areaRank: number,
  totalRegions: number,
): FillRegionRole {
  const lum = hexLuminance(color)
  const rgb = color.replace('#', '')
  const r = parseInt(rgb.slice(0, 2), 16)
  const g = parseInt(rgb.slice(2, 4), 16)
  const b = parseInt(rgb.slice(4, 6), 16)
  const sat = rgbSaturation(r, g, b)

  if (lum > 230 || areaRatio > 0.25 && lum > 200) return 'background'
  if (areaRank === 0 && lum < 230) return 'body'
  if (areaRatio < 0.04 && sat > 0.25) return 'accent'
  if (areaRatio < 0.08) return 'detail'
  if (areaRank <= Math.max(1, Math.floor(totalRegions * 0.3))) return 'body'
  return 'detail'
}

function roleSortOrder(role: FillRegionRole, area: number): number {
  const base = role === 'background' ? 0 : role === 'body' ? 100 : role === 'detail' ? 200 : 300
  return base + (role === 'body' ? -area : area)
}

function bboxContour(bbox: { x: number; y: number; w: number; h: number }): PointPair[] {
  const { x, y, w, h } = bbox
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]
}

interface RawRegion {
  pixels: number[]
  colorIdx: number
  color: string
}

function extractRawRegions(
  colorIndex: Int32Array,
  w: number,
  h: number,
  data: Uint8ClampedArray,
  minPixels: number,
  maxBodyPixels: number,
  maxBgPixels: number,
): RawRegion[] {
  const visited = new Uint8Array(w * h)
  const raw: RawRegion[] = []
  const colorIds = new Set<number>()
  for (let i = 0; i < w * h; i++) {
    if (colorIndex[i] >= 0) colorIds.add(colorIndex[i])
  }

  for (const c of colorIds) {
    visited.fill(0)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x
        if (visited[idx] || colorIndex[idx] !== c) continue
        let pixels = floodFillComponent(colorIndex, w, h, x, y, c, visited)
        if (pixels.length < minPixels) continue

        const color = medianColorFromIndices(pixels, data)
        const lum = hexLuminance(color)

        if (pixels.length > maxBgPixels && lum > 200) continue

        if (pixels.length > maxBodyPixels && lum <= 200) {
          const subs = subdivideOversizedRegion(pixels, data, minPixels)
          if (subs.length > 1) {
            for (const sub of subs) {
              raw.push({
                pixels: sub,
                colorIdx: c,
                color: medianColorFromIndices(sub, data),
              })
            }
            continue
          }
        }

        raw.push({ pixels, colorIdx: c, color })
      }
    }
  }
  return raw
}

/** Posterize + connected components → semantic fill regions with source-sampled colors. */
export function analyzeColorRegionsFromSource(
  sourceCanvas: HTMLCanvasElement,
  opts: ColorAnalyzeOptions = {},
): SemanticFillRegion[] {
  const w = sourceCanvas.width
  const h = sourceCanvas.height
  const canvasArea = w * h
  const maxRegions = opts.maxRegions ?? PIPELINE_CONFIG.maxColorRegions
  const minAreaRatio = opts.minAreaRatio ?? PIPELINE_CONFIG.minColorRegionAreaRatio
  const mergeDeltaE = opts.mergeSimilarDeltaE ?? 20
  const enforceSingle = opts.enforceSingleSubject ?? PIPELINE_CONFIG.enforceSingleSubject
  const posterizeK = opts.posterizeColors ?? 8

  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data

  let subjectMask: Uint8Array
  if (enforceSingle) {
    subjectMask = detectPrimarySubjectBBox(sourceCanvas).subjectMask
  } else {
    subjectMask = new Uint8Array(w * h).fill(1)
  }

  const palette = buildLabPalette(data, w, h, subjectMask, posterizeK)
  const colorIndex = assignPosterIndex(data, w, h, subjectMask, palette)

  const minPixels = Math.max(8, Math.floor(canvasArea * minAreaRatio))
  const maxBodyPixels = Math.floor(canvasArea * MAX_BODY_FILL_RATIO)
  const maxBgPixels = Math.floor(canvasArea * MAX_BG_FILL_RATIO)

  let raw = extractRawRegions(colorIndex, w, h, data, minPixels, maxBodyPixels, maxBgPixels)

  raw.sort((a, b) => b.pixels.length - a.pixels.length)
  if (raw.length > maxRegions) raw = raw.slice(0, maxRegions)

  const regions: SemanticFillRegion[] = raw.map((r, i) => {
    const mask = new Uint8Array(w * h)
    for (const idx of r.pixels) mask[idx] = 1
    const areaRatio = r.pixels.length / canvasArea
    const role = classifyRole(r.color, areaRatio, i, raw.length)
    const bbox = bboxFromIndices(r.pixels, w)
    const traced = traceMaskContour(w, h, r.pixels)
    const contour = traced.length >= 3 ? traced : bboxContour(bbox)
    return {
      id: `fill-${i}`,
      mask,
      color: r.color,
      area: r.pixels.length,
      bbox,
      role,
      sortOrder: roleSortOrder(role, r.pixels.length),
      contour,
    }
  })

  regions.sort((a, b) => a.sortOrder - b.sortOrder || a.area - b.area)

  const colors = regions.map((r) => r.color)
  const roles = regions.map((r) => r.role)
  console.log(
    `[color] regions=${regions.length} colors=[${colors.join(',')}] roles=[${roles.join(',')}]`
    + ` mergeΔE=${mergeDeltaE}`,
  )

  return mergeRegionsToCap(regions, PIPELINE_CONFIG.maxAnimatedColorRegions)
}

/** Closed contour for the primary subject silhouette (full-res canvas coords). */
export function buildSubjectCoverageContour(
  sourceCanvas: HTMLCanvasElement,
): { contour: PointPair[]; area: number } | null {
  const w = sourceCanvas.width
  const h = sourceCanvas.height
  const { subjectMask, bbox } = detectPrimarySubjectBBox(sourceCanvas)
  const pixels: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (subjectMask[i]) pixels.push(i)
  }
  if (pixels.length === 0) return null
  const traced = traceMaskContour(w, h, pixels)
  const contour = traced.length >= 3 ? traced : bboxContour(bbox)
  return { contour, area: pixels.length }
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

/** Shared edges between posterized regions — sketch stroke boundaries only. */
export function extractSemanticBoundaryPaths(
  sourceCanvas: HTMLCanvasElement,
  opts: ColorAnalyzeOptions = {},
  maxStrokes: number = PIPELINE_CONFIG.maxOutlineStrokes,
  minLengthPx: number = PIPELINE_CONFIG.sketchPathMinLengthPx,
): VectorPath[] {
  const w = sourceCanvas.width
  const h = sourceCanvas.height
  const enforceSingle = opts.enforceSingleSubject ?? PIPELINE_CONFIG.enforceSingleSubject
  const posterizeK = opts.posterizeColors ?? 8

  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data
  const subjectMask = enforceSingle
    ? detectPrimarySubjectBBox(sourceCanvas).subjectMask
    : new Uint8Array(w * h).fill(1)

  const palette = buildLabPalette(data, w, h, subjectMask, posterizeK)
  const colorIndex = assignPosterIndex(data, w, h, subjectMask, palette)

  const visited = new Uint8Array(w * h)
  const loops: PointPair[][] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (visited[i] || !isRegionBoundary(colorIndex, w, h, x, y)) continue
      const points: PointPair[] = [[x + 0.5, y + 0.5]]
      visited[i] = 1
      let cx = x
      let cy = y
      let dir = 0
      const sx = x
      const sy = y
      for (let steps = 0; steps < w * h * 2; steps++) {
        let moved = false
        for (let d = 0; d < 8; d++) {
          const nd = (dir + d) % 8
          const [dx, dy] = MOORE[nd]
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          if (!isRegionBoundary(colorIndex, w, h, nx, ny)) continue
          cx = nx
          cy = ny
          dir = (nd + 6) % 8
          if (cx === sx && cy === sy && points.length > 3) {
            loops.push(points)
            moved = true
            break
          }
          if (!visited[ny * w + nx]) {
            visited[ny * w + nx] = 1
            points.push([cx + 0.5, cy + 0.5])
          }
          moved = true
          break
        }
        if (!moved) {
          if (points.length >= 4) loops.push(points)
          break
        }
        if (cx === sx && cy === sy && points.length > 3) {
          loops.push(points)
          break
        }
      }
    }
  }

  const paths: VectorPath[] = []
  for (const loop of loops) {
    const len = pathLengthFromPairs(loop)
    if (len < minLengthPx) continue
    const d = pairsToPathD(loop, loop.length > 3)
    paths.push({ d, minX: 0, minY: 0, length: len })
  }
  paths.sort((a, b) => b.length - a.length)
  return paths.slice(0, maxStrokes)
}

export interface UnifiedImageAnalysis {
  w: number
  h: number
  data: Uint8ClampedArray
  subjectMask: Uint8Array
  regions: SemanticFillRegion[]
  boundaryPaths: VectorPath[]
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  if (h.length < 6) return [128, 128, 128]
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

/** Merge tiny fill regions so color animation stays at or below cap. */
function mergeRegionsToCap(
  regions: SemanticFillRegion[],
  cap: number,
): SemanticFillRegion[] {
  if (regions.length <= cap) return regions

  const sorted = [...regions].sort((a, b) => b.area - a.area)
  const kept = sorted.slice(0, cap)
  const dropped = sorted.slice(cap)

  for (const small of dropped) {
    const smallLab = rgbToLab(...hexToRgb(small.color))
    let best = kept[0]
    let bestDist = Infinity
    for (const k of kept) {
      const d = deltaE(smallLab, rgbToLab(...hexToRgb(k.color)))
      if (d < bestDist) {
        bestDist = d
        best = k
      }
    }
    for (let i = 0; i < small.mask.length; i++) {
      if (small.mask[i]) best.mask[i] = 1
    }
    best.area += small.area
    const bx0 = Math.min(best.bbox.x, small.bbox.x)
    const by0 = Math.min(best.bbox.y, small.bbox.y)
    const bx1 = Math.max(best.bbox.x + best.bbox.w, small.bbox.x + small.bbox.w)
    const by1 = Math.max(best.bbox.y + best.bbox.h, small.bbox.y + small.bbox.h)
    best.bbox = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 }
  }

  return kept.sort((a, b) => a.sortOrder - b.sortOrder || a.area - b.area)
}

function extractBoundaryPathsFromColorIndex(
  colorIndex: Int32Array,
  w: number,
  h: number,
  maxStrokes: number,
  minLengthPx: number,
): VectorPath[] {
  const visited = new Uint8Array(w * h)
  const loops: PointPair[][] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (visited[i] || !isRegionBoundary(colorIndex, w, h, x, y)) continue
      const points: PointPair[] = [[x + 0.5, y + 0.5]]
      visited[i] = 1
      let cx = x
      let cy = y
      let dir = 0
      const sx = x
      const sy = y
      for (let steps = 0; steps < w * h * 2; steps++) {
        let moved = false
        for (let d = 0; d < 8; d++) {
          const nd = (dir + d) % 8
          const [dx, dy] = MOORE[nd]
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          if (!isRegionBoundary(colorIndex, w, h, nx, ny)) continue
          cx = nx
          cy = ny
          dir = (nd + 6) % 8
          if (cx === sx && cy === sy && points.length > 3) {
            loops.push(points)
            moved = true
            break
          }
          if (!visited[ny * w + nx]) {
            visited[ny * w + nx] = 1
            points.push([cx + 0.5, cy + 0.5])
          }
          moved = true
          break
        }
        if (!moved) {
          if (points.length >= 4) loops.push(points)
          break
        }
        if (cx === sx && cy === sy && points.length > 3) {
          loops.push(points)
          break
        }
      }
    }
  }

  const paths: VectorPath[] = []
  for (const loop of loops) {
    const len = pathLengthFromPairs(loop)
    if (len < minLengthPx) continue
    const d = pairsToPathD(loop, loop.length > 3)
    paths.push({ d, minX: 0, minY: 0, length: len })
  }
  paths.sort((a, b) => b.length - a.length)
  return paths.slice(0, maxStrokes)
}

function buildRegionsFromPosterize(
  colorIndex: Int32Array,
  w: number,
  h: number,
  data: Uint8ClampedArray,
  opts: ColorAnalyzeOptions,
): SemanticFillRegion[] {
  const canvasArea = w * h
  const maxRegions = opts.maxRegions ?? PIPELINE_CONFIG.maxColorRegions
  const minAreaRatio = opts.minAreaRatio ?? PIPELINE_CONFIG.minColorRegionAreaRatio
  const mergeDeltaE = opts.mergeSimilarDeltaE ?? 20
  const minPixels = Math.max(8, Math.floor(canvasArea * minAreaRatio))
  const maxBodyPixels = Math.floor(canvasArea * MAX_BODY_FILL_RATIO)
  const maxBgPixels = Math.floor(canvasArea * MAX_BG_FILL_RATIO)

  let raw = extractRawRegions(colorIndex, w, h, data, minPixels, maxBodyPixels, maxBgPixels)
  raw.sort((a, b) => b.pixels.length - a.pixels.length)
  if (raw.length > maxRegions) raw = raw.slice(0, maxRegions)

  const regions: SemanticFillRegion[] = raw.map((r, i) => {
    const mask = new Uint8Array(w * h)
    for (const idx of r.pixels) mask[idx] = 1
    const areaRatio = r.pixels.length / canvasArea
    const role = classifyRole(r.color, areaRatio, i, raw.length)
    const bbox = bboxFromIndices(r.pixels, w)
    const traced = traceMaskContour(w, h, r.pixels)
    const contour = traced.length >= 3 ? traced : bboxContour(bbox)
    return {
      id: `fill-${i}`,
      mask,
      color: r.color,
      area: r.pixels.length,
      bbox,
      role,
      sortOrder: roleSortOrder(role, r.pixels.length),
      contour,
    }
  })

  regions.sort((a, b) => a.sortOrder - b.sortOrder || a.area - b.area)

  const colors = regions.map((r) => r.color)
  const roles = regions.map((r) => r.role)
  console.log(
    `[color] regions=${regions.length} colors=[${colors.join(',')}] roles=[${roles.join(',')}]`
    + ` mergeΔE=${mergeDeltaE}`,
  )

  return mergeRegionsToCap(regions, PIPELINE_CONFIG.maxAnimatedColorRegions)
}

/** Single posterize pass — regions + sketch boundaries from one pixel read. */
export function analyzeImageUnified(
  sourceCanvas: HTMLCanvasElement,
  opts: ColorAnalyzeOptions = {},
  maxStrokes: number = PIPELINE_CONFIG.maxOutlineStrokes,
  minLengthPx: number = PIPELINE_CONFIG.sketchPathMinLengthPx,
): UnifiedImageAnalysis {
  const w = sourceCanvas.width
  const h = sourceCanvas.height
  const enforceSingle = opts.enforceSingleSubject ?? PIPELINE_CONFIG.enforceSingleSubject
  const posterizeK = opts.posterizeColors ?? 8

  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data

  const subjectMask = enforceSingle
    ? detectPrimarySubjectFromData(data, w, h).subjectMask
    : new Uint8Array(w * h).fill(1)

  const palette = buildLabPalette(data, w, h, subjectMask, posterizeK)
  const colorIndex = assignPosterIndex(data, w, h, subjectMask, palette)

  const regions = buildRegionsFromPosterize(colorIndex, w, h, data, opts)
  const boundaryPaths = extractBoundaryPathsFromColorIndex(
    colorIndex, w, h, maxStrokes, minLengthPx,
  )

  return { w, h, data, subjectMask, regions, boundaryPaths }
}

/** Async posterize pass — yields to main thread between heavy steps. */
export async function analyzeImageUnifiedAsync(
  sourceCanvas: HTMLCanvasElement,
  opts: ColorAnalyzeOptions = {},
  maxStrokes: number = PIPELINE_CONFIG.maxOutlineStrokes,
  minLengthPx: number = PIPELINE_CONFIG.sketchPathMinLengthPx,
  signal?: AbortSignal,
): Promise<UnifiedImageAnalysis> {
  const w = sourceCanvas.width
  const h = sourceCanvas.height
  const enforceSingle = opts.enforceSingleSubject ?? PIPELINE_CONFIG.enforceSingleSubject
  const posterizeK = opts.posterizeColors ?? 8

  await yieldToMain()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data

  await yieldIfDue()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const subjectMask = enforceSingle
    ? detectPrimarySubjectFromData(data, w, h).subjectMask
    : new Uint8Array(w * h).fill(1)

  await yieldIfDue()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const palette = await buildLabPaletteAsync(data, w, h, subjectMask, posterizeK, signal)
  const colorIndex = await assignPosterIndexAsync(data, w, h, subjectMask, palette, signal)

  await yieldIfDue()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const regions = buildRegionsFromPosterize(colorIndex, w, h, data, opts)

  await yieldIfDue()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const boundaryPaths = extractBoundaryPathsFromColorIndex(
    colorIndex, w, h, maxStrokes, minLengthPx,
  )

  return { w, h, data, subjectMask, regions, boundaryPaths }
}
