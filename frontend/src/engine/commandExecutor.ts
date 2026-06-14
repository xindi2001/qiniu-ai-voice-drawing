import type { CanvasShape, DrawAction, PointPair } from '../types/commands'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../constants/canvas'
import { pathActionToShape, createShapeId } from './shapeFactory'
import { loadIconActions } from './iconLoader'
import { loadTemplateActions } from './svgTemplateLoader'
import { computePathLength, sanitizeFlatPath, bboxFromFlat, pairsToFlat } from './pathUtils'
import {
  animateDrawStrokeAction,
  animatePathStroke,
  animatePathsBatch,
  animateValue,
  computeWanxTraceBatchSize,
  computeWanxTraceDuration,
  DEFAULT_ANIMATE_MS,
  PATH_DELAY_MS,
  PATHS_DELAY_MS,
  PATHS_MIN_MS,
  sleep,
  TRACE_TIMEOUT_MS_FINE,
  WANX_PATH_TENSION,
  WANX_PATH_TENSION_FINE,
  type PathStrokeItem,
} from './strokeAnimator'
import { PIPELINE_CONFIG, type DrawPipelineMode, type WanxStyle } from '../constants/traceConfig'
import {
  fitImageSourceToCanvas,
  vectorizeGeneratedImage,
  type VectorizeResult,
} from './imageVectorizer'
import { parsePathDAll } from './svgPathParser'
import { clampPathItems, resolvePathItemsFromPrompt } from './tier2Paths'
import { sortStrokeItemsNatural } from './pathSorter'
import { isTraceableImage, LINE_ART_RETRY_SUFFIX, detectWanxStyleFromPrompt, retrySuffixForStyle } from './traceQualityGate'
import {
  animateStrokeReveal,
  computeImageFitBounds,
  generateRevealStrokes,
} from './strokeReveal'
import { vectorizeByColorRegions } from './regionVectorizer'
import { analyzeOutlinePlan, drawOutlineOnly } from './pipelineV4'
import { createAnalysisWorkspace, yieldToMain } from './analysisWorkspace'

export type { DrawPipelineMode }

export interface ExecutorState {
  shapes: CanvasShape[]
  undoStack: CanvasShape[][]
  redoStack: CanvasShape[][]
}

export interface GenerateImageFn {
  (prompt: string, fineDetail?: boolean, drawMode?: string): Promise<{ imageUrl?: string; imageBase64?: string; mimeType?: string }>
}

export interface ExecutorOptions {
  fineDetailMode?: boolean
  drawMode?: DrawPipelineMode
}

export interface PaintProgress {
  phase: 'understanding' | 'drawing' | 'stroking' | 'composing' | 'generating' | 'analyzing' | 'tracing_prep' | 'tracing' | 'revealing' | 'sketching' | 'coloring'
  current?: number
  total?: number
  message: string
  /** Faded Wanx reference thumbnail shown during trace (debug confidence). */
  referenceImage?: string
  /** Active pipeline mode label for UI */
  drawMode?: DrawPipelineMode
}

export function createInitialState(): ExecutorState {
  return { shapes: [], undoStack: [], redoStack: [] }
}

function snapshot(state: ExecutorState): CanvasShape[] {
  return state.shapes.map((s) => ({ ...s, points: s.points ? [...s.points] : undefined }))
}

function pushUndo(state: ExecutorState): void {
  state.undoStack.push(snapshot(state))
  state.redoStack = []
}

function cloneState(state: ExecutorState): ExecutorState {
  return {
    shapes: snapshot(state),
    undoStack: [...state.undoStack],
    redoStack: [...state.redoStack],
  }
}

/** Synchronous executor (instant) — non-draw actions only. */
export function executeActions(
  state: ExecutorState,
  actions: DrawAction[],
): { state: ExecutorState; messages: string[] } {
  const messages: string[] = []
  const next = cloneState(state)
  for (const action of actions) {
    const result = executeSingleInstant(next, action)
    if (result) messages.push(result)
  }
  return { state: next, messages }
}

/** Animated sequential executor — all draws go through stroke animation. */
export async function executeActionsAnimated(
  state: ExecutorState,
  actions: DrawAction[],
  onProgress?: (state: ExecutorState) => void,
  generateImage?: GenerateImageFn,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  options?: ExecutorOptions,
): Promise<{ state: ExecutorState; messages: string[] }> {
  const messages: string[] = []
  const next = cloneState(state)
  const emit = (): void => {
    onProgress?.(cloneState(next))
  }

  try {
    for (const action of actions) {
      const msg = await executeSingleAnimated(
        next, action, emit, generateImage, onPaintProgress, options,
      )
      if (msg) messages.push(msg)
    }
  } finally {
    onPaintProgress?.(null)
  }

  emit()
  return { state: next, messages }
}

