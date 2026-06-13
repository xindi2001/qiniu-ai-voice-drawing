<script setup lang="ts">
import type { CanvasShape } from '../types/commands'

defineProps<{
  shapes: CanvasShape[]
  width: number
  height: number
}>()
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
            fill: shape.color,
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
            fill: shape.color,
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
      </template>
    </v-layer>
  </v-stage>
</template>
