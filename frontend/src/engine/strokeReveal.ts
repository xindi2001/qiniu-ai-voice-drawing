import type { CanvasShape } from '../types/commands'
import { createShapeId } from './shapeFactory'
import { animateValue, sleep } from './strokeAnimator'

export interface ImageFitBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface RevealStroke {
  index: number
  /** Destination rect on canvas */
  x: number
  y: number
  width: number
  height: number
  /** Source crop in fitted image coords (same scale as display) */
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
}

export function preloadImageSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('无法加载图片'))
    img.src = src
  })
}

export function computeImageFitBounds(
  imgW: number,
  imgH: number,
  maxW: number,
  maxH: number,
): ImageFitBounds {
  const scale = Math.min(maxW / imgW, maxH / imgH, 1)
  const width = Math.round(imgW * scale)
  const height = Math.round(imgH * scale)
  return {
    x: Math.floor((maxW - width) / 2),
    y: Math.floor((maxH - height) / 2),
    width,
    height,
  }
}

/**
 * Slice fitted image into horizontal sweep bands — always covers 100% of subject.
 */
export function generateRevealStrokes(
  bounds: ImageFitBounds,
  strokeCount = 60,
  sourceWidth?: number,
  sourceHeight?: number,
): RevealStroke[] {
  const count = Math.max(8, Math.min(120, strokeCount))
  const srcW = sourceWidth ?? bounds.width
  const srcH = sourceHeight ?? bounds.height
  const bandDisplayH = bounds.height / count
  const bandSourceH = srcH / count
  const strokes: RevealStroke[] = []

  for (let i = 0; i < count; i++) {
    const y = bounds.y + i * bandDisplayH
    const h = i === count - 1 ? bounds.y + bounds.height - y : bandDisplayH
    const cropY = i * bandSourceH
    const cropH = i === count - 1 ? srcH - cropY : bandSourceH
    strokes.push({
      index: i,
      x: bounds.x,
      y,
      width: bounds.width,
      height: h,
      cropX: 0,
      cropY,
      cropWidth: srcW,
      cropHeight: cropH,
    })
  }

  return strokes
}

export function revealStrokeToShape(
  imageSrc: string,
  stroke: RevealStroke,
  opacity = 1,
): CanvasShape {
  return {
    id: createShapeId(),
    type: 'image',
    color: '#000000',
    x: stroke.x,
    y: stroke.y,
    width: stroke.width,
    height: stroke.height,
    imageSrc,
    cropX: stroke.cropX,
    cropY: stroke.cropY,
    cropWidth: stroke.cropWidth,
    cropHeight: stroke.cropHeight,
    opacity,
  }
}

export interface StrokeRevealProgress {
  current: number
  total: number
}

const REVEAL_STROKE_MS = 80
const REVEAL_STROKE_MS_FAST = 45

/**
 * Animate progressive image reveal via opacity on horizontal bands.
 * Returns the final consolidated image shape (single node, full opacity).
 */
export async function animateStrokeReveal(
  imageSrc: string,
  bounds: ImageFitBounds,
  strokes: RevealStroke[],
  onUpdate: (shapes: CanvasShape[]) => void,
  onProgress?: (progress: StrokeRevealProgress) => void,
  fast = false,
): Promise<{ shapes: CanvasShape[]; consolidated: CanvasShape }> {
  const strokeMs = fast ? REVEAL_STROKE_MS_FAST : REVEAL_STROKE_MS
  const total = strokes.length
  const bandShapes = strokes.map((s) => revealStrokeToShape(imageSrc, s, 0))

  await preloadImageSrc(imageSrc)
  onUpdate(bandShapes)
  await sleep(80)
  onProgress?.({ current: 0, total })

  for (let i = 0; i < strokes.length; i++) {
    onProgress?.({ current: i + 1, total })
    await animateValue(strokeMs, (t) => {
      bandShapes[i] = { ...bandShapes[i], opacity: t }
      onUpdate([...bandShapes])
    })
    bandShapes[i] = { ...bandShapes[i], opacity: 1 }
    onUpdate([...bandShapes])
    if (i < strokes.length - 1) {
      await sleep(fast ? 8 : 16)
    }
  }

  const consolidated: CanvasShape = {
    id: createShapeId(),
    type: 'image',
    color: '#000000',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    imageSrc,
    opacity: 1,
  }

  return { shapes: [consolidated], consolidated }
}
