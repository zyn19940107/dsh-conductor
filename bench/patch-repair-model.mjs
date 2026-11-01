import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/index.ts'
let text = readFileSync(path, 'utf8')

// The repair needs the conversation's own model, so the plugin uses `llm`.
const oldInject = "export const inject = ['tools', 'systemPrompt', 'commands']"
const newInject = "export const inject = ['tools', 'systemPrompt', 'commands', 'llm']"
if (!text.includes(oldInject)) throw new Error('inject 没匹配上')
text = text.replace(oldInject, newInject)

// One repair, on the conversation's own route and settings.
const oldWiring = `    onPlanStarted: (sessionId, callId) => planGate.markPlanned(sessionId, callId),
  })`

const newWiring = `    onPlanStarted: (sessionId, callId) => planGate.markPlanned(sessionId, callId),
    repair: async (failed, error, schema, signal) => askForRepairIn(ctx, agent, failed, error, schema, signal),
  })`

if (!text.includes(oldWiring)) throw new Error('applyPlanTool 那段没匹配上')
text = text.replace(oldWiring, newWiring)

// The model call itself, below the plugin body.
const anchor = `/**
 * Whether the plugin is mounted at all.`

const helper = `/**
 * Ask the conversation's own model what a failed call should have been.
 *
 * The plugin owns no provider: the repair runs on the same route and settings
 * the conversation already uses, so a plan's failure is fixed with the model the
 * plan came from.
 *
 * @param ctx - the plugin context supplying the model service.
 * @param agent - the agent the plan belongs to.
 * @param failed - the call that failed.
 * @param error - what the tool said.
 * @param schema - the tool's declared parameters.
 * @param signal - the plan's cancellation signal.
 * @returns the corrected call, or undefined when there is nothing to use.
 */
async function askForRepairIn(
  ctx: Context,
  agent: Agent | undefined,
  failed: { name: string, arguments: unknown },
  error: string,
  schema: unknown,
  signal: AbortSignal,
): Promise<{ name: string, arguments: unknown } | undefined> {
  if (agent === undefined) return undefined
  const config = agent.session.header.config
  const model: RepairModel = {
    async complete(request) {
      const stream = ctx.llm.stream({
        provider: request.config.provider,
        model: request.config.model,
        ...(request.config.reasoningEffort === undefined ? {} : { reasoningEffort: request.config.reasoningEffort }),
        system: repairSystem(),
        messages: [...request.messages],
        signal: request.signal,
      })
      return await collectText(stream)
    },
  }
  return await askForRepair(model, config, failed, error, schema, signal)
}

/**
 * Whether the plugin is mounted at all.`

if (!text.includes(anchor)) throw new Error('锚点没匹配上')
text = text.replace(anchor, helper)

// Imports.
text = text.replace(
  "import { applyPlanTool, PLAN_TOOL } from './tool.js'",
  "import { applyPlanTool, PLAN_TOOL } from './tool.js'\nimport { askForRepair, collectText, repairSystem, type RepairModel } from './repair.js'",
)

writeFileSync(path, text)
console.log('index.ts: 修复循环接上了对话自己的模型')