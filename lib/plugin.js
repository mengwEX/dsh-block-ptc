/**
 * dsh-block-ptc — blackboard blocks for PTC mode.
 *
 * `block_run_code(id, description, code)` is the only directly callable tool in
 * the `block-ptc` preset. It behaves exactly like PTC `run_code` (the program is
 * handed to the built-in `run_code` tool through a nested dispatch, so SDK,
 * sub-call logging, sandbox and result rendering are the built-in ones) and it
 * additionally tags every surface node produced while the program runs with the
 * block `id`.
 *
 * Inside a program the SDK exposes one extra callable:
 *
 *   await tools.block_summary({ id, summary })
 *
 * which closes block `id` and replaces the block's model-visible surface span
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

/** Model-facing transport tool: the `run_code` twin that carries a block id. */
const BLOCK_RUN = 'block_run_code'
/** Program-callable: close a block and hand in its summary. */
const BLOCK_SUMMARY = 'block_summary'
/** Message-source kind that marks the replacement node as a compaction checkpoint. */
const CHECKPOINT_KIND = 'compact-checkpoint'
/** Surface node types a block may replace: model work only. */
const REPLACEABLE = new Set(['assistant/message', 'tool/result'])

export const name = 'dsh-block-ptc'
export const inject = ['tools', 'systemPrompt']

const RULES = `## Block mode

Call tools through \`${BLOCK_RUN}\`, the only directly callable tool. Use the \`tools.*\` SDK inside its TypeScript program to call other tools.

\`${BLOCK_RUN}({ id, description, code })\`

- \`id\` — one non-empty string, such as \`auth-refactor\`. The first call opens the block; reuse the same id to continue its work.
- \`description\` — required on every call, one line stating the block's goal.
- \`code\` — the program body. Top-level \`await\` and \`return\` work; \`return\` becomes the result.
- \`timeoutMs\` — optional execution budget in milliseconds.

### Closing a block

When a block's work is finished, call this from inside a program:

\`await tools.${BLOCK_SUMMARY}({ id, summary })\`

- \`summary\` — required, written by you. Summarize all content for this block id and submit the summary to replace the original content. Retain necessary information, such as file paths, as needed.`

/** Check the host capabilities used by the functional preset before mounting. */
function requireHostApi(ctx) {
  const missing = ['register', 'guard', 'execute']
    .filter((method) => typeof ctx.tools?.[method] !== 'function')
    .map((method) => `tools.${method}`)
  if (typeof ctx.systemPrompt?.section !== 'function') missing.push('systemPrompt.section')
  if (typeof ctx.get !== 'function') missing.push('context.get')
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

/** `turn:step` key of a step-scoped event. */
function stepKey(turn, step) {
  return `${String(turn)}:${String(step)}`
}

/**
 * Surface snapshot of one session.
 *
 * Surface order is the authority: a landed replacement puts a new (higher) seq
 * at an older position, so seqs are not monotonic and every position question is
 * answered by index, never by numeric comparison.
 */
function surfaceView(session) {
  const nodes = [...session.surface.nodes]
  const keys = []
  const types = []
  const balance = []
  let inProgress = 0
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    const data = event?.data
    let delta = 0
    if (event?.type === 'assistant/message') {
      const content = data?.message?.content
      if (Array.isArray(content)) {
        delta = content.filter((block) => block?.type === 'tool-call').length
      }
    } else if (event?.type === 'tool/result') {
      delta = -1
    }
    inProgress += delta
    if (inProgress < 0) inProgress = 0
    balance.push(inProgress)
    types.push(event?.type)
    // Only an assistant message identifies the step a tool call belongs to: the
    // system prompt and injected context also carry turn/step fields, and user
    // messages carry none.
    keys.push(event?.type === 'assistant/message' && data !== undefined ? stepKey(data.turn, data.step) : undefined)
  }
  return { nodes, keys, types, balance }
}

/** Index of the last surface node that is already fully paired and committed. */
function lastCommittedIndex(view) {
  for (let index = view.balance.length - 1; index >= 0; index -= 1) {
    if (view.balance[index] === 0) return index
  }
  return -1
}

/** `turn:step` of the step that owns a log position, read from the last `step/start`. */
function stepKeyAtSeq(events, seq) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.seq > seq) continue
    if (event.type === 'step/start') return stepKey(event.data.turn, event.data.step)
    if (event.type === 'turn/end') return undefined
  }
  return undefined
}

/** The turn that is currently open, or null between turns. */
function openTurn(session) {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start') return event.data.turn
    if (event.type === 'turn/end') return null
  }
  return null
}

