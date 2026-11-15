import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { Serialized } from '@langchain/core/load/serializable'
import type { ChainValues } from '@langchain/core/utils/types'
import type { DocumentInterface } from '@langchain/core/documents'
import type { LearningMonitor } from './bus.ts'

// LangGraph/LangChain internals that would only add noise to the monitor.
const HIDDEN = /^(?:RunnableSequence|RunnableLambda|ChannelWrite.*|ChannelRead.*|__start__|__end__|Branch<.*>|RunnableCallable)$/

/**
 * A LangChain callback handler that forwards real run events to the learning
 * monitor. Attached to LangGraph graphs and LangChain pipelines through the
 * standard `callbacks` option, so what the monitor shows is what the
 * framework actually executed: every graph node, pipeline step and retriever
 * call, with timings and parent/child links.
 */
export class MonitorCallbackHandler extends BaseCallbackHandler {
  name = 'triage-learning-monitor'
  private readonly monitor: LearningMonitor
  private readonly starts = new Map<string, { at: number; name: string; visible: boolean; query?: string }>()

  constructor(monitor: LearningMonitor) {
    super()
    this.monitor = monitor
  }

  override async handleChainStart(chain: Serialized, _inputs: ChainValues, runId: string, _runType?: string, tags?: string[],
    metadata?: Record<string, unknown>, runName?: string, parentRunId?: string): Promise<void> {
    const name = runName ?? String(chain?.id?.at(-1) ?? 'step')
    const node = typeof metadata?.langgraph_node === 'string' ? metadata.langgraph_node : undefined
    const graphStep = Boolean(node) && node === name
    const pipelineStep = Boolean(tags?.includes('triage-step'))
    const topLevel = !parentRunId
    // LangGraph wraps a node's function in a run of the same name; show the node once.
    const parent = parentRunId ? this.starts.get(parentRunId) : undefined
    const repeat = Boolean(parent?.visible && parent.name === name)
    const visible = !HIDDEN.test(name) && !repeat && (graphStep || pipelineStep || topLevel)
    this.starts.set(runId, { at: Date.now(), name, visible })
    if (!visible) return
    this.monitor.emit({
      type: 'run', phase: 'start', runId, ...(parentRunId ? { parentId: parentRunId } : {}), name,
      system: node || tags?.includes('langgraph') ? 'langgraph' : 'langchain',
      ...(node ? { node } : {}), ...(typeof metadata?.graph === 'string' ? { graph: metadata.graph } : {})
    })
  }

  override async handleChainEnd(_outputs: ChainValues, runId: string): Promise<void> { this.finish(runId, 'end') }

  override async handleChainError(err: Error, runId: string): Promise<void> {
    // LangGraph signals a pause (interrupt) as an error; that is not a failure.
    if (err?.name === 'GraphInterrupt' || /interrupt/i.test(err?.name ?? '')) { this.finish(runId, 'end'); return }
    this.finish(runId, 'error', err?.message)
  }

  override async handleRetrieverStart(_retriever: Serialized, query: string, runId: string): Promise<void> {
    this.starts.set(runId, { at: Date.now(), name: 'retriever', visible: false, query })
  }

  override async handleRetrieverEnd(documents: DocumentInterface[], runId: string): Promise<void> {
    const start = this.starts.get(runId)
    this.starts.delete(runId)
    this.monitor.emit({
      type: 'retrieval', runId, query: start?.query ?? '', durationMs: start ? Date.now() - start.at : 0,
      hits: documents.map((doc) => ({
        text: doc.pageContent, kind: String(doc.metadata?.kind ?? 'memory'),
        ...(typeof doc.metadata?.score === 'number' ? { score: doc.metadata.score } : {})
      }))
    })
  }

  private finish(runId: string, phase: 'end' | 'error', error?: string): void {
    const start = this.starts.get(runId)
    this.starts.delete(runId)
    if (!start?.visible) return
    this.monitor.emit({ type: 'run', phase, runId, name: start.name, system: 'langchain', durationMs: Date.now() - start.at, ...(error ? { error } : {}) })
  }
}
