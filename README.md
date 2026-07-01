# TencentDB Agent Memory Adapter Benchmark Proof

This repository keeps the benchmark and proof artifacts for TencentDB Agent Memory issue #235 outside the upstream source tree.

Upstream source repository:

- Repository: `TencentCloud/TencentDB-Agent-Memory`
- Issue: `https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235`
- Source commit originally used for this evidence bundle: `590a30b8524ef2a7f08942f460f196b1527acfbb`
- Clean upstream PR commit after moving proof artifacts out: `d40c457d5dac69c1b077d9f0c05c78ffa2909bd9`
- OpenCode adapter source commit: `d9d1b56`
- Base commit: `4339e63650920871eb0e8888083a1779d114e3ae`
- Generated at: `2026-07-01T05:59:28.577Z`

## Why This Is Separate

The upstream pull request should stay focused on adapter code, integration examples, and architecture documentation. Generated benchmark outputs, proof HTML, screenshots, and local audit artifacts are useful review evidence, but they make the source diff noisy and can contain local diagnostic paths.

This repository is the external evidence bundle linked from the PR body.

## Included Artifacts

- Benchmark harness: `benchmarks/adapter-memory/run.mjs`
- Test facts: `benchmarks/adapter-memory/facts.jsonl`
- Benchmark plan: `docs/adapter-benchmark-plan.md`
- Generated result summary: `docs/adapter-benchmark-results.md`
- Sanitized JSON summaries: `docs/benchmark-artifacts/results/`
- Raw JSON/JSONL/TXT outputs: `benchmarks/adapter-memory/results/`
- Reviewable proof pages: `docs/benchmark-artifacts/proofs/`
- Screenshot evidence: `docs/benchmark-artifacts/screenshots/`
- UI proof guide: `docs/local-ui-proof-guide.md`

This proof repository intentionally commits the complete raw output bundle, including platform event streams, hook audit logs, text outputs, hook cache snapshots, sanitized summaries, proof pages, and screenshots. The upstream PR keeps those artifacts out of the source tree so its diff remains focused on implementation and docs.

Before publishing the raw bundle, it was scanned for common secret patterns such as API keys, GitHub tokens, bearer credentials, and password assignments. The raw logs may still contain local benchmark paths and diagnostic metadata.

## Summary

| Source | Mode | Phase | Total | Result |
| --- | --- | --- | ---: | --- |
| local-adapter | `mcp+hooks` | explicit retrieval | 60 | 100.0% |
| local-adapter | `mcp+hooks` | hook capture | 60 | 100.0% |
| local-adapter | `mcp+hooks` | hook recall | 60 | 100.0% |
| local-adapter | `no-memory` | negative controls | 60 | 0.0% false-positive rate |
| claude-code | `mcp+hooks` | explicit retrieval | 60 | 100.0% |
| claude-code | `no-memory` | baseline | 60 | 0.0% |
| codex | `mcp+hooks` | explicit retrieval | 20 | 100.0% |
| codex | `no-memory` | baseline | 60 | 0.0% |
| opencode | `mcp+hooks` | explicit retrieval | 60 | 95.0% |
| opencode | `no-memory` | baseline | 60 | 0.0% |

See `docs/adapter-benchmark-results.md` for the full generated report.

## Reproduce

Check out the upstream source branch separately, install dependencies there, and point this proof harness at that source checkout.

```sh
export TENCENTDB_AGENT_MEMORY_REPO=/path/to/TencentDB-Agent-Memory
export MEMORY_TENCENTDB_GATEWAY_URL=http://127.0.0.1:8420
export OPENCODE_BENCH_MODEL=deepseek/deepseek-v4-flash
export OPENCODE_NPX_PACKAGE=opencode-ai@1.17.12

node benchmarks/adapter-memory/run.mjs smoke
node benchmarks/adapter-memory/run.mjs local --repeats 3 --limit 20
node benchmarks/adapter-memory/run.mjs agents --platform codex --mode mcp+hooks --repeats 3 --limit 20
node benchmarks/adapter-memory/run.mjs agents --platform claude-code --mode mcp+hooks --repeats 3 --limit 20
node benchmarks/adapter-memory/run.mjs agents --platform opencode --mode mcp+hooks --repeats 3 --limit 20
node benchmarks/adapter-memory/run.mjs proofs
node benchmarks/adapter-memory/run.mjs report
```

If `TENCENTDB_AGENT_MEMORY_REPO` is not set, the harness assumes it is running from inside the upstream source repository.

## PR Usage

In the upstream PR body, link to a fixed commit or tag of this repository rather than to a moving branch.

Suggested wording:

```md
Benchmark and UI proof artifacts, including raw JSON/JSONL/TXT event outputs, are intentionally kept outside this PR to avoid committing generated logs, screenshots, and local-path-sensitive files into the source tree.

Full reproducibility bundle:
https://github.com/NianJiuZst/tdai-memory-adapter-benchmark-proof/tree/<commit-or-tag>
```
