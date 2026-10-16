/** Offline regression checks for membership, interval replacement and PTC integration. */
import assert from 'node:assert/strict'
import { apply, __internals as core } from '../lib/plugin.js'
import { summaryMetadata } from '../lib/blocks.js'

function harness() {
  const defs = new Map(), guards = [], sections = [], dispatched = [], listeners = []
  const ctx = {
    tools: {
      register: (def) => defs.set(def.name, def),
      guard: (guard) => guards.push(guard),
      execute: async (input) => { dispatched.push(input); return { isError: false, value: { logs: ['hello'], result: 1 } } },
    },
    systemPrompt: { section: (section) => sections.push(section) },
    get: () => ({ estimateMessage: () => 10 }),
    on: (name, fn) => { assert.equal(name, 'session/event'); listeners.push(fn) },
    logger: { warn: () => {} },
  }
  apply(ctx)
  return { ctx, defs, guards, sections, dispatched, listeners }
}
const host = harness()
const drain = async () => { await new Promise((resolve) => queueMicrotask(resolve)) }

/** Fake only persistence; append order, provenance, surface splice and observer reentry are checked. */
function makeSession(listeners = host.listeners, seed = []) {
  const events = [], nodes = []
  let publishing = false
  const session = {
    surface: { nodes },
    snapshotEvents: () => [...events],
    eventAt: (seq) => events[seq],
    deriveEventMessage: (event) => event.type === 'user/message' ? event.data : event.data.message,
    requestHeader: () => ({ config: { provider: 'test', model: 'test' } }),
    append(type, data, opts = {}) {
      assert.equal(publishing, false, 'session append must not reenter observers')
      const event = { seq: events.length, type, data: structuredClone(data), ...opts }
      if (opts.surfaceOp?.op === 'replace') {
        const first = nodes.indexOf(opts.surfaceOp.startSeq), last = nodes.indexOf(opts.surfaceOp.endSeq)
        assert(first >= 0 && last >= first)
        for (const seq of nodes.slice(first, last + 1)) assert(opts.sourceEventSeqs.includes(seq))
        nodes.splice(first, last - first + 1, event.seq)
      } else if (['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(type)) nodes.push(event.seq)
      events.push(event)
      publishing = true
      try { for (const listener of listeners) listener(session, event) } finally { publishing = false }
      return event
    },
  }
  for (const event of seed) session.append(event.type, event.data, {
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
  })
  return session
}
function work(session, ids, step, complete = true, legacy = false) {
  const callId = `c${step}`
  session.append('step/start', { turn: 1, step })
  session.append('assistant/message', { turn: 1, step, message: { role: 'assistant', content: [
    { type: 'text', text: `thinking and content before ${callId}` }, { type: 'tool-call', id: callId },
  ] } })
  session.append('tool/call', { turn: 1, step, callId, name: 'block_run_code', arguments: JSON.stringify({ ...(legacy ? { id: ids[0] } : { ids }), description: ids.join(','), code: 'return 1' }) })
  if (complete) result(session, step)
}
function result(session, step) {
  session.append('tool/result', { turn: 1, step, message: { role: 'tool', toolCallId: `c${step}`, source: { kind: 'tool', callId: `c${step}` }, content: [{ type: 'text', text: 'result' }] } })
}
function sequence(text, listeners = host.listeners) {
  const session = makeSession(listeners)
  session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'system' }] } })
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'task' }] })
  session.append('turn/start', { turn: 1 })
  ;[...text].forEach((id, index) => work(session, [id], index + 1))
  return session
}
function layout(session) {
  return core.surfaceView(session).filter((row) => row.event.type === 'assistant/message' || summaryMetadata(row.event)).map((row) =>
    summaryMetadata(row.event) ? `S[${row.ids.join(',')}]` : row.ids.join(','),
  ).join(' ')
}
async function summarize(session, ids, legacy = false) {
  return host.defs.get('block_summary').execute({ ...(legacy ? { id: ids[0] } : { ids }), summary: `Summary of ${ids.join(',')}` }, { agent: { session }, callId: 'manual' })
}

