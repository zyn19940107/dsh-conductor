import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/tool.ts'
let text = readFileSync(path, 'utf8')

// runBatch takes the repair hook.
text = text.replace(
  `      respectConcurrencySafety,
      rootCallId,
      overrides,
    )`,
  `      respectConcurrencySafety,
      rootCallId,
      overrides,
      repair,
    )`,
)

// runPlan threads it down.
text = text.replace(
  `  maxAgentDepth: number,
  agentNodeTimeoutMs: number,
): Promise<PlanOutput> {`,
  `  maxAgentDepth: number,
  agentNodeTimeoutMs: number,
  repair?: RepairHook,
): Promise<PlanOutput> {`,
)

// The plan tool builds it from the conversation's own model.
text = text.replace(
  `        options.maxAgentDepth(),
        options.agentNodeTimeoutMs(),
      )`,
  `        options.maxAgentDepth(),
        options.agentNodeTimeoutMs(),
        options.repair,
      )`,
)

text = text.replace(
  "import { mayRunTogether, type ConcurrencyOverride } from './concurrency.js'",
  "import { mayRunTogether, type ConcurrencyOverride } from './concurrency.js'\nimport type { RepairHook } from './repair.js'",
)

writeFileSync(path, text)
console.log('tool.ts: repair 一路传下去')