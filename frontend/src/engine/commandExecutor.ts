import type { CanvasShape, DrawAction } from '../types/commands'
import { actionToShape } from './shapeFactory'

export interface ExecutorState {
  shapes: CanvasShape[]
  undoStack: CanvasShape[][]
  redoStack: CanvasShape[][]
}

export function createInitialState(): ExecutorState {
  return {
    shapes: [],
    undoStack: [],
    redoStack: [],
  }
}

function snapshot(state: ExecutorState): CanvasShape[] {
  return state.shapes.map((s) => ({ ...s }))
}

function pushUndo(state: ExecutorState): void {
  state.undoStack.push(snapshot(state))
  state.redoStack = []
}

export function executeActions(
  state: ExecutorState,
  actions: DrawAction[],
): { state: ExecutorState; messages: string[] } {
  const messages: string[] = []
  const next = {
    shapes: [...state.shapes],
    undoStack: [...state.undoStack],
    redoStack: [...state.redoStack],
  }

  for (const action of actions) {
    const result = executeSingle(next, action)
    if (result) {
      messages.push(result)
    }
  }

  return { state: next, messages }
}

function executeSingle(state: ExecutorState, action: DrawAction): string | null {
  switch (action.action) {
    case 'draw': {
      const shape = actionToShape(action)
      if (!shape) return null
      pushUndo(state)
      state.shapes.push(shape)
      return `绘制 ${shape.type} (${shape.id})`
    }
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
      return `未知操作: ${action.action}`
  }
}
