/**
 * Turning the plugin on and off inside one conversation.
 *
 * The plugin is mounted for a whole deployment, but a conversation may opt out
 * of it. `/dsh-refine-loop off` takes the plugin out of the conversation that
 * ran it: the batch tool disappears from the model's tool table, the guidance
 * leaves the system prompt with it, and the rule stops being enforced.
 * `/dsh-refine-loop on` puts it back.
 *
 * The state is per conversation. One conversation opting out changes no other
 * conversation, and a new conversation starts with the plugin's normal
 * behaviour.
 *
 * The command is a human command: the UI runs it and the model never sees it.
 *
 * @module @zyn19940107/dsh-refine-loop/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: the ctx.commands Context merge.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { PLAN_TOOL } from './tool.js'

/** The command that turns the plugin on and off inside one conversation. */
export const POLICY_COMMAND = 'dsh-refine-loop'

/**
 * The tools a conversation loses when it opts out.
 *
 * The batch tool is the plugin's whole surface: without it there is nothing
 * to batch with, which is what "off" has to mean for the off state to be more
 * than a promise in a prompt.
 */
export const POLICY_TOOLS: readonly string[] = [
  PLAN_TOOL,
]

/**
 * The conversations that opted out of the plugin.
 */
export class SessionPolicy {
  private readonly optedOut = new Set<string>()
  private readonly lifts = new Map<string, () => void>()

  /**
   * Whether the plugin's rules apply to this conversation.
   *
   * @param sessionId - the session's id.
   * @returns true when the conversation follows the plugin's rules.
   */
  appliesTo(sessionId: string): boolean {
    return !this.optedOut.has(sessionId)
  }

  /**
   * Take the plugin out of this conversation.
   *
   * The tool is restricted away in the agent's own scope, so the model stops
   * seeing it and the guidance — which is written in terms of it — leaves the
   * system prompt with it.
   *
   * @param agent - the agent whose conversation opts out.
   */
  turnOff(agent: Agent): void {
    const sessionId = agent.session.id
    if (this.optedOut.has(sessionId)) return
    this.optedOut.add(sessionId)
    const lift = agent.ctx.tools.restrict({ deny: [...POLICY_TOOLS] })
    this.lifts.set(sessionId, lift)
  }

  /**
   * Put the plugin back into this conversation.
   *
   * @param sessionId - the session's id.
   */
  turnOn(sessionId: string): void {
    this.optedOut.delete(sessionId)
    const lift = this.lifts.get(sessionId)
    if (lift === undefined) return
    this.lifts.delete(sessionId)
    lift()
  }
}

/**
 * Run the policy command.
 *
 * The command takes one word: `on` or `off`. Anything else is refused with
 * the two spellings, because a command that guessed would silently leave the
 * conversation in the wrong state.
 *
 * @param policy - the per-conversation state.
 * @param invocation - the command's invocation.
 * @returns what the command reports back to the composer.
 */
export function runPolicyCommand(
  policy: SessionPolicy,
  invocation: CommandInvocation,
): CommandResult {
  const raw = invocation.rawInput.trim().toLowerCase()
  if (raw !== 'on' && raw !== 'off') {
    return {
      kind: 'error',
      text: `Use /${POLICY_COMMAND} on or /${POLICY_COMMAND} off.`,
    }
  }
  const sessionId = invocation.agent.session.id
  if (raw === 'off') {
    policy.turnOff(invocation.agent)
    return {
      kind: 'success',
      text: 'The refined loop is off for this conversation: refine_plan is gone and the rule that makes '
        + 'a turn one plan is not enforced. Turn it back on with '
        + `/${POLICY_COMMAND} on.`,
    }
  }
  policy.turnOn(sessionId)
  return {
    kind: 'success',
    text: 'The refined loop is on for this conversation.',
  }
}

/**
 * The command as it appears in a message.
 *
 * The command registry dispatches a command line to the session it was typed
 * in, so a line typed into a conversation that does not exist yet has nowhere
 * to go. The plugin therefore also recognises its own command line in a user
 * message and applies it there.
 *
 * The command is the message's first line. A surface may append its own
 * context to the message it delivers, and that text is not part of what the
 * person asked for.
 *
 * @param text - the message text.
 * @returns the mode the command asks for, or undefined when the message is not
 * the command.
 */
export function parsePolicyCommand(text: string): 'on' | 'off' | undefined {
  const firstLine = text.trim().split('\n', 1)[0]?.trim() ?? ''
  if (!firstLine.startsWith(`/${POLICY_COMMAND}`)) return undefined
  const rest = firstLine.slice(POLICY_COMMAND.length + 1).trim().toLowerCase()
  if (rest !== 'on' && rest !== 'off') return undefined
  return rest
}

/**
 * What the model is told when the command arrived as a message.
 *
 * The command is the user's decision, not the model's work: the message the
 * model receives asks for one sentence of confirmation and nothing else.
 *
 * @param mode - what the command asked for.
 * @returns the confirmation instruction.
 */
export function policyConfirmation(mode: 'on' | 'off'): string {
  return mode === 'off'
    ? 'The refined loop has been turned off for this conversation: the plan tool is gone and the rule that '
      + 'makes a turn one plan is not enforced. Reply with one short sentence saying so, and do nothing else.'
    : 'The refined loop has been turned on for this conversation: the plan tool is back and the rule that makes '
      + 'a turn one plan is enforced again. Reply with one short sentence saying so, and do nothing else.'
}

/**
 * The text of one message.
 *
 * @param message - the message to read.
 * @returns its text blocks joined by line breaks.
 */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Apply the command that arrived as a user message.
 *
 * The command registry owns the line once a conversation exists; this is the
 * path for a surface with no composer to intercept the line, and for the first
 * line of a conversation, where there is no session to dispatch to yet.
 *
 * A conversation's first turn also carries the messages other plugins inject,
 * so the command is found by its source — the message a person wrote — and
 * only that one message is replaced by the confirmation.
 *
 * @param ctx - the plugin context supplying the agent runtime.
 * @param policy - the per-conversation state the command writes.
 */
export function applyPolicyMessage(ctx: Context, policy: SessionPolicy): void {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const index = decision.messages.findIndex((message) =>
      message.source.kind === 'user' && parsePolicyCommand(messageText(message)) !== undefined)
    if (index === -1) return decision
    const message = decision.messages[index]
    if (message === undefined) return decision
    const mode = parsePolicyCommand(messageText(message))
    if (mode === undefined) return decision
    const sessionId = payload.agent.session.id
    if (mode === 'off') policy.turnOff(payload.agent)
    else policy.turnOn(sessionId)
    const messages = [...decision.messages]
    messages[index] = createUserMessage({
      content: [{ type: 'text', text: policyConfirmation(mode) }],
      source: { kind: 'system-prompt' },
    })
    return { kind: 'enter', messages }
  })
}

/**
 * Register the policy command.
 *
 * @param ctx - the plugin context supplying the command registry.
 * @param policy - the per-conversation state the command writes.
 */
export function applyPolicyCommand(ctx: Context, policy: SessionPolicy): void {
  ctx.commands.register({
    name: POLICY_COMMAND,
    description: 'Turn the refined loop on or off for this conversation.',
    input: { hint: 'on | off' },
    handler: (invocation) => runPolicyCommand(policy, invocation),
  })
}
