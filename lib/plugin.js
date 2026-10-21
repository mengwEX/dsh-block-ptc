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
 *   await tools.block_compact({ ids, content })
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
import { normalizeIds, parseBlockHeader, surfaceView, planReplacement, pendingCompactions } from './blocks.js'
import { RULES, HEADER_GUIDANCE, CONTENT_GUIDANCE, COMPACT_GUIDANCE, blockPrompt } from './prompts.js'

/** The only directly callable tool in a PTC composition. */
const RUN_CODE = 'run_code'
/** Program-callable: close a block and hand in its summary. */
const BLOCK_COMPACT = 'block_compact'
/** Message-source kind that marks the replacement node as a compaction checkpoint. */
const CHECKPOINT_KIND = 'compact-checkpoint'

export const name = 'dsh-block-ptc'
export const inject = ['tools', 'systemPrompt']

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
    throw new Error(`${BLOCK_COMPACT}: incompatible DSH session API; missing ${missing.join(', ')}`)
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
function compactionRequestSeq(session, callId) {
  return [...session.snapshotEvents()].reverse().find((event) =>
    event.type === 'tool/ptc-dispatch-start' && event.data.name === BLOCK_COMPACT && event.data.subCallId === callId,
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
function frameSummary(ids, content) {
  const membership = ids.length > 0 ? `Block ids: ${JSON.stringify(ids)}\n\n` : ''
  return `The following is information you retained from earlier work in this conversation. Use it to continue the current task.\n\n<block-summary>\n${membership}${content}\n</block-summary>`
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
function commitReplacement(ctx, session, plan, target, content, requestSeq = null) {
  if (plan.kind !== 'replace') throw new Error('block_compact: tool results have not completed')
  if (compactionBusy(session)) throw new Error('block_compact: another compaction is in progress')
  const closedIds = normalizeIds({ ids: target }, BLOCK_COMPACT)
  const compactionId = `block:${randomUUID()}`
  const turn = openTurn(session)
  const header = session.requestHeader?.()
  const provider = header?.config?.provider ?? 'dsh-block-ptc'
  const model = header?.config?.model ?? 'dsh-block-ptc'
  const shadowedTokenCount = priceSpan(ctx, session, plan.shadowedSeqs)
  const framed = frameSummary(plan.ids, content)

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
  for (const request of pendingCompactions(session)) {
    try {
      const plan = planReplacement(session, request.ids, request.requestSeq)
      if (plan.kind === 'pending') continue
      commitReplacement(ctx, session, plan, request.ids, request.content, request.requestSeq)
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
 * `block_compact`.
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
        if (failures.get(session) !== message) ctx.logger?.warn(`Deferred block compaction not committed: ${message}`)
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

  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => blockPrompt(await next()))

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
      return `${HEADER_GUIDANCE} This call did not run; retry with the header.`
    }
    return undefined
  })

  ctx.tools.register({
    name: BLOCK_COMPACT,
    description:
      `${COMPACT_GUIDANCE} ` +
      `Call from inside a ${RUN_CODE} program: \`await tools.${BLOCK_COMPACT}({ ids, content })\`.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: {
          type: 'array', items: { type: 'string' },
          description: 'Required. The block ids to organize and close.',
        },
        content: {
          type: 'string',
          description: `Required, written by you. ${CONTENT_GUIDANCE}`,
        },
      },
      required: ['ids', 'content'],
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
      if (session === undefined) throw new Error(`${BLOCK_COMPACT}: no session on this execution`)
      const ids = normalizeIds(args, BLOCK_COMPACT)
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        throw new Error(
          `${BLOCK_COMPACT}: \`content\` is required and must be written by you`,
        )
      }
      requireSessionApi(session)
      const requestSeq = compactionRequestSeq(session, exec.callId)
      const plan = planReplacement(session, ids, requestSeq)
      if (plan.kind === 'pending' || compactionBusy(session)) {
        if (requestSeq === undefined) throw new Error(`${BLOCK_COMPACT}: no durable invocation to defer`)
        return { replaced: 0, tokensFreed: 0, pending: true, requestSeq, note: 'Waiting for tool results or the current compaction to finish.' }
      }
      const result = commitReplacement(ctx, session, plan, ids, args.content, requestSeq ?? null)
      return { replaced: result.replaced, tokensFreed: result.shadowedTokenCount, ...(plan.ids.length > 0 ? { ids: plan.ids } : {}) }
    },
  })
}

/** Exposed for the logic test and for maintenance debugging. Not a public API. */
export const __internals = {
  surfaceView,
  normalizeIds,
  parseBlockHeader,
  pendingCompactions,
  planReplacement,
  commitReplacement,
  openTurn,
  flushPending,
}