async function executeSingleAnimated(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  generateImage?: GenerateImageFn,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  options?: ExecutorOptions,
): Promise<string | null> {
  switch (action.action) {
    case 'draw_stroke':
      return animateDrawStroke(state, action, emit, onPaintProgress)
    case 'draw':
      return animateDrawStroke(state, { ...action, action: 'draw_stroke' }, emit, onPaintProgress)
    case 'draw_paths':
      return animateDrawPaths(state, action, emit, onPaintProgress)
    case 'drawPath':
      return animateDrawPath(state, action, emit)
    case 'generate_and_trace':
      return animateGenerateAndTrace(state, action, emit, generateImage, onPaintProgress, options)
    case 'useTemplate':
      return animateUseTemplate(state, action, emit)
    case 'useIcon':
      return animateUseIcon(state, action, emit)
    case 'modify':
    case 'delete':
    case 'undo':
    case 'redo':
    case 'clear':
      return executeInstantWithEmit(state, action, emit)
    default:
      return `未知操作: ${action.action}`
  }
}

function executeSingleInstant(state: ExecutorState, action: DrawAction): string | null {
  switch (action.action) {
    case 'modify':
    case 'delete':
    case 'undo':
    case 'redo':
    case 'clear':
      return executeInstantAction(state, action)
    default:
      return `操作 ${action.action} 需使用 executeActionsAnimated`
  }
}

function executeInstantWithEmit(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
): string | null {
  const msg = executeInstantAction(state, action)
  emit()
  return msg
}

function executeInstantAction(state: ExecutorState, action: DrawAction): string | null {
  switch (action.action) {
    case 'modify': {
      if (!action.targetId) return '修改失败：缺少 targetId'
      const idx = state.shapes.findIndex((s) => s.id === action.targetId)
      if (idx < 0) return `修改失败：未找到 ${action.targetId}`
      pushUndo(state)
      const target = { ...state.shapes[idx] }
      if (action.color) target.color = action.color
      if (action.x !== undefined) target.x = action.x
      if (action.y !== undefined) target.y = action.y
      if (action.width !== undefined) target.width = action.width
      if (action.height !== undefined) target.height = action.height
      if (action.radius !== undefined) target.radius = action.radius
      state.shapes[idx] = target
      return `修改 ${action.targetId}`
    }
    case 'delete': {
      if (!action.targetId) return '删除失败：缺少 targetId'
      const idx = state.shapes.findIndex((s) => s.id === action.targetId)
      if (idx < 0) return `删除失败：未找到 ${action.targetId}`
      pushUndo(state)
      state.shapes.splice(idx, 1)
      return `删除 ${action.targetId}`
    }
    case 'undo': {
      if (state.undoStack.length === 0) return '无可撤销操作'
      state.redoStack.push(snapshot(state))
      state.shapes = state.undoStack.pop()!
      return '已撤销'
    }
    case 'redo': {
      if (state.redoStack.length === 0) return '无可重做操作'
      state.undoStack.push(snapshot(state))
      state.shapes = state.redoStack.pop()!
      return '已重做'
    }
    case 'clear': {
      if (state.shapes.length === 0) return '画布已为空'
      pushUndo(state)
      state.shapes = []
      return '画布已清空'
    }
    default:
      return null
  }
}

async function animateDrawStroke(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  onPaintProgress?: (progress: PaintProgress | null) => void,
): Promise<string | null> {
  onPaintProgress?.({ phase: 'drawing', message: '落笔描绘…' })
  pushUndo(state)
  let animIndex = -1

  const finalShape = await animateDrawStrokeAction(action, (shape) => {
    if (!shape) return
    if (animIndex < 0) {
      state.shapes.push(shape)
      animIndex = state.shapes.length - 1
    } else {
      state.shapes[animIndex] = shape
    }
    emit()
  })

  if (!finalShape) return null
  if (animIndex >= 0) {
    state.shapes[animIndex] = finalShape
  } else {
    state.shapes.push(finalShape)
  }
  emit()
  return `笔画绘制 ${finalShape.type} (${finalShape.id})`
}

function isClosedPath(points: PointPair[]): boolean {
  if (points.length < 3) return false
  const first = points[0]
  const last = points[points.length - 1]
  return first[0] === last[0] && first[1] === last[1]
}

function isGrayFillColor(color: string): boolean {
  const normalized = color.trim().toLowerCase()
  return (
    normalized.includes('gray')
    || normalized.includes('grey')
    || /^#(?:808080|9ca3af|6b7280|d1d5db|a1a1aa|737373|b0b0b0)/.test(normalized)
  )
}

/** Skip large closed gray polygons (interior fill / shading from LLM traces). */
function isFilledPolygonArtifact(
  points: PointPair[],
  color: string,
  canvasW: number,
  canvasH: number,
): boolean {
  if (points.length < 4 || !isClosedPath(points) || !isGrayFillColor(color)) return false

  const flat = points.flat()
  const bbox = bboxFromFlat(flat)
  const areaRatio = ((bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY)) / (canvasW * canvasH)
  return areaRatio > 0.04
}

