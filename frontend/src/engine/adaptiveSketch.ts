import { PIPELINE_CONFIG } from '../constants/traceConfig'
import type { WanxStyle } from '../constants/traceConfig'

export type SketchStyle =
  | 'flat_cartoon'
  | 'detailed_illustration'
  | 'grayscale_illustration'
  | 'color_illustration'
  | 'photo_like'

export interface SketchProfile {
  style: SketchStyle
  strokeColor: string
  strokeWidth: number
  maxOutlineStrokes: number
  maxFillRegions: number
  useEdgeExtraction: boolean
  simplifyEpsilon: number
  /** Suggest Wanx flat-illustration retry when source looks photographic. */
  needsFlatRetry: boolean
}

interface ImageStats {
  grayscaleRatio: number
  uniqueColors: number
  avgSaturation: number
  edgeDensity: number
  gradientSpread: number
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function computeEdgeDensity(data: Uint8ClampedArray, w: number, h: number): number {
  const gray = new Float32Array(w * h)
  for (let i = 0, p = 0; p < data.length; p += 4, i++) {
    gray[i] = luminance(data[p], data[p + 1], data[p + 2])
  }

  let edgePixels = 0
  let maxMag = 0
  const mag = new Float32Array(w * h)

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x
      const gx =
        -gray[idx - w - 1] - 2 * gray[idx - 1] - gray[idx + w - 1]
        + gray[idx - w + 1] + 2 * gray[idx + 1] + gray[idx + w + 1]
      const gy =
        -gray[idx - w - 1] - 2 * gray[idx - w] - gray[idx - w + 1]
        + gray[idx + w - 1] + 2 * gray[idx + w] + gray[idx + w + 1]
      const m = Math.hypot(gx, gy)
      mag[idx] = m
      if (m > maxMag) maxMag = m
    }
  }

  if (maxMag < 1e-6) return 0
  const threshold = maxMag * 0.2
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] >= threshold) edgePixels++
  }
  return edgePixels / (w * h)
}

function sampleImageStats(canvas: HTMLCanvasElement): ImageStats {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const data = ctx.getImageData(0, 0, w, h).data
  const step = Math.max(1, Math.floor((w * h) / 4000))

  const colorSet = new Set<string>()
  let grayish = 0
  let sampled = 0
  let totalSat = 0
  const lumSamples: number[] = []

  for (let i = 0; i < w * h; i += step) {
    const p = i * 4
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    if (data[p + 3] < 128) continue

    sampled++
    const qr = r >> 3
    const qg = g >> 3
    const qb = b >> 3
    colorSet.add(`${qr},${qg},${qb}`)

    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    totalSat += max === 0 ? 0 : (max - min) / max

    if (Math.abs(r - g) < 18 && Math.abs(g - b) < 18 && Math.abs(r - b) < 18) {
      grayish++
    }

    const lum = luminance(r, g, b)
    if (lum < 248) lumSamples.push(lum)
  }

  lumSamples.sort((a, b) => a - b)
  const p10 = lumSamples[Math.floor(lumSamples.length * 0.1)] ?? 0
  const p90 = lumSamples[Math.floor(lumSamples.length * 0.9)] ?? 255
  const gradientSpread = p90 - p10

  return {
    grayscaleRatio: sampled > 0 ? grayish / sampled : 0,
    uniqueColors: colorSet.size,
    avgSaturation: sampled > 0 ? totalSat / sampled : 0,
    edgeDensity: computeEdgeDensity(data, w, h),
    gradientSpread,
  }
}

function strokeWidthForCanvas(canvas: HTMLCanvasElement, detail: 'low' | 'mid' | 'high'): number {
  const diag = Math.hypot(canvas.width, canvas.height)
  const scale = diag / 1100
  const base = detail === 'low' ? 1.0 : detail === 'mid' ? 1.2 : 1.5
  return Math.min(1.8, Math.max(1.0, base * scale))
}

