/**
 * Create the two benchmark sandboxes: one with the plugin, one without.
 *
 * The A/B needs two profiles that differ in exactly one thing. The plugin's own
 * bundle is the difference, so both profiles get the same harness bundles and
 * the same provider configuration, and only `bench-on` lists the plugin.
 *
 * The "off" arm used to be the same profile with an overlay that set
 * `enabled: false`. That is close, but it is not the same thing: a profile that
 * never had the plugin cannot carry a stale row, a stale tool registration or a
 * stale prompt section. Two profiles remove the question.
 *
 * Usage: node bench/setup-profiles.mjs
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SANDBOX_HOME = process.env.DSH_SANDBOX_HOME ?? 'D:/code/vibe/dsh-sandbox/home'
const PROFILES = resolve(SANDBOX_HOME, 'profiles')
const PLUGIN_SRC = process.env.DSH_BENCH_PLUGIN_SRC ?? REPO
const PLUGIN_NAME = '@zyn19940107/dsh-refine-loop'

/**
 * The provider configuration both profiles need.
 *
 * The model and the key are the benchmark's own: the same model in both arms,
 * or the comparison measures the model instead of the plugin.
 */
const PATCH = `# Benchmark profile: the harness, the model, and nothing else.
#
# Every other plugin the sandbox profile installs is left out on purpose. A
# plugin that registers its own delegation tool is a second instruction set
# competing with the one being measured, and the model then follows the one
# that is not under test.

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      minimax-cn:
        models:
          - id: MiniMax-M3.1-Flash
            name: MiniMax-M3.1-Flash
            contextWindow: 1048576
            maxTokens: 512000
            input:
              - text
              - image
        apiKeyEnv: MINIMAX_CN_API_KEY

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: minimax-cn
    model: MiniMax-M3.1-Flash

# The harness caps subagent depth at 1 by default. That is the honest default
# for the benchmark: the plugin's own maxAgentDepth only becomes reachable when
# a deployment raises this one too.
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxDepth: 3
`

/**
 * The plugin row, for the profile that has the plugin.
 *
 * The plugin itself is not modified: this is the deployment's configuration of
 * it. `shellTool` names the shell the benchmark profile actually has. The
 * plugin's own default names dsh-ops' `ops_bash`; this profile runs the
 * harness's own `pwsh`, so the read-only-shell rule has to point at the tool
 * that exists, or the rule is inert and every shell call runs alone.
 */
const PLUGIN_ROW = `
# The plugin under test.
- id: refine-loop
  name: '@zyn19940107/dsh-refine-loop'
  config:
    enabled: true
    shellTool: pwsh
`

/**
 * Write one profile.
 *
 * @param {string} name - the profile's name.
 * @param {boolean} withPlugin - whether the plugin is part of it.
 * @returns {string} the profile's directory.
 */
function writeProfile(name, withPlugin) {
  const dir = resolve(PROFILES, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
  const dependencies = {}
  if (withPlugin) {
    bundles.push(PLUGIN_NAME)
    dependencies[PLUGIN_NAME] = `link:${PLUGIN_SRC}`
  }
  writeFileSync(resolve(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2)}\n`)
  writeFileSync(resolve(dir, 'cordis.yml'), '[]\n')
  writeFileSync(resolve(dir, 'cordis.patch.yml'), withPlugin ? PATCH + PLUGIN_ROW : PATCH)
  writeFileSync(resolve(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
  return dir
}

/**
 * Install the profile's dependencies.
 *
 * @param {string} dir - the profile's directory.
 */
function install(dir) {
  const result = spawnSync('pnpm', ['install', '--ignore-scripts'], {
    cwd: dir,
    shell: true,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`pnpm install failed in ${dir} (exit ${String(result.status)})`)
    process.exitCode = 1
  }
}

for (const [name, withPlugin] of [['bench-off', false], ['bench-on', true]]) {
  const dir = writeProfile(name, withPlugin)
  console.log(`profile ${name} written to ${dir}`)
  install(dir)
  const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  console.log(`  bundles: ${manifest.dsh.profile.bundles.join(', ')}`)
  console.log(`  plugin present: ${existsSync(resolve(dir, 'node_modules', '@zyn19940107', 'dsh-refine-loop'))}`)
}
