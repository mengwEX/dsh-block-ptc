/**
 * dsh-block-ptc — browser half.
 *
 * The Host half already gives a `block_run_code` call PTC mode's exact sub-call
 * topology, so the program's `bash`/`read`/`write` cards render inside the row
 * through the ordinary Tool tree. What the tree cannot know is which *row* a
 * wire tool name gets: `dsh-client-ui-tool` hard-codes that mapping by name and
 * knows only `run_code`, so `block_run_code` fell back to the generic
 * "Tool call" row. This file registers the missing keyed view and renders the
 * `code` row variant the built-in gives `run_code`: same title, same summary
 * (the call's description), same expanded body (the program source plus the
 * result text).
 *
 * Markup, CSS and behavior are copied from the host client's own row
 * (`DisclosureRow`, `ToolRow`, and their icons) and renamed under this plugin's
 * `dbp-` prefix, so the only shared styling dependency is the `--dsw-alias-*`
 * token set. No Harness client package is imported as a module: a plain-JS
 * plugin has no type check, and a throwing component blanks the slot entry.
 *
 * @module dsh-block-ptc/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-block-ptc',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    //#region styles
    const CSS_TAG = 'dsh-block-ptc/BlockRunCodeRow.css'
    const css =
      '.dbp-root{flex-direction:column;display:flex}' +
      '.dbp-row{height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;transition:color .1s;display:flex;position:relative;overflow:hidden}' +
      '.dbp-row:hover{color:var(--dsw-alias-label-secondary)}' +
      '.dbp-row[data-expandable]{cursor:pointer}' +
      '.dbp-leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex;position:relative}' +
      '.dbp-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}' +
      '.dbp-chevron{color:inherit}' +
      '.dbp-iconIdle{opacity:1;transition:opacity .1s;display:inline-flex}' +
      '.dbp-chevronHover{opacity:0;margin:auto;transition:opacity .1s;position:absolute;inset:0}' +
      '.dbp-row:hover .dbp-iconIdle{opacity:0}' +
      '.dbp-row:hover .dbp-chevronHover{opacity:1}' +
      '.dbp-title{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:none}' +
      '.dbp-content{min-width:0;align-items:baseline;display:flex;flex:auto;overflow:hidden}' +
      '.dbp-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}' +
      '.dbp-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}' +
      '.dbp-errorSummary{color:var(--dsw-alias-state-error-primary)}' +
      '.dbp-stoppedSummary{color:var(--dsw-alias-state-warn-label)}' +
      '.dbp-bodyWrap{flex-direction:column;display:flex}' +
      '.dbp-bodyScroll{max-height:260px;overflow-y:auto}' +
      '.dbp-codeCard{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);flex-direction:column;margin:4px 0 4px 4px;display:flex;overflow:hidden}' +
      '.dbp-code{white-space:pre-wrap;overflow-wrap:anywhere;min-height:0;font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-secondary);margin:0;padding:10px 12px 12px;overflow:auto}' +
      '.dbp-code::-webkit-scrollbar-thumb{border-radius:var(--dsw-radius-sm);background-clip:padding-box;border:2px solid #0000}' +
      '.dbp-code::-webkit-scrollbar-track{margin:6px 0}' +
      '.dbp-ioCard{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);flex-direction:column;margin:4px 0 4px 4px;display:flex}' +
      '.dbp-ioSection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}' +
      '.dbp-ioSection::-webkit-scrollbar-thumb{border-radius:var(--dsw-radius-sm);background-clip:padding-box;border:2px solid #0000}' +
      '.dbp-ioSection::-webkit-scrollbar-track{margin:6px 0}' +
      '.dbp-ioLabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}' +
      '.dbp-ioText{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}' +
      '.dbp-ioText[data-error]{color:var(--dsw-alias-state-error-primary)}' +
      '.dbp-inspectButton{border:.5px solid var(--dsw-alias-border-l3);corner-shape:round;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}' +
      '.dbp-root:hover .dbp-inspectButton,.dbp-inspectButton:focus-visible{opacity:1}' +
      '.dbp-inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}' +
      '.dbp-visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}' +
      '@media (prefers-reduced-motion:reduce){.dbp-row,.dbp-iconIdle,.dbp-chevronHover,.dbp-inspectButton{transition:none}}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-block-ptc'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }
    //#endregion

    //#region locale
    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-block-ptc'
    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'row.title': '代码',
      'row.preparing': '准备运行代码',
      'row.running': '运行中',
      'row.failed': '运行失败',
      'row.stopped': '运行已中止',
      'row.output': '输出',
      'row.inspect': '查看',
    }
    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'row.title': 'Code',
      'row.preparing': 'Preparing to run code',
      'row.running': 'Running',
      'row.failed': 'Run failed',
      'row.stopped': 'Run stopped',
      'row.output': 'OUT',
      'row.inspect': 'Inspect',
    }
    //#endregion

    //#region icons
    /** The `code` row variant's leading glyph, copied from the host icon set. */
    function codeIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1 },
        h('path', { d: 'M6.27612 1.5L4.52612 14.5', stroke: 'currentColor' }),
        h('path', { d: 'M11.4739 1.5L9.72388 14.5', stroke: 'currentColor' }),
        h('path', { d: 'M2.39868 5.5H14.0681', stroke: 'currentColor' }),
        h('path', { d: 'M1.93188 10.5H13.6013', stroke: 'currentColor' }),
      )
    }
    /** Downward chevron shown on hover and while the row is closed. */
    function chevronDown(className) {
      return h(
        'svg',
        { width: 14, height: 14, className, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1 },
        h('path', { d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor' }),
      )
    }
    /** Upward chevron shown while the row is open. */
    function chevronUp(className) {
      return h(
        'svg',
        { width: 14, height: 14, className, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1 },
        h('path', { d: 'M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10', stroke: 'currentColor' }),
      )
    }
    /** Inspect affordance glyph, copied from the host icon set. */
    function inspectIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1 },
        h('path', { d: 'M4.67398 4.25061L1.36094 7.86484C1.29085 7.9413 1.29085 8.05866 1.36094 8.13513L4.67398 11.7494', stroke: 'currentColor' }),
        h('path', { d: 'M11.3262 4.25061L14.6392 7.86484C14.7093 7.9413 14.7093 8.05866 14.6392 8.13513L11.3262 11.7494', stroke: 'currentColor' }),
        h('path', { d: 'M9.56222 3.62573L6.43774 12.3743', stroke: 'currentColor' }),
      )
    }
    //#endregion

    //#region model
    /** First physical line of a multi-line string. */
    function firstLine(text) {
      const nl = text.indexOf('\n')
      return nl === -1 ? text : text.slice(0, nl)
    }
    /** Parse a raw argument payload, or undefined when it is absent or partial. */
    function parseArgs(argsRaw) {
      try {
        return JSON.parse(argsRaw)
      } catch {
        return undefined
      }
    }
    /**
     * Flatten a settled result's content blocks to display text: text blocks
     * verbatim, other block shapes as pretty JSON; an empty failed result falls
     * back to the structured error's `name: code` line. Same contract as the host
     * Tool row.
     */
    function resultText(block) {
      const parts = []
      for (const item of block.content ?? []) parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
      if (parts.length === 0 && block.error !== undefined) parts.push(`${String(block.error.name)}: ${String(block.error.code)}`)
      return parts.join('\n')
    }
    /** Display state without consulting Host session state. */
    function blockState(block) {
      if (!('kind' in block)) return 'running'
      if (block.error?.code === 'interrupted') return 'stopped'
      return block.isError ? 'error' : 'ok'
    }
    /** Visually hidden state copy for the color-only running sweep and error tone. */
    function stateStatus(state, t) {
      if (state === 'running') return t('row.running')
      if (state === 'error') return t('row.failed')
      if (state === 'stopped') return t('row.stopped')
      return null
    }
    /**
     * The row's display model: the block's id and goal become the summary, the
     * program becomes the expanded body, the tool result becomes the output.
     * Every field is optional — a partial or malformed argument payload degrades
     * to the call id instead of throwing.
     */
    function blockRowModel(block) {
      const settled = 'kind' in block
      const argsRaw = (settled ? block.call?.argsRaw : block.phase === 'start' ? block.argsRaw : '') ?? ''
      const args = parseArgs(argsRaw)
      const value = typeof args === 'object' && args !== null ? args : {}
      const state = blockState(block)
      const output = settled ? resultText(block) : null
      const code = typeof value.code === 'string' ? value.code : ''
      const id = typeof value.id === 'string' && value.id !== '' ? value.id : undefined
      const goal = typeof value.description === 'string' && value.description !== '' ? firstLine(value.description) : undefined
      const summary =
        goal === undefined ? (id ?? block.callId) : id === undefined ? goal : `[${id}] ${goal}`
      return {
        state,
        code,
        summary,
        output: output === null || output === '' ? null : output,
      }
    }
    //#endregion

    //#region row
    /** The same non-expandable row the host shows before a call is dispatched. */
    function PreparingRow({ t }) {
      return h(
        'div',
        { className: 'dbp-root', 'data-variant': 'code', 'data-tool': 'block_run_code', 'data-state': 'preparing' },
        h(
          'div',
          { className: 'dbp-row' },
          h('span', { className: 'dbp-leading' }, codeIcon()),
          h('span', { className: 'dbp-visuallyHidden' }, t('row.preparing')),
          h('span', { className: 'dbp-title' }, t('row.title')),
        ),
      )
    }
    /**
     * Render one `block_run_code` call as the built-in `code` row: state glyph,
     * `代码`/`Code` title, the block's goal, and the program plus output behind
     * the disclosure. Program sub-calls are rendered by the Tool tree below this
     * row, not here.
     * @param props - keyed toolview payload plus this plugin's locale seat.
     * @returns the dedicated block row.
     */
    function StartedRow({ block, inspect, t }) {
      const model = blockRowModel(block)
      const [expanded, setExpanded] = React.useState(false)
      const expandable = model.code !== '' || model.output !== null
      const open = expanded && expandable
      const toggle = () => {
        setExpanded((value) => !value)
      }
      const toggleFromKeyboard = (event) => {
        if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        toggle()
      }
      const leading = open
        ? chevronUp('dbp-chevron')
        : expandable
          ? h(
              React.Fragment,
              null,
              h('span', { className: 'dbp-iconIdle' }, codeIcon()),
              chevronDown('dbp-chevron dbp-chevronHover'),
            )
          : codeIcon()
      const status = stateStatus(model.state, t)
      const summaryClass =
        model.state === 'error'
          ? 'dbp-summary dbp-errorSummary'
          : model.state === 'stopped'
            ? 'dbp-summary dbp-stoppedSummary'
            : 'dbp-summary'
      return h(
        'div',
        { className: 'dbp-root', 'data-variant': 'code', 'data-tool': 'block_run_code', 'data-state': model.state },
        h(
          'div',
          {
            className: 'dbp-row',
            'data-disclosure-row': true,
            'data-expandable': expandable || undefined,
            role: expandable ? 'button' : undefined,
            tabIndex: expandable ? 0 : undefined,
            'aria-expanded': expandable ? open : undefined,
            onClick: expandable ? toggle : undefined,
            onKeyDown: expandable ? toggleFromKeyboard : undefined,
          },
          h('span', { className: 'dbp-leading' }, leading),
          status === null ? null : h('span', { className: 'dbp-visuallyHidden' }, status),
          h(
            'span',
            { className: 'dbp-content' },
            h('span', { className: 'dbp-title' }, t('row.title')),
            h('span', { className: 'dbp-sep', 'data-shimmer-decoration': true, 'aria-hidden': true }),
            h('span', { className: summaryClass }, model.summary),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'dbp-bodyWrap' },
              model.code === ''
                ? null
                : h(
                    'div',
                    { className: 'dbp-bodyScroll' },
                    h('div', { className: 'dbp-codeCard' }, h('pre', { className: 'dbp-code' }, model.code)),
                  ),
              model.output === null
                ? null
                : h(
                    'div',
                    { className: 'dbp-ioCard' },
                    h(
                      'div',
                      { className: 'dbp-ioSection' },
                      h('span', { className: 'dbp-ioLabel' }, t('row.output')),
                      h('span', { className: 'dbp-ioText', 'data-error': model.state === 'error' || undefined }, model.output),
                    ),
                  ),
              inspect === undefined
                ? null
                : h(
                    'button',
                    { type: 'button', className: 'dbp-inspectButton', onClick: inspect },
                    inspectIcon(),
                    t('row.inspect'),
                  ),
            )
          : null,
      )
    }
    /** Keyed Tool view for the `block_run_code` wire name. */
    function BlockRunCodeRow(props) {
      if (props.phase === 'preparing') return h(PreparingRow, props)
      return h(StartedRow, props)
    }
    //#endregion

    //#region plugin
    /** Required services: the slot registry and this row's dictionaries. */
    const inject = ['slots', 'locale']
    /**
     * Client plugin body: register the row's dictionaries and its keyed Tool view.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-block-ptc: dictionaries')
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'block_run_code', locale: NS }, BlockRunCodeRow),
      )
    }
    //#endregion

    return { inject, apply }
  },
})
