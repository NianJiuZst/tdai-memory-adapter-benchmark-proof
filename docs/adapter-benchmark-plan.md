# Codex 和 Claude Code 适配 Benchmark 计划 / Codex and Claude Code Adapter Benchmark Plan

本 benchmark 用来证明两件事。  
This benchmark is designed to prove two things.

1. Codex 与 Claude Code 可以通过受支持的平台扩展面真正接入 TencentDB Agent Memory。  
   Codex and Claude Code can actually integrate with TencentDB Agent Memory through supported platform extension surfaces.
2. 接入后能提升跨 session 记忆能力，而不仅是 MCP 连通。  
   The integration improves cross-session memory behavior, not just MCP connectivity.

本 benchmark 会区分“适配是否接通”和“记忆是否有效”。  
The benchmark separates integration correctness from memory effectiveness.

## 测试矩阵 / Test Matrix

| 平台 / Platform | 模式 / Mode | 目的 / Purpose |
| --- | --- | --- |
| Codex | `no-memory` | baseline，不启用 MCP 和 hooks / Baseline with no MCP and no hooks |
| Codex | `mcp+hooks` | 验证显式记忆搜索和 recall/capture 生命周期 / Prove explicit memory search plus recall/capture lifecycle |
| Claude Code | `no-memory` | baseline，不启用 MCP 和 hooks / Baseline with no MCP and no hooks |
| Claude Code | `mcp+hooks` | 验证显式记忆搜索和 recall/capture 生命周期 / Prove explicit memory search plus recall/capture lifecycle |

## 指标 / Metrics

### 接入指标 / Integration Metrics

| 指标 / Metric | 定义 / Definition | 通过标准 / Pass target |
| --- | --- | --- |
| Gateway health | `GET /health` 返回 `ok` 或 `degraded` / returns `ok` or `degraded` | 100% |
| MCP list success | 平台能列出两个 memory tools / Platform lists both memory tools | 100% |
| MCP call success | tool call 返回有效 JSON / Tool call returns valid JSON | 100% |
| Hook recall success | `UserPromptSubmit` 调用 `/recall` / `UserPromptSubmit` calls `/recall` | hook-enabled runs 100% |
| Hook capture success | `Stop` 或等价事件调用 `/capture` 并写入 L0 / `Stop` or equivalent calls `/capture` and records L0 | >= 90% |
| Search after capture | capture 后可通过 `/search/conversations` 搜到 marker / Captured marker is searchable via `/search/conversations` | 100% |

### 效果指标 / Effect Metrics

| 指标 / Metric | 定义 / Definition | 价值 / Why it matters |
| --- | --- | --- |
| Exact recall accuracy | 回答包含隐藏的期望事实 / Answer includes the hidden expected fact | 衡量 memory usefulness / Measures memory usefulness |
| Tool evidence rate | 回答前有 memory tool result 或原始事件证据 / Answer is backed by memory tool evidence | 证明答案来自 memory path / Proves answer came from memory path |
| No-memory false positive rate | baseline 对未知事实编造答案 / Baseline invents answers for unknown facts | 检测 hallucinated memory / Detects hallucinated memory |
| Cross-session retention | 新 session 能回忆旧 session 捕获的事实 / New session recalls facts captured earlier | 证明持久记忆 / Proves persistent memory |
| Latency overhead | 启用 memory 后的耗时增加 / Extra wall-clock time with memory enabled | 衡量 UX 成本 / Measures UX cost |
| Capture lag | assistant answer 到 L0 可搜索之间的时间 / Time from final answer to searchable L0 record | 衡量 hook pipeline 可靠性 / Measures hook pipeline reliability |

推荐 PR 阈值。  
Recommended PR thresholds.

- MCP+hooks 显式检索准确率 >= `95%`。  
  Explicit memory-tool retrieval accuracy in MCP+hooks mode >= `95%`.
- hook-based 跨 session recall 准确率 >= `80%`。  
  Hook-based cross-session recall accuracy >= `80%`.
