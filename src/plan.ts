/**
 * The plan a `refine_plan` call carries.
 *
 * A plan is a small graph. Each node is one piece of work, and each node says
 * what it depends on. The nodes that depend on nothing run together; the
 * nodes that depend on those run after them.
 *
 * The graph is what makes the plan a plan rather than a list: the agent draws
 * the whole shape of the work before it starts, so the shape is one thing it
 * decided rather than a thing it re-decided at every step.
 *
 * @module @zyn19940107/dsh-refine-loop/plan
 */

/** The kinds of node a plan may hold. */
export type PlanNodeKind = 'tools' | 'subagent'

/** The node kinds that start an agent. */
export const AGENT_NODE_KINDS: readonly PlanNodeKind[] = ['subagent']

/** One call inside a tools node. */
export interface PlanToolCall {
  /** The tool to call. */
  name: string
  /** The arguments to call it with. */
  arguments: unknown
}

/** One node of a plan. */
export interface PlanNode {
  /** The node's name; other nodes refer to it in `after`. */
  id: string
  /** What kind of work the node is. */
  kind: PlanNodeKind
  /** The calls of a tools node. */
  calls: PlanToolCall[]
  /** The task of an agent node. */
  task: string
  /** The nodes this one depends on. */
  after: string[]
}

/** The plan a call carries. */
export interface PlanArgs {
  /**
   * Whether the plan asks to be continued.
   *
   * With `more`, the nodes are only the first slice of the work: when they have
   * run, the plugin shows the results to the model and asks what the next slice
   * is, the same way a failed call is repaired. That is how a serial chain that
   * needs a result to write the next call stays inside one plan.
   */
  more: boolean
  /** The observable criteria that decide whether the plan succeeded. */
  criteria: string[]
  /** The nodes of the plan. */
  nodes: PlanNode[]
}

/**
 * The layers of a plan, or the reason there are none.
 *
 * The reason is a sentence the agent can act on, not a boolean: a plan that
 * does not hold together has to say which node broke it.
 */
export type PlanWaves =
  | { waves: PlanNode[][] }
  | { error: string }

/**
 * An argument that stands for a node's output.
 *
 * The whole argument has to be the placeholder. A placeholder inside a longer
 * string is left alone, because the output of a node can be long and a long
 * output spliced into an argument is worse than a caller that passes it whole.
 *
 * The harness reserves double braces for its own prompt variables and refuses
 * to render a section that contains one, so the placeholder here does not use
 * them: `@@nodeId@@` is this plugin's, and nothing else in the prompt can be
 * mistaken for it.
 */
const PLACEHOLDER = /^@@([^@]+)@@$/u

/**
 * A placeholder anywhere inside a string.
 *
 * The anchored form above replaces a whole argument; this one lets a plan paste
 * a result into a sentence — which is how a child gets the facts it needs
 * instead of being told to go and find them again.
 */
const INLINE_PLACEHOLDER = /@@([^@\n]+)@@/gu

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

  const more = record.more === true
  const parsedNodes: PlanNode[] = []
  const seen = new Set<string>()
  for (const entry of nodes) {
    if (entry === null || typeof entry !== 'object') return undefined
    const item = entry as Record<string, unknown>
    const id = item.id
    const kind = item.kind
    if (typeof id !== 'string' || id.trim() === '') return undefined
    if (typeof kind !== 'string') return undefined
    if (kind !== 'tools' && kind !== 'subagent') return undefined
    const nodeId = id.trim()
    if (seen.has(nodeId)) return undefined
    seen.add(nodeId)

    const after = Array.isArray(item.after)
      ? item.after
        .filter((dep): dep is string => typeof dep === 'string' && dep.trim() !== '')
        .map(dep => dep.trim())
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
      parsedNodes.push({ id: nodeId, kind, calls: parsedCalls, task: '', after })
      continue
    }

    const task = item.task
    if (typeof task !== 'string' || task.trim() === '') return undefined
    parsedNodes.push({ id: nodeId, kind, calls: [], task: task.trim(), after })
  }
  if (parsedNodes.length === 0) return undefined

  // A placeholder in a call's arguments is a dependency. The call cannot run
  // before the node it names has produced its output, so the edge is there
  // whether the plan said so or not — otherwise the placeholder would be
  // resolved against a node that has not run yet, and the tool would receive
  // the literal text instead of the output.
  for (const node of parsedNodes) {
    for (const call of node.calls) {
      for (const referenced of collectPlaceholders(call.arguments)) {
        if (!node.after.includes(referenced)) node.after.push(referenced)
      }
    }
  }

  return { criteria: parsedCriteria, nodes: parsedNodes, more }
}

/**
 * What the model answered when it was asked for the next slice.
 */
export type NextSlice =
  | { done: true }
  | { done: false, plan: PlanArgs }

/**
 * Read the answer to "what is the next slice".
 *
 * The model either repeats the plan shape with the next nodes, or says it is
 * done. Anything else is read as done, so a bad answer can only stop the loop —
 * never make the plan worse.
 *
 * @param text - what the model said.
 * @param criteria - the criteria the slice was asked under.
 * @returns the answer.
 */
