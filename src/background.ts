/**
 * Background commands that outlive the node that started them.
 *
 * A node's budget stops the node, not the work. The harness's own background
 * jobs cannot carry that job across a node boundary: they are owned by the
 * session that started them, a child's jobs are cancelled when the child is
 * disposed, and the parent cannot read them at all because every read is fenced
 * by the owner's session id. So this module starts its commands as **unowned**
 * jobs instead. The registry's unowned bucket is visible to every session and
 * lives until the harness exits, which is the one property the parent needs: a
 * handle it can collect with the ordinary `job_output` / `job_kill` tools once
 * the round that started the work has moved on.
 *
 * The node's report carries the handle. A child that started a job here leaves
 * it running when its budget lands, says what it started, and the next round
 * decides who collects or kills it.
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

/** The tool the model calls to start one of these. */
export const BG_TOOL = 'bg'

/**
 * How long an unowned job may run before the plugin ends it on its own.
 *
 * Nothing else reaps an unowned job — no session owns it, so no session teardown
 * stops it — and a command left running for hours holds a process and a ring for
 * the rest of the harness's life. Half an hour is far longer than any benchmark
 * or test suite these plans run.
 */
const MAX_JOB_MS = 30 * 60_000

/** The producer face the registry hands a starter. */
interface JobHandleLike {
  readonly id: string
  append(text: string, options?: { channel?: 'stdout' | 'stderr' | 'log' }): void
}

/** How a producer reports its end. */
interface JobOutcomeLike {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
}

/** The hooks a starter returns to the registry. */
interface JobHooksLike {
  cancel(reason?: string): void
  done: Promise<JobOutcomeLike>
}

/** The part of the harness job registry this module uses. */
interface JobsLike {
  start(spec: {
    kind: 'bash'
    label: string
    run: (job: JobHandleLike) => JobHooksLike
  }): string
  get(id: string): { readonly status: string, readonly label: string }
}

/**
 * Start one command and turn it into a job the registry can track.
 *
 * The command runs the way the shell tool would run it: pwsh on Windows, sh
 * elsewhere, in the node's own working directory. Both streams are appended to
 * the ring whole, so a reader sees exactly what the command printed.
 *
 * @param job - the registry's producer face for the new job.
 * @param command - the command line to run.
 * @param cwd - the directory to run it in; the registry has no opinion.
 * @returns the hooks the registry holds: cancel, and the end of the work.
 */
function runCommand(job: JobHandleLike, command: string, cwd: string | undefined): JobHooksLike {
  const windows = process.platform === 'win32'
  const child = windows
    ? spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd,
        windowsHide: true,
        env: process.env,
      })
    : spawn('sh', ['-c', command], { cwd, env: process.env })
  let settled = false
  let resolveDone: (outcome: JobOutcomeLike) => void = () => {}
  const done = new Promise<JobOutcomeLike>((resolve) => { resolveDone = resolve })
  const newline = String.fromCharCode(10)
  const settle = (outcome: JobOutcomeLike): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolveDone(outcome)
  }
  child.stdout?.on('data', (chunk: Buffer) => { job.append(String(chunk), { channel: 'stdout' }) })
  child.stderr?.on('data', (chunk: Buffer) => { job.append(String(chunk), { channel: 'stderr' }) })
  child.on('error', (error: unknown) => {
    job.append(`${String(error)}${newline}`, { channel: 'stderr' })
    settle({ status: 'failed', detail: 'could not start' })
  })
  child.on('close', (code: number | null) => {
    settle(code === 0
      ? { status: 'completed', detail: 'exit code: 0' }
      : { status: 'failed', detail: `exit code: ${String(code)}` })
  })
  const timer = setTimeout(() => {
    killTree(child)
    settle({ status: 'killed', detail: `stopped after ${Math.round(MAX_JOB_MS / 60_000)} minutes` })
  }, MAX_JOB_MS)
  return {
    cancel: () => { killTree(child) },
    done,
  }
}

/**
 * End the command and everything it started.
 *
 * On Windows a plain kill reaches pwsh but not the process tree it spawned — a
 * python run under it would survive — so the tree is asked to go down together.
 *
 * @param child - the process to end.
 */
function killTree(child: { pid?: number, kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    } catch {
      // Fall through to the plain kill.
    }
  }
  try {
    child.kill()
  } catch {
    // The process is already gone.
  }
}

