import ImageTracer from 'imagetracerjs'

import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../constants/canvas'
import {
  DEFAULT_TRACE_CONFIG,
  PIPELINE_CONFIG,
  type TraceConfig,
} from '../constants/traceConfig'
import {
  extractPathsFromSvg,
  sortForNaturalDrawing,
  splitPathDIntoItems,
  type VectorPath,
} from './pathSorter'
import { coversMostOfCanvas, isCanvasBorderArtifact, pairsToFlat } from './pathUtils'
import { parsePathDAll } from './svgPathParser'
import { preprocessForColoringTrace } from './preprocessImage'
import { scalePaths } from './pathSmoother'
import { deduplicateExactPaths } from './pathDedup'
import { normalizeToLineArt } from './lineArtNormalize'
import { repairPathContinuity } from './pathContinuity'

/** imagetracerjs tuned for strict binary two-level input. */
function tracerOptionsForBinary(config: TraceConfig) {
  return {
    ltres: config.tracerLtres,
    qtres: 1.0,
    pathomit: config.tracerPathOmit,
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
}

/** Legacy simple binarize for default mode. */
const TRACER_OPTIONS = {
  ltres: 1.5,
  qtres: 1.5,
  pathomit: 14,
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

const BINARY_THRESHOLD = 140
export const BINARY_THRESHOLD_WANX = 175
export const TRACE_UPSCALE = DEFAULT_TRACE_CONFIG.traceUpscale

export type VectorizeMode = 'default' | 'wanx'
export const MAX_PATHS = 100

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('无法加载图片'))
    img.src = src
  })
}

function sourcePixelSize(img: CanvasImageSource): { w: number; h: number } {
  if (img instanceof HTMLImageElement) {
    return { w: img.naturalWidth, h: img.naturalHeight }
  }
  if (img instanceof HTMLVideoElement) {
    return { w: img.videoWidth, h: img.videoHeight }
  }
  return { w: (img as HTMLCanvasElement).width, h: (img as HTMLCanvasElement).height }
}

export function fitImageSourceToCanvas(
  img: CanvasImageSource,
  maxW: number,
  maxH: number,
): HTMLCanvasElement {
  const { w: iw, h: ih } = sourcePixelSize(img)
  const scale = Math.min(maxW / iw, maxH / ih, 1)
  const w = Math.round(iw * scale)
  const h = Math.round(ih * scale)
  const canvas = document.createElement('canvas')
  canvas.width = maxW
  canvas.height = maxH
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, maxW, maxH)
  ctx.drawImage(img, Math.floor((maxW - w) / 2), Math.floor((maxH - h) / 2), w, h)
  return canvas
}

function fitToCanvas(
  img: HTMLImageElement,
  maxW: number,
  maxH: number,
): { canvas: HTMLCanvasElement; scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(maxW / img.width, maxH / img.height, 1)
  const w = Math.round(img.width * scale)
  const h = Math.round(img.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = maxW
  canvas.height = maxH
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, maxW, maxH)
  const offsetX = Math.floor((maxW - w) / 2)
  const offsetY = Math.floor((maxH - h) / 2)
  ctx.drawImage(img, offsetX, offsetY, w, h)
  return { canvas, scale, offsetX, offsetY }
}

function preprocessForTrace(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: VectorizeMode = 'default',
): void {
  const imgData = ctx.getImageData(0, 0, width, height)
  const { data } = imgData
  const threshold = mode === 'wanx' ? BINARY_THRESHOLD_WANX : BINARY_THRESHOLD

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    const v = gray < threshold ? 0 : 255
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
    data[i + 3] = 255
  }

  ctx.putImageData(imgData, 0, 0)
}

function countPathPoints(d: string): number {
  const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)/g)?.map(Number) ?? []
  return Math.floor(nums.length / 2)
}

function bboxFromD(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)/g)?.map(Number) ?? []
  const xs = nums.filter((_, i) => i % 2 === 0)
  const ys = nums.filter((_, i) => i % 2 === 1)
  if (!xs.length || !ys.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  }
}

function expandSubpaths(raw: VectorPath[]): VectorPath[] {
  const expanded: VectorPath[] = []
  for (const path of raw) {
    const items = splitPathDIntoItems(path.d)
    if (items.length > 0) {
      expanded.push(...items)
    } else {
      expanded.push(path)
    }
  }
  return expanded
}

