/** Image preprocessing before imagetracerjs — blur, binarize, optional 2× upscale. */

import type { TraceConfig } from '../constants/traceConfig'
import { DEFAULT_TRACE_CONFIG } from '../constants/traceConfig'

export interface PreprocessOptions {
  /** Grayscale threshold (0–255); pixels darker than this become black. */
  threshold?: number
  /** Light Gaussian blur radius in px before threshold (reduces noise). */
  blurRadius?: number
  /** Scale factor applied before trace; coordinates are scaled back afterward. */
  scaleFactor?: number
}

const DEFAULT_THRESHOLD = 175
const DEFAULT_BLUR = 1
const DEFAULT_SCALE = 2
const TRACE_UPSCALE = 1.5

function gaussianKernel(radius: number): number[] {
  const sigma = Math.max(0.5, radius / 2)
  const size = radius * 2 + 1
  const kernel: number[] = []
  let sum = 0
  for (let i = 0; i < size; i++) {
    const x = i - radius
    const v = Math.exp(-(x * x) / (2 * sigma * sigma))
    kernel.push(v)
    sum += v
  }
  return kernel.map((v) => v / sum)
}

/** Separable Gaussian blur on grayscale channel. */
function blurGrayscale(data: Uint8ClampedArray, w: number, h: number, radius: number): void {
  if (radius <= 0) return
  const kernel = gaussianKernel(radius)
  const kLen = kernel.length
  const tmp = new Float32Array(w * h)
  const gray = new Float32Array(w * h)

  for (let i = 0; i < w * h; i++) {
    gray[i] = data[i * 4]
  }

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = 0; k < kLen; k++) {
        const sx = Math.min(w - 1, Math.max(0, x + k - radius))
        sum += gray[y * w + sx] * kernel[k]
      }
      tmp[y * w + x] = sum
    }
  }

  // Vertical pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = 0; k < kLen; k++) {
        const sy = Math.min(h - 1, Math.max(0, y + k - radius))
        sum += tmp[sy * w + x] * kernel[k]
      }
      const v = Math.round(sum)
      const idx = (y * w + x) * 4
      data[idx] = v
      data[idx + 1] = v
      data[idx + 2] = v
    }
  }
}

function binarize(data: Uint8ClampedArray, threshold: number): void {
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    const v = gray < threshold ? 0 : 255
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
    data[i + 3] = 255
  }
}

/** Otsu adaptive threshold on grayscale histogram (0–255). */
export function computeOtsuThreshold(data: Uint8ClampedArray): number {
  const hist = new Uint32Array(256)
  let total = 0
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
    hist[gray]++
    total++
  }
  if (total === 0) return DEFAULT_THRESHOLD

  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]

  let sumB = 0
  let wB = 0
  let maxVar = 0
  let threshold = DEFAULT_THRESHOLD

  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const varBetween = wB * wF * (mB - mF) ** 2
    if (varBetween > maxVar) {
      maxVar = varBetween
      threshold = t
    }
  }
  return threshold
}

export interface PreprocessResult {
  imageData: ImageData
  /** Scale applied before trace; divide path coords by this to map back to canvas. */
  traceScale: number
}

/** Sobel magnitude on luminance — returns normalized edge strength 0–255 per pixel. */
function sobelLuminanceEdges(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const gray = new Float32Array(w * h)
  for (let i = 0, p = 0; p < data.length; p += 4, i++) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  const out = new Uint8Array(w * h)
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
  const scale = maxMag > 0 ? 255 / maxMag : 1
  for (let i = 0; i < mag.length; i++) {
    out[i] = Math.round(mag[i] * scale)
  }
  return out
}

export interface ColoringPreprocessOptions extends PreprocessOptions {
  /** Sobel peak ratio for edge binarization (lower = more edges). */
  edgePeakRatio?: number
  /** Remove connected black components smaller than this many pixels. */
  minComponentArea?: number
}

