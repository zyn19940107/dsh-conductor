/**
 * Temporary probe: what does the Config schema do with an unknown key, and
 * what defaults do the live config values carry?
 */

import { Config } from '../src/index.js'

console.log('Config is a function:', typeof Config)

// The deployment patch (cordis.patch.yml) sets conclusionPullbacks, which the
// Config schema does not declare.
try {
  const resolved = (Config as unknown as (input: unknown) => Record<string, unknown>)({
    enabled: true,
    maxBatchSize: 8,
    conclusionPullbacks: 10,
    shellTool: 'ops_bash',
  })
  console.log('resolved keys:', Object.keys(resolved).sort().join(','))
  console.log('conclusionPullbacks kept?', 'conclusionPullbacks' in resolved)
  console.log('shellTool:', resolved.shellTool)
  console.log('maxRounds:', resolved.maxRounds)
  console.log('maxSlices:', resolved.maxSlices)
  console.log('concurrentTools:', JSON.stringify(resolved.concurrentTools))
} catch (error: unknown) {
  console.log('Config threw:', error instanceof Error ? error.message : String(error))
}
