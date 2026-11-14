export interface ShakeSettings { enabled: boolean; instruction: string; mode?: 'explain' | 'highlight' | 'simplify'; warning?: string }
export interface ShakeTrigger { point: { x: number; y: number }; displayId: string; triggeredAt: number }
export const DEFAULT_SHAKE_INSTRUCTION = 'Explain what is happening near my cursor, using the surrounding screen as context.'
