import { readFileSync, writeFileSync } from 'node:fs'

/**
 * A call that failed inside a plan is retried once.
 *
 * The plan is one unit of work and the turn ends when it has run, so a
 * transient failure — a timeout, a rate limit, a dropped connection — has to
 * be handled inside the plan. There is no second attempt afterwards: the
 * model does not come back to draw another plan.
 */

const path = 'src/batch.ts'
let text = readFileSync(path, 'utf8')

const oldRun = `  try {
    const result = await runner.execute({
      callId: nextCallId(),
      rootCallId,
      name: call.name,
      arguments: call.arguments,
      ...(agent === undefined ? {} : { agent }),
      signal,
    })
    const output = contentToText(result.content, result.value)
    if (result.isError) {
      return {
        name: call.name,
        ok: false,
        scheduled,
        output,
        error: result.error?.message ?? 'the call failed',
      }
    }
    return { name: call.name, ok: true, scheduled, output, error: '' }
  } catch (error: unknown) {
    return { name: call.name, ok: false, scheduled, output: '', error: errorMessage(error) }
  }
}`

const newRun = `  let last = { ok: false, output: '', error: 'the call failed' }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runner.execute({
        callId: nextCallId(),
        rootCallId,
        name: call.name,
        arguments: call.arguments,
        ...(agent === undefined ? {} : { agent }),
        signal,
      })
      const output = contentToText(result.content, result.value)
      if (result.isError) {
        last = { ok: false, output, error: result.error?.message ?? 'the call failed' }
        continue
      }
      return { name: call.name, ok: true, scheduled, output, error: '' }
    } catch (error: unknown) {
      last = { ok: false, output: '', error: errorMessage(error) }
    }
  }
  return { name: call.name, ok: false, scheduled, output: last.output, error: last.error }
}`

if (!text.includes(oldRun)) throw new Error('runOne 没匹配上')
text = text.replace(oldRun, newRun)

writeFileSync(path, text)
console.log('batch.ts 改了:失败的调用重试一次')
