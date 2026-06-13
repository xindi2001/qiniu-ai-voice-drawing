import { ref } from 'vue'
import type { SceneShapeContext, VoiceParseRequest, VoiceParseResponse } from '../types/commands'

const API_BASE = import.meta.env.DEV ? '' : 'https://your-backend-url.example.com'

export function useVoiceApi() {
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function parseCommand(
    text: string,
    sceneContext?: SceneShapeContext[],
  ): Promise<VoiceParseResponse> {
    loading.value = true
    error.value = null

    try {
      const body: VoiceParseRequest = { text }
      if (sceneContext && sceneContext.length > 0) {
        body.sceneContext = sceneContext
      }

      const response = await fetch(`${API_BASE}/api/v1/voice/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}))
        throw new Error((errBody as { error?: string }).error ?? `请求失败 (${response.status})`)
      }

      return (await response.json()) as VoiceParseResponse
    } catch (e) {
      const message = e instanceof Error ? e.message : '未知错误'
      error.value = message
      throw e
    } finally {
      loading.value = false
    }
  }

  return { loading, error, parseCommand }
}