function filterDrawPathItems(
  items: NonNullable<DrawAction['pathItems']>,
  canvasW: number,
  canvasH: number,
): NonNullable<DrawAction['pathItems']> {
  const filtered = items.filter((item) => {
    if (!item.points || item.points.length < 2) return false
    const color = item.color ?? '#1f2937'
    return !isFilledPolygonArtifact(item.points, color, canvasW, canvasH)
  })
  return filtered.length > 0 ? filtered.slice(0, 12) : items.slice(0, 12)
}

async function animateDrawPaths(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  skipUndo = false,
): Promise<string | null> {
  const rawItems = clampPathItems(action.pathItems ?? [], CANVAS_WIDTH, CANVAS_HEIGHT)
  const items = filterDrawPathItems(rawItems, CANVAS_WIDTH, CANVAS_HEIGHT)
  if (items.length === 0) return 'draw_paths 需要 pathItems'

  onPaintProgress?.({ phase: 'drawing', message: '落笔描绘…' })
  const shapeCountBefore = state.shapes.length
  if (!skipUndo) pushUndo(state)

  const defaultColor = action.color ?? '#1f2937'
  const total = items.length

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.points || item.points.length < 2) continue

    onPaintProgress?.({
      phase: 'stroking',
      current: i + 1,
      total,
      message: `绘制中（${i + 1}/${total}）…`,
    })

    const flat = item.points.flat()
    const color = item.color ?? defaultColor
    const sanitizedChunks = sanitizeFlatPath(flat, {
      canvasW: CANVAS_WIDTH,
      canvasH: CANVAS_HEIGHT,
      maxSegmentLen: Math.hypot(CANVAS_WIDTH, CANVAS_HEIGHT) * 0.4,
    })
    const chunks = sanitizedChunks.length > 0 ? sanitizedChunks : [flat]

    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c]
      if (chunk.length < 4) continue

      const closed = item.points.length > 2
        && chunk[0] === chunk[chunk.length - 2]
        && chunk[1] === chunk[chunk.length - 1]

      const duration = Math.max(action.animateMs ?? PATHS_MIN_MS, PATHS_MIN_MS)
      let animIndex = state.shapes.length

      const finalShape = await animatePathStroke(chunk, color, closed, duration, (shape) => {
        if (!shape) return
        if (state.shapes.length <= animIndex) {
          state.shapes.push(shape)
        } else {
          state.shapes[animIndex] = shape
        }
        emit()
      })

      if (state.shapes.length <= animIndex) {
        state.shapes.push(finalShape)
      } else {
        state.shapes[animIndex] = finalShape
      }
      emit()

      if (c < chunks.length - 1) {
        await sleep(PATHS_DELAY_MS)
      }
    }

    if (i < items.length - 1) {
      await sleep(PATHS_DELAY_MS * 1.5)
    }
  }

  const drawn = state.shapes.length - shapeCountBefore
  if (drawn === 0) return '路径坐标无效，未能描绘'
  return `简笔描绘完成 (${drawn}/${total} 笔)`
}

async function fallbackTier2DrawPaths(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  reason?: string,
): Promise<string> {
  onPaintProgress?.({ phase: 'drawing', message: '改用简笔轮廓…' })
  const color = action.color ?? '#1f2937'
  const prompt = action.imagePrompt ?? ''
  const fallbackAction: DrawAction = {
    action: 'draw_paths',
    mode: 'geometry',
    color,
    pathItems: resolvePathItemsFromPrompt(prompt, color),
    animateMs: action.animateMs ?? PATHS_MIN_MS,
  }
  const msg = await animateDrawPaths(state, fallbackAction, emit, onPaintProgress)
  const configReasons = ['通义万相未配置', '参考图生成失败']
  const prefix = reason && configReasons.some((r) => reason.includes(r))
    ? `${reason}，已切换简笔路径模板`
    : reason
      ? `万相矢量化效果不佳，已切换简笔路径模板（${reason}）`
      : '万相矢量化效果不佳，已切换简笔路径模板'
  return msg && !msg.includes('未能描绘') ? `${prefix}（${msg}）` : prefix
}

const WANX_MIN_STROKE_POINTS = 3

function imageResultToDataUrl(
  result: { imageBase64?: string; imageUrl?: string; mimeType?: string },
): string {
  if (result.imageBase64) {
    return result.imageBase64.startsWith('data:')
      ? result.imageBase64
      : `data:${result.mimeType ?? 'image/png'};base64,${result.imageBase64}`
  }
  if (result.imageUrl) return result.imageUrl
  throw new Error('参考图生成失败')
}

function analysisCanvasForGate(fullCanvas: HTMLCanvasElement): HTMLCanvasElement {
  return createAnalysisWorkspace(fullCanvas).analysisCanvas
}

