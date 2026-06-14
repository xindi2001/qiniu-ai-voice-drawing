import type { CanvasShape, DrawAction } from '../types/commands'

let shapeCounter = 0

export function createShapeId(): string {
  shapeCounter += 1
  return `shape-${Date.now()}-${shapeCounter}`
}

export function actionToShape(action: DrawAction): CanvasShape | null {
  if (action.action !== 'draw' || !action.shape) {
    return null
  }

  const id = createShapeId()
  const color = action.color ?? '#6366f1'

  switch (action.shape) {
    case 'circle':
      return {
        id,
        type: 'circle',
        color,
        x: action.x ?? 300,
        y: action.y ?? 200,
        radius: action.radius ?? 50,
      }
    case 'rect':
      return {
        id,
        type: 'rect',
        color,
        x: action.x ?? 250,
        y: action.y ?? 150,
        width: action.width ?? 120,
        height: action.height ?? 80,
      }
    case 'line':
      return {
        id,
        type: 'line',
        color,
        x: action.x1 ?? 100,
        y: action.y1 ?? 100,
        x2: action.x2 ?? 400,
        y2: action.y2 ?? 300,
      }
    default:
      return null
  }
}

export function pathActionToShape(action: DrawAction): CanvasShape | null {
  if (action.action !== 'drawPath' || !action.points || action.points.length < 2) {
    return null
  }

  const flat = action.points.flat()

  return {
    id: createShapeId(),
    type: 'path',
    color: action.color ?? '#6366f1',
    x: 0,
    y: 0,
    points: flat,
    closed: action.closed ?? false,
  }
}
