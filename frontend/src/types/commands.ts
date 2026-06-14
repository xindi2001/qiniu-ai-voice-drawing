export type ActionType =
  | 'draw'
  | 'draw_stroke'
  | 'draw_paths'
  | 'drawPath'
  | 'generate_and_trace'
  | 'useTemplate'
  | 'useIcon'
  | 'modify'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'clear'

export type DrawMode = 'geometry' | 'picture'

export type ShapeType = 'circle' | 'rect' | 'line' | 'path' | 'image' | 'clipImage'
export type CommandSource = 'voice' | 'text'

export type PointPair = [number, number]

export interface PathItem {
  points: PointPair[]
  color?: string
}

export interface DrawAction {
  action: ActionType
  mode?: DrawMode
  shape?: ShapeType
  color?: string
  strokeOnly?: boolean
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
  points?: PointPair[]
  paths?: string[]
  pathItems?: PathItem[]
  imagePrompt?: string
  templateId?: string
  iconId?: string
  scale?: number
  animateMs?: number
  closed?: boolean
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
  fineDetailMode?: boolean
}

export interface VoiceParseResponse {
  speak: string
  actions: DrawAction[]
  mockMode: boolean
  warning?: string
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
  /** Flat [x1,y1,x2,y2,...] for path strokes */
  points?: number[]
  closed?: boolean
  /** Cached polyline length for dashOffset pen animation */
  pathLength?: number
  /** Konva dashOffset — animates from pathLength → 0 */
  dashOffset?: number
  /** During stroke animation: circle drawn as arc path */
  strokeOnly?: boolean
  /** Konva.Line tension for smooth curves (0–1) */
  tension?: number
  /** Raster image source (data URL or URL) for stroke_reveal mode */
  imageSrc?: string
  cropX?: number
  cropY?: number
  cropWidth?: number
  cropHeight?: number
  opacity?: number
  /** Fill color for closed path regions (sketch_then_color phase 2) */
  fill?: string
  /** Path stroke width override */
  strokeWidth?: number
  /** Fill-only path — no stroke during color phase */
  fillOnly?: boolean
  /** Masked source reveal — clip polygon in canvas coords */
  maskClipPoints?: number[]
  /** Optional horizontal band clip (canvas Y coords) for gradual subject reveal */
  bandClipY0?: number
  bandClipY1?: number
  /** Full fitted source image for masked reveal */
  revealImageSrc?: string
  maskedReveal?: boolean
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
