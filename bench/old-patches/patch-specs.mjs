import { readFileSync, writeFileSync } from 'node:fs'

const path = 'verify/gate.spec.ts'
let text = readFileSync(path, 'utf8')

const oldBlock = `  check('the refusal offers the conclusion as the other way out',
    (planRefusal('glob', 's1', gate, () => true, true, 2) ?? '').includes('conclusion'))`

const newBlock = `  const fresh = new PlanGate()
  check('the refusal offers the conclusion as the other way out',
    (planRefusal('glob', 's1b', fresh, () => true, true, 2) ?? '').includes('conclusion'))`

if (!text.includes(oldBlock)) throw new Error('gate.spec.ts 那条没匹配上')
text = text.replace(oldBlock, newBlock)
writeFileSync(path, text)
console.log('gate.spec.ts 改了')
