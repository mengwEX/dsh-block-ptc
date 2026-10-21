/** Offline regression checks for membership, interval replacement and PTC integration. */
import assert from 'node:assert/strict'
import { apply, __internals as core } from '../lib/plugin.js'
import { summaryMetadata } from '../lib/blocks.js'
import { HEADER_GUIDANCE } from '../lib/prompts.js'

function harness() {
  const defs = new Map(), guards = [], sections = [], listeners = [], assemblyHooks = []
  const ctx = {
    tools: {
      register: (def) => defs.set(def.name, def),
      guard: (guard) => guards.push(guard),
    },
    systemPrompt: { section: (section) => sections.push(section) },
    get: () => ({ estimateMessage: () => 10 }),
    on: (name, fn) => {
      if (name === 'session/event') listeners.push(fn)
      else { assert.equal(name, 'system-prompt/assemble'); assemblyHooks.push(fn) }
    },
    logger: { warn: () => {} },
  }
  apply(ctx)
  return { ctx, defs, guards, sections, listeners, assemblyHooks }
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
function work(session, ids, step, complete = true, turn = 1) {
  const callId = `c${step}`
  const argumentsText = JSON.stringify({ description: `[block: ${ids.join(', ')}] goal for ${callId}`, code: 'return 1' })
  session.append('step/start', { turn, step })
  session.append('assistant/message', { turn, step, message: { role: 'assistant', content: [
    { type: 'text', text: `thinking and content before ${callId}` }, { type: 'tool-call', id: callId, name: 'run_code', arguments: argumentsText },
  ] } })
  session.append('tool/call', { turn, step, callId, name: 'run_code', arguments: argumentsText })
  if (complete) result(session, step, turn)
}
function result(session, step, turn = 1) {
  session.append('tool/result', { turn, step, message: { role: 'tool', toolCallId: `c${step}`, source: { kind: 'tool', callId: `c${step}` }, content: [{ type: 'text', text: 'result' }] } })
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
async function compact(session, ids) {
  return host.defs.get('block_compact').execute({ ids, content: `Retained content of ${ids.join(',')}` }, { agent: { session }, callId: 'manual' })
}

// The exact agreed examples, subsequent summaries, non-monotonic seq order and replay.
{
  const session = sequence('AABAB')
  const value = await compact(session, ['A'])
  assert.equal(value.replaced, 8)
  assert.deepEqual(value.ids, ['B'])
  assert.equal(layout(session), 'S[B] B')
  assert(!core.surfaceView(session).some((row) => row.ids.includes('A')))
  const text = core.surfaceView(session).find((row) => summaryMetadata(row.event)).event.data.content[0].text
  assert(text.includes('<block-summary>\nBlock ids: ["B"]\n\nRetained content of A\n</block-summary>'))
  assert(!text.includes('compacted-summary'))
}
{
  const session = sequence('AABACB')
  const originals = JSON.stringify(session.snapshotEvents())
  await compact(session, ['A'])
  assert.equal(layout(session), 'S[B] C B')
  assert(JSON.stringify(session.snapshotEvents()).startsWith(originals.slice(0, -1)), 'original complete messages stay in the durable log')
  const replay = makeSession([], structuredClone(session.snapshotEvents()))
  assert.equal(layout(replay), 'S[B] C B')
  await compact(replay, ['B'])
  assert.equal(layout(replay), 'S[C]')
  await compact(replay, ['C'])
  assert.equal(layout(replay), 'S[]', 'the finished content is retained when its ids are empty')
  assert.deepEqual(core.surfaceView(replay).filter((row) => row.ids.length > 0), [])
}
// Empty memberships stay in metadata; the model sees one content without an empty ids label.
{
  const session = sequence('A')
  const value = await compact(session, ['A'])
  const message = session.eventAt(session.surface.nodes.at(-1)).data
  assert.deepEqual(summaryMetadata(session.eventAt(session.surface.nodes.at(-1))).ids, [])
  assert.equal(Object.hasOwn(value, 'ids'), false)
  assert.equal(message.content[0].text.split('Retained content of A').length - 1, 1)
  assert(message.content[0].text.includes('<block-summary>\nRetained content of A\n</block-summary>'))
  assert(!message.content[0].text.includes('Block ids:'))
  assert(!message.content[0].text.includes('ids=[]'))
}
{
  const session = sequence('AABACB')
  await compact(session, ['A', 'B'])
  assert.equal(layout(session), 'S[C]')
}
// Shared messages transfer all remaining memberships.
{
  const session = sequence('')
  work(session, ['A', 'B'], 1)
  work(session, ['C'], 2)
  work(session, ['A'], 3)
  await compact(session, ['A'])
  assert.equal(layout(session), 'S[B,C]')
  const meta = summaryMetadata(session.eventAt(session.surface.nodes.at(-1)))
  assert.deepEqual(meta.closedIds, ['A'])
}
// Multi-call assistant messages and all their results form one indivisible group.
{
  const session = sequence('')
  const data = { turn: 1, step: 1 }
  const aArgs = JSON.stringify({ description: '[block: A] first' })
  const bArgs = JSON.stringify({ description: '[block: B] second' })
  session.append('assistant/message', { ...data, message: { content: [
    { type: 'text', text: 'reasoning' },
    { type: 'tool-call', id: 'a', name: 'run_code', arguments: aArgs },
    { type: 'tool-call', id: 'b', name: 'run_code', arguments: bArgs },
  ] } })
  session.append('tool/call', { ...data, callId: 'a', name: 'run_code', arguments: aArgs })
  session.append('tool/call', { ...data, callId: 'b', name: 'run_code', arguments: bArgs })
  for (const id of ['a', 'b']) session.append('tool/result', { ...data, message: { source: { callId: id }, content: [] } })
  assert.deepEqual(core.surfaceView(session).filter((row) => row.ids.length).map((row) => row.ids), [['A', 'B'], ['A', 'B'], ['A', 'B']])
  const value = await compact(session, ['A'])
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
  const value = await compact(session, ['A'])
  assert.equal(value.replaced, 7)
  assert.equal(value.tokensFreed, 70)
  assert.equal(layout(session), 'S[B]')
  assert(!session.surface.nodes.includes(notice.seq))
  assert.deepEqual(session.eventAt(notice.seq).data.source, source, 'the original notice remains in the log')
  const replay = makeSession([], session.snapshotEvents())
  assert.equal(layout(replay), 'S[B]')
}
// User messages within the interval participate regardless of their source or turn.
for (const source of [undefined, { kind: 'user' }, { kind: 'human' }, { kind: 'tool-jobs' }, { kind: 'plugin', plugin: 'other', form: 'notice' }]) {
  const session = sequence('A')
  const added = session.append('user/message', { role: 'user', source, content: [{ type: 'text', text: 'Use the revised requirement' }] })
  work(session, ['A'], 2)
  const value = await compact(session, ['A'])
  assert.equal(value.replaced, 5)
  assert.equal(layout(session), 'S[]')
  assert(!session.surface.nodes.includes(added.seq))
  assert.equal(core.surfaceView(session).filter((row) => row.event.type === 'user/message' && !summaryMetadata(row.event)).length, 1, 'the original task before the interval stays')
  assert.equal(layout(makeSession([], session.snapshotEvents())), 'S[]')
}
// A not-yet-dispatched call contributes to the whole assistant message.
{
  const session = sequence('A')
  session.append('assistant/message', { turn: 1, step: 2, message: { content: [
    { type: 'tool-call', id: 'b', name: 'run_code', arguments: '{"description":"[block: B] second"}' },
    { type: 'tool-call', id: 'a', name: 'run_code', arguments: '{"description":"[block: A] first"}' },
  ] } })
  assert.equal(core.planReplacement(session, ['A']).kind, 'pending', 'a not-yet-dispatched call still contributes to its whole message')
  assert.deepEqual(core.surfaceView(session).at(-1).ids, ['B', 'A'])
}

// A protected message refuses the entire operation; never replace only a prefix.
for (const type of ['system/message', 'developer/message']) {
  const session = sequence('A')
  session.append(type, { message: { role: type.split('/')[0], content: [{ type: 'text', text: 'keep this instruction' }] } })
  work(session, ['A'], 2)
  const before = session.snapshotEvents().length
  await assert.rejects(compact(session, ['A']), /protected/)
  assert.equal(session.snapshotEvents().length, before)
  assert.equal(layout(session), 'A A')
  await assert.rejects(compact(session, ['A', 'missing']), /no current content/)
  assert.equal(session.snapshotEvents().length, before)
}
// A rejected replacement releases its lock and leaves every target open for retry.
{
  const session = sequence('ABA')
  const append = session.append
  session.append = (type, data, opts) => { if (opts?.surfaceOp?.op === 'replace') throw new Error('simulated rejection'); return append(type, data, opts) }
  await assert.rejects(compact(session, ['A']), /simulated rejection/)
  assert.equal(layout(session), 'A B A')
  assert.equal(session.snapshotEvents().at(-1).type, 'compaction/end')
  assert.equal(session.snapshotEvents().at(-1).data.error, 'simulated rejection')
  session.append = append
  await compact(session, ['A'])
  assert.equal(layout(session), 'S[B]')
}
function invocation(session, step, ids, content = 'handover') {
  return session.append('tool/ptc-dispatch-start', { parentCallId: `c${step}`, subCallId: `c${step}:ptc:1`, name: 'block_compact', arguments: { ids, content } })
}
function outcome(session, step, ids, value, isError = false, content = 'handover') {
  session.append('tool/ptc-dispatch', { subCallId: `c${step}:ptc:1`, name: 'block_compact', arguments: { ids, content }, isError, content: host.defs.get('block_compact').output.render({}, value) })
}
// Compaction of its own running program waits and includes that program when it settles.
{
  const session = sequence('AAB')
  work(session, ['A'], 4, false)
  invocation(session, 4, ['A'])
  const value = await host.defs.get('block_compact').execute({ ids: ['A'], content: 'handover' }, { agent: { session }, callId: 'c4:ptc:1' })
  assert.equal(value.pending, true)
  outcome(session, 4, ['A'], value)
  await drain()
  assert.equal(layout(session), 'A A B A')
  result(session, 4)
  await drain()
  assert.equal(layout(session), 'S[B]')
  assert.equal(core.pendingCompactions(session).length, 0)
  assert.equal(core.surfaceView(session).filter((row) => row.ids.includes('A')).length, 0)
}
// A block may continue across a user follow-up and close in a later turn.
{
  const session = sequence('A')
  session.append('turn/end', { turn: 1 })
  const added = session.append('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the existing API compatible' }] })
  session.append('turn/start', { turn: 2 })
  work(session, ['A'], 2, false, 2)
  const content = 'The API change is complete, verified and reported to the user. Next: work on the requested documentation.'
  invocation(session, 2, ['A'], content)
  const value = await host.defs.get('block_compact').execute({ ids: ['A'], content }, { agent: { session }, callId: 'c2:ptc:1' })
  outcome(session, 2, ['A'], value, false, content)
  result(session, 2, 2)
  await drain()
  assert.equal(layout(session), 'S[]')
  assert(!session.surface.nodes.includes(added.seq))
  assert(session.eventAt(session.surface.nodes.at(-1)).data.content[0].text.includes(content))
}
// A user message arriving after the content was authored must not disappear.
{
  const session = sequence('A')
  work(session, ['A'], 2, false)
  invocation(session, 2, ['A'])
  const value = await host.defs.get('block_compact').execute({ ids: ['A'], content: 'old progress' }, { agent: { session }, callId: 'c2:ptc:1' })
  outcome(session, 2, ['A'], value)
  const added = session.append('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'New requirement not in the old content' }] })
  result(session, 2)
  await drain()
  assert.equal(layout(session), 'A A')
  assert(session.surface.nodes.includes(added.seq))
  assert.throws(() => core.flushPending(host.ctx, session), /new message arrived/)
}
// Starts and failed dispatches never close a block. Queued success survives a restart/fork.
{
  const session = sequence('A', [])
  work(session, ['A'], 2, false)
  const request = invocation(session, 2, ['A'])
  assert.equal(core.pendingCompactions(session).length, 0)
  outcome(session, 2, ['A'], { pending: true, requestSeq: request.seq }, true)
  assert.equal(core.pendingCompactions(session).length, 0)
  outcome(session, 2, ['A'], { pending: true, requestSeq: request.seq })
  const resumed = makeSession(host.listeners, structuredClone(session.snapshotEvents()))
  result(resumed, 2)
  await drain()
  assert.equal(layout(resumed), 'S[]')
  core.flushPending(host.ctx, resumed)
  assert.equal(layout(resumed), 'S[]', 'a committed request cannot insert another content')
}
// Native compaction and this plugin do not overlap their transaction brackets.
{
  const session = sequence('A')
  session.append('compaction/start', { compactionId: 'native', turn: 1 })
  const request = invocation(session, 1, ['A'])
  const value = await host.defs.get('block_compact').execute({ ids: ['A'], content: 'handover' }, { agent: { session }, callId: 'c1:ptc:1' })
  assert.equal(value.pending, true)
  outcome(session, 1, ['A'], value)
  await drain()
  assert.equal(layout(session), 'A')
  session.append('compaction/end', { compactionId: 'native', turn: 1 })
  await drain()
  assert.equal(layout(session), 'S[]')
  assert.equal(summaryMetadata(session.eventAt(session.surface.nodes.at(-1))).requestSeq, request.seq)
}
// Header parsing, the content tool, guard and host-API boundaries.
{
  assert.deepEqual([...host.defs.keys()], ['block_compact'])
  const definition = host.defs.get('block_compact')
  assert.deepEqual(definition.parameters.required, ['ids', 'content'])
  assert.deepEqual(Object.keys(definition.parameters.properties), ['ids', 'content'])
  assert.equal(host.sections.length, 1)
  assert(!/first eligible|injection|at the start|one block open/.test(host.sections[0].text))
  assert.match(host.sections[0].text, /\[block: <ids>\]/)
  assert.match(host.sections[0].text, /block_compact/)

  assert.deepEqual(core.parseBlockHeader('[block: A, B] rework auth'), { ids: ['A', 'B'], goal: 'rework auth' })
  assert.deepEqual(core.parseBlockHeader('  [block: A]   goal  '), { ids: ['A'], goal: 'goal' })
  assert.deepEqual(core.parseBlockHeader('[block: session refresh] goal'), { ids: ['session refresh'], goal: 'goal' })
  for (const bad of ['goal', '[block: A]', '[block:] goal', '[block: A, A] goal', '[block: A] ', 'run [block: A] goal', '[block: A,, B] goal', '[block: , A] goal', '[block: A, ] goal', '[block: [A] goal', '[block: A]\ngoal', '[block: A] goal\nextra']) {
    assert.equal(core.parseBlockHeader(bad), undefined, bad)
  }

  for (const args of [{ ids: [] }, { ids: [''] }, { ids: ['A', 'A'] }, { id: 'A' }, {}]) {
    await assert.rejects(host.defs.get('block_compact').execute({ ...args, content: 's' }, { agent: { session: sequence('A') } }), /ids/)
  }
  for (const content of [undefined, '', '   ']) {
    await assert.rejects(definition.execute({ ids: ['A'], content }, { agent: { session: sequence('A') } }), /content.*required/)
  }

  const guard = host.guards[0]
  assert.equal(guard({ name: 'run_code', arguments: { description: '[block: A] goal' } }), undefined)
  assert.equal(guard({ name: 'run_code', parent: 'token', arguments: { description: 'goal' } }), undefined)
  assert.match(guard({ name: 'run_code', arguments: { description: 'goal' } }), /\[block: <ids>\]/)
  assert.equal(guard({ name: 'read', parent: 'token' }), undefined)
  assert.match(guard({ name: 'read' }), /only `run_code`/)

  assert.throws(() => apply({ ...host.ctx, tools: {} }), /incompatible DSH host API/)
  await assert.rejects(compact({ surface: { nodes: [] } }, ['A']), /incompatible DSH session API/)
}

// The first assembled request must teach the same header the execution guard requires.
{
  const transport = {
    name: 'run_code', description: 'Execute a program.',
    parameters: { type: 'object', required: ['code', 'description'], properties: {
      code: { type: 'string', description: 'Keep the native runtime instructions.' },
      description: { type: 'string', description: 'A short description, e.g. Show current directory.' },
      timeoutMs: { type: 'number' },
    } },
  }
  const assembly = {
    sections: [host.sections[0], { name: 'tools:sdk', text:
      '## Writing code for run_code\n\n`run_code({ code: "return await tools.bash({ command: \'pwd\', description: \'Show current directory\' })", description: "Show current directory" })`\n\ndeclare const tools: { bash(args: { description: string }): Promise<unknown> }' }],
    tools: [transport, { name: 'another-tool', parameters: {} }], contexts: [], variables: {},
  }
  const before = structuredClone(assembly)
  const assembled = await host.assemblyHooks[0](null, {}, async () => assembly)
  assert.deepEqual(assembly, before, 'native registrations must not be mutated')
  assert.equal(assembled.tools[0].parameters.properties.description.description, HEADER_GUIDANCE)
  assert.match(assembled.tools[0].description, /including the first/)
  assert.deepEqual(assembled.tools[0].parameters.properties.code, transport.parameters.properties.code)
  assert.deepEqual(assembled.tools[0].parameters.properties.timeoutMs, transport.parameters.properties.timeoutMs)
  assert.equal(assembled.tools[1], assembly.tools[1])
  assert.match(assembled.sections[1].text, /description: "\[block: <ids>\] <goal>"/)
  assert(!assembled.sections[1].text.includes('description: "Show current directory"'))
  assert(assembled.sections[1].text.includes('declare const tools: { bash(args: { description: string }): Promise<unknown> }'))
  const ordinary = { ...assembly, sections: [assembly.sections[1]] }
  assert.equal(await host.assemblyHooks[0](null, {}, async () => ordinary), ordinary)
}
await drain()
console.log('dsh-block-ptc logic test: OK')
