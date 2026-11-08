/**
 * Nodes that ran out of budget but are not done.
 *
 * A node's budget is not a verdict on its work: a worker 227 seconds into a
 * benchmark, a solver halfway through a search. The 2.7.0 answer was to stop the
 * node and have it report — but the report ended the node, so the next round had
 * to redo whatever was unfinished.
 *
 * Here the node reports and **stays alive**. Its conversation, its files and its
 * background jobs all keep running, it is simply idle. The report goes back with
 * the round, and the parent decides what happens to it: reusing the same node id
 * in the next plan continues it with a new budget, and leaving the id out ends it.
 * The turn is the outer bound — whatever is still parked when the turn closes is
 * released with it.
 */

/** What one parked node can do when the parent asks for it again. */
export interface ParkedNode {
  /** The plan node id it was parked under. */
  readonly nodeId: string
  /** The child's session id; the same one continues. */
  readonly sessionId: string
  /** What the node reported when its budget ran out. */
  readonly report: string
  /**
   * Continue the same conversation with a fresh budget.
   *
   * @param prompt - what this round asks it to do.
   * @param budgetMs - the new budget, or nothing to use the node ceiling.
   * @param timeoutMs - the ceiling behind the budget.
   * @param signal - the new round's cancellation.
   * @returns what it produced, and whether it ran out again.
   */
  continue(
    prompt: string,
    budgetMs: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ output: string, parked: boolean, error?: string }>
  /** End the node and release the child behind it. */
  dispose(): Promise<void>
}

/**
 * The parked nodes of every conversation, by the round that parked them.
 *
 * Kept per root session so one conversation's parked work can never be continued
 * by another's plan, and so the turn's end releases exactly its own.
 */
export class Parked {
  private readonly byRoot = new Map<string, Map<string, ParkedNode>>()

  /**
   * Record one node as parked under the conversation that parked it.
   *
   * @param rootSessionId - the conversation whose round ran it.
   * @param node - the parked node.
   */
  park(rootSessionId: string, node: ParkedNode): void {
    const nodes = this.byRoot.get(rootSessionId) ?? new Map<string, ParkedNode>()
    nodes.set(node.nodeId, node)
    this.byRoot.set(rootSessionId, nodes)
  }

  /**
   * Continue a parked node, or nothing when this conversation has none under that id.
   *
   * The node leaves the registry for the duration of the call: if it runs out of
   * budget again the continuation re-parks it under the same id.
   *
   * @param rootSessionId - the conversation whose round is running.
   * @param nodeId - the id the plan used for it.
   * @param prompt - what this round asks it to do.
   * @param budgetMs - the new budget.
   * @param timeoutMs - the node ceiling.
   * @param signal - the new round's cancellation.
   * @returns its result, or nothing when it was not parked.
   */
  async resume(
    rootSessionId: string,
    nodeId: string,
    prompt: string,
    budgetMs: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ output: string, parked: boolean, error?: string } | undefined> {
    const nodes = this.byRoot.get(rootSessionId)
    const node = nodes?.get(nodeId)
    if (node === undefined || nodes === undefined) return undefined
    nodes.delete(nodeId)
    if (nodes.size === 0) this.byRoot.delete(rootSessionId)

    const outcome = await node.continue(prompt, budgetMs, timeoutMs, signal)
    if (outcome.parked) {
      // Ran out again: it stays alive for the round after this one.
      this.park(rootSessionId, node)
    } else {
      // Finished inside the new budget: it ends like any node that did its work.
      try {
        await node.dispose()
      } catch {
        // The child is already gone.
      }
    }
    return outcome
  }

  /**
   * End every parked node whose id this round did not ask for.
   *
   * The parent's decision is the plan: a node it leaves out is a node it does not
   * want continued, so the parked child and its work are released here rather
   * than lingering until the turn ends.
   *
   * @param rootSessionId - the conversation whose new plan arrived.
   * @param keep - the node ids the new plan asks for.
   * @returns the ids that were ended.
   */
  async retain(rootSessionId: string, keep: Set<string>): Promise<string[]> {
    const nodes = this.byRoot.get(rootSessionId)
    if (nodes === undefined) return []
    const ended: string[] = []
    for (const [id, node] of nodes) {
      if (keep.has(id)) continue
      nodes.delete(id)
      ended.push(id)
      try {
        await node.dispose()
      } catch {
        // The child is already gone.
      }
    }
    if (nodes.size === 0) this.byRoot.delete(rootSessionId)
    return ended
  }

  /**
   * The parked nodes of one conversation, in parking order.
   *
   * @param rootSessionId - the conversation to look at.
   * @returns how many are parked and the ids.
   */
  list(rootSessionId: string): string[] {
    return [...(this.byRoot.get(rootSessionId)?.keys() ?? [])]
  }

  /**
   * End everything parked under one conversation.
   *
   * @param rootSessionId - the conversation whose turn is closing.
   * @returns the ids that were ended.
   */
  async disposeAll(rootSessionId: string): Promise<string[]> {
    return await this.retain(rootSessionId, new Set<string>())
  }
}