import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Point, Rectangle } from 'electron'

export function clampPosition(point: Point, area: Rectangle, size: { width: number; height: number }): Point {
  return {
    x: Math.round(Math.max(area.x, Math.min(point.x, area.x + Math.max(0, area.width - size.width)))),
    y: Math.round(Math.max(area.y, Math.min(point.y, area.y + Math.max(0, area.height - size.height))))
  }
}

export function readPosition(file: string): Point | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (
      typeof value === 'object' && value !== null &&
      'x' in value && 'y' in value &&
      typeof value.x === 'number' && Number.isFinite(value.x) &&
      typeof value.y === 'number' && Number.isFinite(value.y)
    ) return { x: value.x, y: value.y }
  } catch {
    // A missing or invalid preference must not prevent the companion from opening.
  }
  return undefined
}

export function writePosition(file: string, point: Point): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file + '.tmp', JSON.stringify(point), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  } catch {
    console.warn('Triage could not save its window position; the app can continue.')
  }
}
