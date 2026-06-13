export type ActionType = 'draw' | 'modify' | 'delete' | 'undo' | 'redo' | 'clear'
export type ShapeType = 'circle' | 'rect' | 'line'

export interface DrawAction {
  action: ActionType
  shape?: ShapeType
  color?: string
  x?: number
  y?: number
  width?: number
  height?: number
  radius?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  targetId?: string
  params?: Record<string, unknown>
}

export interface VoiceParseRequest {
  text: string
}

export interface VoiceParseResponse {
  speak: string
  actions: DrawAction[]
  mockMode: boolean
}

export interface CanvasShape {
  id: string
  type: ShapeType
  color: string
  x: number
  y: number
  width?: number
  height?: number
  radius?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
}

export interface LogEntry {
  id: string
  timestamp: string
  text: string
  response?: VoiceParseResponse
  error?: string
  executed?: string[]
}
