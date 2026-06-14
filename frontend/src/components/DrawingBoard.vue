<script setup lang="ts">
import { onMounted, ref } from 'vue'
import KonvaCanvas from './KonvaCanvas.vue'
import TextCommandInput from './TextCommandInput.vue'
import CommandLog from './CommandLog.vue'
import VoicePanel from './VoicePanel.vue'
import { useVoiceApi } from '../composables/useVoiceApi'
import { useSpeechSynthesis } from '../composables/useSpeechSynthesis'
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../constants/canvas'
import {
  createInitialState,
  executeActionsAnimated,
  type DrawPipelineMode,
  type PaintProgress,
} from '../engine/commandExecutor'
import type { CommandSource, LogEntry } from '../types/commands'
import { shapesToSceneContext } from '../types/commands'

const executorState = ref(createInitialState())
const logs = ref<LogEntry[]>([])
const fineDetailMode = ref(false)
const drawMode = ref<DrawPipelineMode>('outline_only')
const painting = ref(false)
const paintMessage = ref<string | null>(null)
const referenceThumb = ref<string | null>(null)
const dashscopeConfigured = ref(false)
const { loading, error: apiError, parseCommand, generateImage, fetchImageGenStatus } = useVoiceApi()
const { speak } = useSpeechSynthesis()

onMounted(async () => {
  const status = await fetchImageGenStatus()
  dashscopeConfigured.value = status.dashscopeConfigured
})

function createLogId(): string {
  return `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function formatPaintMessage(progress: PaintProgress): string {
  switch (progress.phase) {
    case 'generating':
      return progress.message.includes('构思') ? progress.message : '构思中…'
    case 'analyzing':
      return '轮廓分析中…'
    case 'sketching':
      if (progress.message === '绘制完成') return '绘制完成'
      if (progress.current != null && progress.total != null) {
        return `勾线中 (${progress.current}/${progress.total})`
      }
      return progress.message || '勾线中…'
    case 'coloring':
      return progress.message === '绘制完成' ? '绘制完成' : progress.message
    default:
      return progress.message
  }
}

async function handleCommand(text: string, source: CommandSource): Promise<void> {
  const entry: LogEntry = {
    id: createLogId(),
    timestamp: new Date().toLocaleTimeString('zh-CN'),
    text,
    source,
  }
  logs.value.push(entry)

  try {
    const sceneContext = shapesToSceneContext(executorState.value.shapes)
    const response = await parseCommand(text, sceneContext, fineDetailMode.value)
    entry.response = response

    if (response.speak) {
      speak(response.speak)
    }
    if (response.warning) {
      apiError.value = response.warning
    }

    painting.value = true
    paintMessage.value = '理解指令…'
    const { state, messages } = await executeActionsAnimated(
      executorState.value,
      response.actions,
      (next) => {
        executorState.value = next
      },
      async (prompt, fineDetail) => {
        const result = await generateImage(prompt, fineDetail)
        return {
          imageUrl: result.imageUrl,
          imageBase64: result.imageBase64,
          mimeType: result.mimeType,
        }
      },
      (progress: PaintProgress | null) => {
        if (progress) {
          paintMessage.value = formatPaintMessage(progress)
          if (progress.message === '绘制完成') {
            referenceThumb.value = null
          } else if (progress.referenceImage) {
            referenceThumb.value = progress.referenceImage
          }
        } else {
          paintMessage.value = null
          painting.value = false
          referenceThumb.value = null
        }
      },
      { fineDetailMode: fineDetailMode.value, drawMode: drawMode.value },
    )
    executorState.value = state
    entry.executed = messages
  } catch (e) {
    painting.value = false
    paintMessage.value = null
    entry.error = e instanceof Error ? e.message : '执行失败'
  }
}

function handleTextCommand(text: string): void {
  handleCommand(text, 'text')
}

function handleVoiceCommand(text: string): void {
  handleCommand(text, 'voice')
}
</script>

<template>
  <div class="drawing-board">
    <header class="header">
      <h1>七牛 AI 语音绘图</h1>
      <p>语音 / 文本指令驱动 · 逐笔画动画 · 自然语言绘图</p>
    </header>

    <main class="layout">
      <section class="canvas-section">
        <div class="canvas-notice">
          画布仅通过语音/文本指令绘制，鼠标绘图已禁用
        </div>
        <div class="canvas-wrapper">
          <KonvaCanvas
            :shapes="executorState.shapes"
            :width="CANVAS_WIDTH"
            :height="CANVAS_HEIGHT"
          />
          <div v-if="referenceThumb" class="reference-thumb-wrap">
            <img
              :src="referenceThumb"
              class="reference-thumb"
              alt="构思参考"
            />
            <span class="reference-thumb-label">构思参考</span>
          </div>
        </div>
        <p v-if="paintMessage" class="paint-progress">{{ paintMessage }}</p>
        <p v-if="apiError" class="global-error">API 错误：{{ apiError }}</p>
      </section>

      <aside class="sidebar">
        <TextCommandInput
          :loading="loading"
          :painting="painting"
          @submit="handleTextCommand"
        />
        <VoicePanel
          v-model:fine-detail-mode="fineDetailMode"
          v-model:draw-mode="drawMode"
          :loading="loading"
          :painting="painting"
          :paint-message="paintMessage"
          :dashscope-configured="dashscopeConfigured"
          @voice-result="handleVoiceCommand"
        />
        <CommandLog :entries="logs" />
      </aside>
    </main>
  </div>
</template>

<style scoped>
.drawing-board {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem;
}

.header {
  margin-bottom: 1.5rem;
}

.header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.75rem;
}

.header p {
  margin: 0;
  color: #64748b;
}

.layout {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 1.5rem;
  align-items: start;
}

.canvas-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.canvas-notice {
  font-size: 0.85rem;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 6px;
  padding: 0.4rem 0.75rem;
}

.canvas-wrapper {
  position: relative;
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
  overflow: auto;
  border: 1px solid #e2e8f0;
}

.reference-thumb-wrap {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 2;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.reference-thumb {
  width: 140px;
  height: 120px;
  object-fit: contain;
  object-position: center;
  border: 2px solid #6366f1;
  border-radius: 8px;
  background: #fff;
  opacity: 0.85;
  box-shadow: 0 4px 12px rgb(99 102 241 / 0.25);
}

.reference-thumb-label {
  font-size: 0.7rem;
  color: #4338ca;
  background: rgb(255 255 255 / 0.92);
  border: 1px solid #c7d2fe;
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
}

.paint-progress {
  margin: 0;
  font-size: 0.85rem;
  color: #1d4ed8;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
  padding: 0.4rem 0.75rem;
}

.global-error {
  margin: 0;
  font-size: 0.85rem;
  color: #dc2626;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 0.4rem 0.75rem;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1rem;
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
