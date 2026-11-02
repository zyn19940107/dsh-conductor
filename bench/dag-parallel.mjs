import { runPlan } from '../lib/index.js'


const runner = {
  executionMode: () => ({ kind: 'parallel' }),
  async execute(exec) {
    await new Promise(r => setTimeout(r, 600))
    return { isError: false, value: exec.name, content: [{ type: 'text', text: 'ok' }] }
  },
}
const nodes = [
  { id: 'a', kind: 'tools', calls: [{ name: 'x', arguments: {} }], after: [] },
  { id: 'b', kind: 'tools', calls: [{ name: 'x', arguments: {} }], after: [] },
  { id: 'c', kind: 'tools', calls: [{ name: 'x', arguments: {} }], after: [] },
  { id: 'd', kind: 'tools', calls: [{ name: 'x', arguments: {} }], after: ['a', 'b'] },
]
const t0 = Date.now()
const out = await runPlan(runner, { criteria: ['x'], nodes }, undefined, new AbortController().signal, true, 't:root', {})
console.log('层数', out.waves, '| 形状', out.schedule, '| 总耗时', Date.now() - t0, 'ms')
console.log('若并行:3 个独立节点 ≈600ms + d 再 600ms ≈1200ms')
console.log('若串行:4 × 600 = 2400ms')
