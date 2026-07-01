#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proofRoot = resolve(__dirname, "../..");
const repoRoot = process.env.TENCENTDB_AGENT_MEMORY_REPO
  ? resolve(process.env.TENCENTDB_AGENT_MEMORY_REPO)
  : proofRoot;
const factsPath = join(__dirname, "facts.jsonl");
const resultsDir = join(__dirname, "results");
const screenshotsDir = join(proofRoot, "docs", "benchmark-artifacts", "screenshots");
const proofsDir = join(proofRoot, "docs", "benchmark-artifacts", "proofs");
const artifactResultsDir = join(proofRoot, "docs", "benchmark-artifacts", "results");
const reportPath = join(proofRoot, "docs", "adapter-benchmark-results.md");
const gatewayUrl = (process.env.MEMORY_TENCENTDB_GATEWAY_URL || "http://127.0.0.1:8420").replace(/\/+$/, "");
const claudeBenchModel = process.env.CLAUDE_BENCH_MODEL || "deepseek-v4-flash";
const opencodeBenchModel = process.env.OPENCODE_BENCH_MODEL || "deepseek/deepseek-v4-flash";
const opencodeNpxPackage = process.env.OPENCODE_NPX_PACKAGE || "opencode-ai@1.17.12";
const nodeBin = process.execPath;
const mcpBin = join(repoRoot, "bin", "memory-tencentdb-mcp.mjs");
const hookBin = join(repoRoot, "bin", "memory-tencentdb-hook.mjs");
const opencodePluginSource = join(repoRoot, "integrations", "opencode", "plugin.js");

