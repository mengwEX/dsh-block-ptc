# dsh-block-ptc

**[English](README.md) | 中文**

[![CI](https://github.com/mengwEX/dsh-block-ptc/actions/workflows/ci.yml/badge.svg)](https://github.com/mengwEX/dsh-block-ptc/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-block-ptc.svg)](https://www.npmjs.com/package/dsh-block-ptc)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **PTC 模式**加「黑板块」。

`0.3.0` 把区块协议架在内置 `run_code` 传输层上。DSH 的 PTC 呈现只允许直接调用
`run_code`，所以区块归属写在工具描述的开头：

```
run_code({ description: "[block: auth] Rework the auth tests", code })
```

一个*区块*就是黑板上的一块区域。模型跑的每段程序都会带上区块 id；这块工作完成时，
模型提交一段**自己写的**总结，替换它在自己上下文里的那些消息。原始消息仍保留在
只追加的会话日志里，人类看到的对话记录不变，重放也是确定性的。

- DeepSeek Harness **0.2.1-rc.2 或更新**，不设版本上限
- 社区插件，维护者 [mengwEX](https://github.com/mengwEX)
- **零运行时依赖**：唯一的外部导入是 `node:crypto`
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

自动压缩在 token 压力上来时压缩历史，它按大小决定压什么，并不知道前四十条消息是
一个已经完成的子任务、后十条是新任务。

这个插件让模型自己划线：开一个区块、在里面干活、用一段交接总结收口——于是保留
下来的上下文就是模型选择保留的那一段。总结由模型在程序调用里提交，插件不另跑
一个总结模型。

## 上下文与缓存对比

![同一段合成对话的输入上下文与建模缓存命中对比](docs/assets/context-comparison.zh.png)

**这是机制示意，不是 API 基准测试。** 两个面板重放同一段合成四任务负载，token
权重相同。整条 = 输入上下文；蓝色 = 建模的缓存命中；橙色 = 建模的缓存未命中。
被缓存的 token 仍然占用上下文窗口。

区块收口后，下一次请求用一段总结替代已完成的工作。替换历史也可能让缓存后缀
失效：**上下文变小并不保证缓存命中率更高或账单更低**。收口前会等 assistant/tool
对落定；原始用户消息保留。基线尚未触发自动压缩阈值。

数据、假设与复现步骤见 [docs/context-comparison/README.md](docs/context-comparison/README.md)。
插件返回的 `tokensFreed` 不是服务商的缓存命中指标。

## 工作原理

模型看到的直接工具就是内置 PTC 传输层，再加一个程序内可调用的工具：

```
run_code({ description: "[block: <ids>] <goal>", code })   唯一可直接调用的工具
await tools.block_summary({ ids, summary })                 在程序内部调用
```

1. `run_code.description` 开头的区块头声明这段程序推进哪些区块。id 归属覆盖整条
   assistant 消息（包含工具调用前的 thinking/content）及对应工具结果；同一消息内
   多个调用的 id 取并集。
2. `tools.block_summary({ ids, summary })` 用一段总结替换从最早到最晚一次出现
   目标 id 的完整区间。
3. 总结继承「区间内 id 的并集减去本次收口的 id」。它可以再次参与后续总结；没有
   剩余 id 的总结节点也会保留。
4. 区间里的工具对还没完成时，请求先排队，等结果落定再执行。区间里出现受保护的
   system/developer 消息会拒绝整个区间，不会只替换前缀。

```text
A A B A C B  -- summary([A]) --> S[B] C B
S[B] C B    -- summary([B]) --> T[C]
T[C]        -- summary([C]) --> U[]
A A B A C B -- summary([A, B]) --> S[C]
```

人类看到的仍是完整对话（日志只追加）；模型下一次请求看到的是总结。Web UI 里
总结显示为压缩检查点节点。

## 安装

要求：DeepSeek Harness `>=0.2.1-rc.2` 及其自带运行时，Cordis `>=4.0.5`。
两个 peer 范围都没有上限。插件是一个 profile **bundle**：安装后往
`dsh.profile.bundles` 加一行，并新增一个 agent preset `block-ptc`；不会改动
自带的 `ptc` preset。

版本范围只说明「允许新宿主加载」，不等于已完成兼容性验收。本版本的实机验收使用
DSH `0.2.1-rc.2`。DSH 的插件加载器评估 peer 范围时包含预发布版本。插件在挂载前
检查所需的工具/提示词方法，在总结前检查会话方法，缺失时报错。方法存在不等于事件
语义、preset 配置或模型行为已经验证；宿主变化时仍需要重新验收。

### 从 npm 安装（推荐）

在 Harness 的 Plugin Manager 里找到 **dsh-block-ptc** 安装，或让启用了 Plugin
Manager 工具的 agent 安装：

```
plugin_manager  install_bundle  dsh-block-ptc
```

包已发布在 [npm](https://www.npmjs.com/package/dsh-block-ptc)。安装后重启应用，
选择 **Block PTC** preset。

### 从本地目录安装

```sh
git clone https://github.com/mengwEX/dsh-block-ptc.git
```

在 Plugin Manager 里安装绝对路径：

```
plugin_manager  install_bundle  /absolute/path/to/dsh-block-ptc
```

两种方式都会在目标 profile 里用 pnpm 安装。本地方式装成 `link:` 依赖，适合开发。
带版本号的源码包也放在 [GitHub Releases](https://github.com/mengwEX/dsh-block-ptc/releases)。

### 手动安装（等价做法）

在 `~/.dsh/profiles/<profile>/package.json` 里：

```jsonc
{
  "dependencies": { "dsh-block-ptc": "link:/absolute/path/to/dsh-block-ptc" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-block-ptc"] } }
}
```

然后在该目录运行 pnpm。

### 安装之后

1. preset 选择器里出现 **Block PTC**。
2. **重启一次应用。** 加载器按解析后的 URL 缓存插件模块，安装 bundle 会改变组合；
   运行中的宿主会继续用旧模块，直到重启。
3. 用 **Block PTC** preset 新建会话。

### 卸载

```
plugin_manager  remove_bundle  dsh-block-ptc
```

然后重启。`plugin_manager set_bundle dsh-block-ptc enabled=false` 可以只停用、
不卸载。

## 快速上手

直接说要做什么，完成后让它收口：

> 读一下 parser 模块，讲清 tokenizer 怎么工作，然后把这个区块收掉，继续看 lexer。

你应该看到：

- 模型每次跑程序都用带区块头的 `run_code`，例如
  `[block: tokenizer] Explain the tokenizer`；
- 一次 `block_summary` 收口调用，返回值类似
  `{"replaced": 3, "tokensFreed": 346}`——替换了多少条消息，以及被替换消息的
  估算 token 数（不含新总结本身）；
- 原位置出现一个 `<block-summary>…</block-summary>` 节点。

如果程序调用被拒绝并提示 *"every `run_code` description must start with
`[block: <ids>] <goal>`"*，那是 preset 的 guard 在工作：带上区块头重试即可；
被拒绝的那次调用本身不会被归属到任何区块。

## 接口参考

区块要选内聚、松耦合、有明确子目标和完成点的工作单元。相关的调查、修改与验证放在
一起。大任务按可分离的子目标切块，不要把整个任务塞进一个区块，也不要每调一次工具
就开一个新区块。小任务一个区块就够。每块完成后立即收口，再继续剩下的工作，不必等
整个任务结束。

### `run_code.description` 里的区块头

| 部分 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `[block: <ids>]` | 头部 | 是 | 逗号分隔、非空、不重复的区块 id，例如 `[block: auth]` 或 `[block: auth, parser]`。id 不能包含逗号、方括号或换行。 |
| `<goal>` | string | 是 | 头部之后同一行里的目标，显示为工具行的摘要。 |

示例：

```ts
run_code({
  description: '[block: auth] Rework the authentication tests',
  code: `
    const files = await tools.glob({ pattern: 'tests/auth/**' })
    return files
  `,
})
```

`run_code` 本身是 DSH 的工具，插件不替换它。`code`/`timeoutMs` 参数、沙箱、
并行调度和结果渲染都与内置 PTC 完全一致；插件只读区块头并给周围消息打归属。

### 可调用 `tools.block_summary`

| 参数 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `ids` | string[] | 是* | 要总结并收口的区块 id。 |
| `id` | string | 否 | `ids: [id]` 的旧别名。二选一，不能同时给。 |
| `summary` | string | 是 | 由模型撰写。总结这些 id 从第一次到最后一次出现的完整区间，保留区间内用户新增的要求、修正和约束。写清目标、已完成的工作与结果、未完成的工作和下一步；如果只剩向用户汇报，也要说明。按需保留代码、路径、命令、关键输出和决定。 |

*`ids` 必填，除非用旧的 `id` 别名。

替换文本会说明这是模型对先前工作的总结，并包在
`<block-summary>…</block-summary>` 里。只有还有剩余归属时才出现 `Block ids`
一行；空 ids 留在内部元数据里。这个格式与 DSH 自动压缩分开，二者可以共存。

立即完成时返回 `{ replaced, tokensFreed, ids? }`；`ids` 非空时表示总结继承的
剩余归属。`tokensFreed` 是被替换消息的估算大小，不含新总结的成本。

如果工具结果或另一个压缩还没结束，返回
`{ replaced: 0, tokensFreed: 0, pending: true, requestSeq, note }`。这只表示
已排队，不代表替换完成。成功的工具结果会写入日志，重启/分叉后可以继续完成；
延迟执行失败会记录日志，目标归属保留到真正替换为止。目标 id 不存在或区间含受保护
消息时，整个请求被拒绝，不会删除任何归属。

### 预设 `block-ptc`

自带 `ptc` preset 加上：

- 与自带 preset 相同的 `tool-presentation.mode: ptc`，因此宿主的 PTC 收窄规则
  继续生效：只有 `run_code` 可以直接调用；
- 本插件的行：一条 **guard**，要求每次模型直接调用的 `run_code` 都带
  `[block: <ids>] <goal>` 头（如果收窄规则缺席，也仍然拒绝直接调用其他工具）；
  此外还有区块规则段和程序内可调用的 `block_summary`。

## 设计说明

**为什么用描述头，而不是自定义传输层。** DSH `0.2.1` 移除了 `both` 呈现模式。
在 `ptc` 下，`dsh-tools` 会在策略之前把任何非 `run_code` 的模型直接调用解析为
`UNKNOWN_TOOL`，旧的 `block_run_code` 这类插件工具因此再也无法被调用。受支持的
传输层就是 `run_code`；插件把区块 id 放进它的描述，并且不包装、不重写它，从而
保持传输层行为完全一致。

**为什么用压缩词汇。** 一条消息只能通过 DSH 自己的 surface 替换机制从模型上下文
里消失，而一次替换必须携带 DSH 期望的事件：

```
compaction/start        取得持久压缩锁
compaction/summary      声明被替换精确区间的 token 价格
user/message            替换本身（surfaceOp: replace，compact-checkpoint 来源）
compaction/end          释放锁
```

这些都是 DSH 自己的会话事件类型（`@deepseek-ai/dsh-compaction`、
`@deepseek-ai/dsh-session`），不是插件发明的名字；插件定义新事件类型会让会话
日志无法读取。**内置压缩引擎不会被调用**，也不会发起总结请求——总结是模型自己
写的文本，这四个事件只是 DSH 要求的簿记。任何失败都只做一次收口尝试，失败的总结
不会把持久锁留在那里。

**保留什么。** system/developer 消息永远不被替换；包含它们的区间会被拒绝。区间内
的用户补充和工具通知会随工作一起被总结，总结必须保留新增要求、修正和约束。区间外
的消息保持不动。模型写完总结之后才到达的用户消息不会被丢弃：旧总结会被拒绝，模型
必须读完新消息再更新总结。未完成的工具对会推迟完整替换。

**状态放在哪。** `run_code` 的描述分配消息归属。已提交的总结检查点在
`source.blockPtc` 里携带剩余 id、已收口 id 和请求序号。只有总结尝试不会收口任何
东西。成功的排队结果可重放；`session/event` 观察者在 append 边界之外调度完成。
不使用第二个持久化存储。

**为什么没有外部导入。** profile bundle 可以以符号链接安装；按裸模块名导入
`@deepseek-ai/dsh-*` 的插件可能因宿主链接方式而解析失败。插件唯一的外部导入是
`node:crypto`，归属辅助逻辑用包内的相对模块。

## 验证

```
npm run check                  # 语法检查 + 逻辑测试
node tests/logic.test.mjs
```

逻辑测试用假的 context 和会话驱动真实的插件入口：区块头解析、工具注册、guard、
完整的压缩事务、失败后仍释放锁的路径，以及宿主 API 检查。

可选的实机检查使用 DSH 真实的 `Session` 类：

```
node tests/native-session.mjs /path/to/dsh-session/lib/index.js /path/to/dsh-tools/lib/index.js
```

在 DSH `0.2.1-rc.2` 上运行，它验证工具 schema 支持、所有压缩事件的真实 append 与
重放、区间内用户消息替换，以及延迟请求路径。preset 也在 `0.2.1-rc.2` 宿主里
激活过：roster 没有 `broken` 诊断，挂载组合包含 `dsh-block-ptc`，且 preset
作用域的线上 schema 只有 `run_code`，`block_summary` 对程序 SDK 可见、作为直接
调用则被拒绝。同一宿主的 guard 拒绝了没有区块头的 `run_code`，允许带合法区块头
的调用，允许嵌套调用并拒绝直接调用 `bash`。这不会运行模型，也不会验证 Web UI 的
实际渲染；一次带模型的实机对话仍需要已配置凭据的宿主。

## 排障

| 现象 | 原因与处理 |
|---|---|
| preset 选择器里没有 | bundle 不在 `dsh.profile.bundles`，或宿主还没重新组合。检查 `plugin_manager list_bundles`，然后重启。 |
| preset 显示损坏 / *"dsh-block-ptc: never started"* | 插件模块导入失败（本地链接安装通常是包解析问题）。修正布局后重启。 |
| *"invalid config: $.mode expected native \| ptc but got both"* | 旧 `0.2.x` bundle 装在 DSH `0.2.1+` 上。升级到 `0.3.0` 后重启。 |
| 会话里没有区块归属 | 会话没跑 `block-ptc` preset，或模型漏了区块头（guard 会拒绝那次调用）。 |
| 总结报 *"no current content for ids"* | 该 id 没在当前 surface 的 `run_code` 头里出现过。检查拼写；已收口的 id 不再可见。 |
| 新总结还是旧格式 | 宿主仍在跑旧模块。更新 bundle，完全退出并重开 DSH。历史总结保留原文。 |
| 改了插件不生效 | 模块按 URL 缓存，默认不开模块监听：重启应用。 |
| 某个区块一直不被压缩 | 没有用 `block_summary` 收口，内容会留到自动压缩把它折进通用总结。 |
| 会话里压缩不工作了 | 没有配对 `compaction/end` 的 `compaction/start` 就是持久锁。本插件在每个失败路径都会关闭自己的括号；旧版本留下的锁请开新会话。 |

## 已知边界

- 一次总结替换一个完整、连续的首尾区间。区间里有受保护的 system/developer 消息
  就拒绝整个区间，不会跳过它，也不会把前缀当成已完成总结。
- 区块头由模型撰写。没有区块头的调用会在执行前被拒绝，所以未归属的工作不会进入
  区块。
- 总结是有损的：必要信息必须写进总结文本。
- 检查点继承剩余 id，可以再次被总结；空 id 的检查点作为已完成结果保留。
- `0.2.x` 工具产生的历史区块总结仍可重放；新调用使用区块头，因为旧的传输工具已经
  不存在。
- 区块按会话隔离。子 agent 有自己的上下文和区块。
- peer 依赖只声明最低版本、不设上限。允许更新宿主，但事件语义和 preset 配置仍需
  重新验收。

## 开发

```
.
├── lib/plugin.js        宿主侧 guard、block_summary、压缩事务
├── lib/blocks.js        区块头解析、消息归属与区间规划
├── cordis.patch.yml     bundle 补丁：新增一个 preset `block-ptc`
├── locale/{en,zh}.json  Harness UI 读取的显示元数据
├── tests/logic.test.mjs 逻辑与事务测试
├── RELEASING.md         发布与交接检查表
└── package.json         bundle manifest（`dsh.bundle.patch`）
```

用任意 Node 22+ 运行测试（无需安装依赖）：

```
node tests/logic.test.mjs
```

### 发布到 npm

步骤见 [RELEASING.md](RELEASING.md)。包名是 `dsh-block-ptc`，bundle 补丁也按
这个名字解析。

### 贡献与反馈

欢迎在 <https://github.com/mengwEX/dsh-block-ptc> 提 issue 或 PR。提交前运行
`npm run check`，并把实机验收结果与离线测试分开记录。

## 许可证

MIT，见 [LICENSE](LICENSE)。
