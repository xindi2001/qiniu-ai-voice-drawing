<script setup lang="ts">
import { reactive, watch } from 'vue'
import type { CanvasShape } from '../types/commands'

const props = defineProps<{
  shapes: CanvasShape[]
  width: number
  height: number
}>()

const imageCache = reactive<Record<string, HTMLImageElement | undefined>>({})

function loadImage(src: string): void {
  if (!src || imageCache[src]) return
  imageCache[src] = undefined
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    imageCache[src] = img
  }
  img.onerror = () => {
    delete imageCache[src]
  }
  img.src = src
}

watch(
  () => props.shapes
    .map((s) => s.imageSrc ?? s.revealImageSrc)
    .filter(Boolean)
    .join('\0'),
  () => {
    for (const shape of props.shapes) {
      const src = shape.imageSrc ?? shape.revealImageSrc
      if ((shape.type === 'image' || shape.type === 'clipImage' || shape.maskedReveal) && src) {
        loadImage(src)
      }
    }
  },
  { immediate: true },
)

function imageConfig(shape: CanvasShape): Record<string, unknown> | null {
  const src = shape.imageSrc ?? shape.revealImageSrc
  if (!src) return null
  const img = imageCache[src]
  if (!img) return null
  return {
    x: shape.x,
    y: shape.y,
    width: shape.width ?? props.width,
    height: shape.height ?? props.height,
    image: img,
    crop: shape.cropWidth
      ? {
          x: shape.cropX ?? 0,
          y: shape.cropY ?? 0,
          width: shape.cropWidth,
          height: shape.cropHeight ?? shape.height ?? props.height,
        }
      : undefined,
    opacity: shape.opacity ?? 1,
    listening: false,
  }
}

function maskedGroupConfig(shape: CanvasShape): Record<string, unknown> | null {
  const pts = shape.maskClipPoints
  const bandY0 = shape.bandClipY0
  const bandY1 = shape.bandClipY1
  if ((!pts || pts.length < 6) && bandY0 === undefined) return null
  return {
    clipFunc: (ctx: CanvasRenderingContext2D) => {
      if (pts && pts.length >= 6) {
        ctx.beginPath()
        ctx.moveTo(pts[0], pts[1])
        for (let i = 2; i < pts.length; i += 2) {
          ctx.lineTo(pts[i], pts[i + 1])
        }
        ctx.closePath()
        ctx.clip()
      }
      if (bandY0 !== undefined && bandY1 !== undefined && bandY1 > bandY0) {
        ctx.beginPath()
        ctx.rect(0, bandY0, props.width, bandY1 - bandY0)
        ctx.clip()
      }
    },
    opacity: shape.opacity ?? 1,
    listening: false,
  }
}
</script>

<template>
  <v-stage :config="{ width, height }">
    <v-layer>
      <v-rect
        :config="{
          x: 0,
          y: 0,
          width,
          height,
          fill: '#ffffff',
          stroke: '#cbd5e1',
          strokeWidth: 1,
        }"
      />
      <template v-for="shape in shapes" :key="shape.id">
        <v-circle
          v-if="shape.type === 'circle'"
          :config="{
            x: shape.x,
            y: shape.y,
            radius: shape.radius ?? 50,
            fill: shape.strokeOnly ? undefined : shape.color,
            stroke: shape.strokeOnly ? shape.color : undefined,
            strokeWidth: shape.strokeOnly ? 2.5 : 0,
            listening: false,
          }"
        />
        <v-rect
          v-else-if="shape.type === 'rect'"
          :config="{
            x: shape.x,
            y: shape.y,
            width: shape.width ?? 100,
            height: shape.height ?? 80,
            fill: shape.strokeOnly ? undefined : shape.color,
            stroke: shape.strokeOnly ? shape.color : undefined,
            strokeWidth: shape.strokeOnly ? 2.5 : 0,
            listening: false,
          }"
        />
        <v-line
          v-else-if="shape.type === 'line'"
          :config="{
            points: [shape.x, shape.y, shape.x2 ?? 0, shape.y2 ?? 0],
            stroke: shape.color,
            strokeWidth: 3,
            lineCap: 'round',
            listening: false,
          }"
        />
        <v-line
          v-else-if="shape.type === 'path' && shape.points && (!shape.fillOnly || (shape.opacity ?? 0) > 0)"
          :config="{
            x: 0,
            y: 0,
            points: shape.points,
            stroke: shape.fillOnly ? undefined : shape.color,
            strokeWidth: shape.fillOnly ? 0 : (shape.strokeWidth ?? 2),
            lineCap: 'round',
            lineJoin: 'round',
            tension: shape.tension ?? 0.4,
            closed: shape.closed ?? false,
            fill: shape.fill ?? undefined,
            dash: !shape.fillOnly && shape.pathLength ? [shape.pathLength, shape.pathLength] : undefined,
            dashOffset: shape.dashOffset,
            opacity: shape.opacity ?? 1,
            listening: false,
          }"
        />
        <v-group
          v-else-if="(shape.type === 'clipImage' || shape.maskedReveal) && (shape.opacity ?? 0) > 0 && maskedGroupConfig(shape) && imageConfig(shape)"
          :config="maskedGroupConfig(shape)!"
        >
          <v-image :config="imageConfig(shape)!" />
        </v-group>
        <v-image
          v-else-if="shape.type === 'image' && imageConfig(shape)"
          :config="imageConfig(shape)!"
        />
      </template>
    </v-layer>
  </v-stage>
</template>