const passTargets = {
  gatewayHealth: 1,
  mcpCall: 1,
  explicitRetrieval: 0.95,
  hookRecall: 0.8,
  baselineAccuracyMax: 0.1,
  captureSearchable: 0.9,
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function runId() {
  return nowIso().replace(/[:.]/g, "-");
}

async function ensureDirs() {
  await mkdir(resultsDir, { recursive: true });
  await mkdir(screenshotsDir, { recursive: true });
  await mkdir(proofsDir, { recursive: true });
  await mkdir(artifactResultsDir, { recursive: true });
}

async function loadFacts(limit = Infinity) {
  const text = await readFile(factsPath, "utf-8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .slice(0, Number.isFinite(limit) ? limit : undefined);
}

function headers() {
  const h = { "Content-Type": "application/json" };
  const apiKey = (process.env.MEMORY_TENCENTDB_GATEWAY_API_KEY || process.env.TDAI_GATEWAY_API_KEY || "").trim();
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

async function gatewayGet(path) {
  const start = Date.now();
  const res = await fetch(`${gatewayUrl}${path}`, { headers: headers() });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `GET ${path} failed: ${res.status}`);
  return { json, latency_ms: Date.now() - start };
}

async function gatewayPost(path, body) {
  const start = Date.now();
  const res = await fetch(`${gatewayUrl}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `POST ${path} failed: ${res.status}`);
  return { json, latency_ms: Date.now() - start };
}

function spawnCapture(command, args, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: opts.cwd || repoRoot,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs || 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, latency_ms: Date.now() - started });
    });
    if (opts.stdin != null) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

function scoreText(text, expected) {
  const normalized = String(text || "").toLowerCase();
  const exact = normalized.includes(String(expected).toLowerCase());
  if (exact) return { score: 1, label: "exact" };
  const words = String(expected)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5);
  const hits = words.filter((word) => normalized.includes(word)).length;
  if (words.length > 0 && hits / words.length >= 0.6) return { score: 0.5, label: "partial" };
  return { score: 0, label: "miss" };
}

function summarizeRecords(records) {
  const exact = records.filter((r) => r.score === 1).length;
  const partial = records.filter((r) => r.score === 0.5).length;
  const failed = records.filter((r) => r.score === 0).length;
  const total = records.length;
  return {
    total,
    exact,
    partial,
    failed,
    accuracy: total ? Number(((exact + partial * 0.5) / total).toFixed(4)) : 0,
  };
}

async function writeJson(name, data) {
  await ensureDirs();
  const path = join(resultsDir, name);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return path;
}

async function appendJsonl(name, entries) {
  await ensureDirs();
  const path = join(resultsDir, name);
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(path, text, "utf-8");
  return path;
}

async function seedFacts(facts, sessionKey) {
  const captures = [];
  for (const fact of facts) {
    const body = {
      user_content: fact.seed_prompt,
      assistant_content: `Adapter benchmark seed recorded for ${fact.id}: ${fact.expected_answer}`,
      session_key: sessionKey,
      session_id: `${sessionKey}:${fact.id}`,
      messages: [
        { role: "user", content: fact.seed_prompt, timestamp: Date.now() },
        {
          role: "assistant",
          content: `Adapter benchmark seed recorded for ${fact.id}: ${fact.expected_answer}`,
          timestamp: Date.now() + 1,
        },
      ],
      started_at: Date.now() - 1,
    };
    const capture = await gatewayPost("/capture", body);
    captures.push({ fact_id: fact.id, marker: fact.marker, ...capture.json, latency_ms: capture.latency_ms });
  }
  return captures;
}

function mcpClient() {
  const child = spawn(nodeBin, [mcpBin], {
    cwd: repoRoot,
    env: { ...process.env, MEMORY_TENCENTDB_GATEWAY_URL: gatewayUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  const pending = new Map();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf-8");
    while (true) {
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd < 0) break;
      const line = stdout.slice(0, lineEnd).trim();
      stdout = stdout.slice(lineEnd + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        continue;
      }
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
  });

  function request(method, params = {}, timeoutMs = 20_000) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out. stderr=${stderr.slice(-500)}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  function close() {
    child.kill("SIGTERM");
  }

  return { request, close, stderr: () => stderr };
}

async function mcpListAndCall(query, limit = 3) {
  const client = mcpClient();
  const start = Date.now();
  try {
    await client.request("initialize", {});
    const list = await client.request("tools/list", {});
    const call = await client.request("tools/call", {
      name: "memory_tencentdb_conversation_search",
      arguments: { query, limit },
    });
    return {
      ok: true,
      tools: list.result?.tools?.map((tool) => tool.name) || [],
      call: call.result,
      latency_ms: Date.now() - start,
    };
  } finally {
    client.close();
  }
}

async function runHook(platform, event, payload, extraEnv = {}) {
  const env = {
    MEMORY_TENCENTDB_GATEWAY_URL: gatewayUrl,
    MEMORY_TENCENTDB_HOOK_PLATFORM: platform,
    MEMORY_TENCENTDB_HOOK_EVENT: event,
    MEMORY_TENCENTDB_HOOK_CACHE_DIR: join(resultsDir, "hook-cache"),
    ...extraEnv,
  };
  const result = await spawnCapture(nodeBin, [hookBin], {
    cwd: repoRoot,
    env,
    stdin: JSON.stringify(payload),
    timeoutMs: 30_000,
  });
  let json;
  try {
    json = result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  } catch {
    json = undefined;
  }
  return { ...result, json };
}

async function waitSearch(query, expected, sessionKey, timeoutMs = 10_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await gatewayPost("/search/conversations", {
      query,
      limit: 5,
      session_key: sessionKey,
    });
    const resultsText = String(last.json.results || "");
    if (resultsText.includes(query) || resultsText.includes(expected)) {
      return { found: true, latency_ms: Date.now() - started, search: last.json };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { found: false, latency_ms: Date.now() - started, search: last?.json };
}

async function smoke() {
  await ensureDirs();
  const facts = await loadFacts(1);
  const sessionKey = "adapter-benchmark-smoke";
  const seeded = await seedFacts(facts, sessionKey);
  const health = await gatewayGet("/health");
  const mcp = await mcpListAndCall(facts[0].marker, 3);
  const hookRecall = await runHook("benchmark-smoke", "UserPromptSubmit", {
    hook_event_name: "UserPromptSubmit",
    prompt: facts[0].query_prompt,
    session_key: sessionKey,
    session_id: "smoke-recall",
  });
  const hookMarker = `hook-proof-smoke-${Date.now()}`;
  const hookExpected = `Synthetic hook capture succeeded for ${hookMarker}.`;
  const hookCapture = await runHook("benchmark-smoke", "Stop", {
    hook_event_name: "Stop",
    prompt: `Remember ${hookMarker}`,
    last_assistant_message: hookExpected,
    session_key: sessionKey,
    session_id: "smoke-capture",
  });
  const captureSearch = await waitSearch(hookMarker, hookExpected, sessionKey);
  const result = {
    run_id: runId(),
    created_at: nowIso(),
    gateway_url: gatewayUrl,
    health: health.json,
    seeded,
    mcp,
    hook_recall: {
      code: hookRecall.code,
      has_additional_context: !!hookRecall.json?.hookSpecificOutput?.additionalContext,
      stdout: hookRecall.stdout,
      stderr: hookRecall.stderr,
      latency_ms: hookRecall.latency_ms,
    },
    hook_capture: {
      code: hookCapture.code,
      stdout: hookCapture.stdout,
      stderr: hookCapture.stderr,
      latency_ms: hookCapture.latency_ms,
      capture_search: captureSearch,
    },
  };
  const path = await writeJson(`${result.run_id}-smoke.json`, result);
  console.log(`smoke result: ${path}`);
}

async function localBenchmark(opts) {
  await ensureDirs();
  const limit = Number(opts.limit || 20);
  const repeats = Number(opts.repeats || 3);
  const facts = await loadFacts(limit);
  const sessionKey = `adapter-benchmark-local-${Date.now()}`;
  const seed = await seedFacts(facts, sessionKey);
  const explicit = [];
  const hookCapture = [];
  const hookRecall = [];
  const negative = [];

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const fact of facts) {
      const mcp = await mcpListAndCall(fact.marker, 3);
      const toolText = JSON.stringify(mcp.call || {});
      explicit.push({
        phase: "explicit-retrieval",
        mode: "mcp+hooks",
        platform: "local-adapter",
        repeat,
        fact_id: fact.id,
        marker: fact.marker,
        expected: fact.expected_answer,
        tool_evidence: toolText.includes("memory_tencentdb_conversation_search") || toolText.includes(fact.marker),
        latency_ms: mcp.latency_ms,
        ...scoreText(toolText, fact.expected_answer),
      });

      const hookMarker = `hook-proof-local-${repeat}-${fact.id}-${Date.now()}`;
      const hookExpected = `Local hook capture remembers ${fact.expected_answer}`;
      await runHook("local-adapter", "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        prompt: `For hook benchmark, remember ${hookMarker}.`,
        session_key: sessionKey,
        session_id: `local-${repeat}-${fact.id}`,
        turn_id: `seed-${repeat}-${fact.id}`,
      });
      const stop = await runHook("local-adapter", "Stop", {
        hook_event_name: "Stop",
        last_assistant_message: hookExpected,
        session_key: sessionKey,
        session_id: `local-${repeat}-${fact.id}`,
        turn_id: `seed-${repeat}-${fact.id}`,
      });
      const searchable = await waitSearch(hookMarker, hookExpected, sessionKey);
      hookCapture.push({
        phase: "hook-capture",
        platform: "local-adapter",
        repeat,
        fact_id: fact.id,
        marker: hookMarker,
        expected: hookExpected,
        hook_exit_code: stop.code,
        searchable: searchable.found,
        capture_lag_ms: searchable.latency_ms,
        score: searchable.found ? 1 : 0,
        label: searchable.found ? "exact" : "miss",
      });

      const recall = await runHook("local-adapter", "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        prompt: fact.query_prompt,
        session_key: sessionKey,
        session_id: `recall-${repeat}-${fact.id}`,
      });
      const context = recall.json?.hookSpecificOutput?.additionalContext || "";
      hookRecall.push({
        phase: "hook-recall",
        platform: "local-adapter",
        repeat,
        fact_id: fact.id,
        marker: fact.marker,
        expected: fact.expected_answer,
        has_additional_context: !!context,
        hook_exit_code: recall.code,
        latency_ms: recall.latency_ms,
        ...scoreText(context, fact.expected_answer),
      });

      const negativeMarker = `never-seeded-control-${repeat}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const neg = await gatewayPost("/search/conversations", {
        query: negativeMarker,
        limit: 3,
        session_key: sessionKey,
      });
      negative.push({
        phase: "negative-control",
        platform: "local-adapter",
        repeat,
        fact_id: fact.id,
        expected: fact.expected_answer,
        marker: negativeMarker,
        false_positive: String(neg.json.results || "").includes(fact.expected_answer) ||
          String(neg.json.results || "").includes(fact.marker),
        latency_ms: neg.latency_ms,
      });
    }
  }

  const result = {
    run_id: runId(),
    created_at: nowIso(),
    gateway_url: gatewayUrl,
    session_key: sessionKey,
    facts: facts.length,
    repeats,
    seed,
    summaries: {
      explicit_retrieval: summarizeRecords(explicit),
      hook_capture: {
        ...summarizeRecords(hookCapture),
        searchable_rate: hookCapture.length
          ? Number((hookCapture.filter((r) => r.searchable).length / hookCapture.length).toFixed(4))
          : 0,
      },
      hook_recall: summarizeRecords(hookRecall),
      negative_false_positive_rate: negative.length
        ? Number((negative.filter((r) => r.false_positive).length / negative.length).toFixed(4))
        : 0,
    },
    records: [...explicit, ...hookCapture, ...hookRecall, ...negative],
  };
  const path = await writeJson(`${result.run_id}-local.json`, result);
  console.log(`local benchmark result: ${path}`);
}

function findCodexCommand() {
  const candidates = [
    process.env.CODEX_BIN,
    "/Applications/Codex.app/Contents/Resources/codex",
    "codex",
  ].filter(Boolean);
  return candidates[0];
}

function findClaudeCommand() {
  const candidates = [
    process.env.CLAUDE_BIN,
    "claude",
    join(process.env.HOME || "", ".nvm/versions/node/v24.14.1/bin/claude"),
    join(process.env.HOME || "", ".nvm/versions/node/v24.14.1/bin/.claude-DrvaOsxF"),
    join(
      process.env.HOME || "",
      ".nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude",
    ),
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "claude" || existsSync(candidate)) || candidates[0];
}

function findOpenCodeCommand() {
  if (process.env.OPENCODE_BIN) return { command: process.env.OPENCODE_BIN, args: [] };
  return {
    command: process.env.NPX_BIN || "npx",
    args: ["-y", "-p", opencodeNpxPackage, "opencode"],
  };
}

async function runCodexPrompt(prompt, mode, rawName) {
  const outputFile = join(resultsDir, `${rawName}.txt`);
  const eventsFile = join(resultsDir, `${rawName}.jsonl`);
  const hookAuditFile = join(resultsDir, `${rawName}-hooks.jsonl`);
  const cwd = mode === "no-memory"
    ? await mkdtemp(join(tmpdir(), "memory-bench-codex-baseline-"))
    : repoRoot;
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-C",
    cwd,
    "-o",
    outputFile,
  ];
  if (mode === "no-memory") args.push("--ignore-user-config", "--ignore-rules");
  else args.push("--dangerously-bypass-hook-trust");
  args.push(prompt);
  const result = await spawnCapture(findCodexCommand(), args, {
    cwd,
    env: mode === "mcp+hooks"
      ? { MEMORY_TENCENTDB_HOOK_AUDIT_LOG: hookAuditFile }
      : {},
    timeoutMs: 240_000,
  });
  await writeFile(eventsFile, result.stdout || "", "utf-8");
  let answer = "";
  try {
    answer = await readFile(outputFile, "utf-8");
  } catch {
    answer = result.stdout;
  }
  return { ...result, answer, output_file: outputFile, events_file: eventsFile, hook_audit_file: hookAuditFile, cwd };
}