function startElapsedReporter(
  phase: PaintProgress['phase'],
  label: string,
  report: (progress: Omit<PaintProgress, 'referenceImage'> & { referenceImage?: string }) => void,
  referenceImage?: string,
): () => void {
  const start = performance.now()
  report({ phase, message: `${label}… (0s)`, referenceImage })
  const timer = setInterval(() => {
    const sec = Math.floor((performance.now() - start) / 1000)
    report({ phase, message: `${label}… (${sec}s)`, referenceImage })
  }, 1000)
  return () => clearInterval(timer)
}

async function loadImageForGate(src: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      performance.mark('gate-load-start')
      let source: CanvasImageSource = img
      const maxPx = PIPELINE_CONFIG.gateCanvasMaxPx
      if (Math.max(img.width, img.height) > maxPx) {
        const scale = maxPx / Math.max(img.width, img.height)
        const tmp = document.createElement('canvas')
        tmp.width = Math.round(img.width * scale)
        tmp.height = Math.round(img.height * scale)
        tmp.getContext('2d')!.drawImage(img, 0, 0, tmp.width, tmp.height)
        source = tmp
        console.log(`[gate] downscaled reference ${img.width}x${img.height} → ${tmp.width}x${tmp.height}`)
      }
      const canvas = fitImageSourceToCanvas(source, CANVAS_WIDTH, CANVAS_HEIGHT)
      performance.mark('gate-load-end')
      performance.measure('gate-load', 'gate-load-start', 'gate-load-end')
      resolve(canvas)
    }
    img.onerror = () => reject(new Error('无法加载图片'))
    img.src = src
  })
}

async function vectorizeWanxResult(
  result: { imageBase64?: string; imageUrl?: string; mimeType?: string },
  fineDetail: boolean,
  imagePrompt: string,
): Promise<VectorizeResult> {
  const dataUrl = imageResultToDataUrl(result)
  return vectorizeGeneratedImage(dataUrl, CANVAS_WIDTH, CANVAS_HEIGHT, { fineDetail, imagePrompt })
}
const WANX_FULL_MIN_LENGTH = 3
const WANX_CHUNK_MIN_LENGTH = 4

function vectorPathsToStrokeItems(
  paths: { d: string }[],
  canvasW: number,
  canvasH: number,
  maxSeg: number,
  minLength = WANX_FULL_MIN_LENGTH,
): PathStrokeItem[] {
  const strokeItems: PathStrokeItem[] = []
  for (const path of paths) {
    for (const sp of parsePathDAll(path.d)) {
      if (sp.points.length < WANX_MIN_STROKE_POINTS) continue
      const flat = pairsToFlat(sp.points)
      if (computePathLength(flat) < minLength) continue
      const chunks = sanitizeFlatPath(flat, {
        canvasW,
        canvasH,
        maxSegmentLen: maxSeg,
      })
      for (const chunk of chunks) {
        if (chunk.length >= 4 && computePathLength(chunk) >= WANX_CHUNK_MIN_LENGTH) {
          strokeItems.push({ flat: chunk, closed: sp.closed })
        }
      }
    }
  }
  return strokeItems
}

async function animateDrawPath(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  skipUndo = false,
): Promise<string | null> {
  if (!action.points || action.points.length < 2) return 'drawPath 需要至少 2 个点'
  const fullShape = pathActionToShape(action)
  if (!fullShape || !fullShape.points) return null

  if (!skipUndo) pushUndo(state)

  const duration = action.animateMs ?? DEFAULT_ANIMATE_MS
  let animIndex = state.shapes.length

  const finalShape = await animatePathStroke(
    fullShape.points,
    fullShape.color,
    fullShape.closed ?? false,
    duration,
    (shape) => {
      if (!shape) return
      if (state.shapes.length <= animIndex) {
        state.shapes.push(shape)
      } else {
        state.shapes[animIndex] = shape
      }
      emit()
    },
  )

  if (state.shapes.length <= animIndex) {
    state.shapes.push(finalShape)
  } else {
    state.shapes[animIndex] = finalShape
  }
  emit()
  return `绘制路径 (${finalShape.id})`
}

async function animateMultiPath(
  state: ExecutorState,
  pathActions: DrawAction[],
  label: string,
  emit: () => void,
): Promise<string> {
  pushUndo(state)
  for (let i = 0; i < pathActions.length; i++) {
    if (i > 0) await sleep(PATH_DELAY_MS)
    await animateDrawPath(state, pathActions[i], emit, true)
  }
  return label
}

async function animateUseTemplate(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
): Promise<string | null> {
  if (!action.templateId) return 'useTemplate 缺少 templateId'
  const pathActions = await loadTemplateActions(
    action.templateId,
    action.x ?? 80,
    action.y ?? 60,
    action.scale ?? 1,
    action.color ?? '#6366f1',
    action.animateMs,
  )
  return animateMultiPath(
    state,
    pathActions,
    `绘制模板 ${action.templateId} (${pathActions.length} 条路径)`,
    emit,
  )
}

