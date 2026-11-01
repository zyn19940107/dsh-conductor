import { readFileSync, writeFileSync } from 'node:fs'

const batch = 'src/batch.ts'
let text = readFileSync(batch, 'utf8')

const oldInterface = `export interface BatchRunner {
  /** Classify a pending call as safe to run concurrently or not. */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode
  /** Run one call through the registry's pipeline. */
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
}`

const newInterface = `export interface BatchRunner {
  /** Classify a pending call as safe to run concurrently or not. */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode
  /** Run one call through the registry's pipeline. */
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
  /** The parameters a visible tool declares, when the registry can say. */
  parameters?(name: string, agent: Agent | undefined): unknown
}`

if (!text.includes(oldInterface)) throw new Error('BatchRunner 接口没匹配上')
text = text.replace(oldInterface, newInterface)
writeFileSync(batch, text)
console.log('batch.ts: BatchRunner 加了 parameters')

const tool = 'src/tool.ts'
let toolText = readFileSync(tool, 'utf8')

const oldCall = `      return await runPlan(
        ctx.tools,`

const newCall = `      return await runPlan(
        withSchemas(ctx.tools),`

if (!toolText.includes(oldCall)) throw new Error('runPlan 调用没匹配上')
toolText = toolText.replace(oldCall, newCall)

const anchor = `/**
 * The kinds of node that start an agent.
 */`

const helper = `/**
 * A registry that can also say what parameters a tool declares.
 *
 * The batch uses it to repair the arguments a plan wrote by hand: a plan is
 * written before anything has run, so its calls carry "5" where the tool wants
 * 5. The repair has to happen inside the plan — the turn is over when the plan
 * has run.
 *
 * @param tools - the tool registry the plan runs against.
 * @returns the registry, with the schema lookup added.
 */
function withSchemas(tools: ToolRegistry): BatchRunner {
  return {
    executionMode: exec => tools.executionMode(exec),
    execute: exec => tools.execute(exec),
    parameters: (name: string) => tools.get(name)?.parameters,
  }
}

/**
 * The kinds of node that start an agent.
 */`

if (!toolText.includes(anchor)) throw new Error('锚点没匹配上')
toolText = toolText.replace(anchor, helper)

writeFileSync(tool, toolText)
console.log('tool.ts: runPlan 现在拿到带 schema 的 registry')