/** Sample median color from darkest ~10% of non-background pixels. */
function sampleDarkestStrokeColor(canvas: HTMLCanvasElement): string {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return '#2a2a2a'
  const data = ctx.getImageData(0, 0, w, h).data
  const step = Math.max(1, Math.floor((w * h) / 3000))
  const samples: { lum: number; r: number; g: number; b: number }[] = []
  for (let i = 0; i < w * h; i += step) {
    const p = i * 4
    if (data[p + 3] < 128) continue
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    const lum = luminance(r, g, b)
    if (lum > 245) continue
    samples.push({ lum, r, g, b })
  }
  if (samples.length === 0) return '#2a2a2a'
  samples.sort((a, b) => a.lum - b.lum)
  const slice = samples.slice(0, Math.max(1, Math.floor(samples.length * 0.05)))
  const rs = slice.map((s) => s.r).sort((a, b) => a - b)
  const gs = slice.map((s) => s.g).sort((a, b) => a - b)
  const bs = slice.map((s) => s.b).sort((a, b) => a - b)
  const mid = Math.floor(slice.length / 2)
  const toHex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${toHex(rs[mid])}${toHex(gs[mid])}${toHex(bs[mid])}`
}

function detectStyle(stats: ImageStats): SketchStyle {
  const { grayscaleRatio, uniqueColors, avgSaturation, edgeDensity, gradientSpread } = stats

  if (
    uniqueColors > 90
    && avgSaturation > 0.18
    && edgeDensity > 0.06
    && gradientSpread > 80
  ) {
    return 'photo_like'
  }

  if (grayscaleRatio > 0.72 && avgSaturation < 0.14) {
    return 'grayscale_illustration'
  }

  if (uniqueColors < 32 && avgSaturation < 0.38 && gradientSpread < 120) {
    return 'flat_cartoon'
  }

  return 'color_illustration'
}

export function profileForStyle(style: SketchStyle, canvas: HTMLCanvasElement): SketchProfile {
  const cfg = PIPELINE_CONFIG

  switch (style) {
    case 'flat_cartoon':
      return {
        style,
        strokeColor: '#1a1a1a',
        strokeWidth: strokeWidthForCanvas(canvas, 'mid'),
        maxOutlineStrokes: Math.min(40, cfg.maxOutlineStrokes),
        maxFillRegions: 6,
        useEdgeExtraction: false,
        simplifyEpsilon: 2.0,
        needsFlatRetry: false,
      }
    case 'detailed_illustration':
      return {
        style,
        strokeColor: sampleDarkestStrokeColor(canvas),
        strokeWidth: strokeWidthForCanvas(canvas, 'high'),
        maxOutlineStrokes: Math.min(40, cfg.maxOutlineStrokes),
        maxFillRegions: cfg.detailedMaxColorRegions,
        useEdgeExtraction: false,
        simplifyEpsilon: 1.8,
        needsFlatRetry: false,
      }
    case 'grayscale_illustration':
      return {
        style,
        strokeColor: '#3d3d3d',
        strokeWidth: strokeWidthForCanvas(canvas, 'low'),
        maxOutlineStrokes: Math.min(35, cfg.maxGrayscaleSketchStrokes, cfg.maxOutlineStrokes),
        maxFillRegions: 5,
        useEdgeExtraction: false,
        simplifyEpsilon: 2.5,
        needsFlatRetry: true,
      }
    case 'color_illustration':
      return {
        style,
        strokeColor: '#2a2a2a',
        strokeWidth: strokeWidthForCanvas(canvas, 'mid'),
        maxOutlineStrokes: Math.min(40, cfg.maxOutlineStrokes),
        maxFillRegions: cfg.maxFillRegions,
        useEdgeExtraction: false,
        simplifyEpsilon: 2.0,
        needsFlatRetry: false,
      }
    case 'photo_like':
      return {
        style,
        strokeColor: '#333333',
        strokeWidth: strokeWidthForCanvas(canvas, 'low'),
        maxOutlineStrokes: Math.min(30, cfg.maxOutlineStrokes),
        maxFillRegions: 4,
        useEdgeExtraction: true,
        simplifyEpsilon: 3.0,
        needsFlatRetry: true,
      }
  }
}

/** Map Wanx generation style to sketch/fill analysis profile. */
export function profileForWanxStyle(wanxStyle: WanxStyle, canvas: HTMLCanvasElement): SketchProfile {
  if (wanxStyle === 'flat_cartoon') {
    return profileForStyle('flat_cartoon', canvas)
  }
  return analyzeImageForSketch(canvas)
}

/** Analyze Wanx/source image and pick sketch + fill parameters. */
export function analyzeImageForSketch(canvas: HTMLCanvasElement): SketchProfile {
  if (!PIPELINE_CONFIG.adaptiveSketch) {
    return profileForStyle('detailed_illustration', canvas)
  }

  const stats = sampleImageStats(canvas)
  let style = detectStyle(stats)

  // Prefer detailed profile when image is not clearly flat cartoon
  if (style === 'color_illustration') {
    style = 'detailed_illustration'
  }

  const profile = profileForStyle(style, canvas)

  console.log(
    `[sketch] analyze grayscale=${(stats.grayscaleRatio * 100).toFixed(0)}%`
    + ` colors=${stats.uniqueColors} sat=${stats.avgSaturation.toFixed(2)}`
    + ` edges=${(stats.edgeDensity * 100).toFixed(1)}% → ${style}`,
  )

  return profile
}
