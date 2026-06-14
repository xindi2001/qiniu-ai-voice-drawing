/**
 * Quality gate before vectorization — detect untraceable (photo/gradient) Wanx output.
 */

import { PIPELINE_CONFIG, type WanxStyle } from '../constants/traceConfig'

export interface TraceabilityResult {
  traceable: boolean
  score: number
  reason: string
}

/** Detailed illustration retry — clear linework, moderate detail, NOT flat chibi. */
export const DETAILED_RETRY_SUFFIX =
  '，single subject centered，high quality digital illustration，clear linework，moderate detail，'
  + 'soft shading allowed，traceable illustration，white background，NOT chibi，NOT overly simplified，'
  + '单一主体居中，高质量插画，清晰线稿，适度细节，可描摹，白底，非Q版'

/** Flat cartoon retry — only when user explicitly wants anime/cartoon style. */
export const FLAT_CARTOON_RETRY_SUFFIX =
  '，single subject centered，max 6 distinct flat color zones，each zone solid color，'
  + 'NO pencil，NO grayscale，NO realistic shading，flat vector cartoon，hard edges，'
  + 'distinct flat color blocks，white background，'
  + '单一主体居中，最多6种纯色色块，每块纯色，无铅笔，无灰度，无写实阴影，白底扁平插画'

/** @deprecated Use retrySuffixForStyle — kept for bitmap_trace fallback */
export const UNIFIED_RETRY_SUFFIX = DETAILED_RETRY_SUFFIX

/** @deprecated Use retrySuffixForStyle — bitmap_trace only */
export const LINE_ART_RETRY_SUFFIX =
  '，<flat illustration>，flat vector graphic，traceable line art，NO photograph，'
  + 'no photorealistic，no 3d render，no gradient，no reflection，hard-edge line art only，'
  + '可描摹线稿，无渐变，硬边缘'

const CARTOON_HINTS = [
  '动漫', '卡通', 'q版', 'Q版', 'anime', 'cartoon', 'chibi', 'flat cartoon', '扁平卡通', 'cel-shading',
]
const DETAILED_HINTS = [
  '头像', '肖像', '写生', '细节', '写实', '插画', 'portrait', 'detailed', 'illustration', 'sketch',
  '精细', '高清', '线稿',
]

/** Infer Wanx output style from user/image prompt text. */
export function detectWanxStyleFromPrompt(prompt: string | undefined): WanxStyle {
  if (!prompt?.trim()) return PIPELINE_CONFIG.defaultWanxStyle
  const lower = prompt.toLowerCase()
  for (const hint of CARTOON_HINTS) {
    if (lower.includes(hint.toLowerCase())) return 'flat_cartoon'
  }
  for (const hint of DETAILED_HINTS) {
    if (lower.includes(hint.toLowerCase())) return 'detailed_illustration'
  }
  return PIPELINE_CONFIG.defaultWanxStyle
}

export function retrySuffixForStyle(style: WanxStyle): string {
  return style === 'flat_cartoon' ? FLAT_CARTOON_RETRY_SUFFIX : DETAILED_RETRY_SUFFIX
}

/** @deprecated Use UNIFIED_RETRY_SUFFIX */
export const SINGLE_SUBJECT_RETRY_SUFFIX =
  '，single subject only，one character centered，solo figure，no crowd，no multiple people，'
  + '仅单一主体，一个角色居中，无多人，无群像'

function posterizeProbe(data: Uint8ClampedArray, colorCount: number): Set<number> {
  const levels = Math.max(2, colorCount)
  const step = 255 / (levels - 1)
  const buckets = new Set<number>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 32) continue
    const r = Math.round(data[i] / step) * step
    const g = Math.round(data[i + 1] / step) * step
    const b = Math.round(data[i + 2] / step) * step
    buckets.add(r * 65536 + g * 256 + b)
  }
  return buckets
}

function gradientScore(data: Uint8ClampedArray, w: number, h: number): number {
  const step = 4
  let smoothGrad = 0
  let samples = 0
  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const idx = (y * w + x) * 4
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]
      const ni = (y * w + (x + step)) * 4
      const nLum = 0.299 * data[ni] + 0.587 * data[ni + 1] + 0.114 * data[ni + 2]
      const diff = Math.abs(lum - nLum)
      if (diff >= 4 && diff <= 40) smoothGrad++
      samples++
    }
  }
  return samples > 0 ? smoothGrad / samples : 0
}

function edgeDensity(data: Uint8ClampedArray, w: number, h: number): number {
  const gray = new Float32Array(w * h)
  for (let i = 0, p = 0; p < data.length; p += 4, i++) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  let edgeCount = 0
  let maxMag = 0
  const mags: number[] = []
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
      mags.push(m)
      if (m > maxMag) maxMag = m
    }
  }
  if (maxMag <= 0) return 0
  const threshold = maxMag * 0.12
  for (const m of mags) {
    if (m >= threshold) edgeCount++
  }
  return mags.length > 0 ? edgeCount / mags.length : 0
}

/**
 * Check whether a Wanx image is suitable for line-art vectorization.
 * Uses posterized color count, gradient ratio, and edge density.
 */
export function isTraceableImage(canvas: HTMLCanvasElement): TraceabilityResult {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { traceable: false, score: 0, reason: '无法读取画布' }
  }

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const colorBuckets = posterizeProbe(data, PIPELINE_CONFIG.posterizeColors)
  const grad = gradientScore(data, width, height)
  const edges = edgeDensity(data, width, height)

  let score = 50
  const reasons: string[] = []

  if (colorBuckets.size <= 12) {
    score += 25
  } else if (colorBuckets.size <= 30) {
    score += 10
  } else {
    score -= 20
    reasons.push(`色块过多(${colorBuckets.size})`)
  }

  if (grad < 0.08) {
    score += 15
  } else if (grad < 0.15) {
    score += 5
  } else {
    score -= 25
    reasons.push(`渐变过多(${(grad * 100).toFixed(0)}%)`)
  }

  if (edges >= 0.04 && edges <= 0.35) {
    score += 15
  } else if (edges < 0.02) {
    score -= 20
    reasons.push('边缘过少')
  } else if (edges > 0.45) {
    score -= 10
    reasons.push('边缘噪声过多')
  }

  const traceable = score >= 45 && !(grad > 0.18 && colorBuckets.size > 40)
  const reason = traceable
    ? '适合描摹'
    : reasons.length > 0 ? reasons.join('，') : '质量偏低'

  return { traceable, score, reason }
}
