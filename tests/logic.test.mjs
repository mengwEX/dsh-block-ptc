/**
 * Logic smoke test for dsh-block-ptc.
 *
 * Runs the real plugin entry against a fake Cordis context and fake sessions:
 * tool registration, the direct-call guard, the nested `run_code` dispatch and
 * the compaction transaction a `block_summary` commits.
 *
 * Scenario B mirrors a real session (captured live) whose surface starts with
 * the system prompt and carries several user messages inside the block span —
 * the two shapes that must never be replaced.
 *
 *   node tests/logic.test.mjs
 */

import assert from 'node:assert/strict'
import { apply } from '../lib/plugin.js'

const defs = new Map()
const guards = []
const sections = []
const dispatched = []
let appends = []

const fakeCtx = {
  tools: {
    register: (definition) => {
      defs.set(definition.name, definition)
      return () => {}
    },
    guard: (guard) => {
      guards.push(guard)
      return () => {}
    },
    execute: async (input) => {
      dispatched.push(input)
      return { isError: false, value: { logs: ['hello'], result: { ok: true } } }
    },
  },
  systemPrompt: {
    section: (section) => {
      sections.push(section)
      return () => {}
    },
  },
  get: (name) => (name === 'tokenMeter' ? { estimateMessage: () => 10 } : undefined),
}

apply(fakeCtx)

assert.deepEqual([...defs.keys()].sort(), ['block_run_code', 'block_summary'], 'both tools register')
assert.equal(sections.length, 1, 'one prompt section registers')
assert.equal(guards.length, 1, 'one guard registers')

/** Build a fake session over an explicit event log and surface. */
function makeSession(events, nodes, seq) {
  return {
    surface: { nodes },
    seq,
    snapshotEvents: () => events,
    eventAt: (target) => events.find((event) => event.seq === target),
    deriveEventMessage: () => ({ content: [{ type: 'text', text: 'x' }] }),
    requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }),
    append: (type, data, opts) => {
      const event = { seq: 1000 + appends.length, type, data, ...(opts ?? {}) }
      appends.push(event)
      return event
    },
  }
}

// ── scenario A: one block opened and closed across two turns ────────────────
{
  appends = []
  const events = [
    { seq: 0, type: 'system/message', data: {} },
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 3, type: 'user/message', data: { role: 'user' } },
    { seq: 4, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call' }] } } },
    { seq: 5, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'block_run_code', arguments: '{"id":"a","description":"goal A"}' } },
    { seq: 6, type: 'tool/result', data: { turn: 1, step: 1, message: {} } },
    { seq: 7, type: 'turn/end', data: { turn: 1 } },
    { seq: 8, type: 'turn/start', data: { turn: 2 } },
    { seq: 9, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 10, type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'tool-call' }] } } },
    { seq: 11, type: 'tool/call', data: { turn: 2, step: 1, callId: 'c2', name: 'block_run_code', arguments: '{"id":"a","description":"goal A"}' } },
    {
      seq: 12,
      type: 'tool/ptc-dispatch-start',
      data: { subCallId: 'c2:ptc:1', name: 'block_summary', arguments: { id: 'a', summary: 'handover' } },
    },
  ]
  const session = makeSession(events, [0, 3, 4, 6, 10], 13)
  const exec = {
    callId: 'c2:ptc:1',
    rootCallId: 'c2',
    token: 'TOKEN',
    agent: { session },
    signal: new AbortController().signal,
  }
  const result = await defs.get('block_summary').execute({ id: 'a', summary: 'handover' }, exec)
  assert.deepEqual(result, { replaced: 2, tokensFreed: 20 }, 'A: replaces the block\'s own completed steps')
  assert.deepEqual(
    appends.map((event) => event.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'],
    'A: commits one compaction transaction in the contractual order',
  )
  const [start, summary, replacement, end] = appends
  assert.equal(start.data.turn, 2, 'A: bracket is owned by the open turn')
  assert.deepEqual(summary.data.shadowedRange, { start: 4, end: 6 }, 'A: shadow price covers the replaced surface span')
  assert.equal(summary.data.shadowedTokenCount, 20, 'A: shadow price carries the metered token count')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 4, endSeq: 6 }, 'A: replacement shadows exactly that span')
  assert.deepEqual(replacement.sourceEventSeqs, [start.seq, summary.seq, 4, 6], 'A: replacement cites the bracket and every shadowed node')
  assert.equal(replacement.data.source.kind, 'compact-checkpoint', 'A: replacement is a recognizable compaction checkpoint')
  assert.equal(end.data.compactionId, start.data.compactionId, 'A: end closes the same transaction')
}

