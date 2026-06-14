import { ref } from 'vue'
import type { SceneShapeContext, VoiceParseRequest, VoiceParseResponse } from '../types/commands'

const API_BASE =
  import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '' : '')

export interface AsrStatusResponse {
  aliyunConfigured: boolean
  recommendedProvider: 'aliyun' | 'webspeech'
  message: string
}

export interface ImageGenerateResponse {
  imageUrl?: string
  imageBase64?: string
  mimeType?: string
  configured?: boolean
  error?: string
}

export interface ImageGenStatusResponse {
  dashscopeConfigured: boolean
  message: string
}

export interface VoiceTranscribeResponse {
  text: string
  rawText?: string
  provider: string
  homophoneFixed?: boolean
}

export function useVoiceApi() {
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function parseCommand(
    text: string,
    sceneContext?: SceneShapeContext[],
    fineDetailMode?: boolean,
  ): Promise<VoiceParseResponse> {
    loading.value = true
    error.value = null

    try {
      const body: VoiceParseRequest = { text }
      if (sceneContext && sceneContext.length > 0) {
        body.sceneContext = sceneContext
      }
      if (fineDetailMode) {
        body.fineDetailMode = true
      }

      const response = await fetch(`${API_BASE}/api/v1/voice/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}))
        const serverError = (errBody as { error?: string }).error
        if (serverError) {
          throw new Error(serverError)
        }
        if (response.status === 403) {
          throw new Error(
            '请求被拒绝 (403)：请确认后端已在 8080 端口启动，且通过 npm run dev 访问前端（5173）。不要直接打开 dist 或 GitHub Pages 而未配置 VITE_API_BASE。',
          )
        }
        if (response.status === 502 || response.status === 503) {
          throw new Error(
            `后端不可用 (${response.status})：请先在 backend 目录运行 mvn spring-boot:run`,
          )
        }
        throw new Error(`请求失败 (${response.status})`)
      }

      return (await response.json()) as VoiceParseResponse
    } catch (e) {
      if (e instanceof TypeError && e.message.includes('fetch')) {
        const message =
          '无法连接后端：请确认 backend 已运行 (mvn spring-boot:run) 且前端使用 npm run dev 启动'
        error.value = message
        throw new Error(message)
      }
      const message = e instanceof Error ? e.message : '未知错误'
      error.value = message
      throw e
    } finally {
      loading.value = false
    }
  }

  async function fetchAsrStatus(): Promise<AsrStatusResponse> {
    const response = await fetch(`${API_BASE}/api/v1/voice/asr/status`)
    if (!response.ok) {
      return {
        aliyunConfigured: false,
        recommendedProvider: 'webspeech',
        message: '无法获取 ASR 状态，将使用浏览器语音识别',
      }
    }
    return (await response.json()) as AsrStatusResponse
  }

  async function transcribeAudio(wavBlob: Blob): Promise<VoiceTranscribeResponse> {
    const formData = new FormData()
    formData.append('audio', wavBlob, 'recording.wav')
    formData.append('format', 'wav')
    formData.append('sampleRate', '16000')

    const response = await fetch(`${API_BASE}/api/v1/voice/transcribe`, {
      method: 'POST',
      body: formData,
    })

    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const serverError = (body as { error?: string }).error
      throw new Error(serverError ?? `语音识别失败 (${response.status})`)
    }

    return body as VoiceTranscribeResponse
  }

  async function fetchImageGenStatus(): Promise<ImageGenStatusResponse> {
    const response = await fetch(`${API_BASE}/api/v1/voice/image-gen/status`)
    if (!response.ok) {
      return {
        dashscopeConfigured: false,
        message: '无法获取万相状态，复杂物将使用简笔模板',
      }
    }
    return (await response.json()) as ImageGenStatusResponse
  }

  async function generateImage(
    prompt: string,
    fineDetail = false,
    drawMode?: string,
  ): Promise<ImageGenerateResponse> {
    const response = await fetch(`${API_BASE}/api/v1/voice/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        fineDetail: fineDetail || undefined,
        drawMode: drawMode || undefined,
      }),
    })

    const body = (await response.json().catch(() => ({}))) as ImageGenerateResponse & {
      error?: string
    }
    if (!response.ok) {
      throw new Error(body.error ?? `生图请求失败 (${response.status})`)
    }
    return body
  }

  return { loading, error, parseCommand, fetchAsrStatus, fetchImageGenStatus, transcribeAudio, generateImage }
}
