# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/mengwEX/dsh-block-ptc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mengwEX/dsh-block-ptc/releases/tag/v0.1.0
