<script setup lang="ts">
import { computed } from 'vue'
import { useSpeechRecognition } from '../composables/useSpeechRecognition'
import type { DrawPipelineMode } from '../engine/commandExecutor'

const EXECUTE_LABEL = { confirm: '确认执行', start: '开始执行' } as const

const DRAW_MODE_OPTIONS: { value: DrawPipelineMode; label: string; hint: string }[] = [
  { value: 'outline_only', label: '仅勾线（默认）', hint: '万相参考图 → 轮廓描摹，逐笔动画，不上色' },
  { value: 'stroke_reveal', label: '完整揭示', hint: '快速展示成图，图像逐条揭示' },
  { value: 'region_trace', label: '色块边界', hint: '按色块边界描摹线稿' },
  { value: 'bitmap_trace', label: '位图矢量（实验）', hint: '旧 ImageTracer 管线，可能断线' },
]

const props = defineProps<{
  loading?: boolean
  painting?: boolean
  paintMessage?: string | null
  fineDetailMode?: boolean
  drawMode?: DrawPipelineMode
  dashscopeConfigured?: boolean
}>()

const emit = defineEmits<{
  voiceResult: [text: string]
  'update:fineDetailMode': [value: boolean]
  'update:drawMode': [value: DrawPipelineMode]
}>()

const {
  isListening,
  isTranscribing,
  transcript,
  interimTranscript,
  isSupported,
  continuous,
  confirmBeforeExecute,
  providerName,
  providerMessage,
  error,
  startListening,
  stopListening,
  toggleContinuous,
  toggleConfirmBeforeExecute,
  submitPendingTranscript,
} = useSpeechRecognition({
  onFinalTranscript(text) {
    if (text.trim()) {
      emit('voiceResult', text.trim())
    }
  },
})

const providerLabel = computed(() =>
  providerName.value === 'aliyun' ? '阿里云 ASR' : 'Web Speech API',
)

const busy = computed(() => isListening.value || isTranscribing.value || !!props.painting)

const executeDisabled = computed(
  () =>
    !transcript.value.trim()
    || isListening.value
    || isTranscribing.value
    || !!props.loading
    || !!props.painting,
)

const executeLabel = computed(() =>
  confirmBeforeExecute.value ? EXECUTE_LABEL.confirm : EXECUTE_LABEL.start,
)

function handleStart(): void {
  startListening()
}

async function handleStop(): Promise<void> {
  await stopListening()
}

function handleExecute(): void {
  submitPendingTranscript()
}

function toggleFineDetailMode(event: Event): void {
  emit('update:fineDetailMode', (event.target as HTMLInputElement).checked)
}

function onDrawModeChange(event: Event): void {
  emit('update:drawMode', (event.target as HTMLSelectElement).value as DrawPipelineMode)
}

const drawModeHint = computed(() =>
  DRAW_MODE_OPTIONS.find((o) => o.value === props.drawMode)?.hint ?? '',
)
</script>

