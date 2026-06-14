import ImageTracer from 'imagetracerjs'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../constants/canvas'
import { extractPathsFromSvg, sortPathsOutlineOnly, type VectorPath } from './pathSorter'
import { bboxFromFlat, pairsToFlat } from './pathUtils'
import { parsePathDAll } from './svgPathParser'
import { preprocessCanvasForTrace } from './preprocessImage'
import { scalePaths, smoothVectorPaths } from './pathSmoother'
import { deduplicatePaths } from './pathDedup'
import {
  BINARY_THRESHOLD_WANX,
  TRACE_UPSCALE,
  type VectorizeResult,
} from './imageVectorizer'

const TRACER_OPTIONS_OUTLINE = {
  ltres: 2.0,
  qtres: 2.0,
  pathomit: 8,
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

const TRACER_OPTIONS_LONGEST = {
  ltres: 2.5,
  qtres: 2.5,
  pathomit: 50,
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

const OUTLINE_MIN_PATHS = 3
const LONGEST_PATH_KEEP = 15

export type OutlineTraceMode = 'boundary' | 'longest_paths'

export interface OutlineVectorizeResult extends Omit<VectorizeResult, 'traceMode'> {
  traceMode: OutlineTraceMode
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('无法加载图片'))
    img.src = src
  })
}

function fitToCanvas(
  img: HTMLImageElement,
  maxW: number,
  maxH: number,
): HTMLCanvasElement {
  const scale = Math.min(maxW / img.width, maxH / img.height, 1)
  const w = Math.round(img.width * scale)
  const h = Math.round(img.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = maxW
  canvas.height = maxH
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, maxW, maxH)
  ctx.drawImage(img, Math.floor((maxW - w) / 2), Math.floor((maxH - h) / 2), w, h)
  return canvas
}

/** 0 = background, 1 = foreground */
function toBinaryMask(data: Uint8ClampedArray, w: number, h: number, threshold: number): Uint8Array {
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      mask[y * w + x] = gray < threshold ? 1 : 0
    }
  }
  return mask
}

/** Flood-fill exterior background from corners; returns mask where 1=exterior bg. */
function floodFillExteriorBackground(mask: Uint8Array, w: number, h: number): Uint8Array {
  const exterior = new Uint8Array(w * h)
  const queue: number[] = []

  const seeds = [0, w - 1, (h - 1) * w, (h - 1) * w + w - 1]

  for (const idx of seeds) {
    if (mask[idx] === 0) {
      queue.push(idx)
      exterior[idx] = 1
    }
  }

  while (queue.length > 0) {
    const idx = queue.pop()!
    const x = idx % w
    const y = Math.floor(idx / w)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nIdx = ny * w + nx
      if (mask[nIdx] === 0 && exterior[nIdx] === 0) {
        exterior[nIdx] = 1
        queue.push(nIdx)
      }
    }
  }
  return exterior
}

/** Keep only the largest foreground connected component. */
function keepLargestComponent(mask: Uint8Array, w: number, h: number): void {
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

  if (sizes.size === 0) return

  let bestLabel = 1
  let bestSize = 0
  for (const [label, size] of sizes) {
    if (size > bestSize) {
      bestSize = size
      bestLabel = label
    }
  }

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1 && labels[i] !== bestLabel) mask[i] = 0
  }
}

/** Foreground pixel bordering exterior background → outer outline only. */
function extractOutlineRing(mask: Uint8Array, exteriorBg: Uint8Array, w: number, h: number): Uint8Array {
  const ring = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (mask[idx] !== 1) continue
      let isEdge = false
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          isEdge = true
          break
        }
        const nIdx = ny * w + nx
        if (exteriorBg[nIdx] === 1) {
          isEdge = true
          break
        }
      }
      if (isEdge) ring[idx] = 1
    }
  }
  return ring
}

function ringToImageData(ring: Uint8Array, w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < ring.length; i++) {
    const v = ring[i] ? 0 : 255
    const p = i * 4
    data[p] = v
    data[p + 1] = v
    data[p + 2] = v
    data[p + 3] = 255
  }
  return new ImageData(data, w, h)
}

