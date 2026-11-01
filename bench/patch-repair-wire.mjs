import { readFileSync, writeFileSync } from 'node:fs'

/*
 * The loop: run the call, and if it failed, ask the model what the call should
 * have been, then run that. Only the failing call is repaired; the rest of the
 * plan is untouched. No subagent, no second plan.
 */

const path = 'src/batch.ts'
let text = readFileSync(path, 'utf8')

// Drop the coercion attempt: the repair goes through the model now.
text = text.replace(/import \{ coerceArguments \} from '\.\/coerce\.js'\n/, '')
text = text.replace(
  /  \/\/ A plan is written before anything has run[\s\S]*?  let args = coerceArguments\([^\n]*\n  for \(let attempt = 0; attempt < 2; attempt \+= 1\) \{/,
  `  for (let attempt = 0; attempt <= seconds.repairs; attempt += 1) {`,
)

// The call body: repair through the model when the run failed.
const oldBody = `      const output = contentToText(result.content, result.value)
      if (result.isError) {
        const error = result.error?.message ?? 'the call failed'
        const retried = attempt === 0 ? coerceArguments(schemaOf(runner, call.name, agent), args) : args
        if (attempt === 0 && JSON.stringify(retried) !== JSON.stringify(args)) {
          args = retried
          continue
        }
        return { name: call.name, ok: false, scheduled, output, error }
      }
      return { name: call.name, ok: true, scheduled, output, error: '' }`

const newBody = `      const output = contentToText(result.content, result.value)
      if (result.isError) {
        const error = result.error?.message ?? 'the call failed'
        last = { ok: false, output, error }
        // The turn ends when the plan has run, so this is the last chance to
        // get the call right: ask the model what it should have been.
        if (seconds.repair === undefined || attempt >= seconds.repairs) break
        const fixed = await seconds.repair({ name, arguments: args }, error, seconds.schema, seconds.signal)
        if (fixed === undefined) break
        name = fixed.name
        args = fixed.arguments
        continue
      }
      return { name: call.name, ok: true, scheduled, output, error: '' }`

if (!text.includes(oldBody)) throw new Error('调用体没匹配上')
text = text.replace(oldBody, newBody)

writeFileSync(path, text)
console.log('batch.ts 改了')