<template>
  <section class="voice-panel">
    <h3>语音输入</h3>
    <p v-if="!isSupported" class="notice warn">
      当前环境不支持语音识别。请配置阿里云 ASR 环境变量并重启后端，或使用 Chrome/Edge 的 Web Speech API。
    </p>
    <p v-else-if="providerMessage" class="notice">
      {{ providerMessage }}
    </p>
    <div class="status">
      <span :class="['dot', isSupported ? 'ok' : 'warn']" />
      {{ isSupported ? `识别引擎：${providerLabel}` : '语音识别不可用' }}
      <span v-if="isListening" class="listening-badge">录音中...</span>
      <span v-else-if="isTranscribing" class="listening-badge transcribing">识别中...</span>
    </div>
    <div class="mode-toggle">
      <label class="select-label">
        万相描摹模式
        <select
          :value="props.drawMode ?? 'outline_only'"
          :disabled="busy || loading"
          @change="onDrawModeChange"
        >
          <option
            v-for="opt in DRAW_MODE_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>
      </label>
      <p v-if="drawModeHint" class="hint">{{ drawModeHint }}</p>
    </div>
    <div class="mode-toggle">
      <label>
        <input
          type="checkbox"
          :checked="props.fineDetailMode"
          :disabled="busy || loading"
          @change="toggleFineDetailMode"
        />
        精细描摹模式（较慢，plus 1024，适合头像/细节插画）
      </label>
      <p class="hint">
        <template v-if="!props.fineDetailMode">
          录演示建议保持关闭精细模式：turbo 768 + 快速勾线，全程约 10–18 秒。
        </template>
        <template v-else-if="props.dashscopeConfigured">
          复杂主体默认走万相生图（已配置 DASHSCOPE）
        </template>
        <template v-else>
          未配置 DASHSCOPE_API_KEY，复杂物体使用简笔多段折线
        </template>
      </p>
    </div>
    <div class="mode-toggle">
      <label>
        <input
          type="checkbox"
          :checked="continuous"
          :disabled="busy || loading || providerName === 'aliyun'"
          @change="toggleContinuous"
        />
        连续识别模式（说完自动提交，仅 Web Speech）
      </label>
    </div>
    <div class="mode-toggle">
      <label>
        <input
          type="checkbox"
          :checked="confirmBeforeExecute"
          :disabled="busy || loading"
          @change="toggleConfirmBeforeExecute"
        />
        确认后再执行（识别完成后需点「确认执行」）
      </label>
    </div>
    <div class="controls">
      <button
        type="button"
        class="btn-start"
        :disabled="!isSupported || busy || loading"
        @click="handleStart"
      >
        {{ props.painting ? '绘画中...' : loading ? '解析中...' : '开始录音' }}
      </button>
      <button
        type="button"
        class="btn-stop"
        :disabled="!isListening"
        @click="handleStop"
      >
        停止并识别
      </button>
      <button
        type="button"
        class="btn-confirm"
        :disabled="executeDisabled"
        @click="handleExecute"
      >
        {{ executeLabel }}
      </button>
    </div>
    <p v-if="props.painting" class="loading">
      <span class="spinner" />{{ props.paintMessage || '正在绘画...' }}
    </p>
    <p v-else-if="loading" class="loading">
      <span class="spinner" />正在解析指令...
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="transcript || interimTranscript" class="transcript-box">
      <p v-if="transcript" class="transcript">
        <strong>识别结果：</strong>{{ transcript }}
      </p>
      <p v-if="interimTranscript" class="interim">
        <strong>实时识别：</strong>{{ interimTranscript }}
      </p>
    </div>
    <p v-if="providerName === 'aliyun'" class="hint">
      按住说话：「开始录音」→ 说话 → 「停止并识别」→ 确认识别结果后点「{{ executeLabel }}」
    </p>
    <p v-else-if="!continuous" class="hint">
      点击「开始录音」说话，「停止并识别」后点「{{ executeLabel }}」提交指令
    </p>
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

.notice.warn {
  background: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}

.status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: #475569;
  flex-wrap: wrap;
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

.listening-badge {
  font-size: 0.75rem;
  color: #dc2626;
  background: #fee2e2;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  animation: pulse 1.5s ease-in-out infinite;
}

.listening-badge.transcribing {
  color: #4f46e5;
  background: #e0e7ff;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.mode-toggle label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: #475569;
  cursor: pointer;
}

.select-label {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
}

.select-label select {
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 0.85rem;
  background: white;
  color: #334155;
}

.controls {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

button {
  padding: 0.5rem 1rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: white;
}

.btn-start {
  background: #4f46e5;
  color: white;
  border-color: #4f46e5;
}

.btn-stop {
  background: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}

.btn-confirm {
  background: #ecfdf5;
  border-color: #86efac;
  color: #15803d;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #4f46e5;
  font-size: 0.85rem;
  margin: 0;
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid #c7d2fe;
  border-top-color: #4f46e5;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error {
  color: #dc2626;
  font-size: 0.85rem;
  margin: 0;
}

.transcript-box {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}

.transcript,
.interim {
  font-size: 0.85rem;
  color: #334155;
  margin: 0.2rem 0;
}

.interim {
  color: #94a3b8;
  font-style: italic;
}

.hint {
  margin: 0;
  font-size: 0.8rem;
  color: #94a3b8;
}
</style>