/** Remove tiny speckle components from binary image (black=edge, white=bg). */
function removeSmallComponents(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  minArea: number,
): void {
  if (minArea <= 1) return
  const labels = new Int32Array(w * h)
  let nextLabel = 1
  const areas = new Map<number, number>()

  const idx = (x: number, y: number) => y * w + x
  const isBlack = (x: number, y: number) => data[idx(x, y) * 4] === 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y)
      if (!isBlack(x, y) || labels[i] !== 0) continue
      const label = nextLabel++
      const stack: number[] = [i]
      let area = 0
      labels[i] = label

      while (stack.length > 0) {
        const cur = stack.pop()!
        area++
        const cx = cur % w
        const cy = Math.floor(cur / w)
        const neighbors = [
          [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1],
        ]
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const ni = idx(nx, ny)
          if (labels[ni] !== 0 || !isBlack(nx, ny)) continue
          labels[ni] = label
          stack.push(ni)
        }
      }
      areas.set(label, area)
    }
  }

  for (let i = 0; i < w * h; i++) {
    const label = labels[i]
    if (label === 0) continue
    const area = areas.get(label) ?? 0
    if (area < minArea) {
      const p = i * 4
      data[p] = 255
      data[p + 1] = 255
      data[p + 2] = 255
    }
  }
}

/**
 * Color OR line-art Wanx output → edge-enhanced binary for ImageTracer.
 * Combines Otsu luminance threshold with Sobel edges to preserve hair/clothing lines.
 */
export function preprocessForColoringTrace(
  sourceCanvas: HTMLCanvasElement,
  opts: ColoringPreprocessOptions = {},
): PreprocessResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const blurRadius = opts.blurRadius ?? DEFAULT_BLUR
  const scaleFactor = opts.scaleFactor ?? DEFAULT_SCALE
  const edgePeakRatio = opts.edgePeakRatio ?? 0.14
  const minComponentArea = opts.minComponentArea ?? 0

  let w = sourceCanvas.width
  let h = sourceCanvas.height
  const work = document.createElement('canvas')
  work.width = w
  work.height = h
  const wctx = work.getContext('2d')!
  wctx.drawImage(sourceCanvas, 0, 0)

  if (scaleFactor > 1) {
    const scaled = document.createElement('canvas')
    scaled.width = Math.round(w * scaleFactor)
    scaled.height = Math.round(h * scaleFactor)
    const sctx = scaled.getContext('2d')!
    sctx.imageSmoothingEnabled = true
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(work, 0, 0, scaled.width, scaled.height)
    w = scaled.width
    h = scaled.height
    work.width = w
    work.height = h
    wctx.drawImage(scaled, 0, 0)
  }

  const raw = wctx.getImageData(0, 0, w, h)
  const otsu = computeOtsuThreshold(raw.data)
  const effectiveThreshold = Math.min(threshold, otsu + 8)
  const blurred = new ImageData(new Uint8ClampedArray(raw.data), w, h)
  blurGrayscale(blurred.data, w, h, blurRadius)
  const edges = sobelLuminanceEdges(blurred.data, w, h)
  const edgeThreshold = Math.round(255 * edgePeakRatio)

  const out = wctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    const gray = 0.299 * blurred.data[p] + 0.587 * blurred.data[p + 1] + 0.114 * blurred.data[p + 2]
    const isEdge = edges[i] >= edgeThreshold
    const isDark = gray < effectiveThreshold
    const v = isEdge || isDark ? 0 : 255
    out.data[p] = v
    out.data[p + 1] = v
    out.data[p + 2] = v
    out.data[p + 3] = 255
  }
  if (minComponentArea > 0) {
    removeSmallComponents(out.data, w, h, minComponentArea)
  }
  wctx.putImageData(out, 0, 0)

  return {
    imageData: wctx.getImageData(0, 0, w, h),
    traceScale: scaleFactor,
  }
}

/** Primary contour pass — strong blur + high edge threshold (fewer shading edges). */
export function preprocessContourPrimary(
  sourceCanvas: HTMLCanvasElement,
  threshold: number,
): PreprocessResult {
  return preprocessForColoringTrace(sourceCanvas, {
    threshold,
    blurRadius: 2,
    scaleFactor: TRACE_UPSCALE,
    edgePeakRatio: 0.16,
    minComponentArea: 12,
  })
}

/** Detail supplement pass — moderate threshold for facial features / wheels. */
export function preprocessContourDetail(
  sourceCanvas: HTMLCanvasElement,
  threshold: number,
): PreprocessResult {
  return preprocessForColoringTrace(sourceCanvas, {
    threshold,
    blurRadius: 1,
    scaleFactor: TRACE_UPSCALE,
    edgePeakRatio: 0.16,
    minComponentArea: 6,
  })
}