- no-memory baseline 对隐藏事实命中率 <= `10%`。  
  Baseline no-memory accuracy on hidden facts <= `10%`.
- hook capture 在 10 秒内可搜索 >= `90%`。  
  Hook capture searchable within 10 seconds >= `90%`.
- Gateway health 与 MCP call success = `100%`。  
  Gateway health and MCP call success = `100%`.

## 数据集 / Benchmark Dataset

数据集包含 20 条合成记忆事实。它们不应是基础模型天然知道的内容，并且必须容易精确评分。  
The dataset contains 20 synthetic memory facts. They should be impossible for the base model to know and easy to grade exactly.

每条事实包含以下字段。  
Each fact includes these fields.

- `id`
- `category`
- `marker`
- `seed_prompt`
- `expected_answer`
- `query_prompt`
- `negative_control_prompt`

数据分布。  
Dataset distribution.

- 5 条用户偏好 / 5 user preferences
- 5 条项目约定 / 5 project conventions
- 5 条设计决策 / 5 design decisions
- 5 条原始细节 / 5 raw details

## 阶段 / Phases

### Phase 1: 连通性 Smoke / Connectivity Smoke

目标：证明 adapter 已经连上 Gateway、MCP 和 hooks。  
Goal: prove the adapter is wired to Gateway, MCP, and hooks.

```sh
curl -s http://127.0.0.1:8420/health
```

```sh
curl -s -X POST http://127.0.0.1:8420/search/conversations \
  -H 'Content-Type: application/json' \
  -d '{"query":"agent-memory-local-proof","limit":5}'
```

平台提示词。  
Platform prompt.

```text
Call the memory_tencentdb_conversation_search tool with query "agent-memory-local-proof" and limit 3. Then summarize the returned proof memory in one sentence.
```

所需证据。  
Required evidence.

- MCP tool call row 或 raw event。  
  MCP tool call row or raw event.
- tool result 中包含 proof memory。  
  Tool result contains proof memory.
- Gateway log 或 report 显示 search/recall/capture 路径。  
  Gateway log or report shows the search/recall/capture path.

### Phase 2: MCP+Hooks 显式检索 / Explicit Retrieval In MCP+Hooks Mode

目标：证明模型在被要求调用 memory tool 时可以正确使用记忆。  
Goal: prove the model can use memory when instructed to call the memory tool.

```text
Call memory_tencentdb_conversation_search with query "<fact marker>" and limit 3.
Use the returned memory to answer: <question>.
```

评分。  
Scoring.

- `1`: 回答包含期望事实 / answer contains the expected fact.
- `0.5`: 部分正确但缺少关键短语 / partially correct but missing key phrase.
- `0`: 缺失、错误或回答 memory 不可用 / missing, wrong, or says memory is unavailable.

### Phase 3: Hook 捕获 / Hook Capture

目标：证明 UI/agent 会话不手动调用 memory tool 时也能被 hook 捕获。  
Goal: prove UI/agent conversations can be captured by hooks without manually calling memory tools.

```text
For hook benchmark, remember this exact fact: hook-proof-<platform>-<id> means "<expected fact>". Reply exactly: hook benchmark seed done.
```

验证。  
Verification.

```sh
curl -s -X POST http://127.0.0.1:8420/search/conversations \
  -H 'Content-Type: application/json' \
  -d '{"query":"hook-proof-<platform>-<id>","limit":5}'
```

通过条件。  
Pass condition.

- marker 出现在 L0 search 结果中。  
  The marker appears in L0 search results.
- Gateway 或 hook evidence 显示 capture 完成。  
  Gateway or hook evidence shows capture completion.

### Phase 4: Hook-Based 跨 Session Recall / Hook-Based Cross-Session Recall

目标：证明不显式提 tool 名时，hooks 能在新 session 注入 recall context。  
Goal: prove hooks can inject recall context in a new session without explicitly mentioning tools.

```text
What does hook-proof-<platform>-<id> mean? Answer only with the remembered meaning.
```

