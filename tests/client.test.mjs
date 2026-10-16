/**
 * Client-half smoke test for dsh-block-ptc.
 *
 * Loads `client/client.js` through a stubbed browser module table and drives the
 * registered `block_run_code` row through every lifecycle shape the Tool tree
 * can hand it: preparation, a dispatched program, a settled result, and a
 * malformed argument payload. A keyed view that throws blanks the slot entry, so
 * "renders something for every stage" is the contract this test protects.
 *
 *   node tests/client.test.mjs
 */

import assert from 'node:assert/strict'

/** Minimal React stand-in: enough for createElement, Fragment and useState. */
const react = {
  createElement: (type, props, ...children) => {
    const clean = children.flat().filter((child) => child !== null && child !== undefined && child !== false)
    // Evaluate function components the way React does, so a test can walk the
    // rendered tree instead of a tree of unrendered component references.
    if (typeof type === 'function') return type({ ...(props ?? {}), children: clean })
    return { type, props: props ?? {}, children: clean }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  Fragment: Symbol('react.fragment'),
}

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load: (registration) => {
      registrations.push(registration)
    },
  },
}
globalThis.document = undefined

await import('../client/client.js')

assert.equal(registrations.length, 1, 'the client module registers exactly one factory')
const [registration] = registrations
assert.equal(registration.id, 'dsh-block-ptc', 'the factory id is the package name')
assert.equal(typeof registration.factory, 'function', 'the factory is a function')

const plugin = registration.factory((specifier) => {
  assert.equal(specifier, 'react', 'the client half imports only react')
  return react
})
assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'], 'the plugin injects the slot and locale services')

// ── registration ───────────────────────────────────────────────────────────
const registered = []
const effects = []
const ctx = {
  effect: (fn, label) => {
    effects.push(label)
    return fn()
  },
  locale: {
    register: (ns, dictionaries) => {
      registered.push({ ns, dictionaries })
      return () => {}
    },
  },
  slots: {
    inject: (ownerKey, callback) => {
      registered.push({ ownerKey })
      return callback()
    },
    register: (descriptor, component) => {
      registered.push({ descriptor, component })
      return () => {}
    },
  },
}
plugin.apply(ctx)

const slot = registered.find((entry) => entry.descriptor !== undefined)
assert.equal(slot.descriptor.name, 'tool.call.toolview', 'the row is registered into the Tool view slot')
assert.equal(slot.descriptor.key, 'block_run_code', 'the row is keyed by the wire tool name')
assert.equal(slot.descriptor.locale, 'dsh-block-ptc', 'the row binds this plugin\'s dictionary namespace')
assert.equal(slot.component.name, 'BlockRunCodeRow', 'the registered component is the block row')

const dictionaries = registered.find((entry) => entry.dictionaries !== undefined)
assert.deepEqual(
  Object.keys(dictionaries.dictionaries.zh).sort(),
  Object.keys(dictionaries.dictionaries.en).sort(),
  'both dictionaries carry the same key set',
)

// ── rendering ──────────────────────────────────────────────────────────────
const t = (key) => key
const Row = slot.component

/** Every string in one rendered element tree. */
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  for (const child of node.children ?? []) texts(child, out)
  return out
}

/** The props of the first element whose props carry `key`. */
function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.props !== undefined && predicate(node.props)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

const preparing = Row({ phase: 'preparing', toolName: 'block_run_code', callId: 'c1', t })
assert.deepEqual(texts(preparing), ['row.preparing', 'row.title'], 'preparation shows the code title')
assert.equal(preparing.props['data-state'], 'preparing', 'preparation is labelled as such')

const running = Row({
  phase: 'start',
  toolName: 'block_run_code',
  callId: 'c2',
  block: { phase: 'start', callId: 'c2', name: 'block_run_code', argsRaw: '{"ids":["auth","parser"],"description":"Rework auth","code":"return 1"}', subCalls: [] },
  t,
})
assert.equal(running.props['data-state'], 'running', 'a dispatched call renders as running')
assert.equal(running.props['data-variant'], 'code', 'the row claims the built-in code variant')
assert.ok(texts(running).includes('row.title'), 'the title is the code title')
assert.ok(texts(running).includes('[auth, parser] Rework auth'), 'the summary is the block id and its goal')
assert.equal(find(running, (props) => props['data-expandable'] === true).props.role, 'button', 'the row is an expandable disclosure')
assert.equal(find(running, (props) => props.className === 'dbp-code'), undefined, 'the program stays collapsed until the row is opened')

const settled = Row({
  phase: 'result',
  toolName: 'block_run_code',
  callId: 'c3',
  block: {
    kind: 'tool-result',
    callId: 'c3',
    call: { name: 'block_run_code', argsRaw: '{"id":"auth","description":"Rework auth","code":"return 1"}' },
    content: [{ type: 'text', text: 'hello\nworld' }],
    isError: false,
    subCalls: [],
  },
  t,
})
assert.equal(settled.props['data-state'], 'ok', 'a settled successful call renders as ok')

const failed = Row({
  phase: 'result',
  toolName: 'block_run_code',
  callId: 'c4',
  block: {
    kind: 'tool-result',
    callId: 'c4',
    call: { name: 'block_run_code', argsRaw: 'not json' },
    content: [],
    isError: true,
    error: { name: 'ToolCallError', code: 'EXECUTION_FAILED' },
    subCalls: [],
  },
  t,
})
assert.equal(failed.props['data-state'], 'error', 'a failed call renders as error')
assert.ok(texts(failed).includes('c4'), 'an unparseable argument payload degrades to the call id')

const interrupted = Row({
  phase: 'result',
  toolName: 'block_run_code',
  callId: 'c5',
  block: {
    kind: 'tool-result',
    callId: 'c5',
    call: { name: 'block_run_code', argsRaw: '{"id":"a","description":"d","code":"x"}' },
    content: [],
    isError: true,
    error: { name: 'Interrupted', code: 'interrupted' },
    subCalls: [],
  },
  t,
})
assert.equal(interrupted.props['data-state'], 'stopped', 'an interrupted call renders as stopped')

console.log('dsh-block-ptc client test: OK')
