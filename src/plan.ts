/**
 * The plan a `refine_plan` call carries.
 *
 * A plan is a set of nodes that run together. There is one layer: every node
 * starts at the same time, and every result comes back together. A node is
 * one of four kinds:
 *
 * - `tools` — calls whose arguments are already decided;
 * - `worker` — a child that starts with this conversation and does the work
 *   itself, in its own loop, without drawing a plan of its own;
 * - `spawner` — a child that starts empty and plans through this plugin's loop;
 * - `forker` — a child that starts with this conversation and plans through
 *   this plugin's loop.
 *
 * There is no `after` and no layering: a node that needs another node's
 * output belongs to the next round, where the main agent sees the results and
 * decides what is still missing. Work that belongs together belongs in one
 * node — in a worker, which can take its own steps as it goes.
 *
 * @module @zyn19940107/dsh-refine-loop/plan
 */

/** The kinds of node a plan may hold. */
export type PlanNodeKind = 'tools' | 'worker' | 'spawner' | 'forker'

/** The node kinds that start an agent. */
export const AGENT_NODE_KINDS: readonly PlanNodeKind[] = ['worker', 'spawner', 'forker']

/**
 * The node kinds that start a child which does not plan.
 *
 * A worker is a child that thinks and acts, and never draws a graph of its
 * own: the work it was given is the whole of its job.
 */
export const WORKER_NODE_KINDS: readonly PlanNodeKind[] = ['worker']

/**
 * The harness tool each agent node runs through.
 *
 * The node kinds are named for what the child does, not for the tool that
 * starts it: a plan node is not a tool call, and two of the three child kinds
 * share one tool. A `worker` starts with this conversation and works; a
 * `spawner` starts empty and plans; a `forker` starts with this conversation
 * and plans.
 */
export const NODE_AGENT_TOOL: Readonly<Record<'worker' | 'spawner' | 'forker', string>> = {
  worker: 'subagent_fork',
  spawner: 'subagent',
  forker: 'subagent_fork',
}

/**
 * How the calls of a tools node run.
 *
 * `parallel` is the default and lets the calls that are safe together run
 * together. `sequential` runs them in the order they are written, which is how
 * a node says "write the file, then run the test" — an order of business that
 * the tool's own safety rules cannot express.
 */
export type PlanNodeOrder = 'parallel' | 'sequential'

/** One call inside a tools node. */
export interface PlanToolCall {
  /** The tool to call. */
  name: string
  /** The arguments to call it with. */
  arguments: unknown
}

/** One node of a plan. */
export interface PlanNode {
  /** The node's name. */
  id: string
  /** What kind of work the node is. */
  kind: PlanNodeKind
  /** The calls of a tools node. */
  calls: PlanToolCall[]
  /** The task of an agent node. */
  task: string
  /** How the calls of a tools node run. */
  order: PlanNodeOrder
  /** The files a node writes, so two nodes that write the same one do not run together. */
  writes: string[]
  /**
   * How long the model expected this node to take, in milliseconds.
   *
   * Zero means it declared none. When it is set and spent, the node's child is
   * stopped and asked to look at where it got to and decide whether to finish or
   * report its state — it is not killed without a word. The runner's ceiling
   * still bounds the node.
   */
  budgetMs: number
}

/** The largest budget a node may declare, so one typo cannot park a child for a day. */
export const MAX_NODE_BUDGET_MS = 3_600_000

/** The plan a call carries. */
export interface PlanArgs {
  /** The observable criteria that decide whether the plan succeeded. */
  criteria: string[]
  /** The nodes of the plan. */
  nodes: PlanNode[]
}

/**
 * The marker that opens a worker's task.
 *
 * The doctrine that tells a conversation to draw a plan is a message at the
 * head of every turn. A worker is told not to draw one, and the plugin has to
 * recognise the worker's own conversation to keep the doctrine away from it.
 * The delegation prompt is the first thing the worker reads, so the marker in
 * it is what the plugin looks for.
 */
export const WORKER_MARKER = '[refine-loop worker]'

