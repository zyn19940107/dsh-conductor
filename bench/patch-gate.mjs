import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/gate.ts'
let text = readFileSync(path, 'utf8')

const oldRequired = `export const PLAN_REQUIRED = 'This turn is one plan. Before you call anything else, hand the turn over as a '
  + \`plan with \${PLAN_TOOL}: the criteria that decide whether it succeeded, and the nodes — the calls \`
  + 'that run together, the tasks that need a child with no context, the tasks that need a child that '
  + 'inherits this conversation, and what depends on what. The plan runs in one round trip and returns every '
  + 'result together.'`

const newRequired = `export const PLAN_REQUIRED = 'Do not call tools yourself — every call you make goes inside a plan. Either hand '
  + \`the work over as a plan with \${PLAN_TOOL} — the criteria that decide whether it succeeded, and the \`
  + 'nodes: the calls that run together, the tasks that need a child with no context, the tasks that need a '
  + 'child that inherits this conversation, and what depends on what. The plan runs in one round trip and '
  + 'returns every result together, and the turn is over when it has run — or write the conclusion, which '
  + 'ends the turn too.'`

const oldDone = `export const PLAN_DONE = 'This turn already handed over its plan, and the plan\\'s results are in front of '
  + 'you. Do not call any tool again in this turn — the turn ends with what the plan produced. Write that '
  + 'conclusion now: what the plan produced, what it did not settle, and what the next round has to pick up. '
  + 'The next round draws the next plan. Do not hand over another plan in this turn.'`

const newDone = `export const PLAN_DONE = 'This turn already handed over its plan, and the plan\\'s results are in front of '
  + 'you. Do not call any tool again in this turn — the turn ends with what the plan produced, and the next '
  + 'round draws the next plan.'`

if (!text.includes(oldRequired)) throw new Error('PLAN_REQUIRED 没匹配上')
if (!text.includes(oldDone)) throw new Error('PLAN_DONE 没匹配上')
text = text.replace(oldRequired, newRequired).replace(oldDone, newDone)
writeFileSync(path, text)
console.log('两条文案都改了')
