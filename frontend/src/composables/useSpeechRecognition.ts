import { onMounted, onUnmounted, ref } from 'vue'
import { useAudioRecorder } from './useAudioRecorder'
import { convertBlobToWav16k } from '../utils/audioToWav'
import { useVoiceApi } from './useVoiceApi'

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': '麦克风权限被拒绝，请在浏览器设置中允许访问',
  'no-speech': '未检测到语音，请重试',
  'audio-capture': '未找到麦克风设备',
  network: '语音识别需要网络连接（Chrome 使用云端识别）',
  aborted: '语音识别已取消',
  'language-not-supported': '当前浏览器不支持中文语音识别',
  'service-not-allowed': '语音识别服务不可用',
}

export type SpeechProviderName = 'aliyun' | 'webspeech'

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

export interface SpeechRecognitionOptions {
  continuous?: boolean
  onFinalTranscript?: (text: string) => void
}

export function useSpeechRecognition(options: SpeechRecognitionOptions = {}) {
  const isListening = ref(false)
  const isTranscribing = ref(false)
  const transcript = ref('')
  const interimTranscript = ref('')
  const error = ref<string | null>(null)
  const continuous = ref(options.continuous ?? false)
  const confirmBeforeExecute = ref(false)
  const providerName = ref<SpeechProviderName>('webspeech')
  const providerMessage = ref<string | null>(null)
  const isSupported = ref(false)

  const { fetchAsrStatus, transcribeAudio } = useVoiceApi()
  const { startRecording, stopRecording } = useAudioRecorder()

  let recognition: SpeechRecognition | null = null
  let activeProvider: SpeechProviderName = 'webspeech'

  function createWebSpeechRecognition(): SpeechRecognition | null {
    const Ctor = getRecognitionCtor()
    if (!Ctor) return null

    const instance = new Ctor()
    instance.lang = 'zh-CN'
    instance.continuous = continuous.value
    instance.interimResults = true
    instance.maxAlternatives = 1

    instance.onstart = () => {
      isListening.value = true
      error.value = null
    }

    instance.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let finalText = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) {
          finalText += text
        } else {
          interim += text
        }
      }

      interimTranscript.value = interim
      if (finalText) {
        transcript.value = (transcript.value + finalText).trim()
        interimTranscript.value = ''
        if (continuous.value && !confirmBeforeExecute.value) {
          options.onFinalTranscript?.(finalText.trim())
          transcript.value = ''
        }
      }
    }

    instance.onerror = (event: SpeechRecognitionErrorEvent) => {
      error.value = ERROR_MESSAGES[event.error] ?? `语音识别错误: ${event.error}`
      isListening.value = false
    }

    instance.onend = () => {
      isListening.value = false
      interimTranscript.value = ''
    }

    return instance
  }

  async function startAliyunListening(): Promise<void> {
    activeProvider = 'aliyun'
    error.value = null
    transcript.value = ''
    interimTranscript.value = ''

    try {
      await startRecording()
      isListening.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : '启动录音失败'
      isListening.value = false
    }
  }

  async function stopAliyunListening(): Promise<void> {
    if (!isListening.value) return

    isListening.value = false
    isTranscribing.value = true
    error.value = null

    try {
      const blob = await stopRecording()
      const wavBlob = await convertBlobToWav16k(blob)
      const result = await transcribeAudio(wavBlob)
      transcript.value = result.text.trim()

      if (result.homophoneFixed && result.rawText && result.rawText !== result.text) {
        providerMessage.value = `已纠正同音字：${result.rawText} → ${result.text}`
      }

      if (transcript.value && continuous.value && !confirmBeforeExecute.value) {
        options.onFinalTranscript?.(transcript.value)
        transcript.value = ''
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '阿里云语音识别失败'
    } finally {
      isTranscribing.value = false
    }
  }

  function startWebSpeechListening(): void {
    activeProvider = 'webspeech'
    if (getRecognitionCtor() === null) {
      error.value = '当前浏览器不支持 Web Speech API，请使用 Chrome 或 Edge'
      return
    }

    if (isListening.value) return

    error.value = null
    transcript.value = ''
    interimTranscript.value = ''

    try {
      recognition?.abort()
      recognition = createWebSpeechRecognition()
      if (!recognition) {
        error.value = '无法初始化语音识别'
        return
      }
      recognition.start()
    } catch {
      error.value = '启动语音识别失败，请检查麦克风权限'
      isListening.value = false
    }
  }

  function stopWebSpeechListening(): void {
    if (!recognition || !isListening.value) return
    try {
      recognition.stop()
    } catch {
      isListening.value = false
    }
  }

  function startListening(): void {
    if (isListening.value || isTranscribing.value) return

    if (providerName.value === 'aliyun') {
      void startAliyunListening()
    } else {
      startWebSpeechListening()
    }
  }

  function stopListening(): void {
    if (providerName.value === 'aliyun') {
      void stopAliyunListening()
    } else {
      stopWebSpeechListening()
    }
  }

  function toggleContinuous(): void {
    if (providerName.value === 'aliyun') {
      providerMessage.value = '阿里云 ASR 为按住说话模式，连续识别请使用 Web Speech'
      return
    }
    continuous.value = !continuous.value
    if (isListening.value) {
      stopListening()
    }
  }

  function toggleConfirmBeforeExecute(): void {
    confirmBeforeExecute.value = !confirmBeforeExecute.value
  }

  function resetTranscript(): void {
    transcript.value = ''
    interimTranscript.value = ''
    error.value = null
    providerMessage.value = null
  }

  function confirmTranscript(): string | null {
    const text = (transcript.value + interimTranscript.value).trim()
    if (!text) return null
    options.onFinalTranscript?.(text)
    resetTranscript()
    return text
  }

  function submitPendingTranscript(): string | null {
    if (confirmBeforeExecute.value) {
      return confirmTranscript()
    }

    const text = (transcript.value + interimTranscript.value).trim()
    if (!text) return null

    if (activeProvider === 'webspeech' && !continuous.value) {
      options.onFinalTranscript?.(text)
      resetTranscript()
    } else if (activeProvider === 'aliyun' && text) {
      options.onFinalTranscript?.(text)
      resetTranscript()
    }
    return text
  }

  onMounted(async () => {
    try {
      const status = await fetchAsrStatus()
      if (status.aliyunConfigured) {
        providerName.value = 'aliyun'
        isSupported.value = true
        providerMessage.value = status.message
      } else {
        providerName.value = 'webspeech'
        isSupported.value = getRecognitionCtor() !== null
        providerMessage.value = status.message
      }
    } catch {
      providerName.value = 'webspeech'
      isSupported.value = getRecognitionCtor() !== null
      providerMessage.value = '无法连接后端，使用浏览器 Web Speech API'
    }
  })

  onUnmounted(() => {
    recognition?.abort()
    recognition = null
  })

  return {
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
    resetTranscript,
    confirmTranscript,
    submitPendingTranscript,
  }
}
