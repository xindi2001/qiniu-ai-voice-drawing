import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../constants/canvas'
import { bboxFromFlat, isCanvasBorderArtifact, sanitizeFlatPath } from './pathUtils'

export const MAX_WANX_EDGES = 60
export const MAX_WANX_EDGES_FINE = 100
export const MAX_VEHICLE_EDGE_SUPPLEMENT = 30
export const MAX_VEHICLE_EDGES = 100
const VEHICLE_SOBEL_RATIO = 0.22
const VEHICLE_MIN_POLYLINE_LEN = 25

export interface EdgeVectorizeResult {
  /** Flat [x1,y1,x2,y2,...] polylines ready for Konva */
  flats: number[][]
  rawEdgeCount: number
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

function sobelMagnitude(data: Uint8ClampedArray, width: number, height: number): { mag: Float32Array; maxMag: number } {
  const gray = new Float32Array(width * height)
  for (let i = 0, p = 0; p < data.length; p += 4, i++) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }

  const mag = new Float32Array(width * height)
  let maxMag = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const gx =
        -gray[idx - width - 1] - 2 * gray[idx - 1] - gray[idx + width - 1]
        + gray[idx - width + 1] + 2 * gray[idx + 1] + gray[idx + width + 1]
      const gy =
        -gray[idx - width - 1] - 2 * gray[idx - width] - gray[idx - width + 1]
        + gray[idx + width - 1] + 2 * gray[idx + width] + gray[idx + width + 1]
      const m = Math.hypot(gx, gy)
      mag[idx] = m
      if (m > maxMag) maxMag = m
    }
  }

  return { mag, maxMag }
}

function magnitudeToEdges(mag: Float32Array, maxMag: number, peakRatio: number): Uint8Array {
  const threshold = maxMag * peakRatio
  const edges = new Uint8Array(mag.length)
  for (let i = 0; i < mag.length; i++) {
    edges[i] = mag[i] >= threshold ? 1 : 0
  }
  return edges
}

/** Grayscale + Sobel magnitude → binary edge map (Canny-lite peak threshold). */
function sobelEdges(data: Uint8ClampedArray, width: number, height: number, peakRatio = 0.18): Uint8Array {
  const { mag, maxMag } = sobelMagnitude(data, width, height)
  return magnitudeToEdges(mag, maxMag, peakRatio)
}

/** 1px morphological erosion to suppress noise before tracing. */
function erodeEdges(edges: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (!edges[idx]) continue
      let keep = true
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (!edges[(y + dy) * width + (x + dx)]) {
          keep = false
          break
        }
      }
      out[idx] = keep ? 1 : 0
    }
  }
  return out
}

const NEIGHBORS: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
]

function tracePolyline(
  edges: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  visited: Uint8Array,
): number[] {
  const flat: number[] = []
  let x = startX
  let y = startY

  while (true) {
    const idx = y * width + x
    if (!edges[idx] || visited[idx]) break
    visited[idx] = 1
    flat.push(x, y)

    let found = false
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const nIdx = ny * width + nx
      if (edges[nIdx] && !visited[nIdx]) {
        x = nx
        y = ny
        found = true
        break
      }
    }
    if (!found) break
    if (flat.length > width * height) break
  }

  return flat
}

function polylineLength(flat: number[]): number {
  let len = 0
  for (let i = 2; i < flat.length; i += 2) {
    len += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1])
  }
  return len
}

function subsampleFlat(flat: number[], maxPoints: number): number[] {
  const pointCount = flat.length / 2
  if (pointCount <= maxPoints) return flat
  const result: number[] = []
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i / (maxPoints - 1)) * (pointCount - 1)) * 2
    result.push(flat[idx], flat[idx + 1])
  }
  return result
}

function sortFlatsTopLeft(flats: number[][]): number[][] {
  return [...flats].sort((a, b) => {
    const ba = bboxFromFlat(a)
    const bb = bboxFromFlat(b)
    const dy = ba.minY - bb.minY
    if (Math.abs(dy) > 5) return dy
    return ba.minX - bb.minX
  })
}

/** Reject horizontal scan-line artifacts and thin horizontal slivers. */
function isNoisePolyline(flat: number[], canvasW: number): boolean {
  const bbox = bboxFromFlat(flat)
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  if (h < 4 && w / Math.max(h, 1) > 15) return true
  if (w > canvasW * 0.4 && h < w * 0.15) return true
  return false
}

/** Filter noise, split bridges, cap count — longest strokes first for vehicle mode. */
function postProcessPolylines(
  polylines: number[][],
  canvasW: number,
  canvasH: number,
  opts: { fineDetail?: boolean; vehicleMode?: boolean; maxCount?: number; minLength?: number } = {},
): number[][] {
  const fineDetail = opts.fineDetail === true
  const vehicleMode = opts.vehicleMode === true
  const minLength = opts.minLength ?? (vehicleMode ? VEHICLE_MIN_POLYLINE_LEN : 10)
  const maxCount = opts.maxCount ?? (vehicleMode
    ? MAX_VEHICLE_EDGE_SUPPLEMENT
    : (fineDetail ? MAX_WANX_EDGES_FINE : MAX_WANX_EDGES))
  const maxSeg = Math.hypot(canvasW, canvasH) * 0.45
  const cleaned: number[][] = []

  for (const flat of polylines) {
    if (polylineLength(flat) < minLength) continue
    if (isNoisePolyline(flat, canvasW)) continue
    const chunks = sanitizeFlatPath(flat, {
      canvasW,
      canvasH,
      maxSegmentLen: maxSeg,
    })
    for (const chunk of chunks) {
      if (
        chunk.length >= 4
        && polylineLength(chunk) >= minLength
        && !isCanvasBorderArtifact(chunk, canvasW, canvasH)
        && !isNoisePolyline(chunk, canvasW)
      ) {
        cleaned.push(chunk)
      }
    }
  }

  const sorted = sortFlatsTopLeft(cleaned).sort(
    (a, b) => polylineLength(b) - polylineLength(a),
  )
  return sorted.length <= maxCount ? sorted : sorted.slice(0, maxCount)
}

