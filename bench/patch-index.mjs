import { readFileSync, writeFileSync } from 'node:fs'

/**
 * The guidance, the renderings and the config, all in one place.
 */

const index = 'src/index.ts'
let text = readFileSync(index, 'utf8')

const oldGuidance = `  '- Draw the plan in your reasoning before you act: the shape of this turn — which items are '
  + 'independent, which need a child with no context, which need a child that inherits this conversation, '
  + 'and what depends on what. Then hand that shape over in one refine_plan call. A turn is one plan: give '
  + 'the plan, run it, and the turn is over: the results it produced are what this turn produced.',`

const newGuidance = `  '- You do not call tools yourself: every call you make goes inside a plan. Draw the shape of the '
  + 'work in your reasoning first — which items are independent, which need a child with no context, which '
  + 'need a child that inherits this conversation, and what depends on what — then hand that shape over in '
  + 'one refine_plan call. The plan runs, its results come back together, and then you decide: another plan '
  + 'for what is left, or the conclusion. Writing the conclusion ends the turn.',`

if (!text.includes(oldGuidance)) throw new Error('提示词那段没匹配上')
text = text.replace(oldGuidance, newGuidance)

const oldLine = `  '- The plan runs in one round trip and every result comes back together. That result is the turn: the '
  + 'next round starts from it.',`

const newLine = `  '- The plan runs in one round trip and every result comes back together. A result may be too long to '
  + 'fit and be left out of what you see — the rest is in the spill file, and the next plan can read it.',`

if (!text.includes(oldLine)) throw new Error('计划结果那句没匹配上')
text = text.replace(oldLine, newLine)

// The config loses the conclusion pullbacks: there is no second half of the
// rule any more — after a plan, the agent decides what to do.
text = text.replace(
  `    conclusionPullbacks: () => config.conclusionPullbacks.get(),\n`,
  '',
)
text = text.replace(
  `    onPlanStarted: (sessionId, callId) => planGate.markPlanned(sessionId, callId),\n`,
  '',
)
text = text.replace(
  `  conclusionPullbacks: Volatile<number>\n`,
  '',
)
text = text.replace(
  `  conclusionPullbacks: z.number().step(0).min(0).default(DEFAULT_CONCLUSION_PULLBACKS).volatile(),\n`,
  '',
)
text = text.replace(
  `export const DEFAULT_CONCLUSION_PULLBACKS = 10\n`,
  '',
)

writeFileSync(index, text)
console.log('index.ts 改了')

const tool = 'src/tool.ts'
let toolText = readFileSync(tool, 'utf8')
const oldTool = `  lines.push('Every result is above. The turn is over.')`
const newTool = `  lines.push('Every result is above. Decide what is next: another plan for what is left, or the '
    + 'conclusion that ends the turn.')`
if (!toolText.includes(oldTool)) throw new Error('tool.ts 那句没匹配上')
toolText = toolText.replace(oldTool, newTool)
writeFileSync(tool, toolText)
console.log('tool.ts 改了')