async function animateUseIcon(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
): Promise<string | null> {
  if (!action.iconId) return 'useIcon 缺少 iconId'
  const pathActions = await loadIconActions(
    action.iconId,
    action.x ?? 80,
    action.y ?? 60,
    action.scale ?? 1,
    action.color ?? '#6366f1',
    action.animateMs,
  )
  return animateMultiPath(
    state,
    pathActions,
    `绘制图标 ${action.iconId} (${pathActions.length} 条路径)`,
    emit,
  )
}

async function animateGenerateAndTrace(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  generateImage?: GenerateImageFn,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  options?: ExecutorOptions,
): Promise<string | null> {
  const drawMode = options?.drawMode ?? PIPELINE_CONFIG.drawMode
  switch (drawMode) {
    case 'outline_only':
    case 'sketch_then_color':
      return executePipelineV4(state, action, emit, generateImage, onPaintProgress, options)
    case 'stroke_reveal':
      return executeStrokeReveal(state, action, emit, generateImage, onPaintProgress, options)
    case 'region_trace':
      return executeRegionTrace(state, action, emit, generateImage, onPaintProgress, options)
    case 'bitmap_trace':
    default:
      return executeBitmapTrace(state, action, emit, generateImage, onPaintProgress, options)
  }
}

async function loadGeneratedImage(
  action: DrawAction,
  generateImage: GenerateImageFn,
  fineDetail: boolean,
  onReport: (msg: Omit<PaintProgress, 'referenceImage'> & { referenceImage?: string }) => void,
  drawMode?: string,
  wanxStyle?: WanxStyle,
): Promise<{ referenceImage: string; genResult: { imageBase64?: string; imageUrl?: string; mimeType?: string } }> {
  const stopElapsed = startElapsedReporter('composing', '构思中', onReport)
  try {
    const style = wanxStyle ?? detectWanxStyleFromPrompt(action.imagePrompt)
    let genResult = await generateImage(action.imagePrompt!, fineDetail, drawMode)
    let referenceImage = imageResultToDataUrl(genResult)

    if (PIPELINE_CONFIG.traceableRetry && PIPELINE_CONFIG.maxWanxRetries > 0) {
      const gateCanvas = await loadImageForGate(referenceImage)
      const probe = analysisCanvasForGate(gateCanvas)
      const gate = isTraceableImage(probe)
      if (!gate.traceable && gate.score < 40) {
        const retryPrompt = `${action.imagePrompt}${retrySuffixForStyle(style)}`
        onReport({ phase: 'composing', message: '优化参考图 (1/2)…', referenceImage })
        genResult = await generateImage(retryPrompt, fineDetail, drawMode)
        referenceImage = imageResultToDataUrl(genResult)
      }
    }

    return { referenceImage, genResult }
  } finally {
    stopElapsed()
  }
}

async function executePipelineV4(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  generateImage?: GenerateImageFn,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  options?: ExecutorOptions,
): Promise<string | null> {
  if (!action.imagePrompt) return 'generate_and_trace 缺少 imagePrompt'
  const fineDetail = options?.fineDetailMode === true

  if (!generateImage) {
    return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, '图像生成未配置')
  }

  let referenceImage: string | undefined
  const pipelineMode = options?.drawMode ?? 'outline_only'
  const report = (progress: Omit<PaintProgress, 'referenceImage'> & { referenceImage?: string }): void => {
    onPaintProgress?.({
      ...progress,
      referenceImage: progress.referenceImage ?? referenceImage,
      drawMode: pipelineMode,
    })
  }

  const pipelineT0 = performance.now()
  let wanxMs = 0

  try {
    // Step 0: 构思 (reference thumb visible through entire draw)
    report({ phase: 'generating', message: '构思中…' })
    const wanxT0 = performance.now()
    const { referenceImage: ref } = await loadGeneratedImage(
      action, generateImage, fineDetail, (p) => {
        report({
          ...p,
          phase: 'generating',
          message: p.message.replace('构思参考图', '构思中').replace(/….*$/, '…'),
        })
      }, options?.drawMode,
    )
    wanxMs = performance.now() - wanxT0
    referenceImage = ref
    console.log(`[pipeline-v4] wanx=${(wanxMs / 1000).toFixed(1)}s`)

    // Step 1: 轮廓分析
    report({ phase: 'analyzing', message: '轮廓分析中…', referenceImage })

    const gateCanvas = await loadImageForGate(referenceImage)
    await yieldToMain()

    const plan = await analyzeOutlinePlan(gateCanvas, referenceImage, fineDetail)

    if (plan.outlineStrokes.length === 0) {
      return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, '轮廓路径为空')
    }

    pushUndo(state)

    // Step 2: 勾线动画
    report({
      phase: 'sketching',
      message: `勾线中 (0/${plan.outlineStrokes.length})`,
      current: 0,
      total: plan.outlineStrokes.length,
      referenceImage,
    })

    const sketchT0 = performance.now()
    const { sketched } = await drawOutlineOnly(plan, {
      onInitStrokes: (strokeShapes) => {
        state.shapes = strokeShapes
        emit()
      },
      onStrokeUpdate: (idx, shape) => {
        if (shape.fillOnly || shape.type === 'clipImage' || shape.fill) {
          console.error('[pipeline-v4] stroke update rejected fill layer during sketch')
          return
        }
        state.shapes[idx] = shape
        emit()
      },
      onSketchProgress: ({ current, total }) => {
        report({
          phase: 'sketching',
          message: `勾线中 (${current}/${total})`,
          current,
          total,
          referenceImage,
        })
      },
    })
    const sketchMs = performance.now() - sketchT0

    const totalMs = performance.now() - pipelineT0
    console.log(
      `[pipeline-v4] wanx=${(wanxMs / 1000).toFixed(1)}s`
      + ` analyze=${(plan.stats.analyzeMs / 1000).toFixed(2)}s`
      + ` draw=${(sketchMs / 1000).toFixed(1)}s`
      + ` total=${(totalMs / 1000).toFixed(1)}s`
      + ` strokes=${sketched}/${plan.outlineStrokes.length}`,
    )

    report({ phase: 'sketching', message: '绘制完成', current: sketched, total: plan.outlineStrokes.length })
    return `勾线完成：${sketched} 条轮廓`
  } catch (e) {
    const msg = e instanceof Error ? e.message : '勾线失败'
    return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, msg)
  }
}

