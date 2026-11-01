import { readFileSync, writeFileSync } from 'node:fs'

const path = 'README.md'
let text = readFileSync(path, 'utf8')

const oldLine = `- **图的结果可能装不下。** 一张图的结果太大时会被截断，被截掉的部分模型看不见 —— 这时它应该在结论里写明「哪里没看清」，而不是接着调工具。`
const newLine = `- **图的结果可能装不下。** 一张图的结果太大时会被截断，被截掉的部分模型看不见。截掉的部分在 spill 文件里，下一张图可以把它读回来。`

if (!text.includes(oldLine)) throw new Error('那条没匹配上')
text = text.replace(oldLine, newLine)

writeFileSync(path, text)
console.log('README 改了')
