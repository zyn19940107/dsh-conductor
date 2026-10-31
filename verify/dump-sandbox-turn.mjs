// Dump the turn outline and stats of the newest sandbox session.
import fs from 'node:fs'
import path from 'node:path'

const dir = 'D:/code/vibe/dsh-sandbox/home/storages/session_projcache/sessions'
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.json'))
  .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)

if (files.length === 0) {
  console.log('no projection cache files under', dir)
  process.exit(0)
}
const newest = files[0]
console.log('newest:', newest.f, 'mtime', new Date(newest.m).toISOString())
const o = JSON.parse(fs.readFileSync(path.join(dir, newest.f), 'utf8'))
const rows = o.record?.rows ?? o.rows ?? {}
for (const key of Object.keys(rows)) {
  const val = rows[key]?.val ?? rows[key]
  if (key === 'turnOutline' || key === 'sessionStats' || key === 'tokenUsage') {
    console.log(`\n=== ${key} ===`)
    console.log(JSON.stringify(val, null, 2).slice(0, 4000))
  }
}
console.log('\nall row keys:', Object.keys(rows).join(', '))
