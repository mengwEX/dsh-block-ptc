/**
 * dsh-block-ptc — blackboard blocks for PTC mode.
 *
 * DSH's PTC presentation makes the built-in `run_code` transport the only tool
 * the model may call directly. This plugin layers a block protocol on it: every
 * `run_code` description starts with `[block: id1, id2] goal`, and that
 * membership tags the complete assistant message (including preceding
 * thinking/text) and its tool results with the supplied ids.
 *
 * Inside a program the SDK exposes one extra callable:
 *
 *   await tools.block_summary({ ids, summary })
 *
 * which closes those ids and replaces their complete first-to-last interval
 * with the summary the model wrote itself. The replacement is a normal
 * compaction transaction (`compaction/start` → `compaction/summary` →
 * shadowing `user/message` → `compaction/end`), so the token meter's shadow
 * price stays exact, the durable compaction lock excludes concurrent
 * compaction, and the original events stay in the append-only log (the human
 * transcript keeps showing them).
 *
 * @module dsh-block-ptc
 */

import { randomUUID } from 'node:crypto'
import { normalizeIds, parseBlockHeader, surfaceView, planReplacement, pendingSummaries } from './blocks.js'

/** The only directly callable tool in a PTC composition. */
const RUN_CODE = 'run_code'
/** Program-callable: close a block and hand in its summary. */
const BLOCK_SUMMARY = 'block_summary'
/** Message-source kind that marks the replacement node as a compaction checkpoint. */
const CHECKPOINT_KIND = 'compact-checkpoint'

export const name = 'dsh-block-ptc'
export const inject = ['tools', 'systemPrompt']

const SUMMARY_GUIDANCE = 'Summarize the complete content from the first occurrence to the last occurrence of these ids, including intervening user messages. Preserve added requirements, corrections and constraints accurately. State the goal, completed work and results, unfinished work, and the next step. Distinguish completed work from pending work; if only reporting to the user remains, say so. Retain necessary code, file paths, commands, key outputs and decisions as appropriate.'
const BLOCK_GUIDANCE = 'Choose cohesive, loosely coupled, medium-sized units of work, each with a clear subgoal and completion point.'

const RULES = `## Block mode

Call the built-in \`run_code\` tool directly; it is the only tool you may call without a program. Use the \`tools.*\` SDK inside its TypeScript program to call everything else.

\`run_code({ description, code })\`

- \`description\` — required. Start it with \`[block: <ids>] <goal>\`, for example \`[block: session-refresh] Refresh the session cache\`. Use \`[block: a, b]\` when the program advances several blocks; ids are non-empty strings that must not contain commas, brackets or line breaks.
- \`code\` — the program body. Top-level \`await\` and \`return\` work; \`return\` becomes the result.
- \`timeoutMs\` — optional execution budget in milliseconds.

${BLOCK_GUIDANCE} Reuse an id while continuing the same subgoal. Keep related investigation, implementation and verification for a subgoal together. Split a large task into blocks for separable subgoals; do not put the entire large task in one block or create a new block for every tool call. A small task may fit in one block. Summarize and close each unit when its work is complete, then continue with the remaining work without waiting for the entire task to finish.

### Closing a block

When a block's work is finished, call this from inside a program:

\`await tools.block_summary({ ids, summary })\`

- \`ids\` — required, the block ids to summarize and close.
- \`summary\` — required, written by you. ${SUMMARY_GUIDANCE}

An earlier \`<block-summary>\` contains your own summary of earlier work. Continue from its recorded progress and next step. If it lists block ids, those are its remaining block memberships.`

/** Check the host capabilities used by the functional preset before mounting. */
function requireHostApi(ctx) {
  const missing = ['register', 'guard']
    .filter((method) => typeof ctx.tools?.[method] !== 'function')
    .map((method) => `tools.${method}`)
  if (typeof ctx.systemPrompt?.section !== 'function') missing.push('systemPrompt.section')
  if (typeof ctx.get !== 'function') missing.push('context.get')
  if (typeof ctx.on !== 'function') missing.push('context.on')
  if (missing.length > 0) {
    throw new Error(`dsh-block-ptc: incompatible DSH host API; missing ${missing.join(', ')}`)
  }
}

/** Check the session seam before planning or appending a summary transaction. */
function requireSessionApi(session) {
  const missing = ['snapshotEvents', 'eventAt', 'deriveEventMessage', 'append']
    .filter((method) => typeof session[method] !== 'function')
  if (typeof session.surface?.nodes?.[Symbol.iterator] !== 'function') missing.push('surface.nodes (iterable)')
  if (missing.length > 0) {
    throw new Error(`${BLOCK_SUMMARY}: incompatible DSH session API; missing ${missing.join(', ')}`)
  }
}