function edgesToPolylines(
  edges: Uint8Array,
  width: number,
  height: number,
  canvasW: number,
  canvasH: number,
  opts: { fineDetail?: boolean; vehicleMode?: boolean; minLength?: number } = {},
): number[][] {
  const minLength = opts.minLength ?? (opts.vehicleMode ? VEHICLE_MIN_POLYLINE_LEN : 10)
  const visited = new Uint8Array(width * height)
  const polylines: number[][] = []

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (!edges[idx] || visited[idx]) continue
      const flat = tracePolyline(edges, width, height, x, y, visited)
      if (flat.length >= 8 && polylineLength(flat) >= minLength) {
        polylines.push(subsampleFlat(flat, opts.fineDetail ? 48 : 32))
      }
    }
  }

  polylines.sort((a, b) => polylineLength(b) - polylineLength(a))
  return postProcessPolylines(polylines, canvasW, canvasH, opts)
}

export async function vectorizeEdgesFromSource(
  source: string,
  canvasW = CANVAS_WIDTH,
  canvasH = CANVAS_HEIGHT,
  fineDetail = false,
): Promise<EdgeVectorizeResult> {
  const img = await loadImage(source)
  const canvas = fitToCanvas(img, canvasW, canvasH)
  const ctx = canvas.getContext('2d')!
  const { data, width, height } = ctx.getImageData(0, 0, canvasW, canvasH)
  const rawEdges = sobelEdges(data, width, height)
  const edges = erodeEdges(rawEdges, width, height)
  const flats = edgesToPolylines(edges, width, height, canvasW, canvasH, { fineDetail })
  return { flats, rawEdgeCount: flats.length }
}

/** Vehicle trace: Sobel edges as supplement to full ImageTracer — no spatial path cap. */
export async function vectorizeVehicleEdgesFromSource(
  source: string,
  canvasW = CANVAS_WIDTH,
  canvasH = CANVAS_HEIGHT,
  fineDetail = false,
): Promise<EdgeVectorizeResult> {
  const img = await loadImage(source)
  const canvas = fitToCanvas(img, canvasW, canvasH)
  const ctx = canvas.getContext('2d')!
  const { data, width, height } = ctx.getImageData(0, 0, canvasW, canvasH)
  const edges = sobelEdges(data, width, height, VEHICLE_SOBEL_RATIO)
  const flats = edgesToPolylines(edges, width, height, canvasW, canvasH, {
    fineDetail,
    vehicleMode: true,
    minLength: fineDetail ? Math.max(8, VEHICLE_MIN_POLYLINE_LEN - 4) : VEHICLE_MIN_POLYLINE_LEN,
  })
  return { flats, rawEdgeCount: flats.length }
}

export async function vectorizeVehicleEdgesFromBase64(
  base64: string,
  mimeType = 'image/png',
  canvasW = CANVAS_WIDTH,
  canvasH = CANVAS_HEIGHT,
  fineDetail = false,
): Promise<EdgeVectorizeResult> {
  const dataUrl = base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`
  return vectorizeVehicleEdgesFromSource(dataUrl, canvasW, canvasH, fineDetail)
}

export async function vectorizeEdgesFromBase64(
  base64: string,
  mimeType = 'image/png',
  canvasW = CANVAS_WIDTH,
  canvasH = CANVAS_HEIGHT,
  fineDetail = false,
): Promise<EdgeVectorizeResult> {
  const dataUrl = base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`
  return vectorizeEdgesFromSource(dataUrl, canvasW, canvasH, fineDetail)
}

export interface EdgeExtractOptions {
  peakRatio?: number
  maxStrokes?: number
  minLengthPx?: number
  fineDetail?: boolean
}

/** Sync Sobel edge extraction from an already-fitted canvas (sketch phase). */
export function extractEdgePathsFromCanvas(
  canvas: HTMLCanvasElement,
  opts: EdgeExtractOptions = {},
): number[][] {
  const canvasW = canvas.width
  const canvasH = canvas.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { data, width, height } = ctx.getImageData(0, 0, canvasW, canvasH)
  const peakRatio = opts.peakRatio ?? 0.28
  const rawEdges = sobelEdges(data, width, height, peakRatio)
  const edges = erodeEdges(rawEdges, width, height)
  const minLength = opts.minLengthPx ?? 15
  const flats = edgesToPolylines(edges, width, height, canvasW, canvasH, {
    fineDetail: opts.fineDetail,
    minLength,
  })
  const maxCount = opts.maxStrokes ?? MAX_WANX_EDGES
  return flats.length <= maxCount ? flats : flats.slice(0, maxCount)
}