export function parseNextSlice(text: string, criteria: readonly string[]): NextSlice {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { done: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { done: true }
  }
  if (parsed === null || typeof parsed !== 'object') return { done: true }
  const record = parsed as Record<string, unknown>
  if (record.done === true) return { done: true }
  const plan = parsePlanArgs({ criteria: [...criteria], nodes: record.nodes, more: record.more === true })
  if (plan === undefined) return { done: true }
  return { done: false, plan }
}

/**
 * The nodes a value refers to through placeholders.
 *
 * @param value - the value to look in.
 * @returns the names of the nodes it refers to.
 */
export function collectPlaceholders(value: unknown): string[] {
  const found: string[] = []
  const walk = (entry: unknown): void => {
    if (typeof entry === 'string') {
      for (const match of entry.matchAll(INLINE_PLACEHOLDER)) {
        const id = match[1]!
        if (!found.includes(id)) found.push(id)
      }
      return
    }
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item)
      return
    }
    if (entry !== null && typeof entry === 'object') {
      for (const item of Object.values(entry as Record<string, unknown>)) walk(item)
    }
  }
  walk(value)
  return found
}

/**
 * Split the plan into the layers that run one after the other.
 *
 * A node that depends on nothing is in the first layer. A node that depends
 * on a node in the first layer is in the second, and so on. The layers are
 * the plan's waves: every node of a wave runs at the same time.
 *
 * @param nodes - the nodes of the plan.
 * @returns the waves, or the reason there are none.
 */
export function buildWaves(nodes: readonly PlanNode[]): PlanWaves {
  const byId = new Map<string, PlanNode>()
  for (const node of nodes) {
    if (byId.has(node.id)) return { error: `two nodes are called "${node.id}"` }
    byId.set(node.id, node)
  }
  for (const node of nodes) {
    for (const dependency of node.after) {
      if (dependency === node.id) return { error: `the node "${node.id}" depends on itself` }
      if (!byId.has(dependency)) {
        return { error: `the node "${node.id}" depends on "${dependency}", which is not a node of this plan` }
      }
    }
  }

  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  /**
   * The layer of one node: one more than the deepest layer it depends on.
   *
   * @param node - the node.
   * @returns the layer, or undefined when the dependencies form a cycle.
   */
  const depthOf = (node: PlanNode): number | undefined => {
    const known = depth.get(node.id)
    if (known !== undefined) return known
    if (visiting.has(node.id)) return undefined
    visiting.add(node.id)
    let layer = 0
    for (const dependency of node.after) {
      const dependencyNode = byId.get(dependency)
      if (dependencyNode === undefined) return undefined
      const dependencyDepth = depthOf(dependencyNode)
      if (dependencyDepth === undefined) return undefined
      layer = Math.max(layer, dependencyDepth + 1)
    }
    visiting.delete(node.id)
    depth.set(node.id, layer)
    return layer
  }
  for (const node of nodes) {
    if (depthOf(node) === undefined) {
      return { error: 'the dependencies of the plan form a cycle, so no node can run first' }
    }
  }

  const layers = Math.max(...nodes.map(node => depth.get(node.id) ?? 0)) + 1
  const waves: PlanNode[][] = Array.from({ length: layers }, () => [])
  for (const node of nodes) {
    waves[depth.get(node.id) ?? 0]!.push(node)
  }
  return { waves }
}

/**
 * Put a node's dependencies in front of it.
 *
 * @param node - the node.
 * @param byId - every node of the plan.
 * @returns the nodes it depends on, in the order they were declared.
 */
export function dependenciesOf(
  node: PlanNode,
  byId: ReadonlyMap<string, PlanNode>,
): PlanNode[] {
  const dependencies: PlanNode[] = []
  for (const id of node.after) {
    const dependency = byId.get(id)
    if (dependency !== undefined) dependencies.push(dependency)
  }
  return dependencies
}

/**
 * Replace a placeholder with what it stands for.
 *
 * A placeholder that cannot be resolved is an error, not a literal. A tool
 * that receives the text `{{nodeId}}` instead of an output fails in a way
 * that points at the wrong thing, so the plan says so instead.
 *
 * @param value - the value to substitute into.
 * @param outputs - the output of each node that has finished.
 * @returns the value with its placeholders replaced.
 */
export function substitutePlaceholders(value: unknown, outputs: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const exact = PLACEHOLDER.exec(value)
    if (exact !== null) {
      const id = exact[1]!
      const output = outputs.get(id)
      if (output === undefined) {
        throw new Error(`the argument refers to the output of "${id}", and that node has not produced one`)
      }
      return output
    }
    if (!value.includes('@@')) return value
    // A placeholder inside a sentence: paste the result where it stands, so a
    // child can be given the facts instead of being sent to find them.
    return value.replace(INLINE_PLACEHOLDER, (whole, id: string) => {
      const output = outputs.get(id)
      if (output === undefined) {
        throw new Error(`the argument refers to the output of "${id}", and that node has not produced one`)
      }
      return output
    })
  }
  if (Array.isArray(value)) {
    return value.map(entry => substitutePlaceholders(entry, outputs))
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = substitutePlaceholders(entry, outputs)
    }
    return result
  }
  return value
}