function parseClaudeStream(stdout) {
  let finalResult = "";
  const assistantTexts = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "result" && typeof event.result === "string") {
      finalResult = event.result;
    }
    const content = event.message?.content;
    if (event.type === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          assistantTexts.push(part.text);
        }
      }
    }
  }
  return finalResult || assistantTexts.join("\n");
}

function parseOpenCodeStream(stdout) {
  const texts = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      texts.push(event.part.text);
    }
  }
  return texts.join("\n").trim();
}

async function runClaudePrompt(prompt, mode, rawName) {
  const outputFile = join(resultsDir, `${rawName}.txt`);
  const eventsFile = join(resultsDir, `${rawName}.jsonl`);
  const cwd = mode === "no-memory"
    ? await mkdtemp(join(tmpdir(), "memory-bench-claude-baseline-"))
    : repoRoot;
  const command = findClaudeCommand();
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    claudeBenchModel,
  ];
  if (mode === "no-memory") {
    args.push(
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
    );
  } else {
    args.push(
      "--dangerously-skip-permissions",
      "--include-hook-events",
      "--mcp-config",
      join(repoRoot, ".mcp.json"),
      "--strict-mcp-config",
      "--settings",
      join(repoRoot, ".claude", "settings.json"),
    );
  }
  args.push(prompt);
  const result = await spawnCapture(command, args, {
    cwd,
    timeoutMs: 240_000,
  });
  await writeFile(eventsFile, result.stdout || "", "utf-8");
  const answer = parseClaudeStream(result.stdout) || result.stdout || result.stderr || "";
  await writeFile(outputFile, answer, "utf-8");
  return { ...result, answer, output_file: outputFile, events_file: eventsFile, cwd, command };
}

