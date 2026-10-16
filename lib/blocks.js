/** Message membership and interval planning. All state is rebuilt from the log. */

export function normalizeIds(args, tool) {
  if (args.ids !== undefined && args.id !== undefined) throw new Error(`${tool}: use ids or the legacy id, not both`)
  const ids = args.ids ?? (args.id === undefined ? undefined : [args.id])
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new Error(`${tool}: ids must be a non-empty array of non-empty strings`)
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${tool}: ids must not contain duplicates`)
  return [...ids]
}

function loggedIds(args) {
  try { return normalizeIds(args, 'block') } catch { return [] }
}

const keyOf = (data) => `${String(data.turn)}:${String(data.step)}`

/** Job completion notices are tool output even though the host gives them a user role. */
function isJobNotice(event) {
  if (event?.type !== 'user/message') return false
  const source = event.data?.source
  return source?.form === 'notice' && (
    source.kind === 'tool-jobs' || (source.kind === 'plugin' && source.plugin === 'tool-jobs')
  )
}

/** Only our durable checkpoint metadata gives a summary active memberships. */
export function summaryMetadata(event) {
  const source = event?.type === 'user/message' ? event.data?.source : undefined
  const meta = source?.kind === 'compact-checkpoint' ? source.blockPtc : undefined
  return meta?.version === 1 && Array.isArray(meta.ids) && meta.ids.every((id) => typeof id === 'string') ? meta : undefined
}

/** Map whole assistant messages and their results to the union of their calls' ids. */
export function surfaceView(session) {
  const events = session.snapshotEvents()
  const steps = new Map()
  const calls = new Map()
  const assign = (key, raw) => {
    let args
    try { args = JSON.parse(raw) } catch { return }
    const ids = steps.get(key) ?? new Set()
    for (const id of loggedIds(args)) ids.add(id)
    steps.set(key, ids)
  }
  for (const event of events) {
    // Read the complete model-issued batch before dispatch starts. Another
    // call in that same message may not have a tool/call log record yet.
    if (event.type === 'assistant/message') {
      const key = keyOf(event.data)
      for (const part of event.data.message?.content ?? []) {
        if (part.type !== 'tool-call') continue
        calls.set(part.id, key)
        if (part.name === 'block_run_code') assign(key, part.arguments)
      }
    }
    if (event.type !== 'tool/call') continue
    const key = keyOf(event.data)
    calls.set(event.data.callId, key)
    if (event.data.name !== 'block_run_code') continue
    assign(key, event.data.arguments)
  }
  let balance = 0
  return [...session.surface.nodes].map((seq) => {
    const event = session.eventAt(seq)
    const metadata = summaryMetadata(event)
    const data = event?.data
    let key
    if (event?.type === 'assistant/message') {
      key = keyOf(data)
      balance += (data.message?.content ?? []).filter((part) => part.type === 'tool-call').length
    } else if (event?.type === 'tool/result') {
      key = calls.get(data.message?.source?.callId ?? data.message?.toolCallId ?? data.callId) ?? keyOf(data)
      balance -= 1
    }
    if (balance < 0) throw new Error('block_summary: unpaired tool result on the session surface')
    return {
      seq, event, balance,
      ids: metadata === undefined ? [...(steps.get(key) ?? [])] : [...metadata.ids],
      replaceable: metadata !== undefined || isJobNotice(event) || event?.type === 'assistant/message' || event?.type === 'tool/result',
    }
  })
}

/** Plan one entire first-to-last interval, or wait for its tool pairs to settle. */
export function planReplacement(session, target) {
  const ids = normalizeIds(typeof target === 'string' ? { id: target } : { ids: target }, 'block_summary')
  const wanted = new Set(ids)
  const rows = surfaceView(session)
  const matches = rows.flatMap((row, index) => row.ids.some((id) => wanted.has(id)) ? [index] : [])
  const present = new Set(rows.flatMap((row) => row.ids))
  const missing = ids.filter((id) => !present.has(id))
  if (missing.length > 0) throw new Error(`block_summary: no current content for ids ${JSON.stringify(missing)}`)
  const first = matches[0]
  const last = matches[matches.length - 1]
  const span = rows.slice(first, last + 1)
  if (span.some((row) => !row.replaceable)) {
    throw new Error('block_summary: the full interval contains protected system/user/developer messages; nothing was replaced')
  }
  if ((rows[first - 1]?.balance ?? 0) !== 0) throw new Error('block_summary: the interval starts inside an unfinished tool group')
  const inherited = [...new Set(span.flatMap((row) => row.ids))].filter((id) => !wanted.has(id))
  return {
    kind: rows[last].balance === 0 ? 'replace' : 'pending',
    startSeq: rows[first].seq,
    endSeq: rows[last].seq,
    shadowedSeqs: span.map((row) => row.seq),
    closedIds: ids,
    ids: inherited,
  }
}

/** Successful queued tool outcomes survive restart/fork; attempts alone do not close ids. */
export function pendingSummaries(session) {
  const events = session.snapshotEvents()
  const committed = new Set(events.map(summaryMetadata).filter(Boolean).map((meta) => meta.requestSeq))
  const starts = new Map()
  const pending = []
  for (const event of events) {
    const data = event.data
    if (event.type === 'tool/ptc-dispatch-start' && data.name === 'block_summary') starts.set(data.subCallId, event.seq)
    if (event.type !== 'tool/ptc-dispatch' || data.name !== 'block_summary' || data.isError !== false) continue
    const requestSeq = starts.get(data.subCallId)
    if (requestSeq === undefined || committed.has(requestSeq)) continue
    let value
    try { value = JSON.parse((data.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')) } catch { continue }
    if (value.pending !== true || value.requestSeq !== requestSeq) continue
    const ids = loggedIds(data.arguments)
    if (ids.length > 0 && typeof data.arguments.summary === 'string') pending.push({ ids, summary: data.arguments.summary, requestSeq })
  }
  return pending
}