/** Text content block helper. */
function textBlock(text) {
  return { type: 'text', text }
}

/** The turn currently open, or null between turns. */
function openTurn(session) {
  for (const event of [...session.snapshotEvents()].reverse()) {
    if (event.type === 'turn/start') return event.data.turn
    if (event.type === 'turn/end') return null
  }
  return null
}

/** Locate the durable invocation that submitted a summary. */
function summaryRequestSeq(session, callId) {
  return [...session.snapshotEvents()].reverse().find((event) =>
    event.type === 'tool/ptc-dispatch-start' && event.data.name === BLOCK_SUMMARY && event.data.subCallId === callId,
  )?.seq
}

/** Heuristic price used only when no token meter is mounted. */
function roughTokens(message) {
  try {
    return Math.ceil(JSON.stringify(message.content).length / 4)
  } catch {
    return 0
  }
}

/** Estimated token price of the shadowed span. */
function priceSpan(ctx, session, shadowedSeqs) {
  const meter = ctx.get('tokenMeter')
  let total = 0
  for (const seq of shadowedSeqs) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message === null || message === undefined) continue
    total += meter === undefined ? roughTokens(message) : meter.estimateMessage(message)
  }
  return total
}

/** A block summary stays distinct from the host's automatic-compaction summary. */
function frameSummary(ids, summary) {
  const membership = ids.length > 0 ? `Block ids: ${JSON.stringify(ids)}\n\n` : ''
  return `The following is your summary of earlier work in this conversation. Continue from the recorded progress and next step.\n\n<block-summary>\n${membership}${summary}\n</block-summary>`
}

/** Observe the native durable compaction lock before appending our own bracket. */
function compactionBusy(session) {
  const active = new Set()
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/start') active.add(event.data.compactionId)
    if (event.type === 'compaction/end') active.delete(event.data.compactionId)
  }
  return active.size > 0
}

/**
 * Commit one block replacement as a compaction transaction.
 *
 * Order is contractual: `compaction/start` takes the durable lock,
 * `compaction/summary` states the shadow price of the exact replaced range and
 * must sit immediately before the replacing `user/message`, and
 * `compaction/end` releases the lock. Nothing may yield between the summary and
 * the replacement.
 *
 * Every failure makes exactly one close attempt: an unmatched `compaction/start`
 * is the durable compaction lock, so leaving one behind would make the whole
 * session look permanently busy to the compaction service.
 */
