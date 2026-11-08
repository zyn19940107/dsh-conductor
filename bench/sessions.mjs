/**
 * Read the sandbox's session logs: identity, tree, and provider accounting.
 *
 * The token accounting a session log carries is the provider's own report on
 * each `assistant/message` event. A plan's calls do not produce top-level
 * tool-call events, and a delegated agent's tokens live in the child's own
 * log, so the only complete number is the sum over the whole tree.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Decode every zstd frame in one session log and return the concatenated text.
 *
 * A session log is several zstd frames laid end to end. Decompressing the
 * whole file as one stream yields only the first frame, so the frames have to
 * be found and inflated one by one.
 *
 * @param {string} file - the log file.
 * @returns {string} the decoded text.
 */
export function decodeLog(file) {
  const data = readFileSync(file)
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 4 <= data.length; i += 1) {
    if (data[i] === magic[0] && data[i + 1] === magic[1] && data[i + 2] === magic[2] && data[i + 3] === magic[3]) {
      starts.push(i)
    }
  }
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : data.length
    try {
      text += zstdDecompressSync(data.subarray(from, to)).toString('utf8')
    } catch {
      // A frame that does not inflate carries nothing this reader needs.
    }
  }
  return text
}

/**
 * One session's identity and accounting.
 *
 * @typedef {object} SessionFacts
 * @property {string} id - the session id.
 * @property {string|undefined} parent - the session that spawned it.
 * @property {number} depth - how deep the session is.
 * @property {number} input - uncached input tokens the provider reported.
 * @property {number} output - output tokens the provider reported.
 * @property {number} cacheRead - cache-read tokens the provider reported.
 * @property {number} steps - the model round trips the session took.
 * @property {number} lastPrompt - the prompt size of the session's last request.
 * @property {string} firstUserMessage - the first user message, for matching a run.
 */

/**
 * Read every session log under a sessions root.
 *
 * @param {string} root - the directory holding one directory per session.
 * @returns {Map<string, SessionFacts>} the facts, keyed by session id.
 */
export function readSessions(root) {
  const sessions = new Map()
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    return sessions
  }
  for (const entry of entries) {
    const directory = join(root, entry.name)
    for (const file of readdirSync(directory)) {
      if (!file.endsWith('.zstd')) continue
      const facts = readOne(join(directory, file))
      if (facts === undefined) continue
      // One session may be written as several segment files; each segment only
      // carries its own events, so the totals add up rather than overwrite.
      const existing = sessions.get(facts.id)
      if (existing === undefined) {
        sessions.set(facts.id, facts)
        continue
      }
      existing.input += facts.input
      existing.output += facts.output
      existing.cacheRead += facts.cacheRead
      existing.steps += facts.steps
      existing.lastPrompt = Math.max(existing.lastPrompt, facts.lastPrompt)
    }
  }
  return sessions
}

/**
 * Read one session log.
 *
 * @param {string} file - the log file.
 * @returns {SessionFacts|undefined} the facts.
 */
function readOne(file) {
  const text = decodeLog(file)
  if (text === '') return undefined
  const facts = {
    id: '',
    parent: undefined,
    depth: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    steps: 0,
    lastPrompt: 0,
    firstUserMessage: '',
  }
  const events = []
  for (const line of text.split(String.fromCharCode(10))) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // torn line
    }
  }
  // A forked child's log begins with a copy of the parent's conversation. Those
  // seeded events carry the parent's own usage, and summing them here would count
  // the parent's tokens once per child — the on arm's totals grow with every
  // child forked. Only the events after the seed boundary are this session's own.
  // The session header is read from anywhere: it sits before the seed.
  const header = events.find(event => event.type === 'session')
  if (header !== undefined) {
    facts.id = String(header.id ?? '')
    facts.parent = header.parentSession
    facts.depth = Number(header.delegationDepth ?? 0)
  }
  const boundary = events.findIndex(event => String(event.type).includes('end-seed'))
  for (let index = boundary + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'step/start') {
      facts.steps += 1
      continue
    }
    if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage !== undefined) {
        facts.input += usage.inputTokens ?? 0
        facts.output += usage.outputTokens ?? 0
        facts.cacheRead += usage.cacheReadTokens ?? 0
        facts.lastPrompt = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
      }
    }
  }
  return facts.id === '' ? undefined : facts
}

/**
 * Every session under one root, with its subtree.
 *
 * @param {Map<string, SessionFacts>} sessions - all the sessions.
 * @param {string} rootId - the root session.
 * @returns {SessionFacts[]} the root and everything below it.
 */
export function subtree(sessions, rootId) {
  const children = new Map()
  for (const facts of sessions.values()) {
    if (facts.parent === undefined) continue
    const list = children.get(facts.parent) ?? []
    list.push(facts)
    children.set(facts.parent, list)
  }
  const collected = []
  const walk = (id) => {
    const facts = sessions.get(id)
    if (facts === undefined) return
    collected.push(facts)
    for (const child of children.get(id) ?? []) walk(child.id)
  }
  walk(rootId)
  return collected
}

/**
 * The totals of a set of sessions.
 *
 * @param {SessionFacts[]} facts - the sessions.
 * @returns {object} the summed tokens and the session count.
 */
export function totals(facts) {
  const sum = key => facts.reduce((total, entry) => total + entry[key], 0)
  return {
    sessions: facts.length,
    input: sum('input'),
    output: sum('output'),
    cacheRead: sum('cacheRead'),
    total: sum('input') + sum('output') + sum('cacheRead'),
    steps: sum('steps'),
  }
}
