# Context and cache comparison / 上下文与缓存对比

**Mechanism illustration, not a measured API benchmark.**
**机制示意，不是 API 实测基准。**

The figure replays the same **synthetic** four-task workload twice: append-only
PTC history, and history replaced by Block PTC. It uses the real plugin's
replacement planner and transaction writer against an in-memory fixture. Token
weights and cache behavior are assigned explicitly; no model API is called.

两组使用同一份**模拟**工作量：4 个任务，每个任务 3 次请求；原生 PTC 保留历史，
Block PTC 在任务收口时替换历史。示例调用真实插件的替换规划与事务函数，但会话是
内存 fixture，token 权重与缓存行为由示例人工指定，没有调用模型 API。

## Reading the bars / 如何读图

- Full bar = input context (`cache hit + cache miss`). A cached token still
  occupies the context window. Blue is a subset of the input, not extra context.
- The two panels use the same vertical scale and request numbers.
- R3, R6 and R9 submit summaries inside their existing program executions.
  R4, R7 and R10 therefore show the smaller context and a partially cold prefix.
- The current assistant/tool pair has not finished when its summary is written;
  it remains after the replacement, as do all user messages. This is why the
  Block PTC bars do not return to the fixed system prefix after each block.
- R12 also closes a block, but there is no R13 in the figure to show that effect.
- The baseline has not reached its automatic compaction threshold. This does not
  compare Block PTC against every possible automatic/manual compaction policy.

整根柱子是输入上下文，蓝色缓存命中和橙色未命中共同组成它。两图共享纵轴和请求
序号。摘要写在 R3、R6、R9 已有程序内部，下一次请求才看到替换结果；收口请求中
尚未完成的 assistant/tool 消息及所有用户消息仍保留。R12 也收口，但没有画出 R13。
原生 PTC 在本例中尚未达到内置自动压缩阈值，因此不能推广成对所有压缩策略的比较。

## Assumptions / 假设

| Item / 项目 | Assigned tokens / 人工指定 token 数 |
|---|---:|
| Equal fixed prefix in both arms / 两组相同固定前缀 | 4,096 |
| Each new task's user message / 每个任务的新用户消息 | 256 |
| Each completed assistant/tool pair / 每对已完成 assistant/tool 消息 | 2,048 |
| Each replacement summary / 每段替换摘要 | 512 |

The fixed prefix is normalized: differences in preset instructions, schemas and
wrapper arguments are omitted. The example cannot estimate their real overhead.
Each arm starts with its own cold cache. Cache hits are the longest unchanged
prefix of an earlier input in that arm, rounded down to 64-token units. This is
an **idealized model**, not a reconstruction of DeepSeek's cache implementation:
there are no retention misses, asynchronous cache writes or contention. Prior
model output is not assumed to have been cached as an earlier input.

两组固定前缀被归一化，省略了实际预设提示、schema 和 wrapper 参数的差异，不能
据此估算真实额外开销。两组使用彼此独立的冷缓存；命中量取该组历史输入中的最长
相同前缀，再向下取整到 64 token。这是**理想化模型**，并非 DeepSeek 缓存实现的
复刻；未模拟过期、异步写入或竞争，也未假定之前生成的输出已作为输入被缓存。

DeepSeek documents prefix-based reuse and the usage fields
`prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. Its cache does not
promise a 100% hit rate. See the official
[context caching guide](https://api-docs.deepseek.com/guides/kv_cache) and
[cache announcement](https://api-docs.deepseek.com/news/news0802/).

DeepSeek 官方说明了前缀复用及上述 usage 字段，也说明了命中并非 100% 保证。
本图不使用 token 价格，不宣称真实费用、延迟、缓存命中率或任务质量提升。
压缩会改变历史前缀，可能增加当次未命中量；上下文变小不等于账单一定下降。

## Reproduce / 重现

From the repository root, using Node 22+ and Python with matplotlib installed:

```sh
node scripts/generate-context-example.mjs
python3 scripts/render-context-comparison.py
```

For an isolated Python environment:

```sh
python3 -m venv /tmp/dsh-context-chart-env
/tmp/dsh-context-chart-env/bin/pip install matplotlib
/tmp/dsh-context-chart-env/bin/python scripts/render-context-comparison.py
```

Data: [illustrative.json](illustrative.json). Figures are written to
`docs/assets/context-comparison.{en,zh}.{png,svg}`. The generator verifies
`cache hit + cache miss = input tokens`; image generation adds no plugin runtime
dependencies. For Chinese labels, install a CJK font (Hiragino Sans GB, PingFang
or Noto Sans CJK at one of the paths supported by the renderer).

## A future real benchmark / 后续真实基准

Use the same task inputs, repository snapshot, tool outputs, model and inference
parameters in two fresh DSH sessions. Record exact DSH/plugin versions, all
prompt/schema overhead, summary calls, request order and complete API usage.
Prevent cross-arm cache warming, counterbalance run order and repeat runs.
Report task correctness and retained decisions alongside token counts.

取同一任务输入、仓库快照、工具结果、模型和推理参数，在两组新会话中运行；记录
宿主/插件版本、完整 prompt/schema 开销、摘要调用、请求顺序和 API usage。
隔离两组缓存，交错运行并多次重复，同时验证任务结果和关键决策是否保留。

Use `prompt_tokens` for the full input and provider-reported cache hit/miss
fields for its split. Missing fields must be recorded as unknown, not inferred
from context size or the plugin's `tokensFreed` value. That value counts the
estimated replaced-message tokens before subtracting the new summary's cost.

真实图应使用 API 返回的 `prompt_tokens` 及缓存命中/未命中字段。缺字段就标未知，
不能从上下文长度或 `tokensFreed` 反推。后者是被替换消息的估算量，未扣除新摘要。