/** 3×3 binary erosion — removes 1px speckle noise. */
function erodeBinary(data: Uint8ClampedArray, w: number, h: number): void {
  const copy = new Uint8ClampedArray(data)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      if (copy[i] !== 0) continue
      let keep = true
      for (let dy = -1; dy <= 1 && keep; dy++) {
        for (let dx = -1; dx <= 1 && keep; dx++) {
          const ni = ((y + dy) * w + (x + dx)) * 4
          if (copy[ni] !== 0) keep = false
        }
      }
      if (!keep) {
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
      }
    }
  }
}

/** 3×3 binary dilation — closes small gaps in subject outline. */
function dilateBinary(data: Uint8ClampedArray, w: number, h: number): void {
  const copy = new Uint8ClampedArray(data)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      if (copy[i] === 0) continue
      let touchBlack = false
      for (let dy = -1; dy <= 1 && !touchBlack; dy++) {
        for (let dx = -1; dx <= 1 && !touchBlack; dx++) {
          const ni = ((y + dy) * w + (x + dx)) * 4
          if (copy[ni] === 0) touchBlack = true
        }
      }
      if (touchBlack) {
        data[i] = 0
        data[i + 1] = 0
        data[i + 2] = 0
      }
    }
  }
}

/** Keep only the largest black connected component as subject (white background). */
function keepLargestComponent(data: Uint8ClampedArray, w: number, h: number): void {
  const labels = new Int32Array(w * h)
  let nextLabel = 1
  const areas = new Map<number, number>()
  const idx = (x: number, y: number) => y * w + x
  const isBlack = (x: number, y: number) => data[idx(x, y) * 4] === 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y)
      if (!isBlack(x, y) || labels[i] !== 0) continue
      const label = nextLabel++
      const stack = [i]
      let area = 0
      labels[i] = label
      while (stack.length > 0) {
        const cur = stack.pop()!
        area++
        const cx = cur % w
        const cy = Math.floor(cur / w)
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const ni = idx(nx, ny)
          if (labels[ni] !== 0 || !isBlack(nx, ny)) continue
          labels[ni] = label
          stack.push(ni)
        }
      }
      areas.set(label, area)
    }
  }

  if (areas.size <= 1) return
  let bestLabel = 1
  let bestArea = 0
  for (const [label, area] of areas) {
    if (area > bestArea) {
      bestArea = area
      bestLabel = label
    }
  }

  for (let i = 0; i < w * h; i++) {
    const label = labels[i]
    if (label === 0) continue
    if (label !== bestLabel) {
      const p = i * 4
      data[p] = 255
      data[p + 1] = 255
      data[p + 2] = 255
    }
  }
}

export interface PhotographicDetection {
  photographic: boolean
  gradientRatio: number
  colorSpread: number
}

/**
 * Detect Wanx output that still looks photographic (gradients/reflections).
 * High smooth-gradient ratio + wide color spread → binarizeTwoLevel will collapse to a blob.
 */
export function detectPhotographicImage(canvas: HTMLCanvasElement): PhotographicDetection {
  const ctx = canvas.getContext('2d')
  if (!ctx) return { photographic: false, gradientRatio: 0, colorSpread: 0 }

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const step = 6
  let gradientPixels = 0
  let samples = 0
  let minL = 255
  let maxL = 0
  const bucket = new Set<number>()

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const idx = (y * width + x) * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const a = data[idx + 3]
      if (a < 32) continue

      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
      minL = Math.min(minL, lum)
      maxL = Math.max(maxL, lum)
      bucket.add(Math.floor(r / 16) * 4096 + Math.floor(g / 16) * 256 + Math.floor(b / 16))

      const neighbors = [
        (y * width + (x + step)) * 4,
        ((y + step) * width + x) * 4,
      ]
      let smoothGrad = true
      for (const ni of neighbors) {
        const nr = data[ni]
        const ng = data[ni + 1]
        const nb = data[ni + 2]
        const nLum = 0.299 * nr + 0.587 * ng + 0.114 * nb
        const diff = Math.abs(lum - nLum)
        if (diff < 4 || diff > 48) {
          smoothGrad = false
          break
        }
      }
      if (smoothGrad) gradientPixels++
      samples++
    }
  }

  if (samples === 0) return { photographic: false, gradientRatio: 0, colorSpread: 0 }

  const gradientRatio = gradientPixels / samples
  const colorSpread = maxL - minL
  const manyColors = bucket.size > 120
  const photographic = gradientRatio > 0.12 && colorSpread > 90 && manyColors

  return { photographic, gradientRatio, colorSpread }
}

