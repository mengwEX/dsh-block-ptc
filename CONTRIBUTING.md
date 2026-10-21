# Contributing

Issues and pull requests in English or Chinese are welcome.

## Development

Use Node.js 22 or newer. The plugin and its tests have no external runtime or
development dependencies; no install or build step is needed for local checks.
The peer dependencies are supplied by DeepSeek Harness at runtime.

```sh
git clone https://github.com/mengwEX/dsh-block-ptc.git
cd dsh-block-ptc
npm run check
npm pack --dry-run
```

For a live check, install the absolute checkout path as a bundle in a compatible
DSH profile, restart the host, and open a session with the **Block PTC** preset.
See the [README](README.md#install) for installation details.

## Changes

- Keep changes focused and explain the problem and resulting behavior.
- Delegate program execution to the built-in PTC transport. Keep block state
  derived from the session log rather than adding a second persistence layer.
- Preserve system/developer messages and paired tool calls when replacing history.
  User follow-ups inside the target interval participate in the summary; never
  discard messages arriving after the model wrote that summary.
- Use `block_compact({ ids, content })`; do not add legacy aliases or replay
  compatibility branches. Peer dependencies express minimum versions
  without upper bounds; check required host capabilities and record live
  compatibility evidence separately from the declared ranges.
- For behavior changes, add a regression case to `tests/logic.test.mjs` and run
  `npm run check`. Explain whether validation used mocks or a live DSH profile.
- Update both `README.md` and `README.zh.md` when user-facing behavior changes,
  and record changes under `Unreleased` in `CHANGELOG.md`.
- Include the DSH version, Node version, OS and sanitized reproduction steps in
  bug reports. Remove credentials, personal paths and private conversation data.

CI checks Node 22 and 24 on Linux and Windows. These are standalone plugin
checks, not end-to-end compatibility tests against a running DSH host.

Contributions are licensed under the project's [MIT license](LICENSE).
