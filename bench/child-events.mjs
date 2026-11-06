/**
 * A child session's own events.
 *
 * A forked child starts from a seed: the parent's conversation replayed into its
 * log. Those seeded events look exactly like the child's own — same event types,
 * same shapes — so reading them as the child's work attributes the parent's plan
 * call to the child, and every timing number after that is wrong.
 *
 * Everything a child did starts after the seed closes. This module returns the
 * events from that boundary on, and says how many were inherited, so a caller
 * can print or assert the split instead of trusting a number that might be the
 * parent's.
 */

import { decodeLog } from './sessions.mjs'

/** Where the harness keeps the bench session logs. */
export const SESSIONS = 'D:/code/vibe/dsh-sandbox/home/sessions/--D-code-vibe--'

const LF = String.fromCharCode(10)

/**
 * Every event of one session, all segments, in order.
 *
 * @param session - the session directory name.
 * @returns the events.
 */
export function sessionEvents(session) {
  const events = []
  for (const file of readdirOf(session).filter(entry => entry.endsWith('.zstd')).sort()) {
    try {
      events.push(...decodeLog(joinOf(session, file)).split(LF).filter(Boolean).map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean))
    } catch {
      // torn segment
    }
  }
  return events
}

/**
 * The part of a session that the session itself produced.
 *
 * @param session - the session directory name.
 * @returns the inherited count and the own events.
 */
export function ownEvents(session) {
  const all = sessionEvents(session)
  const boundary = all.findIndex(event => String(event.type).includes('end-seed'))
  return boundary < 0
    ? { inherited: 0, own: all }
    : { inherited: boundary + 1, own: all.slice(boundary + 1) }
}

/**
 * @param event - a session event.
 * @returns its wall-clock stamp in milliseconds.
 */
export function stamp(event) {
  return event.timestamp ?? event.time ?? 0
}

/**
 * Every child session whose parent is one run.
 *
 * @param parentSessionId - the parent's session id.
 * @returns the matching directory names.
 */
export function childrenOf(parentSessionId) {
  return readdirOfRoot().filter(entry => {
    if (!entry.startsWith('refine-loop-child-')) return false
    const header = sessionEvents(entry).find(event => event.type === 'session')
    const owner = header?.data?.parentSession ?? header?.parentSession
    return owner === parentSessionId
  })
}

// Node's fs is imported lazily so this module stays usable from a browser-less
// context without a bundler resolving 'node:fs' at build time.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param session - a session directory name.
 * @returns its file names.
 */
function readdirOf(session) {
  return readdirSync(join(SESSIONS, session))
}

/**
 * @param session - a session directory name.
 * @param file - a file inside it.
 * @returns the joined path.
 */
function joinOf(session, file) {
  return join(SESSIONS, session, file)
}

/**
 * @returns every session directory name.
 */
function readdirOfRoot() {
  return readdirSync(SESSIONS)
}
