# 本地 Codex 和 Claude Code 证明指南 / Local Codex and Claude Code Proof Guide

本指南说明如何在本地验证 Codex 与 Claude Code 的 MCP+hooks 接入。  
This guide explains how to validate the Codex and Claude Code MCP+hooks integration locally.

## 本地服务 / Local Services

- Gateway: `http://127.0.0.1:8420`
- 建议 launch label / Suggested launch label: `com.tencentdb.agent-memory.gateway`
- 建议 data dir / Suggested data dir: `${TDAI_DATA_DIR:-~/.tdai-memory-gateway}`
- 建议 log file / Suggested log file: `/tmp/memory-tencentdb-gateway-8420.log`
- MCP server: `memory-tencentdb`
- MCP tools:
  - `memory_tencentdb_memory_search`
  - `memory_tencentdb_conversation_search`

健康检查。  
Health check.

```sh
curl -s http://127.0.0.1:8420/health
```

如果 Codex Desktop 在仓库外创建 proof thread，请把 MCP 配置同步到 `~/.codex/config.toml`，或者用本仓库作为 workspace 新开一个 thread。  
If Codex Desktop creates proof threads outside this repo, mirror the MCP config in `~/.codex/config.toml` or open a fresh thread with this repo as the workspace.

如果是用建议的 launch label 启动 Gateway，验证结束后可以停止服务。  
If the Gateway was started with the suggested launch label, stop it after proof collection.

```sh
launchctl remove com.tencentdb.agent-memory.gateway
```

## 证明提示词 / Proof Prompts

在真实 Codex 和 Claude Code UI 或命令入口中使用以下提示词。  
Use the following prompt in the real Codex and Claude Code UI or command entrypoint.

```text
Call the memory_tencentdb_conversation_search tool with query "agent-memory-local-proof" and limit 3. Then summarize the returned proof memory in one sentence.
```

截图目标。  
Screenshot targets.

- `memory_tencentdb_conversation_search` 的 MCP tool call。  
  MCP tool call for `memory_tencentdb_conversation_search`.
- 包含 `agent-memory-local-proof` 的 tool result。  
  Tool result containing `agent-memory-local-proof`.
- assistant 的最终总结句。  
  Final assistant sentence summarizing the memory.

## Hook Capture 证明 / Hook Capture Proof

运行平台提示词后，可以从 Gateway 验证是否写入 L0。  
After running the platform prompt, verify L0 capture from the Gateway.

```sh
curl -s -X POST http://127.0.0.1:8420/search/conversations \
  -H 'Content-Type: application/json' \
  -d '{"query":"agent-memory-local-proof","limit":5}'
```

响应应包含 seeded proof message，以及 hooks 捕获的相关 turn。  
The response should include the seeded proof message and turns captured by hooks.

## 生成 Proof Pages / Generated Proof Pages

为了避免截图暴露私有绝对路径，建议先生成 proof pages，再通过本地 HTTP 服务截图。  
To avoid exposing private absolute paths in screenshots, generate proof pages first and serve the repo through a local HTTP server.

```sh
npm run benchmark:adapters:proofs
python3 -m http.server 9786 --bind 127.0.0.1
```

然后打开以下页面。  
Then open:

- `http://127.0.0.1:9786/docs/benchmark-artifacts/proofs/codex-proof.html`
- `http://127.0.0.1:9786/docs/benchmark-artifacts/proofs/claude-code-proof.html`

最终截图应保存到以下路径。  
Final screenshots should be saved to:

- `docs/benchmark-artifacts/screenshots/codex-proof.png`
- `docs/benchmark-artifacts/screenshots/claude-code-proof.png`