// ── scenario B: the system prompt and user messages are never replaced ──────
{
  appends = []
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    // The system prompt is appended inside step 1 and therefore carries turn 1 / step 1.
    { seq: 9, type: 'system/message', data: { turn: 1, step: 1, message: { content: [] } } },
    { seq: 10, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'prompt 1' }] } },
    { seq: 12, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'injected context' }] } },
    { seq: 19, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call' }] } } },
    { seq: 20, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'block_run_code', arguments: '{"id":"smoke","description":"goal"}' } },
    { seq: 29, type: 'tool/result', data: { turn: 1, step: 1, message: {} } },
    { seq: 33, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'answer 1' }] } } },
    { seq: 44, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'prompt 2' }] } },
    { seq: 45, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 46, type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'tool-call' }] } } },
    { seq: 47, type: 'tool/call', data: { turn: 2, step: 1, callId: 'c2', name: 'block_run_code', arguments: '{"id":"closer","description":"close"}' } },
    {
      seq: 52,
      type: 'tool/ptc-dispatch-start',
      data: { subCallId: 'c2:ptc:1', name: 'block_summary', arguments: { id: 'smoke', summary: 'handover' } },
    },
  ]
  const session = makeSession(events, [9, 10, 12, 19, 29, 33, 44, 46], 53)
  const exec = { callId: 'c2:ptc:1', rootCallId: 'c2', token: 'TOKEN', agent: { session }, signal: new AbortController().signal }
  const result = await defs.get('block_summary').execute({ id: 'smoke', summary: 'handover' }, exec)
  assert.deepEqual(result, { replaced: 3, tokensFreed: 30 }, 'B: replaces the model work only')
  const summary = appends[1]
  assert.deepEqual(
    summary.data.shadowedSeqs,
    [19, 29, 33],
    'B: the system prompt (seq 9) and both user messages (10, 12, 44) stay',
  )
  assert.deepEqual(summary.data.shadowedRange, { start: 19, end: 33 }, 'B: the replaced span never starts at node 0')
}

// ── scenario C: a failed replacement still releases the compaction lock ─────
{
  appends = []
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call' }] } } },
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'block_run_code', arguments: '{"id":"a","description":"goal A"}' } },
    { seq: 4, type: 'tool/result', data: { turn: 1, step: 1, message: {} } },
    { seq: 5, type: 'step/start', data: { turn: 1, step: 2 } },
    { seq: 6, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'tool-call' }] } } },
    { seq: 7, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'block_run_code', arguments: '{"id":"a","description":"goal A"}' } },
    { seq: 8, type: 'tool/ptc-dispatch-start', data: { subCallId: 'c2:ptc:1', name: 'block_summary', arguments: { id: 'a', summary: 's' } } },
  ]
  const session = makeSession(events, [2, 4, 6], 9)
  const append = session.append
  session.append = (type, data, opts) => {
    if (type === 'user/message') throw new Error('surface replace: simulated rejection')
    return append(type, data, opts)
  }
  const exec = { callId: 'c2:ptc:1', rootCallId: 'c2', token: 'TOKEN', agent: { session }, signal: new AbortController().signal }
  await assert.rejects(
    () => defs.get('block_summary').execute({ id: 'a', summary: 's' }, exec),
    /simulated rejection/,
    'C: a rejected replacement surfaces to the caller',
  )
  assert.deepEqual(
    appends.map((event) => event.type),
    ['compaction/start', 'compaction/summary', 'compaction/end'],
    'C: every failure makes exactly one close attempt',
  )
  assert.equal(appends[2].data.error, 'surface replace: simulated rejection', 'C: the close records the failure')
  assert.equal(appends[2].data.compactionId, appends[0].data.compactionId, 'C: the failing bracket is the one released')
}

