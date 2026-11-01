import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/index.ts'
let text = readFileSync(path, 'utf8')

const oldTool = `    maxAgentDepth: () => config.maxAgentDepth.get(),
    agentNodeTimeoutMs: () => config.agentNodeTimeoutMs.get(),
  })`

const newTool = `    maxAgentDepth: () => config.maxAgentDepth.get(),
    agentNodeTimeoutMs: () => config.agentNodeTimeoutMs.get(),
    onPlanStarted: (sessionId, callId) => planGate.markPlanned(sessionId, callId),
  })`

if (!text.includes(oldTool)) throw new Error('applyPlanTool 那段没匹配上')
text = text.replace(oldTool, newTool)

writeFileSync(path, text)
console.log('index.ts 改了:onPlanStarted 接上了闸门')
