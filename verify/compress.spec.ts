/**
 * Compressing an oversized tool result before it enters a plan report.
 *
 * The harness truncates a result that is too large: it keeps the head and the
 * tail, drops the middle into a spill file, and says so. Inside a plan that is
 * not good enough — the report carries every call's output, so a spilled result
 * makes the report large enough to be truncated as well, and truncating the
 * report loses whole nodes.
 *
 * So a spilled result is read back in full and compressed with the model.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { compressToolOutput, needsCompression, spilledText, SPILL_NOTICE } from '../src/compress.js'

let failures = 0

/**
 * Assert one condition.
 *
 * @param name - what is being asserted.
 * @param condition - the condition that must hold.
 * @param detail - what to print when it does not.
 */
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * A model registry that answers with a fixed text and records the prompt.
 *
 * @param answer - what the model replies.
 * @returns the context and the recorded prompts.
 */
function fakeContext(answer: string): {
  ctx: { llm: { stream: (request: unknown) => AsyncIterable<{ type: string, text: string }> } }
  prompts: string[]
} {
  const prompts: string[] = []
  return {
    prompts,
    ctx: {
      llm: {
        stream: (request: unknown) => {
          const { messages } = request as { messages: { content: { text: string }[] }[] }
          prompts.push(messages[0]?.content[0]?.text ?? '')
          return (async function* () {
            yield { type: 'text-delta', text: answer }
          })()
        },
      },
    },
  }
}

const route = { provider: 'p', model: 'm' }
const signal = new AbortController().signal

// 1. A small result needs no compression; a spilled one always does.
check('small result: no compression', needsCompression('a short output') === false)
check('spilled result: compression', needsCompression(`head\n${SPILL_NOTICE}/tmp/x.txt. Use read.`) === true)

// 2. A spilled result is read back in full, and the compressor sees all of it.
const dir = await mkdtemp(join(tmpdir(), 'refine-compress-'))
try {
  const full = Array.from({ length: 500 }, (_, index) => `line ${index} — ${'x'.repeat(40)}`).join('\n')
  const spillPath = join(dir, 'out.txt')
  await writeFile(spillPath, full, 'utf8')
  const spilled = spilledText(`head\n${SPILL_NOTICE}${spillPath}. Use read with offset/limit, or grep this path to search within it.)`)
  check('spilled text is read back', spilled?.text === full, String(spilled?.text?.length))
  check('spill path is reported', spilled?.path === spillPath, String(spilled?.path))

  const { ctx, prompts } = fakeContext('THE COMPRESSION')
  const compressed = await compressToolOutput(
    ctx as never,
    route,
    'pwsh',
    `head\n${SPILL_NOTICE}${spillPath}. Use read with offset/limit, or grep this path to search within it.)`,
    signal,
  )
  check('compressed text is the model answer', compressed.startsWith('THE COMPRESSION'))
  check('model saw the full result', prompts[0]?.includes('line 499') === true)
  check('model was told the tool', prompts[0]?.includes('pwsh') === true)
  check('note keeps the full length', compressed.includes(String(full.length)))
  check('note keeps the spill path', compressed.includes(spillPath))

  // 3. A result without a spill is compressed from what was returned.
  const { ctx: ctx2, prompts: prompts2 } = fakeContext('SHORT')
  const long = 'y'.repeat(60000)
  const out2 = await compressToolOutput(ctx2 as never, route, 'read', long, signal)
  check('plain long result is compressed', out2.startsWith('SHORT'))
  check('plain long result reached the model', prompts2[0]?.includes('y'.repeat(100)) === true)

  // 4. A medium result is not worth a model call.
  const { ctx: ctx3, prompts: prompts3 } = fakeContext('SHOULD NOT RUN')
  const medium = await compressToolOutput(ctx3 as never, route, 'read', 'm'.repeat(20000), signal)
  check('medium result is left alone', medium === 'm'.repeat(20000))
  check('medium result: no model call', prompts3.length === 0)

  // 5. The model producing nothing leaves the result alone.
  const silent = {
    llm: {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: '   ' }
      })(),
    },
  }
  const out3 = await compressToolOutput(silent as never, route, 'read', long, signal)
  check('empty compression keeps the raw result', out3 === long)
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ncompress: ok')
