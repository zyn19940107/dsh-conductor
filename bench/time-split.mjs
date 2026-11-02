/** 把一次运行的墙钟拆成:主 agent 模型 / 主 agent 工具 / 孩子(最大/合计) */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeLog } from './sessions.mjs'

const ROOT = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'
function load(id) {
  for (const d of readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory())) {
    for (const f of readdirSync(join(ROOT, d.name))) {
      if (!f.endsWith('.zstd')) continue
      const t = decodeLog(join(ROOT, d.name, f))
      if (t === '') continue
      let h
      try { h = JSON.parse(t.split('\n')[0]) } catch { continue }
      if (h.id !== id) continue
      return t.split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    }
  }
  return undefined
}
function kids(parent) {
  const out = []
  for (const d of readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory())) {
    for (const f of readdirSync(join(ROOT, d.name))) {
      if (!f.endsWith('.zstd')) continue
      const t = decodeLog(join(ROOT, d.name, f))
      if (t === '') continue
      let h
      try { h = JSON.parse(t.split('\n')[0]) } catch { continue }
      if (h.parentSession === parent) out.push(h.id)
    }
  }
  return out
}
function steps(ev) {
  const out = []
  let cur
  for (const e of ev) {
    const time = Number(e.time ?? 0)
    if (e.type === 'step/start') { cur = { start: time, first: 0, last: 0, end: 0, calls: [] }; continue }
    if (!cur) continue
    if (e.type === 'tool/call') { if (!cur.first) cur.first = time; cur.calls.push(String(e.data?.name ?? '')) ; continue }
    if (e.type === 'tool/result') { cur.last = time; continue }
    if (e.type === 'step/end') { cur.end = time; out.push(cur); cur = undefined }
  }
  return out
}
const fmt = ms => (ms / 1000).toFixed(0) + 's'
for (const task of ['coveragewide', 'coverage', 'review', 'sweep', 'fanout']) {
  for (const cond of ['off', 'on']) {
    const r = JSON.parse(readFileSync(`bench/results/${task}-${cond}-1.json`, 'utf8'))
    const main = load(r.sessionId)
    if (!main) { console.log(task, cond, '无日志'); continue }
    const st = steps(main)
    let model = 0, tool = 0
    for (const s of st) {
      if (!s.first) { model += s.end - s.start; continue }
      model += s.first - s.start
      tool += (s.last || s.end) - s.first
    }
    const planStep = st.find(s => s.calls.includes('refine_plan'))
    const planModel = planStep ? planStep.first - planStep.start : 0
    const planExec = planStep ? (planStep.last || planStep.end) - planStep.first : 0
    const konly = kids(r.sessionId).map(id => load(id)).filter(Boolean)
    const spans = konly.map(ev => {
      const t = ev.map(e => Number(e.time ?? 0)).filter(Boolean)
      return Math.max(...t) - Math.min(...t)
    })
    let kmodel = 0
    for (const ev of konly) {
      for (const s of steps(ev)) { if (!s.first) kmodel += s.end - s.start; else kmodel += (s.first - s.start) + ((s.last || s.end) - s.first) }
    }
    console.log(
      task.padEnd(13), cond.padEnd(3), fmt(r.wallMs).padStart(5),
      '| 主模型', fmt(model).padStart(4), '主工具', fmt(tool).padStart(5),
      '| 写图', fmt(planModel).padStart(4), '图执行', fmt(planExec).padStart(5),
      '| 孩子', konly.length, '最大', konly.length ? fmt(Math.max(...spans)).padStart(4) : '   -', '合计', konly.length ? fmt(spans.reduce((a, b) => a + b, 0)).padStart(4) : '   -',
    )
  }
}