async function executeStrokeReveal(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  generateImage?: GenerateImageFn,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  options?: ExecutorOptions,
): Promise<string | null> {
  if (!action.imagePrompt) return 'generate_and_trace 缺少 imagePrompt'
  const fineDetail = options?.fineDetailMode === true

  if (!generateImage) {
    return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, '通义万相未配置')
  }

  let referenceImage: string | undefined
  const report = (progress: Omit<PaintProgress, 'referenceImage'> & { referenceImage?: string }): void => {
    onPaintProgress?.({
      ...progress,
      referenceImage: progress.referenceImage ?? referenceImage,
      drawMode: 'stroke_reveal',
    })
  }

  try {
    const { referenceImage: ref, genResult } = await loadGeneratedImage(
      action, generateImage, fineDetail, report, options?.drawMode,
    )
    referenceImage = ref

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.crossOrigin = 'anonymous'
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('无法加载图片'))
      el.src = referenceImage!
    })

    // Ensure browser has decoded image before band animation
    if ('decode' in img) {
      await img.decode().catch(() => undefined)
    }

    const dataUrl = genResult.imageBase64
      ? (genResult.imageBase64.startsWith('data:')
        ? genResult.imageBase64
        : `data:${genResult.mimeType ?? 'image/png'};base64,${genResult.imageBase64}`)
      : referenceImage!

    const bounds = computeImageFitBounds(img.width, img.height, CANVAS_WIDTH, CANVAS_HEIGHT)
    const strokes = generateRevealStrokes(
      bounds,
      PIPELINE_CONFIG.revealStrokeCount,
      img.width,
      img.height,
    )

    report({
      phase: 'revealing',
      message: `图像揭示（0/${strokes.length}）…`,
      current: 0,
      total: strokes.length,
      referenceImage,
    })

    pushUndo(state)
    const baseIndex = state.shapes.length

    const { shapes: finalShapes } = await animateStrokeReveal(
      dataUrl,
      bounds,
      strokes,
      (shapes) => {
        state.shapes.splice(baseIndex, state.shapes.length - baseIndex, ...shapes)
        emit()
      },
      ({ current, total }) => {
        report({
          phase: 'revealing',
          message: `图像揭示（${current}/${total}）… 描摹模式：图像揭示`,
          current,
          total,
          referenceImage,
        })
      },
      fineDetail,
    )

    state.shapes.splice(baseIndex, state.shapes.length - baseIndex, ...finalShapes)
    emit()

    console.log(`[pipeline] stroke_reveal bands=${strokes.length} mode=image-reveal`)
    return `图像揭示完成（${strokes.length} 笔，完整呈现）`
  } catch (e) {
    const msg = e instanceof Error ? e.message : '图像揭示失败'
    return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, msg)
  }
}