/**
 * Read the plan out of a tool call.
 *
 * A call that carries no plan is refused: a plan without criteria, without
 * nodes, or with a node that says neither what to call nor what to ask is not
 * a plan the plugin can run.
 *
 * @param value - the parsed arguments.
 * @returns the plan, or undefined when the call does not carry one.
 */
export function parsePlanArgs(value: unknown): PlanArgs | undefined {
  const record = (value ?? {}) as Record<string, unknown>
  const criteria = record.criteria
  const nodes = record.nodes
  if (!Array.isArray(criteria) || !Array.isArray(nodes)) return undefined
  const parsedCriteria = criteria
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => entry.trim())
  if (parsedCriteria.length === 0) return undefined

  const parsedNodes: PlanNode[] = []
  const seen = new Set<string>()
  for (const entry of nodes) {
    if (entry === null || typeof entry !== 'object') return undefined
    const item = entry as Record<string, unknown>
    const id = item.id
    const kind = item.kind
    if (typeof id !== 'string' || id.trim() === '') return undefined
    if (typeof kind !== 'string') return undefined
    if (kind !== 'tools' && kind !== 'worker' && kind !== 'spawner' && kind !== 'forker') {
      return undefined
    }
    const nodeId = id.trim()
    if (seen.has(nodeId)) return undefined
    seen.add(nodeId)

    const rawBudget = item.budgetMs
    const budgetMs = typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0
      ? Math.min(Math.round(rawBudget), MAX_NODE_BUDGET_MS)
      : 0
    const order: PlanNodeOrder = item.order === 'sequential' ? 'sequential' : 'parallel'
    const writes = Array.isArray(item.writes)
      ? item.writes
        .filter((path): path is string => typeof path === 'string' && path.trim() !== '')
        .map(path => path.trim())
      : []

    if (kind === 'tools') {
      const calls = item.calls
      if (!Array.isArray(calls) || calls.length === 0) return undefined
      const parsedCalls: PlanToolCall[] = []
      for (const call of calls) {
        if (call === null || typeof call !== 'object') return undefined
        const callItem = call as Record<string, unknown>
        const name = callItem.name
        if (typeof name !== 'string' || name.trim() === '') return undefined
        const args = callItem.arguments
        parsedCalls.push({ name: name.trim(), arguments: args === undefined ? {} : args })
      }
      parsedNodes.push({ id: nodeId, kind, calls: parsedCalls, task: '', order, writes, budgetMs })
      continue
    }

    const task = item.task
    if (typeof task !== 'string' || task.trim() === '') return undefined
    parsedNodes.push({ id: nodeId, kind, calls: [], task: task.trim(), order, writes, budgetMs })
  }
  // An empty plan is allowed and the model decides when it is right: a turn that
  // already has what it needs hands over nothing to run and goes to the
  // conclusion. The loop does not prescribe how much a plan must contain.

  return { criteria: parsedCriteria, nodes: parsedNodes }
}

/**
 * The groups of nodes that may run at the same time.
 *
 * Two nodes that write the same file do not run together: the file is written
 * twice and the second write lands on the first one's result. A node that
 * declares no writes is taken at its word — the plan cannot know what a call
 * does to the disk — and the ones that do declare are separated.
 *
 * The groups are in the order the plan declared them, and the nodes inside a
 * group keep their order too, so a plan that runs entirely in series runs in
 * the order it was written.
 *
 * @param nodes - the nodes of the plan.
 * @returns the groups.
 */
export function buildGroups(nodes: readonly PlanNode[]): PlanNode[][] {
  const groups: PlanNode[][] = []
  for (const node of nodes) {
    const group = groups.find(candidate => canRunTogether(candidate, node))
    if (group === undefined) groups.push([node])
    else group.push(node)
  }
  return groups
}

/**
 * Whether a node may join a group of nodes.
 *
 * @param group - the nodes already in the group.
 * @param node - the node that wants to join.
 * @returns true when the two do not write the same file.
 */
function canRunTogether(group: readonly PlanNode[], node: PlanNode): boolean {
  if (node.writes.length === 0) return true
  for (const other of group) {
    for (const path of other.writes) {
      if (node.writes.includes(path)) return false
    }
  }
  return true
}