// ── the transport tool forwards the program to the built-in run_code ─────────
{
  const forwarded = await defs.get('block_run_code').execute(
    { id: 'a', description: 'goal A', code: 'return 1' },
    { callId: 'c3', rootCallId: 'c3', token: 'TOKEN2', agent: { session: {} }, signal: new AbortController().signal },
  )
  assert.deepEqual(forwarded, { logs: ['hello'], result: { ok: true } }, 'run_code result is forwarded verbatim')
  assert.equal(dispatched.length, 1, 'exactly one nested dispatch')
  assert.equal(dispatched[0].name, 'run_code', 'the nested dispatch is the built-in transport')
  assert.equal(dispatched[0].parent, 'TOKEN2', 'nested dispatch carries the transport parent token')
  // Rendering contract: the PTC bridge parents every program sub-call at the
  // executing call's id, and the conversation UI only hangs sub-calls off a call
  // node it can see. The nested transport must therefore reuse the outer id, not
  // invent a synthetic parent node that never appears in the transcript.
  assert.equal(dispatched[0].callId, 'c3', 'the nested transport reuses the outer call id')
  assert.equal(dispatched[0].rootCallId, 'c3', 'the nested transport keeps the outer root call id')
  assert.equal(dispatched[0].arguments.description, '[block:a] goal A', 'block id is visible to the transport log')
}

// ── the guard narrows direct calls to the transport tool ─────────────────────
{
  const guard = guards[0]
  assert.equal(guard({ name: 'block_run_code' }), undefined, 'the transport tool may be called directly')
  assert.equal(guard({ name: 'read', parent: 'TOKEN' }), undefined, 'nested sub-calls stay allowed')
  assert.match(guard({ name: 'read' }), /only `block_run_code` may be called directly/i, 'a direct call is denied')
  assert.match(guard({ name: 'run_code' }), /block_run_code/, 'the built-in transport is denied directly too')
}

// ── the host-level discovery anchor registers nothing ───────────────────────
{
  const anchorTools = []
  const anchorGuards = []
  const anchorSections = []
  const anchorCtx = {
    tools: {
      register: (definition) => {
        anchorTools.push(definition.name)
        return () => {}
      },
      guard: (guard) => {
        anchorGuards.push(guard)
        return () => {}
      },
      execute: async () => {
        throw new Error('the discovery anchor must not dispatch')
      },
    },
    systemPrompt: {
      section: (section) => {
        anchorSections.push(section)
        return () => {}
      },
    },
    get: () => undefined,
  }
  apply(anchorCtx, { anchor: true })
  assert.deepEqual(anchorTools, [], 'the discovery anchor registers no tools')
  assert.deepEqual(anchorGuards, [], 'the discovery anchor installs no direct-call guard')
  assert.deepEqual(anchorSections, [], 'the discovery anchor adds no prompt section')
}

// ── incompatible hosts fail before registering or appending anything ───────
{
  const before = [defs.size, guards.length, sections.length]
  assert.throws(
    () => apply({ ...fakeCtx, tools: { ...fakeCtx.tools, execute: undefined } }),
    /incompatible DSH host API; missing tools\.execute/,
  )
  assert.deepEqual([defs.size, guards.length, sections.length], before, 'an incompatible host is not partially mounted')

  let inspected = false
  const session = {
    surface: { nodes: [] },
    snapshotEvents: () => { inspected = true; return [] },
    eventAt: () => undefined,
    deriveEventMessage: () => null,
  }
  await assert.rejects(
    defs.get('block_summary').execute({ id: 'a', summary: 'handover' }, { agent: { session } }),
    /incompatible DSH session API; missing append/,
  )
  assert.equal(inspected, false, 'a session without append is rejected before inspecting its history')
}

console.log('dsh-block-ptc logic test: OK')