async function executeRegionTrace(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  generateImage?: GenerateImageFn,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  options?: ExecutorOptions,
): Promise<string | null> {
  if (!action.imagePrompt) return 'generate_and_trace 缺少 imagePrompt'
  const fineDetail = options?.fineDetailMode === true
  const traceTimeout = TRACE_TIMEOUT_MS_FINE
  const batchDelay = 40

  if (!generateImage) {
    return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, '通义万相未配置')
  }

  let referenceImage: string | undefined
  const report = (progress: Omit<PaintProgress, 'referenceImage'> & { referenceImage?: string }): void => {
    onPaintProgress?.({
      ...progress,
      referenceImage: progress.referenceImage ?? referenceImage,
      drawMode: 'region_trace',
    })
  }

  try {
    const { referenceImage: ref } = await loadGeneratedImage(
      action, generateImage, fineDetail, report, options?.drawMode,
    )
    referenceImage = ref

    report({ phase: 'tracing_prep', message: '色块边界矢量化…', referenceImage })

    const gateCanvas = await loadImageForGate(referenceImage)
    const regionResult = vectorizeByColorRegions(gateCanvas, PIPELINE_CONFIG.regionColors)
    const filtered = regionResult.paths.length

    if (filtered === 0) {
      return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, '色块边界为空')
    }

    const color = action.color ?? '#1f2937'
    const maxSeg = Math.hypot(CANVAS_WIDTH, CANVAS_HEIGHT) * 0.4
    let strokeItems = vectorPathsToStrokeItems(
      regionResult.paths, CANVAS_WIDTH, CANVAS_HEIGHT, maxSeg, WANX_FULL_MIN_LENGTH,
    )

    if (strokeItems.length === 0) {
      return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, '有效路径为空')
    }

    report({ phase: 'tracing_prep', message: '排序…', referenceImage })
    strokeItems = sortStrokeItemsNatural(strokeItems, CANVAS_WIDTH, CANVAS_HEIGHT)

    pushUndo(state)
    const baseIndex = state.shapes.length
    const duration = computeWanxTraceDuration(strokeItems.length, fineDetail)
    const batchSize = computeWanxTraceBatchSize(strokeItems.length)
    const pathTension = fineDetail ? WANX_PATH_TENSION_FINE : WANX_PATH_TENSION

    report({
      phase: 'tracing',
      message: `矢量描摹（0/${strokeItems.length}）… 描摹模式：色块矢量`,
      current: 0,
      total: strokeItems.length,
      referenceImage,
    })

    const animationStart = performance.now()

    for (let i = 0; i < strokeItems.length; i++) {
      const flat = strokeItems[i].flat
      state.shapes.push({
        id: createShapeId(),
        type: 'path',
        color,
        x: 0,
        y: 0,
        points: flat,
        closed: false,
        pathLength: computePathLength(flat),
        dashOffset: computePathLength(flat),
        tension: pathTension,
      })
    }
    emit()

    const animatedCount = await animatePathsBatch(
      strokeItems,
      color,
      duration,
      batchSize,
      (idx, shape) => {
        state.shapes[baseIndex + idx] = shape
        emit()
      },
      (completed, total) => {
        report({
          phase: 'tracing',
          current: completed,
          total,
          message: `矢量描摹（${completed}/${total}）… 描摹模式：色块矢量`,
          referenceImage,
        })
      },
      () => performance.now() - animationStart > traceTimeout,
      batchDelay,
      pathTension,
    )

    console.log(
      `[pipeline] region_trace colors=${regionResult.colorCount}`
      + ` regions=${regionResult.regionCount} paths=${filtered} draw=${animatedCount}`,
    )

    return `色块矢量描摹完成 (${animatedCount}/${strokeItems.length} 条边界，${regionResult.colorCount} 色)`
  } catch (e) {
    const msg = e instanceof Error ? e.message : '色块矢量化失败'
    return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, msg)
  }
}