/**
 * The commands one node started, and where their handles go.
 *
 * A node is not required to remember what it started: the plugin records it when
 * the job is created, and reads the live ones back when the node ends. That is
 * what turns "I left a benchmark running" into a line the parent can act on.
 */
export class Background {
  private readonly jobs: JobsLike | undefined
  private readonly bySession = new Map<string, Set<string>>()

  /**
   * @param jobs - the composition's job registry, when it has one.
   */
  constructor(jobs: JobsLike | undefined) {
    this.jobs = jobs
  }

  /** Whether this composition can start background jobs at all. */
  get available(): boolean {
    return this.jobs !== undefined
  }

  /**
   * Start one command as an unowned job and remember who asked for it.
   *
   * @param sessionId - the conversation that asked, for the handle list later.
   * @param command - the command line to run.
   * @param cwd - the directory to run it in.
   * @returns the job's id and label.
   */
  start(sessionId: string, command: string, cwd: string | undefined): { jobId: string, label: string } {
    const jobs = this.jobs
    if (jobs === undefined) throw new Error('this composition has no background job registry')
    const label = command.replace(/\s+/g, ' ').trim().slice(0, 120)
    const jobId = jobs.start({
      kind: 'bash',
      label,
      run: (job) => runCommand(job, command, cwd),
    })
    const started = this.bySession.get(sessionId) ?? new Set<string>()
    started.add(jobId)
    this.bySession.set(sessionId, started)
    return { jobId, label }
  }

  /**
   * The handles a node is leaving behind, as lines the parent can use.
   *
   * Settled jobs are dropped: their output is already in the report's world (the
   * parent can still read them by id, but they are not work waiting to be handed
   * over).
   *
   * @param sessionId - the conversation that just ended.
   * @returns one line per live job, or nothing when it left none.
   */
  handlesOf(sessionId: string): string[] {
    const started = this.bySession.get(sessionId)
    if (started === undefined || this.jobs === undefined) return []
    const lines: string[] = []
    for (const id of started) {
      let view: { readonly status: string, readonly label: string }
      try {
        view = this.jobs.get(id)
      } catch {
        started.delete(id)
        continue
      }
      if (view.status !== 'running' && view.status !== 'stopping') continue
      lines.push(`- ${id} (${view.status}): ${view.label}`)
    }
    return lines
  }
}

/** What the model reads before it calls the tool. */
export const BG_TOOL_DESCRIPTION = 'Start a command that will run for a while as a background job, and return its '
  + 'job id immediately. Use this instead of a blocking shell call for anything that may take minutes — a test '
  + 'suite, a benchmark, a build: the job keeps running after this node ends, so its budget cannot cut the run '
  + 'short, and the next round can collect it with job_output or stop it with job_kill. The job is unowned: any '
  + 'conversation can read it, including the parent. Do not poll it here — start it, and put its id in your '
  + 'conclusion. It is stopped after 30 minutes.'

/**
 * Register the background tool.
 *
 * @param ctx - the plugin context supplying the tool registry.
 * @param background - the jobs this node starts, and the handles it leaves.
 */
export function applyBackgroundTool(ctx: Context, background: Background): void {
  ctx.tools.register(defineTool({
    name: BG_TOOL,
    description: BG_TOOL_DESCRIPTION,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The command line to run, in the node\'s working directory. It is unowned and outlives the '
          + 'node; its output is read with job_output.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          label: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args: { [key: string]: unknown }, value: unknown) => {
        const started = value as { jobId: string, label: string, note: string }
        return [{ type: 'text', text: `${started.jobId} started: ${started.label}${String.fromCharCode(10)}${started.note}` }]
      },
    },
    async execute(args, exec: ToolRunContext) {
      const command = String((args as { command?: unknown }).command ?? '').trim()
      if (command === '') throw new Error('bg needs a command to run')
      if (!background.available) throw new Error('this composition has no background job registry')
      const agent = exec.agent
      const sessionId = agent?.session.id ?? 'unknown'
      const cwd = (agent?.session.header as { cwd?: string } | undefined)?.cwd
      const started = background.start(sessionId, command, cwd)
      return {
        jobId: started.jobId,
        label: started.label,
        note: 'Running as an unowned background job: it survives this node, and any conversation can read it with '
          + 'job_output or stop it with job_kill. Name the id in your conclusion so the next round can collect it.',
      }
    },
  }))
}