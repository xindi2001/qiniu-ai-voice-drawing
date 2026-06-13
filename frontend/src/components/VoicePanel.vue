<script setup lang="ts">
import { useSpeechRecognition } from '../composables/useSpeechRecognition'

const emit = defineEmits<{
  voiceResult: [text: string]
}>()

const {
  isListening,
  transcript,
  isSupported,
  error,
  startListening,
  stopListening,
} = useSpeechRecognition()

function handleStart(): void {
  startListening()
}

function handleStop(): void {
  stopListening()
  if (transcript.value.trim()) {
    emit('voiceResult', transcript.value.trim())
  }
}
</script>

<template>
  <section class="voice-panel">
    <h3>语音输入（占位）</h3>
    <p class="notice">
      Web Speech API 接口已预留，MVP 阶段请使用文本输入调试。
    </p>
    <div class="status">
      <span :class="['dot', isSupported ? 'ok' : 'warn']" />
      {{ isSupported ? '浏览器支持语音识别' : '浏览器不支持语音识别' }}
    </div>
    <div class="controls">
      <button
        type="button"
        :disabled="!isSupported || isListening"
        @click="handleStart"
      >
        开始录音
      </button>
      <button
        type="button"
        :disabled="!isListening"
        @click="handleStop"
      >
        停止
      </button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="transcript" class="transcript">识别结果：{{ transcript }}</p>
  </section>
</template>

<style scoped>
.voice-panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

h3 {
  margin: 0;
  font-size: 1rem;
}

.notice {
  margin: 0;
  font-size: 0.85rem;
  color: #64748b;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}

.status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: #475569;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot.ok {
  background: #22c55e;
}

.dot.warn {
  background: #f59e0b;
}

.controls {
  display: flex;
  gap: 0.5rem;
}

button {
  padding: 0.5rem 1rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: white;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error {
  color: #dc2626;
  font-size: 0.85rem;
  margin: 0;
}

.transcript {
  font-size: 0.85rem;
  color: #334155;
  margin: 0;
}
</style>
