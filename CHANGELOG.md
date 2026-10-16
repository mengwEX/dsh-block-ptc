# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] — 2026-10-16

### Fixed

- Allow a block to span user follow-ups across turns. Include intervening user
  messages in the full replacement interval and require their added requirements,
  corrections and constraints in the summary. System/developer boundaries remain
  protected and errors identify their event types and sequence numbers.
- Refuse stale summaries when a new message arrives after the model authored
  them, so deferred replacement cannot discard an unread follow-up.
- Clarify that old module generations require a full host restart and that
  existing historical summaries retain their original text.

## [0.2.1] — 2026-10-16

### Changed

- Guide block selection toward cohesive, loosely coupled units with clear
  subgoals and completion points. Close finished units during larger tasks,
  without imposing call counts, parallelism rules or mandatory splits for small tasks.

## [0.2.0] — 2026-10-16

### Changed

- Both tools accept `ids`; the old `id` remains an alias for `[id]`. Whole
  assistant messages and their tool results receive the union of the block ids
  in that step, including thinking/content before the calls.
- Replace the complete first-to-last target interval. Summary checkpoints
  inherit the interval's remaining ids and can be summarized again; a checkpoint
  with empty ids is retained. `AABACB` closing A becomes `S[B]CB`.
- Wait for unfinished tool pairs before replacing the full interval. Successful
  queued requests are reconstructed from the session log; failed attempts alone
  do not close any ids. Protected-message boundaries reject the whole interval.
- Give summaries their own `<block-summary>` framing, separate from native
  automatic compaction. Identify the text as the agent's summary of earlier
  work; hide empty memberships from the text and tool return value.
- Ask summaries to distinguish completed results, unfinished work and the next
  step. Show multiple ids in the browser tool row.

### Fixed

- Include host-generated `tool-jobs` completion notices in block replacement
  intervals instead of rejecting them as human instructions. Support both the
  legacy and plugin source formats while keeping human/system/developer and
  unknown plugin messages protected.

## [0.1.1] — 2026-10-15

### Changed

- Keep `block_run_code` on a single string `id`. Model-facing instructions
  describe usage without prescribing how many
  blocks may be open. Keep summary instructions focused on writing and submitting
  the block's summary; remove replacement mechanics from the prompt, tool
  descriptions and summary footer.
- Replace exact DSH peer pins with `>=0.2.0-rc.2` and the Cordis peer range with
  `>=4.0.4`, with no upper bounds. Document declared ranges separately from live
  compatibility evidence.
- Check required host methods before mounting and required session methods
  before summarizing, with explicit errors for missing APIs.

### Added

- Browser half (`client/client.js`, declared through `dsh.client` and the
  `./client` export): it registers the keyed `tool.call.toolview` entry for
  `block_run_code` and renders PTC mode's own `code` row — the `Code` title,
  `[<block id>] <goal>` as the summary, the program source and the result text
  behind the disclosure. Its markup, CSS and icons are copies of the host row
  renamed under a `dbp-` prefix, so `--dsw-alias-*` tokens are the only shared
  styling dependency.
- A host-level discovery anchor row in the bundle patch. DSH serves a package's
  client module only for packages that appear as host Loader entries, and this
  bundle's functional row lives inside the `block-ptc` preset (a separate tree).
  The anchor carries `config.anchor: true` and registers nothing, so no guard
  leaks into other presets.

### Fixed

- The nested `run_code` dispatch keeps the outer call id again, so a program's
  sub-call tree renders inside the `block_run_code` row. The dispatch events the
  PTC bridge writes carry `parentCallId = <the executing call's id>`, and the
  conversation UI only attaches sub-calls to a call node present in the
  transcript — a synthetic `<callId>:blk:1` parent was no such node, so every
  `bash`/`read`/`write` card a program dispatched was projected away.

### Documentation

- Make npm the recommended installation method after publishing `0.1.0`.

### Validation

- Local syntax checks and standalone host/client tests pass. The client tests
  use a stubbed React/slot runtime; browser loading and rendering in a live DSH
  host have not been validated for this release.
- No new real API or context/cache savings benchmark was run. The README charts
  remain illustrations, and newer DSH versions have not passed live acceptance.

## [0.1.0] — 2026-10-15

First release: blackboard blocks for PTC mode.

### Added

- `block_run_code({ id, description, code, timeoutMs? })` — the only directly
  callable tool in the preset. It forwards the program to the built-in PTC
  `run_code` transport through a nested dispatch, so program semantics, the
  `tools.*` SDK, sub-call logging, sandbox, timeouts and result rendering are
  the built-in ones, and additionally tags the step with a block id.
- `tools.block_summary({ id, summary })` — callable from inside a program;
  closes a block and replaces its model-visible messages with the summary the
  model writes itself. No extra model request is issued.
- The `block-ptc` agent preset: the shipped `ptc` preset with
  `tool-presentation.mode: both`, the plugin row, and a guard that narrows
  model-direct calls to `block_run_code` while leaving nested calls
  unrestricted.
- Display metadata in `locale/en.json` and `locale/zh.json`.
- Public repository metadata, MIT license and upstream preset attribution.
- English/Chinese installation guides, contribution and security reporting docs.
- GitHub Actions checks for Node 22/24 on Linux and Windows.

### Fixed

- The preset now resolves `dsh-block-ptc`, matching the package name instead of
  the old `dsh-block` name.
- Clarified that `tokensFreed` counts replaced-message tokens before the new
  summary's token cost.

### Design notes

- Replacements use DSH's own compaction vocabulary
  (`compaction/start → compaction/summary → user/message(surfaceOp: replace) →
  compaction/end`). The built-in compaction engine is never invoked and no
  summarization call is made: the summary is the model's own text.
- The system prompt and user-role messages are never replaced, and a user
  message inside a block's span breaks the run instead of being swallowed.
- Every failure makes exactly one close attempt, so a failed summary cannot
  leave the durable compaction lock behind.
- Block state is derived from the session log, so it survives resume and fork.
- The plugin imports nothing but `node:crypto`, so it loads regardless of how
  the host links profile bundles.

### Development validation (recorded before repository publication)

- Live on DeepSeek Harness `0.2.0-rc.2` with the `block-ptc` preset: closing a
  block produced `compaction/start(55) → compaction/summary(56) →
  user/message(57) → compaction/end(58)` with no error, the replacement
  `{op:'replace', startSeq:19, endSeq:33}`, and `{"replaced": 3,
  "tokensFreed": 346}`; the resulting surface kept the system prompt at node 0
  and every user message.
- The same transaction was replayed offline through the runtime's own
  `SurfaceManager` validator against that session's real log and was accepted.
- `node tests/logic.test.mjs` covers tool registration, the guard, the nested
  dispatch, the whole transaction, and the failure path that still releases the
  compaction lock.

[Unreleased]: https://github.com/mengwEX/dsh-block-ptc/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/mengwEX/dsh-block-ptc/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/mengwEX/dsh-block-ptc/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mengwEX/dsh-block-ptc/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mengwEX/dsh-block-ptc/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mengwEX/dsh-block-ptc/releases/tag/v0.1.0