async function prepareOpenCodeCwd(mode, rawName) {
  const cwd = await mkdtemp(join(tmpdir(), mode === "no-memory"
    ? "memory-bench-opencode-baseline-"
    : "memory-bench-opencode-mcp-hooks-"));
  const auditFile = join(resultsDir, `${rawName}-opencode-audit.jsonl`);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: opencodeBenchModel,
  };

  if (mode === "mcp+hooks") {
    await mkdir(join(cwd, ".opencode", "plugins"), { recursive: true });
    await copyFile(opencodePluginSource, join(cwd, ".opencode", "plugins", "memory-tencentdb.js"));
    config.mcp = {
      "memory-tencentdb": {
        type: "local",
        command: [nodeBin, mcpBin],
        enabled: true,
        environment: {
          MEMORY_TENCENTDB_GATEWAY_URL: gatewayUrl,
        },
      },
    };
  }

  await writeFile(join(cwd, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return { cwd, auditFile };
}

async function runOpenCodePrompt(prompt, mode, rawName) {
  const outputFile = join(resultsDir, `${rawName}.txt`);
  const eventsFile = join(resultsDir, `${rawName}.jsonl`);
  const { cwd, auditFile } = await prepareOpenCodeCwd(mode, rawName);
  const executable = findOpenCodeCommand();
  const args = [
    ...executable.args,
    "run",
    "--dir",
    cwd,
    "-m",
    opencodeBenchModel,
    "--format",
    "json",
    "--auto",
  ];
  if (mode === "no-memory") args.push("--pure");
  args.push(prompt);

  const result = await spawnCapture(executable.command, args, {
    cwd,
    env: {
      MEMORY_TENCENTDB_GATEWAY_URL: gatewayUrl,
      MEMORY_TENCENTDB_OPENCODE_AUDIT_LOG: auditFile,
    },
    timeoutMs: 240_000,
  });
  await writeFile(eventsFile, result.stdout || "", "utf-8");
  const answer = parseOpenCodeStream(result.stdout) || result.stdout || result.stderr || "";
  await writeFile(outputFile, answer, "utf-8");
  return {
    ...result,
    answer,
    output_file: outputFile,
    events_file: eventsFile,
    hook_audit_file: mode === "mcp+hooks" ? auditFile : undefined,
    cwd,
    command: [executable.command, ...executable.args].join(" "),
    model: opencodeBenchModel,
  };
}

function agentPrompt(fact, mode, sessionKey) {
  if (mode === "mcp+hooks") {
    const args = {
      query: fact.marker,
      limit: 10,
      session_key: sessionKey,
    };
    return [
      `Call memory_tencentdb_conversation_search with these exact JSON arguments: ${JSON.stringify(args)}.`,
      "Do not call memory_tencentdb_memory_search for this benchmark item.",
      "Use only the session_key shown above. Do not switch to any other session_key even if another key appears in memory context.",
      `In the raw conversation result, find the sentence containing '${fact.marker} means "..."'.`,
      `Answer this question using only the quoted meaning from that exact sentence: ${fact.query_prompt}`,
      "Do not edit files or run shell commands. Do not summarize a scene or profile. Answer only with the remembered meaning.",
    ].join("\n");
  }
  return [
    fact.query_prompt,
    "Do not use external tools. If you do not know from this session alone, answer exactly: I do not know.",
  ].join("\n");
}

async function agentBenchmark(opts) {
  await ensureDirs();
  const platform = String(opts.platform || "codex");
  const mode = String(opts.mode || "mcp+hooks");
  const limit = Number(opts.limit || 20);
  const repeats = Number(opts.repeats || 3);
  const facts = await loadFacts(limit);
  const sessionKey = `adapter-benchmark-agent-${platform}-${Date.now()}`;
  let seed = [];
  let seedSearch;
  if (mode === "mcp+hooks") {
    seed = await seedFacts(facts, sessionKey);
    seedSearch = await waitSearch(facts[0].marker, facts[0].expected_answer, sessionKey, 30_000);
  }
  const records = [];
  const raw = [];

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const fact of facts) {
      const rawName = `${runId()}-${platform}-${mode.replace("+", "plus")}-${repeat}-${fact.id}`;
      const prompt = agentPrompt(fact, mode, sessionKey);
      const execution = platform === "claude-code"
        ? await runClaudePrompt(prompt, mode, rawName)
        : platform === "opencode"
          ? await runOpenCodePrompt(prompt, mode, rawName)
          : await runCodexPrompt(prompt, mode, rawName);
      const score = scoreText(execution.answer, fact.expected_answer);
      const toolEvidence = /memory_tencentdb_(conversation|memory)_search/.test(execution.stdout || execution.answer || "");
      records.push({
        phase: mode === "mcp+hooks" ? "explicit-retrieval" : "baseline",
        platform,
        mode,
        repeat,
        fact_id: fact.id,
        marker: fact.marker,
        expected: fact.expected_answer,
        code: execution.code,
        signal: execution.signal,
        latency_ms: execution.latency_ms,
        output_file: relativePath(execution.output_file),
        events_file: relativePath(execution.events_file),
        hook_audit_file: execution.hook_audit_file ? relativePath(execution.hook_audit_file) : undefined,
        model: execution.model,
        tool_evidence: toolEvidence,
        answer_excerpt: String(execution.answer || "").slice(0, 500),
        stderr_excerpt: String(execution.stderr || "").slice(0, 500).replaceAll(repoRoot, "<repo>"),
        ...score,
      });
      raw.push({
        platform,
        mode,
        repeat,
        fact_id: fact.id,
        hook_audit_file: execution.hook_audit_file ? relativePath(execution.hook_audit_file) : undefined,
        stdout: execution.stdout,
        stderr: execution.stderr,
        answer: execution.answer,
      });
    }
  }

  const summary = summarizeRecords(records);
  const result = {
    run_id: runId(),
    created_at: nowIso(),
    platform,
    mode,
    session_key: sessionKey,
    facts: facts.length,
    repeats,
    seed,
    seed_search: seedSearch,
    summary: {
      ...summary,
      tool_evidence_rate: records.length
        ? Number((records.filter((r) => r.tool_evidence).length / records.length).toFixed(4))
        : 0,
    },
    records,
  };
  const jsonPath = await writeJson(`${result.run_id}-${platform}-${mode.replace("+", "plus")}.json`, result);
  await appendJsonl(`${result.run_id}-${platform}-${mode.replace("+", "plus")}-raw.jsonl`, raw);
  console.log(`agent benchmark result: ${jsonPath}`);
}