// The exact agreed examples, subsequent summaries, non-monotonic seq order and replay.
{
  const session = sequence('AABAB')
  const value = await summarize(session, ['A'])
  assert.equal(value.replaced, 8)
  assert.deepEqual(value.ids, ['B'])
  assert.equal(layout(session), 'S[B] B')
  assert(!core.surfaceView(session).some((row) => row.ids.includes('A')))
  const text = core.surfaceView(session).find((row) => summaryMetadata(row.event)).event.data.content[0].text
  assert(text.includes('<block-summary>\nBlock ids: ["B"]\n\nSummary of A\n</block-summary>'))
  assert(!text.includes('compacted-summary'))
}
{
  const session = sequence('AABACB')
  const originals = JSON.stringify(session.snapshotEvents())
  await summarize(session, ['A'])
  assert.equal(layout(session), 'S[B] C B')
  assert(JSON.stringify(session.snapshotEvents()).startsWith(originals.slice(0, -1)), 'original complete messages stay in the durable log')
  const replay = makeSession([], structuredClone(session.snapshotEvents()))
  assert.equal(layout(replay), 'S[B] C B')
  await summarize(replay, ['B'])
  assert.equal(layout(replay), 'S[C]')
  await summarize(replay, ['C'])
  assert.equal(layout(replay), 'S[]', 'the finished summary is retained when its ids are empty')
  assert.deepEqual(core.surfaceView(replay).filter((row) => row.ids.length > 0), [])
}
// Empty memberships stay in metadata; the model sees one summary without an empty ids label.
{
  const session = sequence('A')
  const value = await summarize(session, ['A'])
  const message = session.eventAt(session.surface.nodes.at(-1)).data
  assert.deepEqual(summaryMetadata(session.eventAt(session.surface.nodes.at(-1))).ids, [])
  assert.equal(Object.hasOwn(value, 'ids'), false)
  assert.equal(message.content[0].text.split('Summary of A').length - 1, 1)
  assert(message.content[0].text.includes('<block-summary>\nSummary of A\n</block-summary>'))
  assert(!message.content[0].text.includes('Block ids:'))
  assert(!message.content[0].text.includes('ids=[]'))
}
{
  const session = sequence('AABACB')
  await summarize(session, ['A', 'B'])
  assert.equal(layout(session), 'S[C]')
}
// Shared messages transfer all remaining memberships; old id calls remain valid.
{
  const session = sequence('')
  work(session, ['A', 'B'], 1)
  work(session, ['C'], 2)
  work(session, ['A'], 3, true, true)
  await summarize(session, ['A'], true)
  assert.equal(layout(session), 'S[B,C]')
  const meta = summaryMetadata(session.eventAt(session.surface.nodes.at(-1)))
  assert.deepEqual(meta.closedIds, ['A'])
}
// Multi-call assistant messages and all their results form one indivisible group.
{
  const session = sequence('')
  const data = { turn: 1, step: 1 }
  session.append('assistant/message', { ...data, message: { content: [{ type: 'text', text: 'reasoning' }, { type: 'tool-call', id: 'a' }, { type: 'tool-call', id: 'b' }] } })
  for (const id of ['A', 'B']) session.append('tool/call', { ...data, callId: id.toLowerCase(), name: 'block_run_code', arguments: JSON.stringify({ ids: [id] }) })
  for (const id of ['a', 'b']) session.append('tool/result', { ...data, message: { source: { callId: id }, content: [] } })
  assert.deepEqual(core.surfaceView(session).filter((row) => row.ids.length).map((row) => row.ids), [['A', 'B'], ['A', 'B'], ['A', 'B']])
  const value = await summarize(session, ['A'])
  assert.equal(value.replaced, 3)
  assert.equal(layout(session), 'S[B]')
}
// Job completion notices participate in the interval, including replay and token accounting.
for (const source of [
  { kind: 'tool-jobs', form: 'notice' },
  { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' },
]) {
  const session = sequence('A')
  const notice = session.append('user/message', { role: 'user', source, content: [{ type: 'text', text: 'background job finished; read its output with job_output' }] })
  work(session, ['B'], 2)
  work(session, ['A'], 3)
  const value = await summarize(session, ['A'])
  assert.equal(value.replaced, 7)
  assert.equal(value.tokensFreed, 70)
  assert.equal(layout(session), 'S[B]')
  assert(!session.surface.nodes.includes(notice.seq))
  assert.deepEqual(session.eventAt(notice.seq).data.source, source, 'the original notice remains in the log')
  const replay = makeSession([], session.snapshotEvents())
  assert.equal(layout(replay), 'S[B]')
}
// Human instructions, unknown plugin messages and non-notice job messages remain protected.
for (const source of [undefined, { kind: 'human' }, { kind: 'tool-jobs' }, { kind: 'plugin', plugin: 'other', form: 'notice' }]) {
  const session = sequence('A')
  session.append('user/message', { role: 'user', source, content: [{ type: 'text', text: 'keep this instruction' }] })
  work(session, ['A'], 2)
  const before = session.snapshotEvents().length
  await assert.rejects(summarize(session, ['A']), /protected/)
  assert.equal(session.snapshotEvents().length, before)
}
// A protected message refuses the entire operation; never replace only a prefix.
{
  const session = sequence('A')
  session.append('assistant/message', { turn: 1, step: 2, message: { content: [
    { type: 'tool-call', id: 'b', name: 'block_run_code', arguments: '{"ids":["B"]}' },
    { type: 'tool-call', id: 'a', name: 'block_run_code', arguments: '{"ids":["A"]}' },
  ] } })
  assert.equal(core.planReplacement(session, ['A']).kind, 'pending', 'a not-yet-dispatched call still contributes to its whole message')
  assert.deepEqual(core.surfaceView(session).at(-1).ids, ['B', 'A'])
}

// A protected message refuses the entire operation; never replace only a prefix.
{
  const session = sequence('A')
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'keep this instruction' }] })
  work(session, ['A'], 2)
  const before = session.snapshotEvents().length
  await assert.rejects(summarize(session, ['A']), /protected/)
  assert.equal(session.snapshotEvents().length, before)
  assert.equal(layout(session), 'A A')
  await assert.rejects(summarize(session, ['A', 'missing']), /no current content/)
  assert.equal(session.snapshotEvents().length, before)
}
// A rejected replacement releases its lock and leaves every target open for retry.
{
  const session = sequence('ABA')
  const append = session.append
  session.append = (type, data, opts) => { if (opts?.surfaceOp?.op === 'replace') throw new Error('simulated rejection'); return append(type, data, opts) }
  await assert.rejects(summarize(session, ['A']), /simulated rejection/)
  assert.equal(layout(session), 'A B A')
  assert.equal(session.snapshotEvents().at(-1).type, 'compaction/end')
  assert.equal(session.snapshotEvents().at(-1).data.error, 'simulated rejection')
  session.append = append
  await summarize(session, ['A'])
  assert.equal(layout(session), 'S[B]')
}
function invocation(session, step, ids) {
  return session.append('tool/ptc-dispatch-start', { subCallId: `c${step}:ptc:1`, name: 'block_summary', arguments: { ids, summary: 'handover' } })
}
function outcome(session, step, ids, value, isError = false) {
  session.append('tool/ptc-dispatch', { subCallId: `c${step}:ptc:1`, name: 'block_summary', arguments: { ids, summary: 'handover' }, isError, content: host.defs.get('block_summary').output.render({}, value) })
}
// A summary of its own running program waits; it includes that program when it settles.
{
  const session = sequence('AAB')
  work(session, ['A'], 4, false)
  invocation(session, 4, ['A'])
  const value = await host.defs.get('block_summary').execute({ ids: ['A'], summary: 'handover' }, { agent: { session }, callId: 'c4:ptc:1' })
  assert.equal(value.pending, true)
  outcome(session, 4, ['A'], value)
  await drain()
  assert.equal(layout(session), 'A A B A')
  result(session, 4)
  await drain()
  assert.equal(layout(session), 'S[B]')
  assert.equal(core.pendingSummaries(session).length, 0)
  assert.equal(core.surfaceView(session).filter((row) => row.ids.includes('A')).length, 0)
}
// Starts and failed dispatches never close a block. Queued success survives a restart/fork.
{
  const session = sequence('A', [])
  work(session, ['A'], 2, false)
  const request = invocation(session, 2, ['A'])
  assert.equal(core.pendingSummaries(session).length, 0)
  outcome(session, 2, ['A'], { pending: true, requestSeq: request.seq }, true)
  assert.equal(core.pendingSummaries(session).length, 0)
  outcome(session, 2, ['A'], { pending: true, requestSeq: request.seq })
  const resumed = makeSession(host.listeners, structuredClone(session.snapshotEvents()))
  result(resumed, 2)
  await drain()
  assert.equal(layout(resumed), 'S[]')
  core.flushPending(host.ctx, resumed)
  assert.equal(layout(resumed), 'S[]', 'a committed request cannot insert another summary')
}
// Native compaction and this plugin do not overlap their transaction brackets.
{
  const session = sequence('A')
  session.append('compaction/start', { compactionId: 'native', turn: 1 })
  const request = invocation(session, 1, ['A'])
  const value = await host.defs.get('block_summary').execute({ ids: ['A'], summary: 'handover' }, { agent: { session }, callId: 'c1:ptc:1' })
  assert.equal(value.pending, true)
  outcome(session, 1, ['A'], value)
  await drain()
  assert.equal(layout(session), 'A')
  session.append('compaction/end', { compactionId: 'native', turn: 1 })
  await drain()
  assert.equal(layout(session), 'S[]')
  assert.equal(summaryMetadata(session.eventAt(session.surface.nodes.at(-1))).requestSeq, request.seq)
}
// Transport, schema, input validation, guard and discovery-anchor boundaries.
{
  assert.deepEqual([...host.defs.keys()], ['block_run_code', 'block_summary'])
  assert.equal(host.sections.length, 1)
  assert(!/first eligible|injection|at the start|one block open/.test(host.sections[0].text))
  for (const name of ['block_run_code', 'block_summary']) {
    for (const args of [{ ids: [] }, { ids: [''] }, { ids: ['A', 'A'] }, { ids: ['A'], id: 'A' }, {}]) {
      await assert.rejects(host.defs.get(name).execute({ ...args, description: 'goal', code: 'return 1', summary: 's' }, { agent: { session: sequence('A') } }), /ids|legacy/)
    }
  }
  const value = await host.defs.get('block_run_code').execute({ ids: ['A', 'B'], description: 'goal', code: 'return 1' }, { callId: 'outer', rootCallId: 'outer', token: 'token' })
  assert.deepEqual(value, { logs: ['hello'], result: 1 })
  assert.equal(host.dispatched.at(-1).callId, 'outer')
  assert.equal(host.dispatched.at(-1).parent, 'token')
  assert.equal(host.dispatched.at(-1).arguments.description, '[block:A,B] goal')
  const guard = host.guards[0]
  assert.equal(guard({ name: 'block_run_code' }), undefined)
  assert.equal(guard({ name: 'read', parent: 'token' }), undefined)
  assert.match(guard({ name: 'read' }), /only `block_run_code`/)
  apply({}, { anchor: true })
  assert.throws(() => apply({ ...host.ctx, tools: {} }), /incompatible DSH host API/)
  await assert.rejects(summarize({ surface: { nodes: [] } }, ['A']), /incompatible DSH session API/)
}
await drain()
console.log('dsh-block-ptc logic test: OK')
