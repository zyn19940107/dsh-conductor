import { readFileSync, writeFileSync } from 'node:fs'

/**
 * The turn ends when the plan has run.
 *
 * The model draws a plan, the plan runs, and the turn is over: the results it
 * produced are what the turn produced. Coming back to draw another plan is
 * exactly the chain this plugin is here to replace.
 */

const path = 'src/gate.ts'
let text = readFileSync(path, 'utf8')

const oldClass = `export class PlanGate {
  private readonly before = new Map<string, number>()
`

const newClass = `export class PlanGate {
  private readonly before = new Map<string, number>()
  private readonly planned = new Map<string, ToolCallId>()
`

if (!text.includes(oldClass)) throw new Error('类头没匹配上')
text = text.replace(oldClass, newClass)

const oldReset = `  /**
   * Forget one conversation's pullbacks.
   *
   * @param sessionId - the session the turn belongs to.
   */
  reset(sessionId: string): void {
    this.before.delete(sessionId)
  }
}`

const newReset = `  /**
   * Record the plan the turn handed over.
   *
   * @param sessionId - the session the plan belongs to.
   * @param callId - the call the plan was handed over with.
   */
  markPlanned(sessionId: string, callId: ToolCallId): void {
    if (!this.planned.has(sessionId)) {
      this.planned.set(sessionId, callId)
    }
  }

  /**
   * Whether the turn has handed over a plan.
   *
   * @param sessionId - the session the turn belongs to.
   * @returns true when a plan has run in this turn.
   */
  hasPlanned(sessionId: string): boolean {
    return this.planned.has(sessionId)
  }

  /**
   * Forget one conversation's pullbacks and its plan.
   *
   * @param sessionId - the session the turn belongs to.
   */
  reset(sessionId: string): void {
    this.before.delete(sessionId)
    this.planned.delete(sessionId)
  }
}`

if (!text.includes(oldReset)) throw new Error('reset 没匹配上')
text = text.replace(oldReset, newReset)

const oldHook = `  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter' && payload.step === 1) {
      gate.reset(payload.agent.session.id)
    }
    return decision
  })`

const newHook = `  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const sessionId = payload.agent.session.id
    if (payload.step === 1) {
      gate.reset(sessionId)
      return decision
    }
    // The plan has run: the turn is over. What it produced is what the turn
    // produced. Coming back to draw another plan is the chain this plugin is
    // here to replace.
    if (gate.hasPlanned(sessionId)) {
      return { kind: 'reject' }
    }
    return decision
  })`

if (!text.includes(oldHook)) throw new Error('pre-step 钩子没匹配上')
text = text.replace(oldHook, newHook)

writeFileSync(path, text)
console.log('gate.ts 改了:图跑完这一轮就结束')