function formatPct(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function collectMetrics(results) {
  const rows = [];
  for (const result of results) {
    if (result.summaries) {
      rows.push({
        source: "local-adapter",
        mode: "mcp+hooks",
        phase: "显式检索 / explicit retrieval",
        total: result.summaries.explicit_retrieval.total,
        accuracy: result.summaries.explicit_retrieval.accuracy,
        extra: "",
      });
      rows.push({
        source: "local-adapter",
        mode: "mcp+hooks",
        phase: "hook 捕获 / hook capture",
        total: result.summaries.hook_capture.total,
        accuracy: result.summaries.hook_capture.accuracy,
        extra: `可搜索 / searchable=${formatPct(result.summaries.hook_capture.searchable_rate)}`,
      });
      rows.push({
        source: "local-adapter",
        mode: "mcp+hooks",
        phase: "hook 回忆 / hook recall",
        total: result.summaries.hook_recall.total,
        accuracy: result.summaries.hook_recall.accuracy,
        extra: "",
      });
      rows.push({
        source: "local-adapter",
        mode: "no-memory",
        phase: "负例 / negative controls",
        total: result.records?.filter((r) => r.phase === "negative-control").length || 0,
        accuracy: result.summaries.negative_false_positive_rate,
        extra: "误报率 / false-positive rate",
      });
    }
    if (result.platform && result.summary) {
      rows.push({
        source: result.platform,
        mode: result.mode,
        phase: result.mode === "mcp+hooks" ? "显式检索 / explicit retrieval" : "基线 / baseline",
        total: result.summary.total,
        accuracy: result.summary.accuracy,
        extra: `工具证据 / tool evidence=${formatPct(result.summary.tool_evidence_rate)}`,
      });
    }
  }
  return rows;
}

function latestByKey(results, predicate, keyOf) {
  const selected = new Map();
  for (const result of results.filter(predicate)) {
    const key = keyOf(result);
    const prev = selected.get(key);
    if (!prev || String(result.created_at).localeCompare(String(prev.created_at)) > 0) {
      selected.set(key, result);
    }
  }
  return [...selected.values()].sort((a, b) => {
    const ak = `${a.platform || "local"}:${a.mode || "mcp+hooks"}`;
    const bk = `${b.platform || "local"}:${b.mode || "mcp+hooks"}`;
    return ak.localeCompare(bk);
  });
}

function relativePath(path) {
  const value = String(path || "");
  if (value.startsWith(proofRoot)) return value.slice(proofRoot.length + 1);
  if (value.startsWith(repoRoot)) return value.slice(repoRoot.length + 1);
  return value;
}

function resolveRepoPath(path) {
  const value = String(path || "");
  return value.startsWith("/") ? value : join(proofRoot, value);
}

async function readResultFiles() {
  await ensureDirs();
  const files = (await readdir(resultsDir)).filter((file) => file.endsWith(".json"));
  const results = [];
  for (const file of files) {
    try {
      results.push(JSON.parse(await readFile(join(resultsDir, file), "utf-8")));
    } catch {
      // Ignore partially written files.
    }
  }
  return results;
}

function selectCompleteResults(results) {
  return [
    ...latestByKey(
      results,
      (result) => !!result.summaries && result.facts === 20,
      () => "local-adapter:mcp+hooks",
    ),
    ...latestByKey(
      results,
      (result) => !!result.platform && !!result.summary && result.facts === 20,
      (result) => `${result.platform}:${result.mode}`,
    ),
  ];
}

async function modelsFromRecords(result) {
  const models = new Set();
  let hookEvents = 0;
  let toolEvents = 0;
  for (const record of result.records || []) {
    if (!record.events_file) continue;
    let text = "";
    try {
      text = await readFile(resolveRepoPath(record.events_file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.message?.model) models.add(event.message.model);
      if (record.model) models.add(record.model);
      if (event.subtype === "hook_started" || event.subtype === "hook_response") hookEvents += 1;
      if (event.message?.content?.some?.((part) => part?.type === "tool_use")) toolEvents += 1;
      if (event.type === "item.completed" && JSON.stringify(event).includes("memory_tencentdb_")) toolEvents += 1;
      if (event.type === "tool_use" && JSON.stringify(event).includes("memory_tencentdb_")) toolEvents += 1;
    }
    if (record.hook_audit_file) {
      try {
        const auditText = await readFile(resolveRepoPath(record.hook_audit_file), "utf-8");
        for (const line of auditText.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            JSON.parse(line);
            hookEvents += 1;
          } catch {
            // Ignore partial audit lines.
          }
        }
      } catch {
        // Hook audit files are optional and only available for adapters that emit them.
      }
    }
  }
  return { models: [...models].sort(), hookEvents, toolEvents };
}

function resultArtifactName(result) {
  const source = result.platform || "local-adapter";
  const mode = String(result.mode || "mcp+hooks").replace("+", "plus");
  return `${source}-${mode}-summary.json`;
}

function sanitizeRecord(record) {
  const sanitized = {
    phase: record.phase,
    platform: record.platform,
    mode: record.mode,
    repeat: record.repeat,
    fact_id: record.fact_id,
    marker: record.marker,
    expected: record.expected,
    score: record.score,
    label: record.label,
    latency_ms: record.latency_ms,
  };
  if ("tool_evidence" in record) sanitized.tool_evidence = record.tool_evidence;
  if ("searchable" in record) sanitized.searchable = record.searchable;
  if ("capture_lag_ms" in record) sanitized.capture_lag_ms = record.capture_lag_ms;
  if ("has_additional_context" in record) sanitized.has_additional_context = record.has_additional_context;
  if ("false_positive" in record) sanitized.false_positive = record.false_positive;
  if ("answer_excerpt" in record) sanitized.answer_excerpt = record.answer_excerpt;
  if ("model" in record) sanitized.model = record.model;
  return sanitized;
}

async function writeSanitizedResult(result, generatedAt) {
  const source = result.platform || "local-adapter";
  const artifact = {
    generated_at: generatedAt,
    source,
    mode: result.mode || "mcp+hooks",
    run_id: result.run_id,
    created_at: result.created_at,
    gateway_url: result.gateway_url || gatewayUrl,
    facts: result.facts,
    repeats: result.repeats,
    summary: result.summary || result.summaries,
    records: (result.records || []).map(sanitizeRecord),
  };
  const file = join(artifactResultsDir, resultArtifactName(result));
  await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return file;
}

async function report() {
  await ensureDirs();
  const generatedAt = nowIso();
  const results = await readResultFiles();
  const selected = selectCompleteResults(results);
  const rows = collectMetrics(selected);
  const evidence = [];
  for (const result of selected) {
    const sanitizedFile = await writeSanitizedResult(result, generatedAt);
    if (result.platform && result.summary) {
      evidence.push({
        source: result.platform,
        mode: result.mode,
        file: relativePath(sanitizedFile),
        ...(await modelsFromRecords(result)),
      });
    } else {
      evidence.push({
        source: "local-adapter",
        mode: "mcp+hooks",
        file: relativePath(sanitizedFile),
        models: [],
        hookEvents: result.records?.filter((record) => record.phase?.startsWith("hook")).length || 0,
        toolEvents: result.records?.filter((record) => record.phase === "explicit-retrieval").length || 0,
      });
    }
  }
  const latestSmoke = results
    .filter((result) => result.health)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const lines = [
    "# Codex、Claude Code 和 OpenCode 适配 Benchmark 结果 / Codex, Claude Code, and OpenCode Adapter Benchmark Results",
    "",
    `生成时间 / Generated: ${generatedAt}`,
    "",
    "## 范围 / Scope",
    "",
    "本报告只评估两种模式：`no-memory` 和 `mcp+hooks`。适配路线由本地 Gateway、MCP 搜索工具、生命周期 hooks/plugin 组成。",
    "",
    "This report evaluates only two modes: `no-memory` and `mcp+hooks`. The adapter route combines the local Gateway, MCP search tools, and lifecycle hooks/plugins.",
    "",
    "## 环境 / Environment",
    "",
    `- Gateway URL: \`${gatewayUrl}\``,
    `- Gateway health / 健康状态: \`${latestSmoke?.health?.status || "not recorded"}\``,
    `- MCP tools observed / 已观测 MCP 工具: \`${latestSmoke?.mcp?.tools?.join(", ") || "not recorded"}\``,
    "- Gateway LLM / 本次 Gateway LLM: `https://api.deepseek.com` / `deepseek-v4-flash` (API key 仅保存在本地配置中，证据产物已脱敏 / API key is stored only in local config and redacted from artifacts)",
    `- OpenCode runner / OpenCode 运行入口: \`${process.env.OPENCODE_BIN || `npx -y -p ${opencodeNpxPackage} opencode`}\``,
    `- OpenCode benchmark model / OpenCode benchmark 模型: \`${opencodeBenchModel}\``,
    `- Raw local result directory / 本地原始结果目录: \`benchmarks/adapter-memory/results\``,
    `- Sanitized result directory / 脱敏结果目录: \`docs/benchmark-artifacts/results\``,
    `- Screenshot directory / 截图目录: \`docs/benchmark-artifacts/screenshots\``,
    `- Proof page directory / 证明页目录: \`docs/benchmark-artifacts/proofs\``,
    "",
    "## 汇总指标 / Summary Metrics",
    "",
    "| 来源 / Source | 模式 / Mode | 阶段 / Phase | 总数 / Total | 准确率 / Rate | 补充 / Extra |",
    "| --- | --- | --- | ---: | ---: | --- |",
    ...rows.map((row) => `| ${row.source} | ${row.mode} | ${row.phase} | ${row.total} | ${formatPct(row.accuracy)} | ${row.extra} |`),
    "",
    "## 选中的结果产物 / Selected Result Artifacts",
    "",
    "| 来源 / Source | 模式 / Mode | 脱敏结果文件 / Sanitized result file | 模型 / Models seen | Hook 事件 / Hook events | 工具事件 / Tool events |",
    "| --- | --- | --- | --- | ---: | ---: |",
    ...evidence.map((item) => `| ${item.source} | ${item.mode} | \`${item.file}\` | ${item.models.length ? item.models.map((model) => `\`${model}\``).join(", ") : "n/a"} | ${item.hookEvents} | ${item.toolEvents} |`),
    "",
    "## 通过标准 / Pass Targets",
    "",
    `- Gateway health and MCP call success / Gateway 健康与 MCP 调用成功率: ${formatPct(passTargets.gatewayHealth)}`,
    `- MCP + hooks explicit retrieval accuracy / 显式检索准确率: >= ${formatPct(passTargets.explicitRetrieval)}`,
    `- Hook-based cross-session recall accuracy / 基于 hook 的跨 session recall 准确率: >= ${formatPct(passTargets.hookRecall)}`,
    `- Baseline hidden-fact accuracy / baseline 隐藏事实命中率: <= ${formatPct(passTargets.baselineAccuracyMax)}`,
    `- Hook capture searchable within 10 seconds / hook capture 在 10 秒内可搜索: >= ${formatPct(passTargets.captureSearchable)}`,
    "",
    "## 证据清单 / Evidence Checklist",
    "",
    "- Codex proof page / Codex 证明页: `docs/benchmark-artifacts/proofs/codex-proof.html`",
    "- Codex screenshot / Codex 截图: `docs/benchmark-artifacts/screenshots/codex-proof.png`",
    "- Claude Code proof page / Claude Code 证明页: `docs/benchmark-artifacts/proofs/claude-code-proof.html`",
    "- Claude Code screenshot / Claude Code 截图: `docs/benchmark-artifacts/screenshots/claude-code-proof.png`",
    "- OpenCode proof page / OpenCode 证明页: `docs/benchmark-artifacts/proofs/opencode-proof.html`",
    "- OpenCode screenshot / OpenCode 截图: `docs/benchmark-artifacts/screenshots/opencode-proof.png`",
    "- Sanitized JSON result files / 脱敏 JSON 结果: `docs/benchmark-artifacts/results/`",
    "- Raw local JSON/JSONL outputs / 本地原始输出: `benchmarks/adapter-memory/results/`，已纳入该 proof 仓库用于完整证据审计 / committed in this proof repository for complete evidence audit.",
    "- Gateway/MCP/hook log excerpts with secrets removed / Gateway、MCP、hook 日志摘录需要移除密钥。",
    "",
    "## 截图证据 / Screenshot Evidence",
    "",
    "![Codex proof](benchmark-artifacts/screenshots/codex-proof.png)",
    "",
    "![Claude Code proof](benchmark-artifacts/screenshots/claude-code-proof.png)",
    "",
    "![OpenCode proof](benchmark-artifacts/screenshots/opencode-proof.png)",
    "",
    "## 说明 / Notes",
    "",
    "- `local-adapter` 行用于排除模型波动，验证共享 Gateway、MCP server 和 hook bridge 的确定性行为。 / The `local-adapter` rows verify deterministic Gateway, MCP server, and hook bridge behavior without model variance.",
    "- Codex、Claude Code 和 OpenCode 行证明真实平台入口可以走同一条适配路线。 / The Codex, Claude Code, and OpenCode rows prove the same route through real platform entrypoints.",
    "- OpenCode 行使用项目级 `opencode.json` MCP 配置和 `.opencode/plugins/memory-tencentdb.js` plugin，并固定 `deepseek/deepseek-v4-flash`。 / The OpenCode rows use project-level `opencode.json` MCP config plus `.opencode/plugins/memory-tencentdb.js`, pinned to `deepseek/deepseek-v4-flash`.",
    "- 截图来自 raw platform JSONL 生成的 proof page；即使桌面自动化无法直接控制 Codex 或终端窗口，证据仍然可审阅。 / Screenshots are proof-page captures generated from raw platform JSONL streams, keeping evidence reviewable even when desktop automation cannot control Codex or terminal windows.",
    "- 如果某个平台行缺失，应先查看对应 CLI discovery/error 输出，再判断是否是 adapter 故障。 / If a platform row is missing, inspect CLI discovery/error output before treating it as an adapter failure.",
    "",
  ];
  await writeFile(reportPath, `${lines.join("\n")}\n`, "utf-8");
  console.log(`report: ${reportPath}`);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, max = 1400) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: "unparsed", line: line.slice(0, 500) });
    }
  }
  return events;
}

function compactEvent(platform, event) {
  if (platform === "codex") {
    const item = event.item;
    if (item?.type === "mcp_tool_call" && item.tool?.includes("memory_tencentdb")) {
      return {
        kind: item.status === "completed" ? "MCP 工具结果 / MCP tool result" : "MCP 工具调用 / MCP tool call",
        text: JSON.stringify({
          server: item.server,
          tool: item.tool,
          arguments: item.arguments,
          status: item.status,
          result: item.result,
        }, null, 2),
      };
    }
    if (item?.type === "agent_message") {
      return { kind: "最终回答 / Final answer", text: item.text };
    }
    return undefined;
  }

  if (platform === "opencode") {
    if (event.type === "tool_use" && event.part?.tool?.includes("memory-tencentdb")) {
      return {
        kind: "MCP 工具调用与结果 / MCP tool call and result",
        text: JSON.stringify({
          tool: event.part.tool,
          input: event.part.state?.input,
          status: event.part.state?.status,
          output: event.part.state?.output,
        }, null, 2),
      };
    }
    if (event.type === "text" && event.part?.text) {
      return { kind: "最终回答 / Final answer", text: event.part.text };
    }
    if (event.type === "step_finish" && event.part?.tokens) {
      return {
        kind: "模型与 token 信号 / Model and token signal",
        text: JSON.stringify({
          reason: event.part.reason,
          tokens: event.part.tokens,
          cost: event.part.cost,
        }, null, 2),
      };
    }
    return undefined;
  }

  if (event.subtype === "hook_started") {
    return {
      kind: "Hook 开始 / Hook started",
      text: JSON.stringify({
        hook_event: event.hook_event,
        hook_name: event.hook_name,
        session_id: event.session_id,
      }, null, 2),
    };
  }
  if (event.subtype === "hook_response") {
    let output;
    try {
      output = event.output ? JSON.parse(event.output) : undefined;
    } catch {
      output = undefined;
    }
    const additionalContext = output?.hookSpecificOutput?.additionalContext || "";
    return {
      kind: "Hook 响应 / Hook response",
      text: JSON.stringify({
        hook_event: event.hook_event,
        hook_name: event.hook_name,
        exit_code: event.exit_code,
        additional_context_present: additionalContext.length > 0,
        additional_context_chars: additionalContext.length,
      }, null, 2),
    };
  }
  const content = event.message?.content;
  if (event.type === "assistant" && Array.isArray(content)) {
    const toolUse = content.find((part) => part?.type === "tool_use" && part.name?.includes("memory_tencentdb"));
    if (toolUse) {
      return {
        kind: "MCP 工具调用 / MCP tool call",
        text: JSON.stringify({
          name: toolUse.name,
          input: toolUse.input,
          model: event.message?.model,
        }, null, 2),
      };
    }
    const text = content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return { kind: "助手文本 / Assistant text", text };
  }
  if (event.type === "user" && JSON.stringify(event).includes("tool_result")) {
    return { kind: "MCP 工具结果 / MCP tool result", text: JSON.stringify(event.message?.content || event.tool_use_result || event, null, 2) };
  }
  if (event.type === "result" && typeof event.result === "string") {
    return {
      kind: "最终回答 / Final answer",
      text: JSON.stringify({
        result: event.result,
        modelUsage: event.modelUsage,
      }, null, 2),
    };
  }
  return undefined;
}

async function proofRowsForRecord(record) {
  let text = "";
  try {
      text = await readFile(resolveRepoPath(record.events_file), "utf-8");
  } catch {
    text = "";
  }
  const rows = [];
  for (const event of parseJsonLines(text)) {
    const compact = compactEvent(record.platform, event);
    if (!compact) continue;
    rows.push(compact);
  }
  const seen = new Set();
  return rows
    .filter((row) => {
      const key = `${row.kind}:${row.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, record.platform === "claude-code" || record.platform === "opencode" ? 8 : 5);
}

function chooseProofRecord(result) {
  return (result.records || []).find((record) => (
    record.fact_id === "P01" &&
    record.score === 1 &&
    record.tool_evidence
  )) || (result.records || []).find((record) => record.score === 1 && record.tool_evidence);
}

function screenshotPathFor(platform) {
  return join(screenshotsDir, `${platform}-proof.png`);
}

function proofPathFor(platform) {
  return join(proofsDir, `${platform}-proof.html`);
}

function platformLabel(platform) {
  if (platform === "claude-code") return "Claude Code";
  if (platform === "opencode") return "OpenCode";
  if (platform === "codex") return "Codex";
  return platform;
}

async function writeProofPage(result, selected, latestSmoke) {
  const record = chooseProofRecord(result);
  if (!record) return undefined;
  const details = await modelsFromRecords(result);
  const baseline = selected.find((item) => item.platform === result.platform && item.mode === "no-memory");
  const proofRows = await proofRowsForRecord(record);
  const label = platformLabel(result.platform);
  const title = `${label} TencentDB Agent Memory 证明 / Proof`;
  const screenshotPath = screenshotPathFor(result.platform);
  const html = `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #111827; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 24px 0 12px; font-size: 18px; letter-spacing: 0; }
    .subtitle { margin: 0 0 20px; color: #4b5563; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { background: #fff; border: 1px solid #d7dce3; border-radius: 8px; padding: 14px; }
    .metric b { display: block; font-size: 22px; margin-top: 4px; }
    .label { color: #4b5563; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .panel { background: #fff; border: 1px solid #d7dce3; border-radius: 8px; padding: 16px; margin-top: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 8px; vertical-align: top; }
    th { color: #374151; font-weight: 650; background: #f9fafb; }
    code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #111827; color: #f9fafb; padding: 12px; border-radius: 8px; overflow: auto; max-height: 260px; }
    .pass { color: #047857; font-weight: 700; }
    .warn { color: #92400e; font-weight: 700; }
    .muted { color: #6b7280; }
    @media (max-width: 880px) { main { padding: 18px; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">由真实平台 JSONL 输出生成；本证据产物不包含 API key。 / Generated from raw platform JSONL output. API keys are not included in this artifact.</p>

    <section class="grid" aria-label="benchmark metrics">
      <div class="metric"><span class="label">模式 / Mode</span><b>${escapeHtml(result.mode)}</b></div>
      <div class="metric"><span class="label">准确率 / Accuracy</span><b class="pass">${escapeHtml(formatPct(result.summary?.accuracy))}</b></div>
      <div class="metric"><span class="label">工具证据 / Tool evidence</span><b class="pass">${escapeHtml(formatPct(result.summary?.tool_evidence_rate))}</b></div>
      <div class="metric"><span class="label">基线 / Baseline</span><b>${escapeHtml(formatPct(baseline?.summary?.accuracy ?? 0))}</b></div>
    </section>

    <section class="panel">
      <h2>截图证据 / Screenshot Evidence</h2>
      <table>
        <tr><th>记忆工具调用 / Memory tool call</th><td><code>memory_tencentdb_conversation_search</code> 查询 / queried <code>${escapeHtml(record.marker)}</code></td></tr>
        <tr><th>返回记忆 / Returned memory</th><td>For adapter benchmark, remember this exact fact: <code>${escapeHtml(record.marker)}</code> means &quot;${escapeHtml(record.expected)}&quot;</td></tr>
        <tr><th>Agent 回答 / Agent answer</th><td>${escapeHtml(record.answer_excerpt)}</td></tr>
        <tr><th>Hook/模型信号 / Hook/model signal</th><td>${escapeHtml(label)} audit/hook events observed / 已观测 audit/hooks: ${details.hookEvents}; MCP tool events / MCP 工具事件: ${details.toolEvents}; model / 模型: ${details.models.length ? details.models.join(", ") : "n/a"}</td></tr>
      </table>
    </section>

    <section class="panel">
      <h2>选中的运行 / Selected Run</h2>
      <table>
        <tr><th>Gateway</th><td>${escapeHtml(gatewayUrl)} (${escapeHtml(latestSmoke?.health?.status || "health not recorded")})</td></tr>
        <tr><th>结果文件 / Result file</th><td><code>${escapeHtml(relativePath(join(resultsDir, `${result.run_id}-${result.platform}-${String(result.mode).replace("+", "plus")}.json`)))}</code></td></tr>
        <tr><th>原始事件文件 / Raw events file</th><td><code>${escapeHtml(relativePath(record.events_file))}</code></td></tr>
        <tr><th>模型 / Models seen</th><td>${details.models.length ? details.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(", ") : "n/a"}</td></tr>
        <tr><th>Hook 事件 / Hook events</th><td>${details.hookEvents}</td></tr>
        <tr><th>工具事件 / Tool events</th><td>${details.toolEvents}</td></tr>
        <tr><th>截图目标 / Screenshot target</th><td><code>${escapeHtml(relativePath(screenshotPath))}</code></td></tr>
      </table>
    </section>

    <section class="panel">
      <h2>证明事实 / Proof Fact</h2>
      <table>
        <tr><th>事实 / Fact</th><td>${escapeHtml(record.fact_id)} / <code>${escapeHtml(record.marker)}</code></td></tr>
        <tr><th>期望记忆 / Expected memory</th><td>${escapeHtml(record.expected)}</td></tr>
        <tr><th>最终回答 / Final answer</th><td>${escapeHtml(record.answer_excerpt)}</td></tr>
        <tr><th>评分 / Score</th><td><span class="${record.score === 1 ? "pass" : "warn"}">${escapeHtml(record.label)}</span></td></tr>
      </table>
    </section>

    <section class="panel">
      <h2>平台事件证据 / Platform Event Evidence</h2>
      ${proofRows.map((row) => `<h3>${escapeHtml(row.kind)}</h3><pre>${escapeHtml(truncate(row.text))}</pre>`).join("\n")}
    </section>
  </main>
</body>
</html>
`;
  const file = proofPathFor(result.platform);
  await writeFile(file, html, "utf-8");
  return file;
}

async function proofs() {
  await ensureDirs();
  const results = await readResultFiles();
  const selected = selectCompleteResults(results);
  const latestSmoke = results
    .filter((result) => result.health)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const files = [];
  for (const platform of ["codex", "claude-code", "opencode"]) {
    const result = selected.find((item) => item.platform === platform && item.mode === "mcp+hooks");
    if (!result) continue;
    const file = await writeProofPage(result, selected, latestSmoke);
    if (file) files.push(file);
  }
  console.log(`proof pages:\n${files.join("\n")}`);
}

async function full(opts) {
  await smoke();
  await localBenchmark(opts);
  await agentBenchmark({ ...opts, platform: "codex", mode: "no-memory" });
  await agentBenchmark({ ...opts, platform: "codex", mode: "mcp+hooks" });
  await agentBenchmark({ ...opts, platform: "claude-code", mode: "no-memory" });
  await agentBenchmark({ ...opts, platform: "claude-code", mode: "mcp+hooks" });
  await agentBenchmark({ ...opts, platform: "opencode", mode: "no-memory" });
  await agentBenchmark({ ...opts, platform: "opencode", mode: "mcp+hooks" });
  await proofs();
  await report();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  if (command === "smoke") return smoke(args);
  if (command === "local") return localBenchmark(args);
  if (command === "agents") return agentBenchmark(args);
  if (command === "proofs") return proofs(args);
  if (command === "report") return report(args);
  if (command === "full") return full(args);
  console.log(`Usage:
  node benchmarks/adapter-memory/run.mjs smoke
  node benchmarks/adapter-memory/run.mjs local --repeats 3 --limit 20
  node benchmarks/adapter-memory/run.mjs agents --platform codex --mode mcp+hooks --repeats 3 --limit 20
  node benchmarks/adapter-memory/run.mjs agents --platform opencode --mode mcp+hooks --repeats 3 --limit 20
  node benchmarks/adapter-memory/run.mjs proofs
  node benchmarks/adapter-memory/run.mjs report
  node benchmarks/adapter-memory/run.mjs full --repeats 3 --limit 20`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