/**
 * Derive every block this session has seen from its own log.
 *
 * `block_run_code` calls are model-direct `tool/call` events and
 * `block_summary` calls are nested `tool/ptc-dispatch-start` events, both of
 * which carry the call arguments, so the registry is rebuildable on replay,
 * resume and fork without any plugin-owned storage.
 */
function deriveBlocks(session) {
  const events = session.snapshotEvents()
  /** @type {{id: string, description: string | undefined, key: string | undefined, openSeq: number, closeSeq: number | undefined, closeKey: string | undefined}[]} */
  const records = []
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === BLOCK_RUN) {
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      const id = typeof args?.id === 'string' ? args.id : undefined
      if (id === undefined || id.length === 0) continue
      const open = [...records].reverse().find((record) => record.id === id && record.closeSeq === undefined)
      if (open !== undefined) {
        // A later call with the same id continues the open block: its span starts
        // at the call that opened it, not at the most recent one.
        if (open.description === undefined && typeof args.description === 'string') open.description = args.description
        continue
      }
      records.push({
        id,
        description: typeof args.description === 'string' ? args.description : undefined,
        key: stepKey(event.data.turn, event.data.step),
        openSeq: event.seq,
        closeSeq: undefined,
        closeKey: undefined,
      })
      continue
    }
    if (
      (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') &&
      event.data.name === BLOCK_SUMMARY
    ) {
      const id = event.data.arguments?.id
      if (typeof id !== 'string') continue
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        if (record.id !== id || record.closeSeq !== undefined) continue
        record.closeSeq = event.seq
        record.closeKey = stepKeyAtSeq(events, event.seq)
        break
      }
    }
  }
  return records
}

/** Seq of the sub-dispatch that is running right now, matched by its sub-call id. */
function currentSummaryCallSeq(events, callId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') continue
    if (event.data.name !== BLOCK_SUMMARY) continue
    if (event.data.subCallId === callId) return event.seq
  }
  return undefined
}

/** Index of the first surface node produced by a step, or -1. */
function indexOfStep(view, key) {
  if (key === undefined) return -1
  return view.keys.indexOf(key)
}

/**
 * Plan the replacement for one block summary.
 *
 * The replaced range is the maximal contiguous run of surface nodes that
 * (a) lie inside the closing block's span, (b) are covered by at least one
 * block, (c) are covered only by blocks that are already closed, and
 * (d) are fully committed (never the in-flight assistant message).
 */
function planReplacement(session, id, closeSeq) {
  const view = surfaceView(session)
  const records = deriveBlocks(session)
  const isCurrent = (record) => closeSeq !== undefined && record.closeSeq === closeSeq
  const reversed = [...records].reverse()
  const current =
    (closeSeq === undefined ? undefined : reversed.find((record) => record.id === id && isCurrent(record))) ??
    reversed.find((record) => record.id === id && record.closeSeq === undefined) ??
    reversed.find((record) => record.id === id)
  if (current === undefined) {
    const ids = [...new Set(records.filter((record) => record.closeSeq === undefined).map((record) => record.id))]
    throw new Error(
      `block_summary: block "${id}" was never opened by ${BLOCK_RUN}${ids.length > 0 ? `; open blocks: ${ids.join(', ')}` : ''}`,
    )
  }
  if (current.closeSeq !== undefined && !isCurrent(current)) {
    throw new Error(`block_summary: block "${id}" is already summarized`)
  }
  const closed = (record) => record.closeSeq !== undefined && !isCurrent(record)
  const start = indexOfStep(view, current.key)
  if (start < 0) return { kind: 'empty', reason: 'the opening step is no longer on the model-visible surface' }
  const events = session.snapshotEvents()
  const closeKey = closeSeq === undefined ? undefined : stepKeyAtSeq(events, closeSeq)
  const closeIndex = indexOfStep(view, closeKey)
  const committed = lastCommittedIndex(view)
  const limit = closeIndex < 0 ? committed : Math.min(closeIndex, committed)
  if (limit < start) return { kind: 'empty', reason: 'there is nothing committed to replace yet' }

  const positions = []
  for (let index = start; index <= limit; index += 1) {
    // Only model work is replaceable. The system prompt and every user-role
    // message stay: a human instruction must never be compressed away, so such a
    // node also breaks the run instead of being stepped over.
    if (!REPLACEABLE.has(view.types[index])) continue
    const covering = records.filter((record) => {
      const open = indexOfStep(view, record.key)
      if (open < 0 || open > index) return false
      if (isCurrent(record)) return true
      const close = closed(record) ? indexOfStep(view, record.closeKey) : -1
      return close < 0 ? true : index <= close
    })
    if (covering.length === 0) continue
    if (covering.some((record) => !closed(record) && !isCurrent(record))) continue
    positions.push(index)
  }
  if (positions.length === 0) return { kind: 'empty', reason: 'no closed, committed block content to replace' }

  // Contiguous runs; the first one carries the block's own opening.
  const runs = []
  let run = [positions[0]]
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] === positions[index - 1] + 1) run.push(positions[index])
    else {
      runs.push(run)
      run = [positions[index]]
    }
  }
  runs.push(run)
  const chosen = runs[0]
  const shadowedSeqs = chosen.map((index) => view.nodes[index])
  return {
    kind: 'replace',
    startSeq: shadowedSeqs[0],
    endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    description: current.description,
    leftoverRuns: runs.length - 1,
  }
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

