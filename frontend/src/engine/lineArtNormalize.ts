/**
 * Universal pre-vectorize normalization — posterize + contrast + Otsu binarize.
 * Works for flat illustration and photo-ish Wanx output alike.
 */

import { DEFAULT_TRACE_CONFIG } from '../constants/traceConfig'
import { PIPELINE_CONFIG } from '../constants/traceConfig'
import { computeOtsuThreshold } from './preprocessImage'

const MAX_TRACE_DIM = DEFAULT_TRACE_CONFIG.maxTraceDimension

function traceContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return canvas.getContext('2d', { willReadFrequently: true })!
}

function resizeToTraceWorkspace(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const longest = Math.max(canvas.width, canvas.height)
  if (longest <= MAX_TRACE_DIM) return canvas

  const scale = MAX_TRACE_DIM / longest
  const w = Math.round(canvas.width * scale)
  const h = Math.round(canvas.height * scale)
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = traceContext(out)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(canvas, 0, 0, w, h)
  return out
}

/** Reduce gradients by quantizing RGB to N discrete levels. */
function posterize(data: Uint8ClampedArray, colorCount: number): void {
  const levels = Math.max(2, colorCount)
  const step = 255 / (levels - 1)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 32) continue
    for (let c = 0; c < 3; c++) {
      data[i + c] = Math.round(data[i + c] / step) * step
    }
  }
}

/** Simple histogram stretch on luminance — CLAHE-lite for trace-friendly contrast. */
function stretchContrast(data: Uint8ClampedArray): void {
  let minL = 255
  let maxL = 0
  const lum: number[] = []

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 32) continue
    const l = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
    lum.push(l)
    minL = Math.min(minL, l)
    maxL = Math.max(maxL, l)
  }

  if (lum.length === 0 || maxL - minL < 20) return
  const range = maxL - minL

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 32) continue
    for (let c = 0; c < 3; c++) {
      const stretched = ((data[i + c] - minL) / range) * 255
      data[i + c] = Math.max(0, Math.min(255, Math.round(stretched)))
    }
  }
}

function toGrayscale(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
    data[i] = gray
    data[i + 1] = gray
    data[i + 2] = gray
    data[i + 3] = 255
  }
}

function otsuBinarize(data: Uint8ClampedArray, threshold: number): void {
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] < threshold ? 0 : 255
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
    data[i + 3] = 255
  }
}

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

/** Morphological close — dilate then erode to bridge small gaps in outlines. */
function morphClose(data: Uint8ClampedArray, w: number, h: number, radius: number): void {
  for (let i = 0; i < radius; i++) dilateBinary(data, w, h)
  for (let i = 0; i < radius; i++) erodeBinary(data, w, h)
}

/**
 * Universal pre-vectorize: posterize → contrast → grayscale → Otsu → morph close.
 * Returns a binary-ready canvas suitable for ImageTracer on ANY subject.
 */
export function normalizeToLineArt(
  canvas: HTMLCanvasElement,
  posterizeColors: number = PIPELINE_CONFIG.posterizeColors,
): HTMLCanvasElement {
  const sized = resizeToTraceWorkspace(canvas)
  const w = sized.width
  const h = sized.height
  const work = document.createElement('canvas')
  work.width = w
  work.height = h
  const ctx = traceContext(work)
  ctx.drawImage(sized, 0, 0)

  const imgData = ctx.getImageData(0, 0, w, h)
  posterize(imgData.data, posterizeColors)
  stretchContrast(imgData.data)
  toGrayscale(imgData.data)
  const threshold = computeOtsuThreshold(imgData.data)
  otsuBinarize(imgData.data, threshold)
  morphClose(imgData.data, w, h, 2)
  ctx.putImageData(imgData, 0, 0)
  return work
}
