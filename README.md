# dsh-block-ptc

**English | [中文](README.zh.md)**

[![CI](https://github.com/mengwEX/dsh-block-ptc/actions/workflows/ci.yml/badge.svg)](https://github.com/mengwEX/dsh-block-ptc/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-block-ptc.svg)](https://www.npmjs.com/package/dsh-block-ptc)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Blackboard blocks for **PTC mode** in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Version `0.4.0` uses `block_compact({ ids, content })`. The old `block_summary`
tool and `summary`/single `id` arguments are not supported. Restart DSH and
start a new **Block PTC** session after updating.

The block protocol uses the built-in `run_code` transport.
DSH's PTC presentation allows only `run_code` to be called directly, so the
model declares blocks in the tool description:

```
run_code({ description: "[block: <ids>] <goal>", code })
```

A *block* is a blackboard region. Every program the model runs is tagged with
block ids. When the content is no longer needed, or its results have already
been reported and the model is moving to other work, it can submit retained
content **it writes itself** to replace the block's messages. Information still
needed for execution, replies or discussion remains available. The original messages stay in the append-only session log, so the
human transcript keeps everything and replay stays deterministic.

- DeepSeek Harness **0.2.1-rc.2 or newer**; no upper version bound
- Community plugin maintained by [mengwEX](https://github.com/mengwEX)
- **Zero runtime dependencies** — the only external import is `node:crypto`
- License: **MIT**

## Table of contents

- [Why](#why)
- [Context and cache comparison](#context-and-cache-comparison)
- [How it works](#how-it-works)
- [Install](#install)
- [Quick start](#quick-start)
- [Reference](#reference)
- [Design notes](#design-notes)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)
- [Development](#development)
- [License](#license)

## Why

Automatic compaction condenses history when token pressure builds, and it
decides what to condense by size. It has no idea that the last forty messages
were one finished sub-task and the next ten are a new one.

This plugin lets the model draw that line itself: open a block, work inside it,
and close it with a handover summary — so the context it keeps is the one it
chose to keep. The model submits the summary inside its program call; the plugin
does not run a separate summarizer model.

## Context and cache comparison

![Illustrative comparison of input context and modeled cache hits for the same synthetic conversation](docs/assets/context-comparison.en.png)

**Mechanism illustration, not an API benchmark.** Both panels replay the same
synthetic four-task workload with assigned token weights. Full bar = input
context; blue = modeled cache hits, orange = modeled cache misses. Cached tokens
still occupy the context window.

After a block closes, the next request carries a summary in place of its
completed work. Replacing history can also invalidate the cached suffix:
**smaller context does not guarantee a higher cache-hit rate or a lower bill**.
The closing assistant/tool pair settles before replacement; original user
messages remain. The baseline has not reached its automatic compaction threshold.

See the [data, assumptions and reproduction steps](docs/context-comparison/README.md).
The plugin's `tokensFreed` is not a provider cache-hit measurement.

## How it works

The model's whole surface is the built-in PTC transport plus one
program-callable:

```
run_code({ description: "[block: <ids>] <goal>", code })   the only tool it may call directly
await tools.block_compact({ ids, content })                  callable from inside a program
```

1. The header in `run_code.description` names the blocks a program advances.
   Its ids apply to the complete assistant message, including preceding
   thinking/text, and its tool results. Calls in the same assistant message
   contribute the union of their ids.
2. `tools.block_compact({ ids, content })` replaces the complete interval from
   the earliest to the latest occurrence of any target id with the retained content.
3. The summary inherits the union of the interval's ids minus the target ids.
   It can participate in a later summary. A summary with no remaining ids stays.
4. If a tool pair in the interval is unfinished, the request is queued until
   its result lands. A protected system/developer message refuses the
   entire interval; no prefix is silently replaced.

```text
A A B A C B  -- compact([A]) --> S[B] C B
S[B] C B    -- compact([B]) --> T[C]
T[C]        -- compact([C]) --> U[]
A A B A C B -- compact([A, B]) --> S[C]
```

What the human sees afterwards: the transcript still shows every original
turn (the log is append-only); the model's next request shows the summary
instead. In the Web UI the summary renders as a compaction checkpoint node.

## Install

Requirements: DeepSeek Harness `>=0.2.1-rc.2` and its bundled runtime, with
Cordis `>=4.0.5`. Neither peer range has an upper version bound. The plugin
is a profile **bundle**: installing it adds one row to `dsh.profile.bundles`
and one new agent preset, `block-ptc`. It does not modify the shipped `ptc`
preset.

The version ranges allow newer hosts to load the plugin; they are not a record
of completed compatibility checks. Live host verification for this release used
DSH `0.2.1-rc.2`. DSH's plugin loader includes prereleases when evaluating its
peer ranges. The plugin checks the required tool/prompt methods before mounting
and the session methods before summarizing, and reports missing capabilities.
Method presence does not verify event semantics, preset configuration or model
behaviour; these still need validation when the host changes.

### From npm (recommended)

Find **dsh-block-ptc** in the Harness Plugin Manager and install it, or ask an
agent with the Plugin Manager tool enabled to install the bundle:

```
plugin_manager  install_bundle  dsh-block-ptc
```

The package is published on [npm](https://www.npmjs.com/package/dsh-block-ptc).
Restart the application after installation and select the **Block PTC** preset.

### From a local checkout

```sh
git clone https://github.com/mengwEX/dsh-block-ptc.git
```

Install the absolute checkout path through the Plugin Manager:

```
plugin_manager  install_bundle  /absolute/path/to/dsh-block-ptc
```

Both methods use pnpm in the target profile. The local form installs a `link:`
dependency for development. Versioned source archives are also available under
[GitHub Releases](https://github.com/mengwEX/dsh-block-ptc/releases).

### Manual install (equivalent, if you prefer files)

In `~/.dsh/profiles/<profile>/package.json`:

```jsonc
{
  "dependencies": { "dsh-block-ptc": "link:/absolute/path/to/dsh-block-ptc" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-block-ptc"] } }
}
```

then run pnpm in that directory.

### After installing

1. The preset appears in the session preset picker as **Block PTC**.
2. **Restart the application once.** The loader keeps a plugin module per
   resolved URL, and installing a bundle changes the composition; a running
   host keeps the old module generation until it restarts.
3. Start a session with the **Block PTC** preset.

### Uninstall

```
plugin_manager  remove_bundle  dsh-block-ptc
```

then restart. `plugin_manager set_bundle dsh-block-ptc enabled=false` disables
it without removing the package.

## Quick start

Work and discuss the results first. Compact earlier blocks when moving to
other work, once their original content is no longer needed:

> Explain how the tokenizer works.
>
> After that discussion: move on to the lexer; organize the earlier block if
> its original content is no longer needed.

You should see:

- the model calling `run_code` with a description such as
  `[block: tokenizer] Explain the tokenizer` for everything it runs;
- a closing call to `block_compact` whose return value is
  `{"replaced": 3, "tokensFreed": 346}` — how many messages were replaced and
  the estimated token count of the replaced messages (before counting the new summary);
- a `<block-summary>…</block-summary>` node sitting where those messages were.

The initial request includes the header requirement in the system prompt,
native tool description and parameter schema. The SDK uses the same header
format.

If a program call is refused with *"Every run_code call, including the first"*, that is the preset's guard working. Retry the
program with the header; the refused call itself is not tagged.

## Reference

Organize blocks around relatively independent units of work, reusing the id
while continuing the same work. Compact a block when its content is no longer
needed, or its results have already been reported to the user and you are
moving on to other work. Keep content needed for upcoming execution, replies
or discussion. Finishing a work step alone is not a reason to compact.

### Header in `run_code.description`

| Part | Type | Required | Meaning |
|---|---|---|---|
| `[block: <ids>]` | header | yes | Comma-separated, non-empty, unique block ids, such as `[block: auth]` or `[block: auth, parser]`. Ids must not contain commas, brackets or line breaks. |
| `<goal>` | string | yes | The goal of this program, on the same line after the header. It is displayed as the tool row's summary. |

`run_code` itself is DSH's tool; the plugin does not replace it. Its
`code`/`timeoutMs` parameters, sandbox, parallel scheduling and result
rendering use the built-in PTC behavior. The plugin aligns the model-facing
header guidance and reads the header to tag surrounding messages.

### Callable `tools.block_compact`

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `ids` | string[] | yes | Block ids to organize and close. |
| `content` | string | yes | Written by the model. Organize the complete first-to-last interval for these ids. Preserve information still needed for subsequent work in full, with enough detail to continue directly. Briefly summarize information no longer needed; omit irrelevant or duplicate material. Preserve user requirements, corrections and constraints accurately. Record completed work, results, unfinished work and the next step. |

The replacement text identifies information you retained from earlier work and is
wrapped in `<block-summary>…</block-summary>`. It includes a `Block ids` line
only when memberships remain. Empty ids stay in internal metadata. This format
is separate from DSH automatic compaction; both can coexist.

On immediate completion, returns `{ replaced, tokensFreed, ids? }`; `ids`, when
non-empty, are the memberships inherited by the summary. `tokensFreed` is the estimated size of the
replaced messages, before the new summary's cost.

If tool results or another compaction are still pending, returns
`{ replaced: 0, tokensFreed: 0, pending: true, requestSeq, note }`. This acknowledges
queuing, not a completed replacement. The logged successful tool outcome lets
the plugin resume the request after restart/fork. Deferred failures are logged;
target memberships remain until a replacement commits. Missing target ids and
protected messages reject the whole request without removing any memberships.

### Preset `block-ptc`

The shipped `ptc` preset plus:

- the same `tool-presentation.mode: ptc` as the shipped preset, so the host's
  own PTC collapse remains in force: only `run_code` may be called directly;
- this plugin's row, which adds a **guard** that requires the
  `[block: <ids>] <goal>` header on every model-direct `run_code` call (and
  still rejects a direct call to any other tool if the collapse is absent),
  the block rules section, model-facing native transport guidance, and the
  program-callable `block_compact`.

## Design notes

**Why the header instead of a custom transport.** DSH `0.2.1` removed the
`both` presentation mode. Under `ptc`, `dsh-tools` resolves every model-direct
call that is not `run_code` to `UNKNOWN_TOOL` before policy, so a plugin tool
such as the old `block_run_code` can no longer be reached. The supported
transport is `run_code`; the plugin carries block ids in its description and
keeps the transport's exact behaviour by not wrapping or reimplementing it.

**Why the compaction vocabulary.** A message can only disappear from the model's
context through DSH's own surface-replacement mechanism, and a replacement must
carry the events DSH expects around it:

```
compaction/start        takes the durable compaction lock
compaction/summary      states the token price of the exact replaced range
user/message            the replacement itself (surfaceOp: replace, compact-checkpoint source)
compaction/end          releases the lock
```

These are DSH's own session event types (`@deepseek-ai/dsh-compaction`,
`@deepseek-ai/dsh-session`), not names invented here; a plugin cannot define new
event types without making the session log unreadable. **The built-in
compaction engine is never invoked** and no summarization call is made — the
summary is the model's own text, and these four events are only the bookkeeping
DSH requires for the replacement. Every failure makes exactly one close attempt,
so a failed summary can never leave the durable lock behind.

**What is preserved.** System and developer messages are never replaced; an
interval containing them is refused. User follow-ups and tool notices inside
the interval are summarized with the work. The summary must preserve added
requirements, corrections and constraints. Messages outside the interval stay.
A user message arriving after the model wrote the summary is not discarded:
the old summary is refused and must be updated after reading the new message.
Unfinished tool pairs delay the complete replacement.

**Where the state lives.** `run_code` descriptions assign message memberships.
Committed summary checkpoints carry the remaining ids, closed ids and request
sequence in `source.blockPtc`. A summary attempt alone closes nothing. Successful
queued outcomes are replayable; a `session/event` observer schedules completion
outside the append boundary. No second persistence store is used.

**Why the plugin has no external imports.** Profile bundles can be installed as
symlinks; a plugin that imports `@deepseek-ai/dsh-*` by bare specifier can fail
to resolve depending on how the host links it. Its only external import is
`node:crypto`; membership helpers use a bundled relative module.

## Verification

```
npm run check                  # syntax + the logic test
node tests/logic.test.mjs
```

The logic test drives the real plugin entry with a fake context and fake
sessions: header parsing, tool registration, the guard, the whole compaction
transaction, the failure path that still releases the lock, and the host-API
checks.

The optional native checks use DSH's installed services:

```
node tests/native-session.mjs /path/to/dsh-session/lib/index.js /path/to/dsh-tools/lib/index.js
node tests/native-prompt.mjs /path/to/dsh-tools/lib/index.js
```

The Session check verifies tool schema support, native append/replay and
intervening user-message replacement. The prompt check assembles the initial
request through real SystemPrompt, Tools and Cordis services: the native
`run_code` schema and SDK examples carry the block header, the program SDK
exposes `block_compact({ ids, content })`, and native code/runtime instructions
are preserved. Both checks are offline; they do not run a model or validate
live UI rendering, block selection, compaction timing or information retention.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The preset is missing from the picker | The bundle is not in `dsh.profile.bundles`, or the host has not recomposed. Check `plugin_manager list_bundles`, then restart. |
| The preset shows as broken / *"dsh-block-ptc: never started"* | The plugin module failed to import (usually a package-resolution problem for a linked checkout). Fix the layout, then restart. |
| *"invalid config: $.mode expected native \| ptc but got both"* | An older `0.2.x` bundle is installed against DSH `0.2.1+`. Update to `0.3.0` and restart. |
| No block tagging in a session | The session is not running the `block-ptc` preset, or the model omitted the header (the guard refuses that call). |
| Summary says *"no current content for ids"* | The id never appeared in a `run_code` header in the current surface. Check the header spelling; already summarized ids are closed. |
| New summaries still use the old framing | The host is running an old module generation. Update the bundle and fully quit/reopen DSH. Existing historical summaries keep their original text. |
| Edits to the plugin do not take effect | Modules are cached per URL and module watching is off by default: restart the app. |
| A block never gets compressed | It was never closed with `block_compact`, so its content stays until automatic compaction folds it into a generic summary. |
| Compaction stops working in a session | A `compaction/start` without a matching `compaction/end` is the durable lock. This plugin closes its own bracket on every failure; if you hit it from an older build, start a fresh session. |

## Known limits

- One summary replaces one complete contiguous first-to-last interval. A
  protected system/developer message rejects that interval; it is not
  skipped and no prefix is treated as a completed summary.
- The block header is model-authored. A call without it is refused before
  execution, so untagged work never enters a block.
- Omitted information is unavailable in later model requests. Preserve all
  details still needed for subsequent work in `content`.
- Checkpoints inherit remaining ids and may be summarized again. A checkpoint
  with empty ids is retained as the completed result.
- Blocks are per session. Sub-agents run their own context and their own blocks.
- Peer dependencies declare minimum versions without an upper bound. Newer
  hosts are allowed, but compatible event semantics and preset configuration
  still need verification.

## Development

```
.
├── lib/plugin.js        host-side guard, block_compact, transactions
├── lib/blocks.js        header parsing, message memberships and interval planning
├── lib/prompts.js       block usage and native tool/schema guidance
├── cordis.patch.yml     the bundle patch: one new preset, `block-ptc`
├── locale/{en,zh}.json  display metadata read by the Harness UI
├── tests/logic.test.mjs the logic and transaction tests
├── RELEASING.md         release and hand-over checklist
└── package.json         bundle manifest (`dsh.bundle.patch`)
```

Run the tests with any Node 22+ (no install step, no dependencies):

```
node tests/logic.test.mjs
```

### Releasing to npm

See [RELEASING.md](RELEASING.md) for GitHub release and npm publication steps.
The package name is `dsh-block-ptc`; the bundle patch resolves that same name.

### Contributing and support

Issues and pull requests are welcome at
<https://github.com/mengwEX/dsh-block-ptc>. Please run `npm run check` before
opening a pull request and describe any live-host verification separately from
offline tests.

## License

MIT. See [LICENSE](LICENSE).
