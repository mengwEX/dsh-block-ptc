/** Reproducible mechanism example, NOT API measurements or a tokenizer. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { __internals } from '../lib/plugin.js'

const config = {
  requests: 12,
  requestsPerBlock: 3,
  systemTokens: 4096,
  userTokens: 256,
  assistantTokens: 96,
  toolResultTokens: 1952,
  summaryTokens: 512,
  cacheUnit: 64,
}

function run(compact) {
  const events = []
  const nodes = []
  const weights = new Map()
  const pastInputs = []
  const requests = []
  const ctx = { get: () => ({ estimateMessage: (message) => message.syntheticTokens }) }
  const session = {
    surface: { nodes },
    snapshotEvents: () => events,
    eventAt: (seq) => events[seq],
    deriveEventMessage: (event) => ({ syntheticTokens: weights.get(event.seq) ?? 0 }),
    requestHeader: () => ({ config: { provider: 'illustrative', model: 'no-api-call' } }),
    append(type, data, opts = {}) {
      const event = { seq: events.length, type, data, ...opts }
      events.push(event)
      if (opts.surfaceOp?.op === 'replace') {
        const start = nodes.indexOf(opts.surfaceOp.startSeq)
        const end = nodes.indexOf(opts.surfaceOp.endSeq)
        assert(start >= 0 && end >= start)
        nodes.splice(start, end - start + 1, event.seq)
        weights.set(event.seq, config.summaryTokens)
      }
      return event
    },
  }
  function surface(type, data, tokens) {
    const event = session.append(type, data)
    nodes.push(event.seq)
    weights.set(event.seq, tokens)
  }
  surface('system/message', {}, config.systemTokens)
  session.append('turn/start', { turn: 1 })
  for (let step = 1; step <= config.requests; step++) {
    const block = Math.ceil(step / config.requestsPerBlock)
    if ((step - 1) % config.requestsPerBlock === 0) {
      surface('user/message', { role: 'user' }, config.userTokens)
    }
    const input = [...nodes]
    const inputTokens = input.reduce((sum, seq) => sum + weights.get(seq), 0)
    let prefixTokens = 0
    for (const previous of pastInputs) {
      let matching = 0
      for (let i = 0; i < Math.min(previous.length, input.length); i++) {
        if (previous[i] !== input[i]) break
        matching += weights.get(input[i])
      }
      prefixTokens = Math.max(prefixTokens, matching)
    }
    const cacheHitTokens = Math.floor(prefixTokens / config.cacheUnit) * config.cacheUnit
    requests.push({ request: step, block, inputTokens, cacheHitTokens,
      cacheMissTokens: inputTokens - cacheHitTokens,
      afterSummary: compact && step > 1 && (step - 1) % config.requestsPerBlock === 0 })
    pastInputs.push(input)
    session.append('step/start', { turn: 1, step })
    surface('assistant/message', { turn: 1, step, message: { content: [{ type: 'tool-call' }] } }, config.assistantTokens)
    session.append('tool/call', { turn: 1, step, name: 'block_run_code', arguments: JSON.stringify({ id: `task-${block}`, description: `Illustrative task ${block}` }) })
    if (compact && step % config.requestsPerBlock === 0) {
      const closing = session.append('tool/ptc-dispatch-start', { subCallId: `call-${step}:ptc:1`, name: 'block_summary', arguments: { id: `task-${block}`, summary: 'Synthetic summary' } })
      const plan = __internals.planReplacement(session, `task-${block}`, closing.seq)
      assert.equal(plan.kind, 'replace')
      __internals.commitReplacement(ctx, session, plan, `task-${block}`, 'Synthetic summary')
      // The closing request's assistant/tool pair is in flight during replacement.
      // It lands afterwards and remains in the next input, just as in the plugin.
    }
    surface('tool/result', { turn: 1, step, message: {} }, config.toolResultTokens)
  }
  return requests
}
const data = {
  kind: 'illustrative-not-measured',
  description: 'Same synthetic four-task conversation, two independent ideal prefix caches. Actual replacement planning uses the plugin. Token weights are assigned, not tokenized.',
  assumptions: [
    'Equal 4096-token fixed prefix in both presets; wrapper/schema/prompt overhead is normalized away.',
    'Four tasks, three requests per task; each new user instruction weighs 256 tokens; each completed assistant/tool pair weighs 2048.',
    'Each summary weighs 512 tokens; compaction happens inside requests 3, 6, 9 and 12, without an extra request. User instructions and the closing in-flight pair remain.',
    'Baseline is append-only PTC before its automatic compaction threshold is reached, not a comparison against every DSH compaction strategy.',
    'Ideal independent cache per arm: longest unchanged input prefix from earlier inputs, rounded down to 64-token units. No retention misses, cache build delay or contention.',
    'These are synthetic inputs and modeled cache hits, not real provider usage, speed, cost, quality or savings measurements.',
  ],
  config,
  baseline: run(false),
  blockPtc: run(true),
}
for (const arm of [data.baseline, data.blockPtc]) for (const row of arm) {
  assert.equal(row.cacheHitTokens + row.cacheMissTokens, row.inputTokens)
  assert(row.cacheHitTokens >= 0 && row.cacheHitTokens <= row.inputTokens)
}
writeFileSync(new URL('../docs/context-comparison/illustrative.json', import.meta.url), JSON.stringify(data, null, 2) + '\n')
console.log('Generated explicitly illustrative input/cache data; no API calls made.')
