import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Only a failure that can go away is worth a second attempt.
 *
 * A file that is not there, or an argument of the wrong type, fails the same
 * way every time: retrying it just doubles the wait. A timeout, a rate limit
 * or a dropped connection can go away, so those get one more try.
 */

const path = 'src/batch.ts'
let text = readFileSync(path, 'utf8')

const oldLoop = `  let last = { ok: false, output: '', error: 'the call failed' }
  for (let attempt = 0; attempt < 2; attempt += 1) {`

const newLoop = `  let last = { ok: false, output: '', error: 'the call failed' }
  const attempts = isTransient(last.error) ? 2 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {`

if (!text.includes(oldLoop)) throw new Error('重试循环没匹配上')
text = text.replace(oldLoop, newLoop)

const marker = `/**
 * Run one call and collect its result.
 *`

const helper = `/**
 * Whether a failure is worth one more attempt.
 *
 * @param error - what the call reported.
 * @returns true when the same call could succeed the second time.
 */
function isTransient(error: string): boolean {
  const lower = error.toLowerCase()
  return lower.includes('timeout') || lower.includes('timed out')
    || lower.includes('rate limit') || lower.includes('429')
    || lower.includes('502') || lower.includes('503') || lower.includes('504')
    || lower.includes('econnreset') || lower.includes('etimedout')
    || lower.includes('socket hang up') || lower.includes('network')
}

/**
 * Run one call and collect its result.
 *`

if (!text.includes(marker)) throw new Error('runOne 的注释没匹配上')
text = text.replace(marker, helper)

writeFileSync(path, text)
console.log('batch.ts 改了:只对瞬时错误重试')
