export type ActionType = 'draw' | 'modify' | 'delete' | 'undo' | 'redo' | 'clear'
export type ShapeType = 'circle' | 'rect' | 'line'
export type CommandSource = 'voice' | 'text'

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

export interface SceneShapeContext {
  id: string
  shape: ShapeType
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

export interface VoiceParseRequest {
  text: string
  sceneContext?: SceneShapeContext[]
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
  source: CommandSource
  response?: VoiceParseResponse
  error?: string
  executed?: string[]
}

export function shapesToSceneContext(shapes: CanvasShape[]): SceneShapeContext[] {
  return shapes.map((s) => ({
    id: s.id,
    shape: s.type,
    color: s.color,
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    radius: s.radius,
    x1: s.x1,
    y1: s.y1,
    x2: s.x2,
    y2: s.y2,
  }))
}