/** The framed replacement text: a stable marker plus the model's own summary. */
function frameSummary(id, description, summary) {
  const header = `[block:${id}]${description === undefined ? '' : ` ${description}`}`
  return `${header}\n\n${summary}`
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
function commitReplacement(ctx, session, plan, id, summary) {
  const compactionId = `block:${id}:${String(Date.now())}:${Math.random().toString(16).slice(2, 10)}`
  const turn = openTurn(session)
  const header = session.requestHeader?.()
  const provider = header?.config?.provider ?? 'dsh-block-ptc'
  const model = header?.config?.model ?? 'dsh-block-ptc'
  const shadowedTokenCount = priceSpan(ctx, session, plan.shadowedSeqs)
  const framed = frameSummary(id, plan.description, summary)

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
      source: { kind: CHECKPOINT_KIND, compactionId },
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
    return `In block mode only \`${BLOCK_RUN}\` may be called directly. Call \`${exec.name}\` from inside a ${BLOCK_RUN} program (it is in the tools SDK there). To keep working in a new block, start one with \`${BLOCK_RUN}({ id, description, code })\`.`
  })

  ctx.tools.register({
    name: BLOCK_RUN,
    description:
      `Run a TypeScript program that reaches every other tool through the SDK, exactly like \`run_code\`, and tag everything it does with a block id. ` +
      `\`id\` opens or continues a block; \`description\` states that block's goal and is required. ` +
      `Call \`${BLOCK_SUMMARY}({ id, summary })\` from inside the program once the block is finished.`,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Block id: a short stable slug such as `auth-refactor`. Everything this program does belongs to this block.',
        },
        description: {
          type: 'string',
          description: 'One line stating the goal of this block. Required on every call.',
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
      required: ['id', 'description', 'code'],
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
      if (typeof args.id !== 'string' || args.id.trim().length === 0) {
        throw new Error(`${BLOCK_RUN}: \`id\` must be a non-empty block id`)
      }
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
          description: `[block:${args.id}] ${args.description}`,
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
      `Summarize and close block \`id\` with a summary you write yourself. ` +
      `Call from inside a ${BLOCK_RUN} program: \`await tools.${BLOCK_SUMMARY}({ id, summary })\`.`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Block id to close.' },
        summary: {
          type: 'string',
          description:
            'Required, written by you. Summarize all content for this block id and submit the summary to replace the original content. Retain necessary information, such as file paths, as needed.',
        },
      },
      required: ['id', 'summary'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          replaced: { type: 'number' },
          tokensFreed: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['replaced', 'tokensFreed'],
      },
      render: (_args, value) =>
        value.note === undefined
          ? [textBlock(`[${BLOCK_SUMMARY}] replaced ${String(value.replaced)} messages with the summary (~${String(value.tokensFreed)} tokens freed).`)]
          : [textBlock(`[${BLOCK_SUMMARY}] nothing replaced: ${value.note}`)],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error(`${BLOCK_SUMMARY}: no session on this execution`)
      if (typeof args.id !== 'string' || args.id.trim().length === 0) {
        throw new Error(`${BLOCK_SUMMARY}: \`id\` must be a non-empty block id`)
      }
      if (typeof args.summary !== 'string' || args.summary.trim().length === 0) {
        throw new Error(
          `${BLOCK_SUMMARY}: \`summary\` is required and must be written by you`,
        )
      }
      requireSessionApi(session)
      const events = session.snapshotEvents()
      const closeSeq = currentSummaryCallSeq(events, exec.callId)
      const plan = planReplacement(session, args.id, closeSeq)
      if (plan.kind === 'empty') {
        return { replaced: 0, tokensFreed: 0, note: plan.reason }
      }
      const result = commitReplacement(ctx, session, plan, args.id, args.summary)
      return { replaced: result.replaced, tokensFreed: result.shadowedTokenCount }
    },
  })
}

/** Exposed for the logic test and for maintenance debugging. Not a public API. */
export const __internals = {
  surfaceView,
  lastCommittedIndex,
  stepKeyAtSeq,
  deriveBlocks,
  planReplacement,
  commitReplacement,
  openTurn,
}
