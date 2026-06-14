import { PIPELINE_CONFIG } from '../constants/traceConfig'
import type { PointPair } from '../types/commands'
import { detectPrimarySubjectBBox, type PrimarySubjectInfo } from './colorFillAnalyzer'

export const ANALYSIS_YIELD_MS = 50

/** Yield to the browser main thread between heavy analysis chunks. */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(() => resolve(), 0)
    }
  })
}

let lastYieldMs = 0

/** Yield when at least `intervalMs` have elapsed since the last yield. */
export async function yieldIfDue(intervalMs: number = ANALYSIS_YIELD_MS): Promise<void> {
  const now = performance.now()
  if (now - lastYieldMs >= intervalMs) {
    lastYieldMs = now
    await yieldToMain()
  }
}

export interface AnalysisWorkspace {
  analysisCanvas: HTMLCanvasElement
  scaleX: number
  scaleY: number
  /** Offset when analysis runs on a subject crop (full-canvas coords). */
  offsetX?: number
  offsetY?: number
  subjectInfo?: PrimarySubjectInfo
}

/** Crop source to primary subject bbox (with padding) for focused analysis. */
export function createSubjectCroppedCanvas(
  source: HTMLCanvasElement,
  paddingRatio = 0.06,
): { canvas: HTMLCanvasElement; offsetX: number; offsetY: number; subjectInfo: PrimarySubjectInfo } {
  const probeMax = 256
  const scale = Math.min(1, probeMax / Math.max(source.width, source.height))
  let subjectInfo: PrimarySubjectInfo
  let bbox: PrimarySubjectInfo['bbox']

  if (scale < 1) {
    const probe = document.createElement('canvas')
    probe.width = Math.max(1, Math.round(source.width * scale))
    probe.height = Math.max(1, Math.round(source.height * scale))
    probe.getContext('2d', { willReadFrequently: true })!.drawImage(source, 0, 0, probe.width, probe.height)
    subjectInfo = detectPrimarySubjectBBox(probe)
    bbox = {
      x: Math.round(subjectInfo.bbox.x / scale),
      y: Math.round(subjectInfo.bbox.y / scale),
      w: Math.max(1, Math.round(subjectInfo.bbox.w / scale)),
      h: Math.max(1, Math.round(subjectInfo.bbox.h / scale)),
    }
  } else {
    subjectInfo = detectPrimarySubjectBBox(source)
    bbox = subjectInfo.bbox
  }

  const padX = Math.round(bbox.w * paddingRatio)
  const padY = Math.round(bbox.h * paddingRatio)
  const x0 = Math.max(0, bbox.x - padX)
  const y0 = Math.max(0, bbox.y - padY)
  const x1 = Math.min(source.width, bbox.x + bbox.w + padX)
  const y1 = Math.min(source.height, bbox.y + bbox.h + padY)
  const cw = Math.max(1, x1 - x0)
  const ch = Math.max(1, y1 - y0)
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, x0, y0, cw, ch, 0, 0, cw, ch)
  return { canvas, offsetX: x0, offsetY: y0, subjectInfo: { ...subjectInfo, bbox } }
}

/** Downscale source canvas for fast pixel analysis (stroke/fill detection). */
export function createAnalysisWorkspace(
  source: HTMLCanvasElement,
  maxPx: number = PIPELINE_CONFIG.analysisWorkspacePx,
  cropToSubject = true,
): AnalysisWorkspace {
  const crop = cropToSubject ? createSubjectCroppedCanvas(source) : null
  const input = crop?.canvas ?? source
  const w = input.width
  const h = input.height
  const scale = Math.min(1, maxPx / Math.max(w, h))
  const aw = Math.max(1, Math.round(w * scale))
  const ah = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = aw
  canvas.height = ah
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(input, 0, 0, aw, ah)
  return {
    analysisCanvas: canvas,
    scaleX: w / aw,
    scaleY: h / ah,
    offsetX: crop?.offsetX ?? 0,
    offsetY: crop?.offsetY ?? 0,
    subjectInfo: crop?.subjectInfo,
  }
}

export function scaleFlatPath(
  flat: number[],
  scaleX: number,
  scaleY: number,
  offsetX = 0,
  offsetY = 0,
): number[] {
  const out: number[] = []
  for (let i = 0; i < flat.length; i += 2) {
    out.push(flat[i] * scaleX + offsetX, flat[i + 1] * scaleY + offsetY)
  }
  return out
}

export function scalePointPairs(
  points: PointPair[],
  scaleX: number,
  scaleY: number,
  offsetX = 0,
  offsetY = 0,
): PointPair[] {
  return points.map(([x, y]) => [x * scaleX + offsetX, y * scaleY + offsetY])
}
