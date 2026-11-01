import { readFileSync, writeFileSync } from 'node:fs'

/*
 * The retry goes away, and the two node kinds say what they really are.
 *
 * A `tools` node is a batch of calls written before anything has run: nothing
 * looks at a result before the next call, so a failure in it is not repaired.
 * A `subagent` node is the ordinary call → think → call chain, run inside the
 * plan: the child sees each result and decides the next call, so it can get
 * itself out of trouble without coming back to the parent.
 */

const batch = 'src/batch.ts'
let batchText = readFileSync(batch, 'utf8')

const oldRun = `  let last = { ok: false, output: '', error: 'the call failed' }
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

const newRun = `  try {
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

if (!batchText.includes(oldRun)) throw new Error('batch 的重试段没匹配上')
batchText = batchText.replace(oldRun, newRun)
writeFileSync(batch, batchText)
console.log('batch.ts: 去掉盲目重试')

const index = 'src/index.ts'
let text = readFileSync(index, 'utf8')

const oldKinds = `  '- A node is one of three kinds. "tools": calls that run together. "subagent": a self-contained task for '
  + 'a child that starts with no context — use it when the task needs nothing from this conversation, such '
  + 'as researching a topic, auditing a file, or doing a scoped piece of work. "subagent_fork": a task for '
  + 'a child that inherits this conversation — use it when the task builds on what has already been said '
  + 'here, such as a follow-up analysis or a review of this conversation. You decide which one each task '
  + 'needs.',`

const newKinds = `  '- A node is one of three kinds. "tools": a batch of calls written before anything has run — they run '
  + 'together and nothing looks at a result before the next call, so it cannot correct itself; use it when '
  + 'the calls are plain and sure, such as reading files you can name exactly. "subagent"/"subagent_fork": '
  + 'the ordinary call → think → call chain, run inside the plan — the child sees each result and decides '
  + 'the next call, so it can work its own way out of a failure; use it when the work needs looking at what '
  + 'came back, such as auditing, searching, or tracing something you cannot name in advance. "subagent" '
  + 'starts with no context; "subagent_fork" inherits this conversation. You decide which one each task '
  + 'needs.',`

if (!text.includes(oldKinds)) throw new Error('节点种类那段没匹配上')
text = text.replace(oldKinds, newKinds)
writeFileSync(index, text)
console.log('index.ts: 三种节点的说明改成「会不会自己修」')