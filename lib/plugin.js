/**
 * dsh-block-ptc — blackboard blocks for PTC mode.
 *
 * `block_run_code({ ids, description, code })` is the only directly callable tool in
 * the `block-ptc` preset. It behaves exactly like PTC `run_code` (the program is
 * handed to the built-in `run_code` tool through a nested dispatch, so SDK,
 * sub-call logging, sandbox and result rendering are the built-in ones) and it
 * tags its complete assistant message and tool results with the supplied ids.
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
import { normalizeIds, surfaceView, planReplacement, pendingSummaries } from './blocks.js'

/** Model-facing transport tool: the `run_code` twin that carries a block id. */
const BLOCK_RUN = 'block_run_code'
/** Program-callable: close a block and hand in its summary. */
const BLOCK_SUMMARY = 'block_summary'
/** Message-source kind that marks the replacement node as a compaction checkpoint. */
const CHECKPOINT_KIND = 'compact-checkpoint'

export const name = 'dsh-block-ptc'
export const inject = ['tools', 'systemPrompt']

const SUMMARY_GUIDANCE = 'Summarize the complete content from the first occurrence to the last occurrence of these ids. State the goal, completed work and results, unfinished work, and the next step. Distinguish completed work from pending work; if only reporting to the user remains, say so. Retain necessary code, file paths, commands, key outputs and decisions as appropriate.'

const RULES = `## Block mode

Call tools through \`${BLOCK_RUN}\`, the only directly callable tool. Use the \`tools.*\` SDK inside its TypeScript program to call other tools.

\`${BLOCK_RUN}({ ids, description, code })\`

- \`ids\` — required, an array of block ids for this work, such as \`["auth-refactor"]\`. Reuse an id to continue its work.
- \`description\` — required on every call, one line stating the goal of this work.
- \`code\` — the program body. Top-level \`await\` and \`return\` work; \`return\` becomes the result.
- \`timeoutMs\` — optional execution budget in milliseconds.

### Closing a block

When a block's work is finished, call this from inside a program:

\`await tools.${BLOCK_SUMMARY}({ ids, summary })\`

- \`ids\` — required, the block ids to summarize and close.
- \`summary\` — required, written by you. ${SUMMARY_GUIDANCE}

An earlier \`<block-summary>\` contains your own summary of earlier work. Continue from its recorded progress and next step. If it lists block ids, those are its remaining block memberships.`

/** Check the host capabilities used by the functional preset before mounting. */
function requireHostApi(ctx) {
  const missing = ['register', 'guard', 'execute']
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

/** Render a program completion value the way PTC mode renders it. */
function renderValue(value) {
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value, null, 2)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
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
      const plan = planReplacement(session, request.ids)
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
 * Mount the block plane.
 *
 * The bundle patch mounts this plugin twice with different intents: a host-level
 * row that exists only so the package is a Loader entry (which is what makes the
 * browser half in `client/client.js` reachable — the client module scan reads
 * host entries only), and the real row inside the `block-ptc` preset. The host
 * row carries `config.anchor`, so it registers nothing: a host-level guard would
 * deny every direct tool call in every other preset.
 *
 * @param ctx - plugin context.
 * @param config - row config; `{ anchor: true }` marks the discovery anchor.
 */
export function apply(ctx, config) {
  if (config !== null && typeof config === 'object' && config.anchor === true) return
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

  // Direct calls: only the transport tool. Everything else — including the
  // built-in `run_code` — is reachable from inside a program, where the call
  // carries a parent token.
  ctx.tools.guard((exec) => {
    if (exec.parent !== undefined) return undefined
    if (exec.name === BLOCK_RUN) return undefined
    return `In block mode only \`${BLOCK_RUN}\` may be called directly. Call \`${exec.name}\` from inside a ${BLOCK_RUN} program (it is in the tools SDK there). To keep working in a new block, start one with \`${BLOCK_RUN}({ ids, description, code })\`.`
  })

  ctx.tools.register({
    name: BLOCK_RUN,
    description:
      `Run a TypeScript program that reaches every other tool through the SDK, exactly like \`run_code\`, and tag everything it does with a block id. ` +
      `\`ids\` assigns the work to blocks; \`description\` states the goal and is required. ` +
      `Call \`${BLOCK_SUMMARY}({ ids, summary })\` from inside the program once the work is finished.`,
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array', items: { type: 'string' },
          description: 'Required block ids for this work. Reuse an id to continue its work.',
        },
        id: {
          type: 'string',
          description: 'Legacy alias for ids: [id]. Supply either ids or id.',
        },
        description: {
          type: 'string',
          description: 'One line stating the goal of this work. Required on every call.',
        },
        code: {
          type: 'string',
          description: 'Program body. Top-level `await` and `return` are available; `return` becomes the result.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional elapsed execution budget in milliseconds for this program.',
        },
      },
      required: ['description', 'code'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'array', items: { type: 'string' } },
          result: {},
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
              denied: { type: 'boolean' },
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
            required: ['mode', 'denied'],
          },
        },
        required: ['logs'],
      },
      render: (_args, value) => {
        const rendered = value?.result === undefined ? '' : renderValue(value.result)
        const parts = [Array.isArray(value?.logs) ? value.logs.join('\n') : '', rendered].filter((part) => part.length > 0)
        if (value?.sandbox?.enforcement === 'partial') parts.push('File sandbox enforcement is partial on this host.')
        if (value?.sandbox?.denied) parts.push(`The ${String(value.sandbox.mode)} file sandbox denied an operation.`)
        return [textBlock(parts.length > 0 ? parts.join('\n') : '(block_run_code completed with no output)')]
      },
    },
    async execute(args, exec) {
      const ids = normalizeIds(args, BLOCK_RUN)
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error(`${BLOCK_RUN}: \`description\` is required — one line stating this block's goal`)
      }
      if (typeof args.code !== 'string' || args.code.trim().length === 0) {
        throw new Error(`${BLOCK_RUN}: \`code\` must be a non-empty program`)
      }
      // The nested transport deliberately keeps the OUTER call id. The PTC
      // bridge stamps every program dispatch with `parentCallId = <the executing
      // call's id>`, and the conversation UI can only hang those sub-calls off a
      // call node it can see. A synthetic parent such as `<callId>:blk:1` is no
      // node in the transcript, so the whole sub-call tree would be projected
      // away and the block card would show a bare tool row. Reusing the outer id
      // reproduces PTC mode's topology exactly: rootCallId = parentCallId =
      // <callId>, with program sub-calls named `<callId>:ptc:<n>`.
      const nested = await ctx.tools.execute({
        callId: String(exec.callId),
        rootCallId: exec.rootCallId,
        name: 'run_code',
        arguments: {
          code: args.code,
          description: `[block:${ids.join(',')}] ${args.description}`,
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        },
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        parent: exec.token,
        signal: exec.signal,
      })
      if (nested.isError) {
        throw new Error(nested.error?.message ?? 'block_run_code: the program failed')
      }
      return nested.value
    },
  })

  ctx.tools.register({
    name: BLOCK_SUMMARY,
    description:
      `Summarize and close the blocks in \`ids\` with a summary you write yourself. ` +
      `Call from inside a ${BLOCK_RUN} program: \`await tools.${BLOCK_SUMMARY}({ ids, summary })\`.`,
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
      const plan = planReplacement(session, ids)
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
  pendingSummaries,
  planReplacement,
  commitReplacement,
  openTurn,
  flushPending,
}
