import { GUIDE_IDLE_MS, GUIDE_MAX_STEPS, type GuideState } from '../../shared/guide-contracts.ts'
import type { GuideProgress } from '../../shared/highlight-contracts.ts'

/**
 * One guided-help run: the goal, the steps already shown and which request
 * produced the step on screen now. Pure state; the coordinator takes the
 * screenshots and asks the model.
 */
export class GuideSession {
  readonly conversationId: string
  readonly goal: string
  readonly spoken: boolean
  private steps: string[] = []
  private taskId: string | null = null
  private touchedAt: number
  private now: () => number

  constructor(options: { conversationId: string; goal: string; spoken: boolean; now?: () => number }) {
    this.conversationId = options.conversationId
    this.goal = options.goal
    this.spoken = options.spoken
    this.now = options.now ?? Date.now
    this.touchedAt = this.now()
  }

  /** What the model is told: the goal and the instructions already given, oldest first. */
  progress(): GuideProgress { return { goal: this.goal, done: [...this.steps] } }

  /** Records the step now on screen and the request that produced it. */
  shown(taskId: string, instruction: string): number {
    this.steps.push(instruction)
    this.taskId = taskId
    this.touchedAt = this.now()
    return this.steps.length
  }

  /** "Show me again": forget the step on screen so the next look gives the same step, freshly placed. */
  again(): void {
    if (this.steps.length) this.steps.pop()
    this.touchedAt = this.now()
  }

  /** A step that could not be shown still counts as activity, and its request becomes the current one. */
  attempted(taskId: string): void {
    this.taskId = taskId
    this.touchedAt = this.now()
  }

  /** True when a click on `taskId`'s outline belongs to the step on screen now, not an earlier one. */
  current(taskId: string): boolean { return this.taskId !== null && this.taskId === taskId }

  get stepCount(): number { return this.steps.length }
  /** No more steps are offered after the limit; a task that long needs a person's help. */
  get exhausted(): boolean { return this.steps.length >= GUIDE_MAX_STEPS }
  get expired(): boolean { return this.now() - this.touchedAt > GUIDE_IDLE_MS }

  snapshot(): GuideState {
    return { conversationId: this.conversationId, goal: this.goal, step: this.steps.length, taskId: this.taskId, spoken: this.spoken }
  }
}
