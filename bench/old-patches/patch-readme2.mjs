import { readFileSync, writeFileSync } from 'node:fs'

const path = 'README.md'
let text = readFileSync(path, 'utf8')

const oldHead = `这个插件提供另一种形状，并且**在能强制的地方强制**。`

const newHead = `这个插件提供另一种形状：**模型不自己调工具** —— 它要做的每一件事都得先画成一张图，
由图去跑，图里能并行的就并行。模型自己决定这一步是画图还是写结论：
画图，图执行完，循环继续；写结论，整个循环结束。

而且**在能强制的地方强制**：模型直接调工具会被拒绝，直到它把活交成一张图。`

if (!text.includes(oldHead)) throw new Error('开头那段没匹配上')
text = text.replace(oldHead, newHead)

const oldTitle = '## 插件做了四件事'
if (!text.includes(oldTitle)) throw new Error('标题没匹配上')
text = text.replace(oldTitle, '## 插件做了三件事')

writeFileSync(path, text)
console.log('README 改了')
