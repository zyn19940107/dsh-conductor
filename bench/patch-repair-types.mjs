import { readFileSync, writeFileSync } from 'node:fs'

const tool = 'src/tool.ts'
let text = readFileSync(tool, 'utf8')

// The tool options accept the repair hook.
const oldOptions = `    onPlanStarted?: (sessionId: string, callId: ToolCallId) => void`
const newOptions = `    onPlanStarted?: (sessionId: string, callId: ToolCallId) => void
    /** Repair a call that failed inside a plan. */
    repair?: RepairHook`
if (!text.includes(oldOptions)) throw new Error('PlanToolOptions 没匹配上')
text = text.replace(oldOptions, newOptions)

// The old schema helper is gone with the coercion attempt.
text = text.replace(/\/\*\*\n \* The parameter schema a tool declares\.[\s\S]*?\n\}\n\n/, '')

// runPlan already got the hook; the batch call needs it in scope (it is a
// parameter of runNode, which calls runBatch).
writeFileSync(tool, text)
console.log('tool.ts: options 加了 repair')

const index = 'src/index.ts'
let indexText = readFileSync(index, 'utf8')

indexText = indexText.replace(
  "import type { Agent } from '@deepseek-ai/dsh-agent'",
  "import type { Agent } from '@deepseek-ai/dsh-agent'",
)
if (!indexText.includes("from '@deepseek-ai/dsh-agent'")) {
  indexText = indexText.replace(
    "import type { Context } from '@deepseek-ai/cordis'",
    "import type { Context } from '@deepseek-ai/cordis'\nimport type { Agent } from '@deepseek-ai/dsh-agent'",
  )
}

// The repair hook needs the agent the plan belongs to. The plan tool builds it
// per call, so it takes the agent from the tool options instead.
indexText = indexText.replace(
  `    repair: async (failed, error, schema, signal) => askForRepairIn(ctx, agent, failed, error, schema, signal),`,
  `    repair: (failed, error, schema, signal, agent: Agent) => askForRepairIn(ctx, agent, failed, error, schema, signal),`,
)

writeFileSync(index, indexText)
console.log('index.ts: 修好了')