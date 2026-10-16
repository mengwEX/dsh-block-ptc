# dsh-block-ptc

**[English](README.md) | 中文**

[![CI](https://github.com/mengwEX/dsh-block-ptc/actions/workflows/ci.yml/badge.svg)](https://github.com/mengwEX/dsh-block-ptc/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-block-ptc.svg)](https://www.npmjs.com/package/dsh-block-ptc)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **PTC 模式**加"黑板块"。

`0.2.0` 的两个工具均支持 `ids`，同时兼容旧参数 `id`，等价于 `ids: [id]`。

一个 *block* 就是一块黑板区域：AI 跑的每个程序可归属于多个 block id；这块活干完之后，AI 交上一段**自己写的**摘要，这段摘要会替换掉该 block 在**它自己上下文里**的那些消息。原始消息仍然留在只追加（append-only）的会话日志里，所以人的对话记录一条不少，回放也保持确定性。

- 要求 DeepSeek Harness **0.2.0-rc.2 或更新版本**，不设版本上限
- 由 [mengwEX](https://github.com/mengwEX) 维护的社区插件
- **零运行时依赖** —— 唯一外部 import 是 Node 内置的 `node:crypto`
- 许可证：**MIT**

## 目录

- [为什么做这个](#为什么做这个)
- [上下文与缓存对比](#上下文与缓存对比)
- [工作原理](#工作原理)
- [安装](#安装)
- [快速上手](#快速上手)
- [接口参考](#接口参考)
- [设计说明](#设计说明)
- [验证](#验证)
- [排障](#排障)
- [已知边界](#已知边界)
- [开发](#开发)
- [许可证](#许可证)

## 为什么做这个

内置的自动压缩是在 token 压力上来时按**体量**决定压哪一段的，它并不知道"刚才那四十条消息是一个已经做完的子任务，接下来十条是新任务"。

这个插件把这条线交给 AI 自己画：开一块，在里面干活，收口时交一段交接摘要——于是留在上下文里的，是**它自己选择要留的**那部分。摘要由模型在现有程序调用中提交，插件不会另起摘要模型请求。

## 上下文与缓存对比

![同一段模拟对话中，输入上下文与模拟缓存命中 token 的对比示意](docs/assets/context-comparison.zh.png)

**机制示意，不是 API 实测。** 两图使用同一份模拟工作量：4 个任务，每个任务
3 次请求，token 权重人工指定。整根柱子是输入上下文；蓝色是模拟缓存命中，
橙色是模拟未命中。缓存命中的 token 仍占用上下文窗口。

区块收口后，下一次请求用摘要替换已完成的内容。但改写历史也可能使后面的缓存
前缀失效：**上下文变小不保证缓存命中率更高，也不保证费用一定下降**。
收口时的 assistant/tool 调用对完成后一起替换，原始用户消息保留。
原生 PTC 在本例中尚未触发内置自动压缩阈值。

[数据、假设与重现方法](docs/context-comparison/README.md) 已一并提供；
`tokensFreed` 不能当作 API 缓存命中统计。

## 工作原理

AI 能直接看到的只有两个可调用：

```
block_run_code({ ids, description, code })     唯一可直接调用的工具
await tools.block_summary({ ids, summary })    只能在程序内部调用
```

1. `block_run_code` 将程序交给内置 PTC `run_code`。`ids` 归属覆盖整条 assistant 消息（包含工具调用前的 thinking/content）及对应工具结果；同一消息内多个调用的 `ids` 取并集。
2. `tools.block_summary({ ids, summary })` 用一条摘要替换目标 id 最早到最晚出现之间的完整区间。
3. 摘要继承区间内全部 `ids` 的并集，再移除本次收口的目标 id。它能继续参与后续总结，`ids` 为空的摘要也保留。
4. 区间内尚未完成的工具调用对会等待结果落地。若区间跨越受保护的系统/用户/developer 消息，则整次拒绝，不只替换前一段。

```text
A A B A C B  -- summary([A]) --> S[B] C B
S[B] C B    -- summary([B]) --> T[C]
T[C]        -- summary([C]) --> U[]
A A B A C B -- summary([A, B]) --> S[C]
```

之后你会看到：对话记录里原来的每一轮都还在（日志只追加）；而 AI 的下一次请求里，它们已经变成那段摘要。Web UI 里这条摘要渲染成"压缩检查点"节点。

## 安装

要求：DeepSeek Harness `>=0.2.0-rc.2` 及其自带运行时、Cordis `>=4.0.4`，均不设版本上限。本插件是一个 profile **bundle**：安装它会往 `dsh.profile.bundles` 加一行，并新增一个名为 `block-ptc` 的 agent preset；**不会改动自带的 `ptc` preset**。

版本范围表示允许更新的宿主加载，不表示所有版本都已验收。此前真实宿主验证使用
DSH `0.2.0-rc.2`；当前浏览器改动及更新宿主仍待实际验收。DSH 插件加载器判断
peer 范围时包含预发布版本。插件在挂载前检查工具和提示词接口，在收口前检查
会话接口，缺少接口时给出明确错误。接口存在不能证明事件语义、预设配置和浏览器
渲染兼容，宿主升级后仍需验证这些行为。

### 从 npm 安装（推荐）

在 Harness 的 Plugin Manager 中搜索 **dsh-block-ptc** 并安装，或让启用了
Plugin Manager 工具的 agent 安装 bundle：

```
plugin_manager  install_bundle  dsh-block-ptc
```

包已发布到 [npm](https://www.npmjs.com/package/dsh-block-ptc)。安装后重启应用，
新建会话时选择 **Block PTC** 预设。

### 从本地目录安装

```sh
git clone https://github.com/mengwEX/dsh-block-ptc.git
```

然后通过 Plugin Manager 安装目录的绝对路径：

```
plugin_manager  install_bundle  /absolute/path/to/dsh-block-ptc
```

两种方式都在目标 profile 中使用 pnpm；本地方式安装 `link:` 依赖，适合开发。
也可以从 [GitHub Releases](https://github.com/mengwEX/dsh-block-ptc/releases)
下载指定版本的源码归档。

### 手动安装（等价做法）

编辑 `~/.dsh/profiles/<profile>/package.json`：

```jsonc
{
  "dependencies": { "dsh-block-ptc": "link:/absolute/path/to/dsh-block-ptc" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-block-ptc"] } }
}
```

然后在该目录下跑一次 pnpm。

### 安装之后

1. preset 选择器里会多出 **Block PTC**。
2. **重启一次应用。** loader 按解析后的 URL 缓存插件模块，安装 bundle 会改变合成树，运行中的宿主不会换用新的模块代际。
3. 新建会话时选 **Block PTC**。

### 卸载

```
plugin_manager  remove_bundle  dsh-block-ptc
```

然后重启。只想临时关掉：`plugin_manager set_bundle dsh-block-ptc enabled=false`。

## 快速上手

正常说你要做什么，做完让它收口，比如：

> 读一下 parser 模块，讲清楚 tokenizer 怎么工作，然后把这块收口，再继续看 lexer。

你应该看到：

- AI 跑什么都通过 `block_run_code`；
- 收口时调用 `block_summary`，返回值形如 `{"replaced": 3, "tokensFreed": 346}` —— 替换了几条消息、被替换消息的估算 token 数（尚未扣除新摘要的开销）；
- 一条 `<block-summary>…</block-summary>` 摘要节点出现在那几条消息原来的位置。

如果某个工具调用被拒绝、提示 *"In block mode only `block_run_code` may be called directly"*，那是这个 preset 的守门规则在起作用：这个模式里其它工具都要在程序内部调用，和 PTC 模式一致。

## 接口参考

按内聚、相对解耦的中等工作单元划分 block，每块有明确的子目标和完成条件。
围绕同一子目标的调查、实现和验证放在一起。大任务按可分开的子目标拆分，
避免整个大任务共用一块，也避免每次工具调用都新建一块；小任务可以只用一块。
每块完成后及时总结收口，再继续剩余工作，不必等整个任务结束。

### 工具 `block_run_code`

| 参数 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `ids` | string[] | 是* | 本次工作的 block id 数组，非空、不重复，例如 `["auth-refactor"]`。 |
| `id` | string | 否 | 旧参数，相当于 `ids: [id]`；两种写法二选一。 |
| `description` | string | 是 | 一句话说明本次工作的目标，显示在工具行中。 |
| `code` | string | 是 | 程序主体；支持顶层 `await` 和 `return`，`return` 的值即结果。 |
| `timeoutMs` | number | 否 | 本次程序的执行预算（毫秒）。 |

*使用旧参数 `id` 时可省略 `ids`。

返回值就是 `run_code` 的结果原样：`{ logs, result?, sandbox? }`，渲染方式与 PTC 模式完全一致：浏览器半边把这次调用注册进 DSH 的键控 Tool 视图槽，画出与内置 `run_code` 相同的 `code` 行——标题「代码」、摘要 `[<block ids>] <目标>`、展开后是程序原文与输出——程序里派发的每个 `bash`/`read`/`write` 卡片都嵌在这一行里。

### 可调用 `tools.block_summary`

| 参数 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `ids` | string[] | 是* | 本次要总结并收口的 block id 数组。 |
| `id` | string | 否 | 旧参数，相当于 `ids: [id]`；两种写法二选一。 |
| `summary` | string | 是 | 由你自己撰写。总结这些 ids 第一次到最后一次出现之间的完整内容。交代目标、已完成的工作及结果、未完成事项和下一步；如果只剩向用户报告结果，明确写出。按需保留必要细节。 |

*使用旧参数 `id` 时可省略 `ids`。

立即完成时返回 `{ replaced, tokensFreed, ids? }`，`ids` 是摘要继承的归属，仅在非空时返回。
`tokensFreed` 是被替换消息的估算 token 数，尚未扣除新摘要的开销。

工具结果或其他压缩尚未结束时，返回
`{ replaced: 0, tokensFreed: 0, pending: true, requestSeq, note }`，表示已排队，
尚未完成替换。成功的工具调用结果记录在日志中，恢复/fork 后可继续处理。
延后提交失败会记录错误，目标归属在真正替换成功前仍保留。目标 id 不存在或
区间包含受保护消息时，整次拒绝，不移除任何归属。

摘要正文说明这是 Agent 自己对先前工作的总结，并使用独立的
`<block-summary>…</block-summary>` 标签。还有剩余归属时显示 `Block ids`，
为空时只保存在内部元数据，正文及返回值都不显示空 ids。该格式与 DSH 原生自动
压缩区分，两者可以共存。

### 预设 `block-ptc`

等于自带的 `ptc` 预设，加上：

- `tool-presentation.mode: both` —— 在 `ptc` 呈现模式下，保留的 `run_code` 传输层是唯一可直接调用的工具（这个判断在 `dsh-tools` 里是硬编码的），插件工具永远够不着；`both` 保留生成的 tools SDK 与原生 schema；
- 本插件的行：注册上面两个可调用，并加一条 **guard**：没有 parent token 的"模型直接调用"只允许 `block_run_code`，程序内部的嵌套调用不受限制。

## 设计说明

**为什么是委派而不是重写传输层。** `block_run_code` 通过 `ctx.tools.execute({ …, parent: exec.token })` 把程序交给内置 `run_code`。于是"与 PTC 模式一模一样"是**构造上成立**的，而不是靠小心抄写。

**为什么嵌套传输层沿用外层的 call id。** PTC 桥给程序里每次子调用打的是"正在执行的那个调用的 id"（`parentCallId: exec.callId`），而会话界面只能把子调用挂到**它看得见的调用节点**上。所以给嵌套 `run_code` 造一个合成 id（如 `<callId>:blk:1`）等于指了一个没有任何节点渲染的父级：整棵子调用树会被投影掉，block 卡片只剩一行光秃秃的工具调用。沿用外层 id 就能**完全复刻 PTC 模式的拓扑**——`rootCallId = parentCallId = <callId>`，程序子调用为 `<callId>:ptc:<n>`——于是程序里派发的 `bash`/`read`/`write` 卡片会像 PTC 模式一样渲染在 block 行里面。

**为什么包里带一个浏览器半边。** DSH 把"线协议工具名 → 那一行长什么样"硬编码在 `@deepseek-ai/dsh-client-ui-tool` 里，它只认识 `run_code`；纯 Host 插件因此只能落到通用的「工具调用」行。往 `tool.call.toolview` 注册键为 `block_run_code` 的视图，是官方支持的唯一办法。它的标记、CSS、图标都是宿主行代码的副本（类名前缀改成 `dbp-`）——因为客户端插件的规则不允许把 Harness 客户端包当模块 import；唯一共享的样式依赖是 `--dsw-alias-*` 主题变量。

**为什么 bundle 补丁还挂了一条宿主层锚点行。** DSH 只为"以宿主 Loader 条目形式存在的包"提供客户端模块（`dsh-client-modules` 扫描的是 `ctx.loader.entries()`），而本插件的功能行挂在 `block-ptc` 预设里，预设是另一棵树。锚点行（`config.anchor: true`）的作用就是让这个包在宿主层有一个条目；它自己不注册任何东西——否则宿主层的 guard 会拒绝其它所有预设里的直接工具调用。

**为什么用 compaction 那套词汇。** 一条消息想让模型看不见，只能走 DSH 自己的 surface 替换机制，而替换必须带上 DSH 要求的前后事件：

```
compaction/start        取得持久压缩锁
compaction/summary      声明被替换范围的 token 计数
user/message            替换本体（surfaceOp: replace，compact-checkpoint 来源）
compaction/end          释放锁
```

这些是 DSH 自己的会话事件类型（`@deepseek-ai/dsh-compaction`、`@deepseek-ai/dsh-session`），不是这里另起的名字；插件也没法自造事件类型——那样会话日志会变得无法读取。**内置压缩引擎从未被调用**，也没有任何摘要模型调用：摘要是 AI 自己写的文本，这四条事件只是 DSH 对这次替换要求的登记手续。任何失败都必定补一次关闭，所以失败的摘要不会把持久锁留在会话里。

**保留的内容。** 系统、developer 和原始用户消息不会被替换；它们落在目标区间内时，整次拒绝。区间内 `tool-jobs` 的后台任务完成通知随工具输出一起总结，兼容宿主新版的 plugin 来源格式；其他插件消息仍受保护。插件自己的摘要检查点可以继续被总结。未完成的工具调用对会推迟整段提交，不能替换一部分却留下目标 id。

**状态放在哪。** `tool/call` 参数决定消息归属。提交的摘要在 `source.blockPtc` 中记录剩余 ids、已收口 ids 和请求序号；仅尝试调用 summary 不会收口。成功的排队结果可从日志恢复，`session/event` 监听器在 append 边界之外提交，无独立持久化存储。

**为什么插件没有外部 import。** profile bundle 可以以符号链接方式安装；一个用裸包名 import `@deepseek-ai/dsh-*` 的插件，会因宿主的链接方式解析失败。唯一外部 import 是 Node 内置的 `node:crypto`，归属计算使用随包提供的相对模块。

## 验证

```
npm run check          # 语法检查 + 两个测试
node tests/logic.test.mjs
node tests/client.test.mjs
```

`ids` 实现已通过上述离线回归，并用 DSH `0.2.0-rc.2` 自身的
`Session` 完成追加与日志重放检查。可向 `tests/native-session.mjs` 传入已安装的
`dsh-session/lib/index.js` 路径重现；ASAR 安装需使用桌面程序的
`ELECTRON_RUN_AS_NODE=1` 模式。这不调用模型，也不代表真实界面验收。

逻辑测试用假的 Cordis 上下文和假会话驱动**真实的插件入口**：工具注册、guard、嵌套 `run_code` 派发、完整的压缩事务、"失败也要释放锁"的路径，以及宿主层锚点行必须什么都不注册。客户端测试用打桩的浏览器模块表加载 `client/client.js`，把这一行在所有生命周期形态下渲染一遍——准备中、已派发、已结算、失败、被中断、参数不是合法 JSON——因为键控视图一旦抛错就会把那一个槽位清空。

行的实机验证（浏览器半边不在单测覆盖范围内）：

1. 把这个目录当 bundle 装进去。desktop profile 由桌面应用管理，所以用应用内的 Plugin Manager 装**绝对路径**：`plugin_manager install_bundle /absolute/path/to/dsh-block-ptc`，或直接在插件页「包名或地址」里填绝对路径。
2. 重启应用：Loader 会缓存已解析的模块，客户端模块扫描只在启动时进行。
3. 新建一个 **Block PTC** 会话跑一段程序。`block_run_code` 这次应该渲染成 PTC 自己的代码行，程序内部的子调用嵌在这一行里。

与内置行已知的观感差异：运行中那一行没有 shimmer 扫光；DSH 若改版行样式，这里需要重新抄一遍。

原始开发记录包含以下真实 desktop profile（`0.2.0-rc.2`）上的 **Block PTC**
验证结果。这些是历史实测记录，仓库 CI 不会启动宿主重新执行端到端验证：

| 环节 | 实测结果 |
|---|---|
| 直接工具目录 | `block_run_code` + SDK（SDK 里另有 `block_summary`） |
| 程序执行 | `block_run_code({ id, description, code })` 原样返回 `run_code` 的结果 |
| 收口 | `compaction/start(55) → compaction/summary(56) → user/message(57) → compaction/end(58)`，无 error |
| 替换 | `{op: 'replace', startSeq: 19, endSeq: 33}`，sources `[55, 56, 19, 29, 33]` |
| 返回 | `{"replaced": 3, "tokensFreed": 346}` |
| 之后的 surface | node 0 仍是系统提示，所有 user 消息保留，摘要正好落在被替换的位置 |

同一次事务还被离线喂给运行版自己的 `SurfaceManager` 校验器（用那个会话的真实日志），一次通过。

## 排障

| 现象 | 原因与处理 |
|---|---|
| preset 列表里没有它 | bundle 不在 `dsh.profile.bundles` 里，或宿主还没重新合成。查 `plugin_manager list_bundles`，然后重启。 |
| 预设显示为 broken / *"dsh-block-ptc: never started"* | 插件模块 import 失败（本地链接安装时通常是包解析问题）。修好布局后重启。 |
| 会话里没有 `block_run_code` | 该会话没跑 `block-ptc` 预设，或安装后还没重启应用。 |
| 改了插件代码不生效 | 模块按 URL 缓存，且模块监听默认关闭：重启应用。 |
| 某块一直没被压缩 | 它从没用 `block_summary` 收口，内容会一直占着，直到内置自动压缩把它压成通用摘要。 |
| 某会话的压缩不工作了 | 出现没有配对的 `compaction/start` 就是持久锁。本插件在任何失败路径上都会补关闭；若是旧版本留下的，开新会话。 |

## 已知边界

- 一次总结替换目标 id 最早到最晚出现的完整连续区间。区间内存在受保护的系统/用户/developer 消息时，整次拒绝，不跳过这些消息，也不只替换前一段。
- 摘要是有损的，后续所需信息应写进摘要。
- 摘要继承剩余 ids，可继续参与总结；`ids` 为空时仍保留已完成结果。
- 兼容旧的 `id` 调用；已经压缩过的旧版本历史没有可恢复的 `ids` 归属元数据，不会被追溯重新标记。
- block 是会话级的；子代理有自己的上下文和自己的 block。
- `peerDependencies` 只声明最低版本，不设上限；允许更新宿主加载，事件语义、预设配置与浏览器接口仍需验证。

## 开发

```
.
├── lib/plugin.js        宿主工具、排队请求与替换事务
├── lib/blocks.js        消息归属与区间规划
├── cordis.patch.yml     bundle 补丁：新增一个 preset `block-ptc`
├── locale/{en,zh}.json  Harness UI 读取的显示文案
├── tests/logic.test.mjs 逻辑与事务测试
├── RELEASING.md         发布与交接清单
└── package.json         bundle 清单（`dsh.bundle.patch`）
```

任意 Node 22+ 即可跑测试（无需安装、无依赖）：

```
node tests/logic.test.mjs
```

### 发布到 npm

GitHub 版本发布与 npm 发布流程见 [RELEASING.md](RELEASING.md)。包名统一使用
`dsh-block-ptc`，bundle 补丁也通过同名包解析插件。

### 贡献与反馈

欢迎在[官方社区介绍帖](https://github.com/deepseek-ai/deepseek-harness/discussions/9754)
交流区块收口与上下文、缓存之间的取舍。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，问题反馈请使用
[GitHub Issues](https://github.com/mengwEX/dsh-block-ptc/issues)；安全漏洞请按
[SECURITY.md](SECURITY.md) 私下报告。欢迎使用中文或英文。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。预设改编自 DeepSeek Harness 的配置，
上游版权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