function expandSubpaths(raw: VectorPath[]): VectorPath[] {
  const expanded: VectorPath[] = []
  for (const path of raw) {
    const subpaths = parsePathDAll(path.d)
    if (subpaths.length <= 1) {
      expanded.push(path)
      continue
    }
    for (const sp of subpaths) {
      if (sp.points.length < 2) continue
      const flat = pairsToFlat(sp.points)
      const bbox = bboxFromFlat(flat)
      let length = 0
      for (let i = 1; i < sp.points.length; i++) {
        const [x0, y0] = sp.points[i - 1]
        const [x1, y1] = sp.points[i]
        length += Math.hypot(x1 - x0, y1 - y0)
      }
      expanded.push({
        d: sp.points
          .map(([x, y], idx) => (idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`))
          .join(' '),
        minX: bbox.minX,
        minY: bbox.minY,
        length,
      })
    }
  }
  return expanded
}

function traceImageData(
  imgd: ImageData,
  tracerOpts: typeof TRACER_OPTIONS_OUTLINE,
): VectorPath[] {
  const svgString = ImageTracer.imagedataToSVG(imgd, tracerOpts)
  return expandSubpaths(extractPathsFromSvg(svgString))
}

function keepLongestPaths(paths: VectorPath[], n: number): VectorPath[] {
  return [...paths].sort((a, b) => b.length - a.length).slice(0, n)
}

function finalizePaths(
  rawPaths: VectorPath[],
  canvasW: number,
  canvasH: number,
  fineDetail: boolean,
  traceScale: number,
): VectorPath[] {
  let paths = rawPaths
  if (traceScale > 1) {
    paths = scalePaths(paths, traceScale)
  }
  paths = smoothVectorPaths(paths, fineDetail, {
    canvasW,
    canvasH,
    dropHatching: true,
    aggressiveHatchFilter: true,
  })
  paths = deduplicatePaths(paths)
  return sortPathsOutlineOnly(paths)
}

function buildResult(
  paths: VectorPath[],
  canvasW: number,
  canvasH: number,
  rawPathCount: number,
  traceMode: OutlineTraceMode,
): OutlineVectorizeResult {
  const shortPathCount = paths.filter((p) => p.length < 25).length
  return {
    paths,
    canvasWidth: canvasW,
    canvasHeight: canvasH,
    rawPathCount,
    filteredPathCount: paths.length,
    shortPathCount,
    traceMode,
  }
}

/** Option A+C: flood-fill background → largest blob → outline ring → imagetracer. */
function vectorizeBoundaryOutline(
  canvas: HTMLCanvasElement,
  canvasW: number,
  canvasH: number,
  fineDetail: boolean,
): { paths: VectorPath[]; rawPathCount: number; traceScale: number } {
  const preprocessed = preprocessCanvasForTrace(canvas, {
    threshold: BINARY_THRESHOLD_WANX,
    blurRadius: 1,
    scaleFactor: TRACE_UPSCALE,
  })
  const { width: w, height: h, data } = preprocessed.imageData
  const mask = toBinaryMask(data, w, h, BINARY_THRESHOLD_WANX)
  const exteriorBg = floodFillExteriorBackground(mask, w, h)
  keepLargestComponent(mask, w, h)
  const ring = extractOutlineRing(mask, exteriorBg, w, h)
  const ringImgd = ringToImageData(ring, w, h)
  const rawPaths = traceImageData(ringImgd, TRACER_OPTIONS_OUTLINE)
  const paths = finalizePaths(rawPaths, canvasW, canvasH, fineDetail, preprocessed.traceScale)
  return { paths, rawPathCount: rawPaths.length, traceScale: preprocessed.traceScale }
}

/** Option B: full imagetracer then keep only top N longest paths (drops interior hatch). */
function vectorizeLongestPathsOnly(
  canvas: HTMLCanvasElement,
  canvasW: number,
  canvasH: number,
  fineDetail: boolean,
  keepN = LONGEST_PATH_KEEP,
): { paths: VectorPath[]; rawPathCount: number } {
  const preprocessed = preprocessCanvasForTrace(canvas, {
    threshold: BINARY_THRESHOLD_WANX,
    blurRadius: 1,
    scaleFactor: TRACE_UPSCALE,
  })
  let rawPaths = traceImageData(preprocessed.imageData, TRACER_OPTIONS_LONGEST)
  const rawPathCount = rawPaths.length
  rawPaths = keepLongestPaths(rawPaths, keepN)
  const paths = finalizePaths(rawPaths, canvasW, canvasH, fineDetail, preprocessed.traceScale)
  return { paths, rawPathCount }
}

export async function vectorizeOutlineFromSource(
  source: string,
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  fineDetail = false,
): Promise<OutlineVectorizeResult> {
  const img = await loadImage(source)
  const canvas = fitToCanvas(img, canvasWidth, canvasHeight)

  const boundary = vectorizeBoundaryOutline(canvas, canvasWidth, canvasHeight, fineDetail)
  if (boundary.paths.length >= OUTLINE_MIN_PATHS) {
    return buildResult(
      boundary.paths,
      canvasWidth,
      canvasHeight,
      boundary.rawPathCount,
      'boundary',
    )
  }

  console.warn(
    `[outlineVectorizer] Boundary outline yielded ${boundary.paths.length} paths; falling back to top-${LONGEST_PATH_KEEP} longest`,
  )
  const longest = vectorizeLongestPathsOnly(canvas, canvasWidth, canvasHeight, fineDetail)
  return buildResult(
    longest.paths,
    canvasWidth,
    canvasHeight,
    longest.rawPathCount,
    'longest_paths',
  )
}

export async function vectorizeOutlineFromBase64(
  base64: string,
  mimeType = 'image/png',
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  fineDetail = false,
): Promise<OutlineVectorizeResult> {
  const dataUrl = base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`
  return vectorizeOutlineFromSource(dataUrl, canvasWidth, canvasHeight, fineDetail)
}
