/**
 * Background commands that outlive the node that started them.
 *
 * The point of the feature is one registry property: the job is started with no
 * owner. An owned job is cancelled when its session is disposed and is invisible
 * to every other session, so a node could not hand it on; an unowned job is
 * visible to any caller and lives until the harness exits, which is what lets the
 * parent collect it in the next round.
 */

import { Background } from '../src/background.ts'

let failures = 0

/**
 * Assert one condition.
 *
 * @param name - what is being asserted.
 * @param condition - the condition that must hold.
 */
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}`)
}

/** One job the fake registry was asked to start. */
interface StartedSpec {
  kind: string
  label: string
  owner?: string
}

/**
 * A registry that records what it was asked to start.
 *
 * @returns the registry, its specs, and its status map.
 */
function fakeJobs(): {
  jobs: { start: (spec: StartedSpec) => string, get: (id: string) => { status: string, label: string } }
  specs: StartedSpec[]
  statuses: Map<string, string>
} {
  const specs: StartedSpec[] = []
  const statuses = new Map<string, string>()
  return {
    specs,
    statuses,
    jobs: {
      start(spec: StartedSpec) {
        specs.push(spec)
        const id = `bash-${specs.length}`
        statuses.set(id, 'running')
        return id
      },
      get(id: string) {
        const status = statuses.get(id)
        if (status === undefined) throw new Error(`unknown job ${id}`)
        return { status, label: 'python bench.py' }
      },
    },
  }
}

console.log('a background job is started unowned')
{
  const { jobs, specs } = fakeJobs()
  const background = new Background(jobs)
  check('the composition can start jobs', background.available)
  const started = background.start('session-node-1', '  python bench.py --scale 10k  ', '/tmp/work')
  check('a job id comes back', started.jobId === 'bash-1')
  check('the label is the command, collapsed', started.label === 'python bench.py --scale 10k')
  check('the job was started as bash', specs[0]?.kind === 'bash')
  check('the job has no owner, so any session can read it', specs[0]?.owner === undefined)
}

console.log('the handles a node leaves behind are the live ones')
{
  const { jobs, statuses } = fakeJobs()
  const background = new Background(jobs)
  const first = background.start('session-node-1', 'python one.py', '/tmp').jobId
  const second = background.start('session-node-1', 'python two.py', '/tmp').jobId
  background.start('session-node-2', 'python other.py', '/tmp')

  check('both jobs are listed for the node that started them',
    background.handlesOf('session-node-1').length === 2)
  check('another node does not inherit them', background.handlesOf('session-node-2').length === 1)
  check('a handle names the id and the label',
    (background.handlesOf('session-node-1')[0] ?? '').includes(first)
    && (background.handlesOf('session-node-1')[0] ?? '').includes('python one.py'))

  statuses.set(first, 'completed')
  const live = background.handlesOf('session-node-1')
  check('a settled job is not handed over as work', live.length === 1 && !live[0].includes(first))
  statuses.set(second, 'stopping')
  check('a stopping job still counts as live', background.handlesOf('session-node-1').length === 1)
}

console.log('a composition without a job registry refuses instead of pretending')
{
  const background = new Background(undefined)
  check('it reports that it cannot start jobs', background.available === false)
  let refused = false
  try {
    background.start('session-node-1', 'python bench.py', '/tmp')
  } catch {
    refused = true
  }
  check('starting refuses with an error', refused)
  check('and it leaves no handles behind', background.handlesOf('session-node-1').length === 0)
}

if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('all checks passed')
}