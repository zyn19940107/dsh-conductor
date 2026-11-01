import { readFileSync, writeFileSync } from 'node:fs'

/*
 * The loop the user asked for: call the tool, look at what came back, fix the
 * call if the fix is mechanical, call again. No subagent, no model round trip.
 */

const path = 'src/batch.ts'
let text = readFileSync(path, 'utf8')

const oldImports = text.split('\n').find(line => line.startsWith('import '))
if (oldImports === undefined) throw new Error('找不到 import 行')

const hasCoerce = text.includes("from './coerce.js'")
if (!hasCoerce) {
  text = text.replace(oldImports, `${oldImports}\nimport { coerceArguments } from './coerce.js'`)
}

const oldSignature = `  let last = { ok: false, output: '', error: 'the call failed' }
  for (let attempt = 0; attempt < 2; attempt += 1) {`

const newSignature = `  let last = { ok: false, output: '', error: 'the call failed' }
  for (let attempt = 0; attempt < 2; attempt += 1) {`

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

const newRun = `  // A plan is written before anything has run, so its arguments are written by
  // hand: "5" where the tool wants 5, and so on. Coerce them to what the tool's
  // schema declares, run the call, and if the tool still rejects the arguments,
  // coerce again and try once more. Nobody is coming back to redraw the plan, so
  // this loop is where the call gets fixed.
  let args = coerceArguments(schemaOf(runner, call.name, agent), call.arguments)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runner.execute({
        callId: nextCallId(),
        rootCallId,
        name: call.name,
        arguments: args,
        ...(agent === undefined ? {} : { agent }),
        signal,
      })
      const output = contentToText(result.content, result.value)
      if (result.isError) {
        const error = result.error?.message ?? 'the call failed'
        const retried = attempt === 0 ? coerceArguments(schemaOf(runner, call.name, agent), args) : args
        if (attempt === 0 && JSON.stringify(retried) !== JSON.stringify(args)) {
          args = retried
          continue
        }
        return { name: call.name, ok: false, scheduled, output, error }
      }
      return { name: call.name, ok: true, scheduled, output, error: '' }
    } catch (error: unknown) {
      return { name: call.name, ok: false, scheduled, output: '', error: errorMessage(error) }
    }
  }
  return { name: call.name, ok: false, scheduled, output: last.output, error: last.error }
}

/**
 * The parameter schema a tool declares.
 *
 * @param runner - the tool registry the call runs through.
 * @param name - the tool being called.
 * @param agent - the agent the batch belongs to.
 * @returns the schema, or undefined when the tool is not visible.
 */
function schemaOf(runner: BatchRunner, name: string, agent: Agent | undefined): unknown {
  return runner.parameters?.(name, agent)
}`

if (!text.includes(oldRun)) throw new Error('runOne 的调用段没匹配上')
text = text.replace(oldRun, newRun)

writeFileSync(path, text)
console.log('batch.ts: 调用外面套了一个「按 schema 修参数再调一次」的循环')