预期。  
Expected behavior.

- hooks enabled 时，`/recall` 在模型回答前取回上下文。  
  With hooks enabled, `/recall` retrieves context before the model answers.
- 模型回答期望事实。  
  The model answers with the expected fact.
- baseline no-memory 应失败或回答不知道。  
  Baseline no-memory should fail or say it does not know.

### Phase 5: 负例 / Negative Controls

目标：证明模型没有编造 memory。  
Goal: prove the model is not hallucinating memory.

```text
What does hook-proof-never-seeded-<id> mean?
```

预期：memory-enabled 和 baseline 都不应编造答案。  
Expected: both memory-enabled and baseline modes should not invent an answer.

### Phase 6: 延迟与稳定性 / Latency and Reliability

记录以下耗时。  
Record wall-clock timings for:

- `/recall`
- MCP `tools/call`
- `/capture`
- assistant answer 到 searchable L0 record 的时间  
  time from final assistant answer to searchable L0 record

## 自动化 Harness / Automated Harness

本 benchmark 使用 CLI harness 做可重复评分，并使用 proof-page screenshots 做维护者可读的视觉证据。  
This benchmark uses a CLI harness for repeatable scoring and proof-page screenshots for maintainer-facing visual evidence.

只比较两种模式。  
Only two modes are compared.

- `no-memory`
- `mcp+hooks`

### 最小命令 / Minimal Commands

Codex MCP+hooks:

```sh
codex exec --json --dangerously-bypass-hook-trust --skip-git-repo-check \
  'Call memory_tencentdb_conversation_search with query "agent-memory-local-proof" and limit 3. Then answer with the remembered proof.'
```

Claude Code MCP+hooks:

```sh
claude --print --verbose --output-format=stream-json \
  --model deepseek-v4-flash \
  --dangerously-skip-permissions --include-hook-events \
  --mcp-config .mcp.json --strict-mcp-config \
  --settings .claude/settings.json \
  'Call memory_tencentdb_conversation_search with query "agent-memory-local-proof" and limit 3. Then answer with the remembered proof.'
```

### 脚本入口 / Script Entry Points

```sh
npm run benchmark:adapters:smoke
npm run benchmark:adapters:local
npm run benchmark:adapters:agents
npm run benchmark:adapters:proofs
npm run benchmark:adapters:report
```

## PR 证据包 / PR Evidence Package

强 PR 应包含以下证据。  
A strong PR should attach or link the following evidence.

1. Codex proof screenshot：MCP tool call、returned memory、final answer。  
   Codex proof screenshot: MCP tool call, returned memory, and final answer.
2. Claude Code proof screenshot：hook/model signal、MCP tool call、tool result。  
   Claude Code proof screenshot: hook/model signal, MCP tool call, and tool result.
3. Gateway health output。  
   Gateway health output.
4. 结果表：比较 `no-memory` 与 `mcp+hooks`。  
   Result table comparing `no-memory` and `mcp+hooks`.
5. 限制说明：MCP 是显式检索，hooks 是基于平台 payload 的 best-effort 生命周期自动化。  
   Limitation note: MCP is explicit retrieval, while hooks provide best-effort lifecycle automation based on platform payloads.

## 解读 / Interpretation

如果指标达标，可以支持以下结论。  
If thresholds pass, the benchmark supports this claim.

> Codex 与 Claude Code 可以通过官方扩展面接入 TencentDB Agent Memory。MCP 提供稳定的显式记忆搜索，hooks 提供足够可用的自动 recall/capture。该路线比 OpenClaw 的 in-process plugin 更外部化，也不如 Hermes Provider 那样原生，但它可移植，并能在真实平台入口工作。
>
> Codex and Claude Code can use TencentDB Agent Memory through official extension surfaces. MCP provides reliable explicit memory search, while hooks provide useful automatic recall/capture. This route is more external than OpenClaw's in-process plugin and less native than Hermes's Provider path, but it is portable and works through real platform entrypoints.