function commitReplacement(ctx, session, plan, target, summary, requestSeq = null) {
  if (plan.kind !== 'replace') throw new Error('block_summary: tool results have not completed')
  if (compactionBusy(session)) throw new Error('block_summary: another compaction is in progress')
  const closedIds = normalizeIds(typeof target === 'string' ? { id: target } : { ids: target }, BLOCK_SUMMARY)
  const compactionId = `block:${randomUUID()}`
  const turn = openTurn(session)
  const header = session.requestHeader?.()
  const provider = header?.config?.provider ?? 'dsh-block-ptc'
  const model = header?.config?.model ?? 'dsh-block-ptc'
  const shadowedTokenCount = priceSpan(ctx, session, plan.shadowedSeqs)
  const framed = frameSummary(plan.ids, summary)

  const startEvent = session.append('compaction/start', { compactionId, turn })
  let summaryEvent
  try {
    summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary: [textBlock(framed)],
      shadowedRange: { start: plan.startSeq, end: plan.endSeq },
      shadowedSeqs: [...plan.shadowedSeqs],
      shadowedTokenCount,
      provider,
      model,
    })
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [textBlock(framed)],
      source: { kind: CHECKPOINT_KIND, compactionId, blockPtc: { version: 1, ids: [...plan.ids], closedIds, requestSeq } },
    }
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...plan.shadowedSeqs],
    })
  } catch (error) {
    session.append('compaction/end', {
      compactionId,
      turn,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  session.append('compaction/end', { compactionId, turn })
  return { replaced: plan.shadowedSeqs.length, shadowedTokenCount }
}

/** Commit accepted deferred summaries after the outer tool-result append returns. */
function flushPending(ctx, session) {
  if (compactionBusy(session)) return
  const errors = []
  for (const request of pendingSummaries(session)) {
    try {
      const plan = planReplacement(session, request.ids, request.requestSeq)
      if (plan.kind === 'pending') continue
      commitReplacement(ctx, session, plan, request.ids, request.summary, request.requestSeq)
    } catch (error) {
      errors.push(`request ${request.requestSeq}: ${error instanceof Error ? error.message : String(error)}`)
      if (compactionBusy(session)) break
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '))
}

/**
 * Mount the block plane inside the `block-ptc` preset.
 *
 * The preset's `tool-presentation` row selects `ptc`, so the host exposes only
 * `run_code` directly. This row adds the block protocol around that one
 * transport: the rules section, the header guard, and the program-callable
 * `block_summary`.
 *
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  requireHostApi(ctx)

  const scheduled = new WeakSet()
  const failures = new WeakMap()
  ctx.on('session/event', (session, event) => {
    if (!['tool/result', 'tool/ptc-dispatch', 'compaction/end', 'step/start', 'turn/start'].includes(event.type) || scheduled.has(session)) return
    scheduled.add(session)
    // Session.append forbids reentry while observers are being notified.
    queueMicrotask(() => {
      try {
        flushPending(ctx, session)
        failures.delete(session)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (failures.get(session) !== message) ctx.logger?.warn(`Deferred block summary not committed: ${message}`)
        failures.set(session, message)
      } finally {
        scheduled.delete(session)
      }
    })
  })

  ctx.systemPrompt.section({
    name: 'dsh-block-ptc:rules',
    order: 4500,
    interpolate: false,
    text: RULES,
  })

  // The host's PTC collapse already limits model-direct calls to run_code.
  // This guard adds the block contract: every run_code description must carry
  // a header the membership scan can tag, and under a native composition
  // (where the collapse does not run) no other tool is directly callable either.
  ctx.tools.guard((exec) => {
    if (exec.parent !== undefined) return undefined
    if (exec.name !== RUN_CODE) {
      return `In block mode only \`${RUN_CODE}\` may be called directly. Call \`${exec.name}\` from inside a ${RUN_CODE} program (it is in the tools SDK there).`
    }
    if (parseBlockHeader(exec.arguments?.description) === undefined) {
      return `In block mode every \`${RUN_CODE}\` description must start with \`[block: <ids>] <goal>\`, for example \`[block: auth] Rework the auth tests\`. This call did not run; retry with the header.`
    }
    return undefined
  })

  ctx.tools.register({
    name: BLOCK_SUMMARY,
    description:
      `Summarize and close the blocks in \`ids\` with a summary you write yourself. ` +
      `Call from inside a ${RUN_CODE} program: \`await tools.${BLOCK_SUMMARY}({ ids, summary })\`.`,
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array', items: { type: 'string' },
          description: 'Required. The block ids to summarize and close.',
        },
        id: { type: 'string', description: 'Legacy alias for ids: [id]. Supply either ids or id.' },
        summary: {
          type: 'string',
          description: `Required, written by you. ${SUMMARY_GUIDANCE}`,
        },
      },
      required: ['summary'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          replaced: { type: 'number' },
          tokensFreed: { type: 'number' },
          note: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' } },
          pending: { type: 'boolean' },
          requestSeq: { type: 'number' },
        },
        required: ['replaced', 'tokensFreed'],
      },
      render: (_args, value) => [textBlock(JSON.stringify(value))],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error(`${BLOCK_SUMMARY}: no session on this execution`)
      const ids = normalizeIds(args, BLOCK_SUMMARY)
      if (typeof args.summary !== 'string' || args.summary.trim().length === 0) {
        throw new Error(
          `${BLOCK_SUMMARY}: \`summary\` is required and must be written by you`,
        )
      }
      requireSessionApi(session)
      const requestSeq = summaryRequestSeq(session, exec.callId)
      const plan = planReplacement(session, ids, requestSeq)
      if (plan.kind === 'pending' || compactionBusy(session)) {
        if (requestSeq === undefined) throw new Error(`${BLOCK_SUMMARY}: no durable invocation to defer`)
        return { replaced: 0, tokensFreed: 0, pending: true, requestSeq, note: 'Waiting for tool results or the current compaction to finish.' }
      }
      const result = commitReplacement(ctx, session, plan, ids, args.summary, requestSeq ?? null)
      return { replaced: result.replaced, tokensFreed: result.shadowedTokenCount, ...(plan.ids.length > 0 ? { ids: plan.ids } : {}) }
    },
  })
}

/** Exposed for the logic test and for maintenance debugging. Not a public API. */
export const __internals = {
  surfaceView,
  normalizeIds,
  parseBlockHeader,
  pendingSummaries,
  planReplacement,
  commitReplacement,
  openTurn,
  flushPending,
}
