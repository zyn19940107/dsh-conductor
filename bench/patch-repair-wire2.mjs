import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/batch.ts'
let text = readFileSync(path, 'utf8')

text = text.replace("import { coerceArguments } from './coerce.js'\n", '')
text = text.replace(
  "import { mayRunTogether, type ConcurrencyOverride } from './concurrency.js'",
  "import { mayRunTogether, type ConcurrencyOverride } from './concurrency.js'\nimport { MAX_REPAIRS, type RepairHook } from './repair.js'",
)

// A plan call carries the name and arguments the repair may rewrite.
const oldCall = "__skip__"


// runBatch takes the repair hook and threads it to every call.
text = text.replace(
  `  rootCallId: ToolCallId,
  overrides: Readonly<Record<string, ConcurrencyOverride>> = {},
): Promise<BatchOutput> {`,
  `  rootCallId: ToolCallId,
  overrides: Readonly<Record<string, ConcurrencyOverride>> = {},
  repair?: RepairHook,
): Promise<BatchOutput> {`,
)

text = text.replace(
  "results[index] = await runOne(runner, call, agent, signal, 'concurrent', rootCallId)",
  "results[index] = await runOne(runner, call, agent, signal, 'concurrent', rootCallId, repair)",
)
text = text.replace(
  "results[index] = await runOne(runner, call, agent, signal, 'serial', rootCallId)",
  "results[index] = await runOne(runner, call, agent, signal, 'serial', rootCallId, repair)",
)

// The tool-call input the registry wants: the repair may have renamed the tool.
text = text.replace(
  `      const result = await runner.execute({
        call: { name, arguments: args },
        callId: nextCallId(),`,
  `      const result = await runner.execute({
        callId: nextCallId(),`,
)

writeFileSync(path, text)
console.log('batch.ts: repair 钩子接进 runBatch / runOne')