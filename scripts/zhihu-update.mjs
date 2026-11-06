/**
 * Update one published Zhihu article in place.
 *
 * The column API edits a published article through its draft: PATCH the draft
 * with the new title and HTML, then PUT publish. The article keeps its id and
 * its URL, which is the point — the CLI has no update command, only create.
 *
 * Usage:
 *   node scripts/zhihu-update.mjs <article-id> <markdown-path> [--apply]
 *
 * Without --apply it prints what would change and touches nothing.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

const CLI_LIB = 'file:///C:/Users/Administrator/AppData/Roaming/npm/node_modules/zhihu-cli/scripts/lib/'
const { loadConfig } = await import(`${CLI_LIB}config.js`)
const { prepareContent, uploadAndCompileContent } = await import(`${CLI_LIB}content.js`)
const { requestWebJson, requestWebRaw } = await import(`${CLI_LIB}http.js`)

const COLUMN_API = 'https://zhuanlan.zhihu.com/api'
const id = process.argv[2]
const markdownPath = process.argv[3]
const apply = process.argv.includes('--apply')

if (!id || !markdownPath) {
  console.error('usage: node scripts/zhihu-update.mjs <article-id> <markdown-path> [--apply]')
  process.exit(1)
}

const source = readFileSync(markdownPath, 'utf8')
const firstLine = source.split('\n').find(line => line.startsWith('# ')) ?? ''
const title = firstLine.replace(/^#\s+/, '').trim()
if (title === '') throw new Error('the markdown has no leading # title')

// The article carries its own title field; a leading "# title" line in the body
// would render as a second heading right under it.
const lines = source.split('\n')
const titleIndex = lines.findIndex(line => line.startsWith('# '))
const body = (titleIndex >= 0 ? lines.slice(titleIndex + 1).join('\n') : source).replace(/^\s+/, '')
const bodyPath = `${markdownPath}.body.tmp.md`
writeFileSync(bodyPath, body, 'utf8')

const config = loadConfig({ required: true })
const prepared = prepareContent({ input: bodyPath })
const { compiled } = await uploadAndCompileContent(config, prepared)
const html = compiled.html

/**
 * @param value - any string.
 * @returns a short sha-like fingerprint for comparison.
 */
function fingerprint(value) {
  return `${String(value).length}:${String(value).slice(0, 40).replace(/\s+/g, ' ')}`
}

const before = await requestWebJson(config, `${COLUMN_API}/articles/${id}`, { signed: true })
console.log('当前文章:', JSON.stringify({ title: before.title, updated: before.updated_time ?? before.updated ?? null }))
console.log('将改成  :', JSON.stringify({ title, chars: html.length }))
console.log('正文指纹:', fingerprint(before.content));

if (!apply) {
  console.log('\n[dry run] 加 --apply 才会真正写入')
  process.exit(0)
}

const patched = await requestWebRaw(config, `${COLUMN_API}/articles/${id}/draft`, {
  method: 'PATCH',
  retries: 0,
  signed: true,
  body: { title, content: html },
})
console.log('PATCH draft ok:', patched.ok)

const published = await requestWebJson(config, `${COLUMN_API}/articles/${id}/publish`, {
  method: 'PUT',
  retries: 0,
  signed: true,
  body: { column: null, commentPermission: 'anyone' },
})
console.log('PUT publish ok:', Boolean(published?.id ?? published?.url ?? true))

const after = await requestWebJson(config, `${COLUMN_API}/articles/${id}`, { signed: true })
console.log('更新后:', JSON.stringify({ title: after.title, updated: after.updated_time ?? after.updated ?? null }))
console.log('新正文指纹:', fingerprint(after.content))
unlinkSync(bodyPath)
