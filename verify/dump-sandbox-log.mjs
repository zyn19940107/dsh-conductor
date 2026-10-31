// Decode every zstd frame of a DSH session log and print the tool traffic.
//
// A session log is a concatenation of independently written zstd frames, so a
// whole-buffer decompress only yields the first one. This walks the file,
// finds every frame boundary, and decodes each frame on its own.

import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const data = fs.readFileSync(file)

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function findFrameOffsets(bytes) {
  const offsets = []
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === ZSTD_MAGIC[0] && bytes[i + 1] === ZSTD_MAGIC[1]
      && bytes[i + 2] === ZSTD_MAGIC[2] && bytes[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i)
    }
  }
  return offsets
}

const offsets = findFrameOffsets(data)
console.log(`file: ${file}`)
console.log(`size: ${data.length}, zstd frames: ${offsets.length}`)

const parts = []
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : data.length
  try {
    parts.push(zlib.zstdDecompressSync(data.subarray(start, end)).toString('utf8'))
  } catch {
    // A frame that does not decode contributes nothing.
  }
}
const whole = parts.join('')
console.log(`decoded text: ${whole.length} chars`)

for (const line of whole.split('\n')) {
  if (line.trim() === '') continue
  let o
  try { o = JSON.parse(line) } catch { continue }
  if (o.type === 'tool/call') {
    console.log(`\n[${o.time ?? ''}] tool/call ${o.data?.name} (turn=${o.data?.turn} step=${o.data?.step})`)
    console.log('  args:', JSON.stringify(o.data?.arguments).slice(0, 1400))
  } else if (o.type === 'tool/result') {
    const content = o.data?.message?.content ?? []
    const text = content.map(b => b.text ?? JSON.stringify(b)).join('\n')
    console.log(`\n[${o.time ?? ''}] tool/result`)
    console.log(text.slice(0, 2600))
  }
}
