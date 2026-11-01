import { readFileSync, writeFileSync } from 'node:fs'

const index = 'src/index.ts'
let text = readFileSync(index, 'utf8')

const oldGuidance = `  + 'one refine_plan call. The plan runs, its results come back together, and then you decide: another plan '
  + 'for what is left, or the conclusion. Writing the conclusion ends the turn.',`

const newGuidance = `  + 'one refine_plan call. The plan runs, its results come back together, and the turn is over: what the '
  + 'plan produced is what this turn produced. If you have nothing left to do, write the conclusion instead — '
  + 'that ends the turn too.',`

if (!text.includes(oldGuidance)) throw new Error('提示词那段没匹配上')
text = text.replace(oldGuidance, newGuidance)
writeFileSync(index, text)
console.log('index.ts 改了')

const tool = 'src/tool.ts'
let toolText = readFileSync(tool, 'utf8')
const oldTool = `  lines.push('Every result is above. Decide what is next: another plan for what is left, or the '
    + 'conclusion that ends the turn.')`

const newTool = `  lines.push('Every result is above. The turn is over.')`

if (!toolText.includes(oldTool)) throw new Error('tool.ts 那句没匹配上')
toolText = toolText.replace(oldTool, newTool)
writeFileSync(tool, toolText)
console.log('tool.ts 改了')

const spec = 'verify/plan.spec.ts'
let specText = readFileSync(spec, 'utf8')
const oldSpec = `  check('the render says the agent decides what is next',
    text.includes('Every result is above. Decide what is next'))`

const newSpec = `  check('the render says the turn is over', text.includes('Every result is above. The turn is over.'))`

if (!specText.includes(oldSpec)) throw new Error('plan.spec.ts 那条没匹配上')
specText = specText.replace(oldSpec, newSpec)
writeFileSync(spec, specText)
console.log('plan.spec.ts 改了')
