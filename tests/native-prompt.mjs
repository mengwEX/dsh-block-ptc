/** Offline prompt assembly against installed DSH services; never calls a model. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import * as plugin from '../lib/plugin.js'
import { HEADER_GUIDANCE } from '../lib/prompts.js'

if (!process.argv[2]) throw new Error('Usage: node tests/native-prompt.mjs /absolute/path/to/dsh-tools/lib/index.js')
const toolsUrl = pathToFileURL(resolve(process.argv[2]))
const load = (name) => import(new URL(`../../${name}/lib/index.js`, toolsUrl).href)
const [{ Context }, { default: SystemPrompt }, { default: Tools }, { PtcRuntime }] = await Promise.all([
  load('cordis'), load('dsh-system-prompt'), import(toolsUrl.href), load('dsh-ptc-runtime'),
])

class OfflineRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'offline'
  async run() { throw new Error('Prompt assembly must not execute programs') }
}

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(OfflineRuntime)
await ctx.plugin(Tools, { mode: 'ptc' })
// Make the native SDK emit its real outer run_code example with nested descriptions.
ctx.tools.register({
  name: 'bash', description: 'Run a command.',
  parameters: { type: 'object', properties: {
    command: { type: 'string' }, description: { type: 'string' },
  }, required: ['command', 'description'] },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() { throw new Error('Prompt assembly must not execute tools') },
})
const original = await ctx.systemPrompt.assemble()
assert(original.sections.find((section) => section.name === 'tools:sdk').text.includes('description: "Show current directory"'))
await ctx.plugin(plugin)
const assembled = await ctx.systemPrompt.assemble()
assert.deepEqual(assembled.tools.map((tool) => tool.name), ['run_code'])
const transport = assembled.tools[0]
assert.equal(transport.parameters.properties.description.description, HEADER_GUIDANCE)
assert.match(transport.description, /including the first/)
const sdk = assembled.sections.find((section) => section.name === 'tools:sdk').text
assert.match(sdk, /block_compact/)
assert(!sdk.includes('block_summary'))
assert(!sdk.includes('description: "Show current directory"'))
assert.match(sdk, /description: "\[block: <ids>\] <goal>"/)
assert.match(sdk, /content: string/)
assert(!sdk.includes('summary: string'))
assert.deepEqual(transport.parameters.properties.code, original.tools[0].parameters.properties.code)
assert.deepEqual(transport.parameters.required, original.tools[0].parameters.required)
console.log('Native DSH initial request prompt and SDK assembly: OK (offline, no API)')