function filterRawTracePaths(
  raw: VectorPath[],
  config: TraceConfig,
  canvasW: number,
  canvasH: number,
): VectorPath[] {
  return raw.filter((p) => {
    const points = countPathPoints(p.d)
    if (points < config.minPathPoints) return false
    const flat = pairsToFlat(parsePathDAll(p.d).flatMap((sp) => sp.points))
    if (flat.length >= 4 && isCanvasBorderArtifact(flat, canvasW, canvasH)) return false
    const { minX, minY, maxX, maxY } = bboxFromD(p.d)
    if (coversMostOfCanvas({ minX, minY, maxX, maxY }, canvasW, canvasH, 0.85)) return false
    return true
  })
}

function dropShortPaths(
  paths: VectorPath[],
  minPx: number,
  protectMinPx = PIPELINE_CONFIG.protectMinPathLengthPx,
): VectorPath[] {
  return paths.filter((p) => p.length >= protectMinPx || p.length >= minPx)
}

function traceContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return canvas.getContext('2d', { willReadFrequently: true })!
}

function traceNormalizedCanvas(
  normalized: HTMLCanvasElement,
  config: TraceConfig,
): VectorPath[] {
  const ctx = traceContext(normalized)
  const imgd = ctx.getImageData(0, 0, normalized.width, normalized.height)
  const svgString = ImageTracer.imagedataToSVG(imgd, tracerOptionsForBinary(config))
  return expandSubpaths(extractPathsFromSvg(svgString))
}

function traceWithEdgeFallback(
  sourceCanvas: HTMLCanvasElement,
  config: TraceConfig,
): { rawPaths: VectorPath[]; traceScale: number } {
  const pre = preprocessForColoringTrace(sourceCanvas, {
    threshold: config.binarizeThreshold,
    blurRadius: 1,
    scaleFactor: config.traceUpscale,
    edgePeakRatio: 0.09,
    minComponentArea: 6,
  })
  const svgString = ImageTracer.imagedataToSVG(pre.imageData, tracerOptionsForBinary(config))
  return { rawPaths: expandSubpaths(extractPathsFromSvg(svgString)), traceScale: pre.traceScale }
}

export interface PipelineStageCounts {
  raw: number
  dedup: number
  minLen: number
  continuity: number
  final: number
}

export interface VectorizeResult {
  paths: VectorPath[]
  canvasWidth: number
  canvasHeight: number
  rawPathCount: number
  filteredPathCount: number
  shortPathCount: number
  stageCounts?: PipelineStageCounts
  traceable?: boolean
  usedEdgeFallback?: boolean
}

export interface VectorizeOptions {
  fineDetail?: boolean
  imagePrompt?: string
}

/**
 * Post-trace path pipeline: exact dedup → continuity → min-length → continuity → quality floor.
 * Exact dedup only — no spatial overlap dedup.
 */
function processTracePaths(rawPaths: VectorPath[]): {
  paths: VectorPath[]
  stageCounts: PipelineStageCounts
} {
  const gapPx = PIPELINE_CONFIG.continuityGapPx
  const maxPasses = PIPELINE_CONFIG.continuityMaxPasses
  const minLen = PIPELINE_CONFIG.minPathLengthPx
  const protectMin = PIPELINE_CONFIG.protectMinPathLengthPx

  const raw = rawPaths.length
  const deduped = deduplicateExactPaths(rawPaths)
  const afterContinuityPre = repairPathContinuity(deduped, gapPx, maxPasses)
  const afterMinLen = dropShortPaths(afterContinuityPre, minLen, protectMin)
  let afterContinuityPost = repairPathContinuity(afterMinLen, gapPx, maxPasses)
  let finalPaths = afterContinuityPost

  if (raw >= 80 && afterContinuityPost.length < raw * 0.5) {
    const relaxed = dropShortPaths(
      afterContinuityPre,
      PIPELINE_CONFIG.qualityFloorMinLengthPx,
      protectMin,
    )
    afterContinuityPost = repairPathContinuity(relaxed, gapPx, maxPasses)
    finalPaths = afterContinuityPost
  }

  const stageCounts: PipelineStageCounts = {
    raw,
    dedup: deduped.length,
    minLen: afterMinLen.length,
    continuity: afterContinuityPost.length,
    final: finalPaths.length,
  }

  return { paths: finalPaths, stageCounts }
}

/**
 * Single unified pipeline for ALL generate_and_trace subjects:
 * fit → normalizeToLineArt → ImageTracer → dedup → min-length → continuity → sort
 */