export interface BinarizeTwoLevelOptions {
  threshold?: number
  scaleFactor?: number
  minComponentArea?: number
  /** When true, keep only the largest foreground blob (subject). */
  subjectMask?: boolean
}

/**
 * Principle 2 — strict two-level binarization: subject (black) + background (white) only.
 * Otsu threshold, morphological clean, optional largest-component subject mask.
 */
export function binarizeTwoLevel(
  sourceCanvas: HTMLCanvasElement,
  opts: BinarizeTwoLevelOptions = {},
): PreprocessResult {
  const threshold = opts.threshold ?? DEFAULT_TRACE_CONFIG.binarizeThreshold
  const scaleFactor = opts.scaleFactor ?? DEFAULT_TRACE_CONFIG.traceUpscale
  const minComponentArea = opts.minComponentArea ?? DEFAULT_TRACE_CONFIG.minComponentArea
  const subjectMask = opts.subjectMask !== false

  let w = sourceCanvas.width
  let h = sourceCanvas.height
  const work = document.createElement('canvas')
  work.width = w
  work.height = h
  const wctx = work.getContext('2d')!
  wctx.drawImage(sourceCanvas, 0, 0)

  if (scaleFactor > 1) {
    const scaled = document.createElement('canvas')
    scaled.width = Math.round(w * scaleFactor)
    scaled.height = Math.round(h * scaleFactor)
    const sctx = scaled.getContext('2d')!
    sctx.imageSmoothingEnabled = false
    sctx.drawImage(work, 0, 0, scaled.width, scaled.height)
    w = scaled.width
    h = scaled.height
    work.width = w
    work.height = h
    wctx.drawImage(scaled, 0, 0)
  }

  const imgData = wctx.getImageData(0, 0, w, h)
  const otsu = computeOtsuThreshold(imgData.data)
  const effective = Math.max(threshold, otsu)
  binarize(imgData.data, effective)

  erodeBinary(imgData.data, w, h)
  dilateBinary(imgData.data, w, h)
  dilateBinary(imgData.data, w, h)
  erodeBinary(imgData.data, w, h)

  if (minComponentArea > 0) {
    removeSmallComponents(imgData.data, w, h, minComponentArea)
  }
  if (subjectMask) {
    keepLargestComponent(imgData.data, w, h)
  }

  wctx.putImageData(imgData, 0, 0)
  return {
    imageData: wctx.getImageData(0, 0, w, h),
    traceScale: scaleFactor,
  }
}

/** Convenience wrapper using TraceConfig fields. */
export function binarizeTwoLevelWithConfig(
  sourceCanvas: HTMLCanvasElement,
  config: TraceConfig,
): PreprocessResult {
  return binarizeTwoLevel(sourceCanvas, {
    threshold: config.binarizeThreshold,
    scaleFactor: config.traceUpscale,
    minComponentArea: config.minComponentArea,
    subjectMask: true,
  })
}

/**
 * Prepare canvas pixels for tracing: optional 2× upscale, blur→threshold binarize, light thinning.
 */
export function preprocessCanvasForTrace(
  sourceCanvas: HTMLCanvasElement,
  opts: PreprocessOptions = {},
): PreprocessResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const blurRadius = opts.blurRadius ?? DEFAULT_BLUR
  const scaleFactor = opts.scaleFactor ?? DEFAULT_SCALE

  let w = sourceCanvas.width
  let h = sourceCanvas.height
  const work = document.createElement('canvas')
  work.width = w
  work.height = h
  const wctx = work.getContext('2d')!
  wctx.drawImage(sourceCanvas, 0, 0)

  if (scaleFactor > 1) {
    const scaled = document.createElement('canvas')
    scaled.width = Math.round(w * scaleFactor)
    scaled.height = Math.round(h * scaleFactor)
    const sctx = scaled.getContext('2d')!
    sctx.imageSmoothingEnabled = true
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(work, 0, 0, scaled.width, scaled.height)
    w = scaled.width
    h = scaled.height
    work.width = w
    work.height = h
    wctx.drawImage(scaled, 0, 0)
  }

  const imgData = wctx.getImageData(0, 0, w, h)
  blurGrayscale(imgData.data, w, h, blurRadius)
  binarize(imgData.data, threshold)
  wctx.putImageData(imgData, 0, 0)

  return {
    imageData: wctx.getImageData(0, 0, w, h),
    traceScale: scaleFactor,
  }
}
