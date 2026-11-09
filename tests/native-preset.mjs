/** Resolve the shipped preset against a real DSH installation, without starting a model. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.argv[2]) throw new Error('Usage: node tests/native-preset.mjs /absolute/path/to/dsh-tools/lib/index.js [preset.patch.yml]')
const require = createRequire(pathToFileURL(resolve(process.argv[2])))
const yaml = require('js-yaml')
// Expressions stay unevaluated: resolving a module path does not need the live profile.
const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source) => ({ source }) })
const patch = yaml.load(readFileSync(process.argv[3] ?? new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
  schema: yaml.DEFAULT_SCHEMA.extend([js]),
})
const declaration = patch.flatMap((entry) => entry.insert ?? []).find((row) => row.id === 'preset-block-ptc')
assert(declaration)
const rows = []
function visit(entries) {
  for (const row of entries) {
    rows.push(row)
    if (row.group) visit(row.config)
  }
}
visit(declaration.config.plugins)
// Check disabled entries too: platform and user settings may enable them later.
for (const row of rows) {
  if (row.name === 'cordis:group') continue
  require.resolve(row.name)
}
const load = (name) => import(pathToFileURL(require.resolve(name)).href)
const { default: AgentPreset } = await load(declaration.name)
AgentPreset.Config(declaration.config)
const executor = rows.find((row) => row.id === 'tool-executor-ptc')
const { Config: executorConfig } = await load(executor.name)
executorConfig(executor.config ?? {})
const { Config: subagentConfig } = await load('@deepseek-ai/dsh-tool-subagent')
const spawn = subagentConfig(rows.find((row) => row.id === 'tool-subagent').config)
assert.equal(spawn.modelSelection, true)
assert.equal(spawn.modelDiscovery, true)
console.log(`Native DSH preset module paths and changed configurations: OK (${rows.length} rows, offline, no API)`)