export async function vectorizeGeneratedImage(
  source: string,
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  opts: VectorizeOptions = {},
): Promise<VectorizeResult> {
  void opts
  const config = DEFAULT_TRACE_CONFIG
  const img = await loadImage(source)
  const { canvas } = fitToCanvas(img, canvasWidth, canvasHeight)

  const normalized = normalizeToLineArt(canvas)
  let rawPaths = traceNormalizedCanvas(normalized, config)
  let usedEdgeFallback = false

  if (rawPaths.length < 15) {
    const edgeRetry = traceWithEdgeFallback(canvas, config)
    const factor = (normalized.width * edgeRetry.traceScale) / canvasWidth
    rawPaths = Math.abs(factor - 1) > 0.001
      ? scalePaths(edgeRetry.rawPaths, factor)
      : edgeRetry.rawPaths
    usedEdgeFallback = rawPaths.length > 0
  }

  const rawPathCount = rawPaths.length
  const { paths, stageCounts } = processTracePaths(rawPaths)
  const sortedPaths = sortForNaturalDrawing(paths, canvasWidth, canvasHeight)

  const shortPathCount = sortedPaths.filter((p) => p.length < PIPELINE_CONFIG.minPathLengthPx).length

  return {
    paths: sortedPaths,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    rawPathCount,
    filteredPathCount: stageCounts.final,
    shortPathCount,
    stageCounts,
    usedEdgeFallback,
  }
}

/** @deprecated Use vectorizeGeneratedImage — kept for legacy default-mode icon trace. */
export async function vectorizeImageSource(
  source: string,
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  mode: VectorizeMode = 'default',
  fineDetailOrOpts: boolean | VectorizeOptions = false,
): Promise<VectorizeResult> {
  if (mode === 'wanx') {
    const opts: VectorizeOptions = typeof fineDetailOrOpts === 'boolean'
      ? { fineDetail: fineDetailOrOpts }
      : fineDetailOrOpts
    return vectorizeGeneratedImage(source, canvasWidth, canvasHeight, opts)
  }

  const img = await loadImage(source)
  const { canvas } = fitToCanvas(img, canvasWidth, canvasHeight)
  const ctx = canvas.getContext('2d')!
  preprocessForTrace(ctx, canvas.width, canvas.height, mode)
  const imgd = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const svgString = ImageTracer.imagedataToSVG(imgd, TRACER_OPTIONS)
  const rawPaths = extractPathsFromSvg(svgString)
  const rawPathCount = rawPaths.length
  const config = DEFAULT_TRACE_CONFIG
  const simplified = filterRawTracePaths(expandSubpaths(rawPaths), config, canvasWidth, canvasHeight)
  const deduped = deduplicateExactPaths(simplified)
  const capped = deduped.length <= MAX_PATHS
    ? deduped
    : [...deduped].sort((a, b) => b.length - a.length).slice(0, MAX_PATHS)
  const paths = sortForNaturalDrawing(capped, canvasWidth, canvasHeight)
  const shortPathCount = paths.filter((p) => p.length < 25).length

  return {
    paths,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    rawPathCount,
    filteredPathCount: paths.length,
    shortPathCount,
  }
}

export async function vectorizeBase64(
  base64: string,
  mimeType = 'image/png',
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  mode: VectorizeMode = 'default',
  fineDetailOrOpts: boolean | VectorizeOptions = false,
): Promise<VectorizeResult> {
  const dataUrl = base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`
  return vectorizeImageSource(dataUrl, canvasWidth, canvasHeight, mode, fineDetailOrOpts)
}

/** Alias — all Wanx generate_and_trace uses vectorizeGeneratedImage. */
export async function vectorizeWanxFull(
  source: string,
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  fineDetail = false,
  imagePrompt?: string,
): Promise<VectorizeResult> {
  return vectorizeGeneratedImage(source, canvasWidth, canvasHeight, { fineDetail, imagePrompt })
}

export async function vectorizeWanxFullFromBase64(
  base64: string,
  mimeType = 'image/png',
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  fineDetail = false,
  imagePrompt?: string,
): Promise<VectorizeResult> {
  const dataUrl = base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`
  return vectorizeGeneratedImage(dataUrl, canvasWidth, canvasHeight, { fineDetail, imagePrompt })
}

/** @deprecated Renamed to vectorizeGeneratedImage. */
export async function vectorizeForColoring(
  source: string,
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  opts: VectorizeOptions = {},
): Promise<VectorizeResult> {
  return vectorizeGeneratedImage(source, canvasWidth, canvasHeight, opts)
}
