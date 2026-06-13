<script setup lang="ts">
import { ref } from 'vue'
import KonvaCanvas from './KonvaCanvas.vue'
import TextCommandInput from './TextCommandInput.vue'
import CommandLog from './CommandLog.vue'
import VoicePanel from './VoicePanel.vue'
import { useVoiceApi } from '../composables/useVoiceApi'
import { useSpeechSynthesis } from '../composables/useSpeechSynthesis'
import { createInitialState, executeActions } from '../engine/commandExecutor'
import type { LogEntry } from '../types/commands'

const CANVAS_WIDTH = 600
const CANVAS_HEIGHT = 400

const executorState = ref(createInitialState())
const logs = ref<LogEntry[]>([])
const { loading, parseCommand } = useVoiceApi()
const { speak } = useSpeechSynthesis()

function createLogId(): string {
  return `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

async function handleCommand(text: string): Promise<void> {
  const entry: LogEntry = {
    id: createLogId(),
    timestamp: new Date().toLocaleTimeString('zh-CN'),
    text,
  }
  logs.value.push(entry)

  try {
    const response = await parseCommand(text)
    entry.response = response

    const { state, messages } = executeActions(executorState.value, response.actions)
    executorState.value = state
    entry.executed = messages

    if (response.speak) {
      speak(response.speak)
    }
  } catch (e) {
    entry.error = e instanceof Error ? e.message : '执行失败'
  }
}
</script>

<template>
  <div class="drawing-board">
    <header class="header">
      <h1>七牛 AI 语音绘图</h1>
      <p>文本优先调试 · 语音绘图 Bootcamp MVP</p>
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
        </div>
      </section>

      <aside class="sidebar">
        <TextCommandInput :loading="loading" @submit="handleCommand" />
        <VoicePanel @voice-result="handleCommand" />
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
  background: white;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
  overflow: hidden;
  border: 1px solid #e2e8f0;
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
