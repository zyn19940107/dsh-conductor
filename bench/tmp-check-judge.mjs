import { readdirSync, readFileSync } from 'node:fs'
import { decodeLog } from './sessions.mjs'
import { TASKS } from './task.mjs'

const SESS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
const LF = String.fromCharCode(10)
const file = process.argv[2]
const r = JSON.parse(readFileSync(file, 'utf8'))
const eventsOf = (dir) => {
  const ev = []
  try {
    for (const f of readdirSync(SESS + '/' + dir).filter(n => n.endsWith('.zstd'))) {
      for (const line of decodeLog(SESS + '/' + dir + '/' + f).split(LF)) {
        if (line.trim() === '') continue
        try { ev.push(JSON.parse(line)) } catch {}
      }
    }
  } catch {}
  return ev
}
const ev = eventsOf(r.sessionId)
const full = ev.filter(e => e.type === 'assistant/message')
  .flatMap(e => (e.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? ''))
  .join('')
const stored = r.correctness
const redo = TASKS[r.task].judge(full)
console.log(file.split('/').pop(), '| 存:', stored.passed + '/' + stored.total, '| 重判:', redo.passed + '/' + redo.total)
console.log('  重判缺失:', JSON.stringify(redo.missing))
console.log('  finalText 长度:', String(r.finalText ?? '').length, '| 日志全文长度:', full.length)
console.log('  日志全文含 key:', ['rounds.ts', 'delegationDepth', 'worker', 'forker'].map(k => k + '=' + full.includes(k)).join(' '))
