/** Optional offline check: pass an installed dsh-session module filename. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { apply, __internals as core } from '../lib/plugin.js'
import { summaryMetadata } from '../lib/blocks.js'

if (!process.argv[2]) throw new Error('Usage: node tests/native-session.mjs /absolute/path/to/dsh-session/lib/index.js')
const { Session } = await import(pathToFileURL(resolve(process.argv[2])).href)
const defs = new Map()
const ctx = {
  tools: { register: (def) => defs.set(def.name, def), guard: () => {}, execute: () => {} },
  systemPrompt: { section: () => {} }, get: () => undefined, on: () => {},
}
apply(ctx)
if (process.argv[3]) {
  const { assertObjectJsonSchema, assertSupportedJsonSchema } = await import(pathToFileURL(resolve(process.argv[3])).href)
  for (const def of defs.values()) {
    assertObjectJsonSchema(def.parameters)
    assertSupportedJsonSchema(def.output.schema)
  }
  console.log('Native DSH tool input/output schema checks: OK')
}
function sessionFor(ids, noticeSource) {
  const session = Session.create('block-ptc-offline')
  session.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'system' }] } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'user', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'task' }] }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  for (const [i, id] of [...ids].entries()) {
    if (i === 1 && noticeSource) session.append('user/message', { id: 'job-notice', role: 'user', source: noticeSource, content: [{ type: 'text', text: 'background job finished; read its output with job_output' }] }, { surfaceOp: 'append' })
    const step = i + 1, callId = `c${step}`
    session.append('step/start', { turn: 1, step })
    session.append('assistant/message', { turn: 1, step, stream: [], message: { id: `a${step}`, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'offline' }, content: [{ type: 'text', text: 'thinking before call' }, { type: 'tool-call', id: callId, name: 'block_run_code', arguments: '{}' }] } }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step, callId, name: 'block_run_code', arguments: JSON.stringify({ ids: [id] }) })
    session.append('tool/result', { turn: 1, step, message: { id: `r${step}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'output' }] } }, { surfaceOp: 'append' })
  }
  return session
}
const session = sessionFor('AABACB')
for (const [id, remaining] of [['A', ['B', 'C', 'C', 'B', 'B']], ['B', ['C']], ['C', []]]) {
  const plan = core.planReplacement(session, [id])
  core.commitReplacement(ctx, session, plan, [id], `summary ${id}`)
  assert.deepEqual(core.surfaceView(session).flatMap((row) => row.ids), remaining)
  const replay = Session.create('block-ptc-replay', session.snapshotEvents())
  assert.deepEqual(core.surfaceView(replay).map((row) => row.ids), core.surfaceView(session).map((row) => row.ids))
}
assert.equal(core.surfaceView(session).filter((row) => summaryMetadata(row.event)).length, 1)
assert.deepEqual(core.surfaceView(session).at(-1).ids, [])
console.log('Native DSH Session append and replay: OK (offline, no API)')

for (const source of [{ kind: 'tool-jobs', form: 'notice' }, { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' }]) {
  const session = sessionFor('ABA', source)
  const notice = session.snapshotEvents().find((event) => event.data?.id === 'job-notice')
  const plan = core.planReplacement(session, ['A'])
  assert(plan.shadowedSeqs.includes(notice.seq))
  core.commitReplacement(ctx, session, plan, ['A'], 'completed work and background-job result')
  assert(!session.surface.nodes.includes(notice.seq))
  const replay = Session.create('job-notice-replay', session.snapshotEvents())
  assert.deepEqual(core.surfaceView(replay).map((row) => row.ids), [[], [], ['B']])
  assert.deepEqual(replay.eventAt(notice.seq).data.source, source)
}
console.log('Native DSH job-notice replacement and replay: OK (offline, no API)')