async function executeBitmapTrace(
  state: ExecutorState,
  action: DrawAction,
  emit: () => void,
  generateImage?: GenerateImageFn,
  onPaintProgress?: (progress: PaintProgress | null) => void,
  options?: ExecutorOptions,
): Promise<string | null> {
  if (!action.imagePrompt) return 'generate_and_trace 缺少 imagePrompt'
  const fineDetail = options?.fineDetailMode === true
  const traceTimeout = TRACE_TIMEOUT_MS_FINE
  const batchDelay = 40

  if (!generateImage) {
    return fallbackTier2DrawPaths(
      state,
      action,
      emit,
      onPaintProgress,
      '通义万相未配置',
    )
  }

  let referenceImage: string | undefined

  const report = (progress: Omit<PaintProgress, 'referenceImage'> & { referenceImage?: string }): void => {
    onPaintProgress?.({
      ...progress,
      referenceImage: progress.referenceImage ?? referenceImage,
      drawMode: 'bitmap_trace',
    })
  }

  try {
    report({ phase: 'composing', message: '构思参考图…' })
    let genResult = await generateImage(action.imagePrompt, fineDetail)

    referenceImage = genResult.imageBase64
      ? (genResult.imageBase64.startsWith('data:')
        ? genResult.imageBase64
        : `data:${genResult.mimeType ?? 'image/png'};base64,${genResult.imageBase64}`)
      : genResult.imageUrl

    report({ phase: 'tracing_prep', message: '位图矢量化…', referenceImage })

    let traceable = true
    let traceableReason = '适合描摹'
    if (PIPELINE_CONFIG.traceableRetry) {
      const gateCanvas = await loadImageForGate(referenceImage!)
      const gate = isTraceableImage(gateCanvas)
      traceable = gate.traceable
      traceableReason = gate.reason

      if (!gate.traceable && generateImage) {
        const retryPrompt = `${action.imagePrompt}${LINE_ART_RETRY_SUFFIX}`
        report({ phase: 'composing', message: '优化参考图 (1/2)…', referenceImage })
        genResult = await generateImage(retryPrompt, fineDetail)

        referenceImage = imageResultToDataUrl(genResult)
        const retryGate = isTraceableImage(await loadImageForGate(referenceImage))
        traceable = retryGate.traceable
        traceableReason = retryGate.reason
        report({ phase: 'tracing_prep', message: '位图矢量化…', referenceImage })
      }
    }

    const vectorResult = await vectorizeWanxResult(genResult, fineDetail, action.imagePrompt)

    const stages = vectorResult.stageCounts
    const vectorized = stages?.raw ?? vectorResult.rawPathCount
    const filtered = stages?.final ?? vectorResult.filteredPathCount

    if (filtered === 0) {
      return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, '矢量化路径为空')
    }

    const color = action.color ?? '#1f2937'
    const maxSeg = Math.hypot(CANVAS_WIDTH, CANVAS_HEIGHT) * 0.4
    let strokeItems = vectorPathsToStrokeItems(
      vectorResult.paths, CANVAS_WIDTH, CANVAS_HEIGHT, maxSeg, WANX_FULL_MIN_LENGTH,
    )

    if (strokeItems.length === 0) {
      return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, '有效路径为空')
    }

    report({ phase: 'tracing_prep', message: '排序…', referenceImage })
    strokeItems = sortStrokeItemsNatural(
      strokeItems, CANVAS_WIDTH, CANVAS_HEIGHT,
    )

    pushUndo(state)
    const baseIndex = state.shapes.length
    const duration = computeWanxTraceDuration(strokeItems.length, fineDetail)
    const batchSize = computeWanxTraceBatchSize(strokeItems.length)
    const pathTension = fineDetail ? WANX_PATH_TENSION_FINE : WANX_PATH_TENSION

    report({
      phase: 'tracing',
      message: `位图描摹（0/${strokeItems.length}）… 描摹模式：位图矢量（实验）`,
      current: 0,
      total: strokeItems.length,
      referenceImage,
    })

    const animationStart = performance.now()

    for (let i = 0; i < strokeItems.length; i++) {
      const flat = strokeItems[i].flat
      state.shapes.push({
        id: createShapeId(),
        type: 'path',
        color,
        x: 0,
        y: 0,
        points: flat,
        closed: false,
        pathLength: computePathLength(flat),
        dashOffset: computePathLength(flat),
        tension: pathTension,
      })
    }
    emit()

    const progressMessage = (completed: number, total: number): string =>
      `位图描摹（${completed}/${total}）… 描摹模式：位图矢量（实验）`

    let fastForwarded = false
    const onFastForward = (): void => {
      if (fastForwarded) return
      fastForwarded = true
      report({
        phase: 'tracing',
        message: '加速完成剩余笔画…',
        referenceImage,
      })
    }

    const animatedCount = await animatePathsBatch(
      strokeItems,
      color,
      duration,
      batchSize,
      (idx, shape) => {
        state.shapes[baseIndex + idx] = shape
        emit()
      },
      (completed, total) => {
        report({
          phase: 'tracing',
          current: completed,
          total,
          message: progressMessage(completed, total),
          referenceImage,
        })
      },
      () => performance.now() - animationStart > traceTimeout,
      batchDelay,
      pathTension,
      onFastForward,
    )

    console.log(
      `[pipeline] bitmap_trace raw=${vectorized}`
      + (stages
        ? ` dedup=${stages.dedup} minLen=${stages.minLen} continuity=${stages.continuity} final=${stages.final}`
        : ` final=${filtered}`)
      + ` → draw ${animatedCount}/${strokeItems.length} traceable=${traceable}`
      + ` (${traceableReason})`
      + `${vectorResult.usedEdgeFallback ? ' edge-fallback' : ''}`,
    )

    const fastForwardNote = fastForwarded ? '，超时后已加速完成' : ''
    return `位图描摹完成 (${animatedCount}/${strokeItems.length} 条路径，原始 ${vectorized})${fastForwardNote}`
  } catch (e) {
    const msg = e instanceof Error ? e.message : '参考图描摹失败'
    return fallbackTier2DrawPaths(state, action, emit, onPaintProgress, msg)
  }
}

// Re-export for legacy animateValue usage in tests
export { animateValue, computePathLength }
