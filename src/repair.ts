/**
 * The loop that fixes a failed call inside the plan.
 *
 * A plan is written before anything has run, so its calls are guesses: a path
 * that is not there, an argument of the wrong type, a search that matches
 * nothing. The plan is one round trip and the turn ends when it has run, so
 * nobody comes back to redraw it — the failed call has to be repaired where it
 * happens.
 *
 * The repair is the ordinary loop this plugin exists to compress, run once and
 * scoped to one call: call the tool, see the error, ask the model what the call
 * should have been, call the tool again with that answer. Only the failing call
 * goes to the model; the rest of the plan is untouched.
 *
 * @module @zyn19940107/dsh-refine-loop/repair
 */

import type { LlmCallConfig, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'

/** How many times one failed call may be repaired before the plan reports it. */
export const MAX_REPAIRS = 2

/**
 * Repair one failed call.
 *
 * @param failed - the call as the plan wrote it.
 * @param error - what the tool said.
 * @param schema - the tool's declared parameters, when known.
 * @param signal - the plan's cancellation signal.
 * @returns the corrected call, or undefined when the model gave no usable one.
 */
export type RepairHook = (
  failed: { name: string, arguments: unknown },
  error: string,
  schema: unknown,
  signal: AbortSignal,
) => Promise<{ name: string, arguments: unknown } | undefined>

/**
 * The model call the repair uses.
 *
 * The plugin does not own a provider: the call goes through the conversation's
 * own model, with the conversation's own route and settings.
 */
export interface RepairModel {
  /** One turn: what to send, and the text that came back. */
  complete(request: {
    config: LlmCallConfig
    messages: readonly RequestMessage[]
    signal: AbortSignal
  }): Promise<string>
}

/**
 * Ask the model what a failed call should have been.
 *
 * The answer is read as JSON: the complete corrected call. Anything that is not
 * a call the plan can run is treated as no answer at all, so a repair can never
 * make the plan worse.
 *
 * @param model - the model the repair runs on.
 * @param config - the conversation's call configuration.
 * @param failed - the call that failed.
 * @param error - what the tool said.
 * @param schema - the tool's declared parameters, when the registry can say.
 * @param signal - the cancellation signal of the plan.
 * @returns the corrected call, or undefined when the model gave no usable one.
 */
export async function askForRepair(
  model: RepairModel,
  config: LlmCallConfig,
  failed: { name: string, arguments: unknown },
  error: string,
  schema: unknown,
  signal: AbortSignal,
): Promise<{ name: string, arguments: unknown } | undefined> {
  const messages: RequestMessage[] = [
    { role: 'user', content: [{ type: 'text', text: describeFailure(failed, error, schema) }] },
  ]
  let text: string
  try {
    text = await model.complete({ config, messages, signal })
  } catch {
    return undefined
  }
  return parseRepair(text, failed.name)
}

const SYSTEM = [
  'You are repairing one tool call that failed inside a plan.',
  'The plan was written before anything had run, so the call was a guess.',
  'The error is the whole truth about what went wrong — a path that is not there, an argument of the wrong',
  'shape, or a tool name that does not exist.',
  'Reply with exactly one JSON object and nothing else:',
  '{"name": "<tool name>", "arguments": {...}}',
].join('\n')

/**
 * The repair's instructions, as one system message.
 *
 * @returns the system text.
 */
export function repairSystem(): string {
  return SYSTEM
}

/**
 * Describe the failure for the model.
 *
 * @param failed - the call that failed.
 * @param error - what the tool said.
 * @param schema - the tool's declared parameters.
 * @returns the text of the request.
 */
export function describeFailure(
  failed: { name: string, arguments: unknown },
  error: string,
  schema?: unknown,
): string {
  const lines = [
    `The call: ${failed.name}`,
    `Its arguments: ${JSON.stringify(failed.arguments)}`,
    '',
    `It failed with: ${error}`,
  ]
  if (schema !== undefined) {
    lines.push('', `The tool declares these parameters: ${JSON.stringify(schema)}`)
  }
  return lines.join('\n')
}

/**
 * Read the model's answer as a call the plan can run.
 *
 * @param text - what the model said.
 * @param fallbackName - the tool the failed call named.
 * @returns the call, or undefined when the answer is not one.
 */
export function parseRepair(
  text: string,
  fallbackName: string,
): { name: string, arguments: unknown } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const name = typeof record.name === 'string' && record.name !== '' ? record.name : fallbackName
  const args = record.arguments
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  return { name, arguments: args }
}

/**
 * Collect a streamed answer into text.
 *
 * @param stream - the chunks of one model call.
 * @returns the text the model produced.
 */
export async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

/**
 * Resolve a tool name the model wrote to a name the registry knows.
 *
 * A model can write a tool name it only half-remembers — a `Compat` prefix the
 * harness never used, a random hex suffix it invented. The suffix is dropped,
 * the prefix is dropped, and the rest is matched case- and separator-insensitively
 * against the registry.
 *
 * @param known - whether the registry knows a name.
 * @param written - the name the model wrote.
 * @returns the registry name, or undefined when nothing matches.
 */
export function resolveToolName(known: (name: string) => boolean, written: string): string | undefined {
  if (known(written)) return written
  const stripped = written
    .replace(/^Compat/u, '')
    .replace(/[0-9a-f]{6,}$/iu, '')
  const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/gu, '')
  const wanted = normalise(stripped)
  if (wanted === '') return undefined
  for (const candidate of TOOL_NAME_CANDIDATES) {
    if (normalise(candidate) === wanted && known(candidate)) return candidate
  }
  return undefined
}

/**
 * The names worth trying when a written tool name is not in the registry.
 *
 * The plugin only sees the tools it was handed; this list is the harness's
 * stable tool vocabulary, which is what a plan's calls are written against.
 */
export const TOOL_NAME_CANDIDATES = [
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'jobs', 'read_image',
  'web_search', 'web_fetch', 'refine_plan', 'subagent', 'subagent_fork', 'workflow',
  'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode', 'todo_write',
  'send_message', 'list_agents', 'interrupt_agent', 'job_kill', 'job_list', 'job_output',
] as const

