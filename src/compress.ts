/**
 * Compress one oversized tool result with the model, so a plan's report stays
 * small.
 *
 * The harness caps a tool result: past its budget it keeps the head and the
 * tail and drops the middle into a spill file, and it says so in the result.
 * That is fine for one call the agent made itself. It is not fine inside a plan:
 * a `tools` node that ran one heavy call hands that result to the plan report,
 * and a report that is too large is truncated again — a plan with three nodes
 * can lose its second node entirely, and the agent judges from what it can see.
 *
 * So an oversized result is compressed here, on the conversation's own route,
 * before it enters the plan report: the facts the next judgement needs, every
 * node still visible, and a pointer to the full text for the one detail that
 * did not fit.
 *
 * @module @zyn19940107/dsh-refine-loop/compress
 */

import { readFileSync, statSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** What the harness writes into a result it had to make smaller. */
export const SPILL_NOTICE = 'Full formatted result stored at: '

/** How much of one tool result the compressor is asked to keep. */
export const COMPRESS_TARGET_CHARS = 3000

/** The largest spill file the compressor will read back. */
const MAX_SPILL_BYTES = 4 * 1024 * 1024

/**
 * The largest result the compressor will send to the model whole.
 *
 * Past this the call itself becomes the expensive part: compressing a 400 KB
 * listing means feeding the model more than the plan report would ever have
 * cost. The retained text is compressed instead — the harness already dropped
 * the middle, and paying a long model call to recover it is the worse trade.
 */
const MAX_COMPRESS_INPUT_CHARS = 150_000

/**
 * The compressor's system prompt.
 *
 * @returns the prompt.
 */
export function compressSystem(): string {
  return 'You compress one tool result so a planning agent can judge from it. '
    + 'Keep every number, name, path, error and conclusion that a decision could rest on; '
    + 'drop repetition, boilerplate, headers, and raw listings that carry no distinct fact. '
    + `Stay under ${COMPRESS_TARGET_CHARS} characters. Do not invent anything and do not add commentary.`
    + 'If the result is a listing, keep what it establishes — how many, which ones, which is largest — '
    + 'not the listing itself.'
}

/**
 * The full text of a result the harness spilled, when it spilled one.
 *
 * The harness replaces the middle of a large result with a notice and stores the
 * whole text in a spill file. Reading it back is how a result larger than the
 * harness budget still gets compressed whole instead of being compressed twice.
 *
 * @param output - the text the tool returned.
 * @returns the full text and the spill path, or undefined when nothing spilled.
 */
export function spilledText(output: string): { text: string, path: string } | undefined {
  const at = output.indexOf(SPILL_NOTICE)
  if (at === -1) return undefined
  const rest = output.slice(at + SPILL_NOTICE.length)
  // The path runs to the end of the notice's own sentence.
  const end = rest.search(/[.)]\s/)
  const path = (end === -1 ? rest : rest.slice(0, end)).trim()
  if (path === '') return undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_SPILL_BYTES) return undefined
    return { text: readFileSync(path, 'utf8'), path }
  } catch {
    return undefined
  }
}

/**
 * Compress one tool result with the model.
 *
 * @param ctx - the plugin context carrying the model registry.
 * @param config - the route the conversation is on.
 * @param tool - the tool the result came from.
 * @param output - the result as the tool returned it.
 * @param signal - cancellation.
 * @returns the text that goes into the plan report.
 */
export async function compressToolOutput(
  ctx: Context,
  config: LlmCallConfig,
  tool: string,
  output: string,
  signal: AbortSignal,
): Promise<string> {
  const spilled = spilledText(output)
  const whole = spilled?.text ?? output
  const full = whole.length > MAX_COMPRESS_INPUT_CHARS ? output : whole
  if (full.length <= COMPRESS_TARGET_CHARS * 2) return output
  const reply = await ctx.llm.stream({
    provider: config.provider,
    model: config.model,
    system: compressSystem(),
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `The ${tool} result is ${full.length} characters. Compress it.\n\n${full}`,
      }],
    }],
    signal,
  })
  let text = ''
  for await (const chunk of reply) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  const trimmed = text.trim()
  if (trimmed === '') return output
  const where = spilled === undefined ? '' : ` Full text: ${spilled.path}`
  const scope = full === output && spilled !== undefined
    ? ` The harness had already truncated it; this compresses what it kept (${output.length} characters).`
    : ''
  return `${trimmed}\n\n[${tool} result: ${full.length} characters, compressed to ${trimmed.length}.${scope}${where}]`
}

/**
 * Whether a result is large enough to be worth a compression call.
 *
 * A result the harness spilled is always worth it: it is already truncated, and
 * its middle is the part nobody can see.
 *
 * @param output - the result as the tool returned it.
 * @returns true when the result should be compressed.
 */
export function needsCompression(output: string): boolean {
  if (output.includes(SPILL_NOTICE)) return true
  return output.length > COMPRESS_TARGET_CHARS * 2
}
