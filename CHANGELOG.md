# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `bench/` reproducible accounting over recorded session logs: per-session cache baseline, compaction anatomy (summarizer call + publication re-read, with backend detection from the published audit), and pruner-run cost, with hashed session labels and no content access.
- `docs/EVIDENCE.md` / `docs/EVIDENCE.zh-CN.md`: measured evidence and methodology (25 sessions, 3,515 requests, 997M prompt tokens), including the finding that shipped summarization calls hit only the system/tools head of the cache (~0–9,856 of ~550k tokens) even 0.1 s after a 99.85%-cached request.
- Benchmark harness tests (discovery, accounting math, backend detection, pruner attribution, rendering).

### Changed

- Added `?test=replay` to the diagnostic route: it rebuilds the most recent recorded compaction span from the live session and runs one real `summarize` call on it, reporting measured input/output usage, checkpoint size and certificate. Nothing is published, and the endpoint is documented as reading and sending session content.
- README and the measurement report now lead with **plugin-installed measurements** (366-message span: 333,184 cached / 468 uncached / 9,954 output tokens, 365 candidates → 46 retained, 2,243-character certified checkpoint) and keep the shipped-backend figures as an explicitly labelled baseline.
- README's cost section and the measurement report summary are now tables instead of bullet lists, and state explicitly that the cache behavior is a constraint of replay-based summarization rather than a defect of the shipped backend. The shipped backend's transaction, lock, overflow recovery, retained tail and replay are noted as preserved unchanged.
- README now includes a Mermaid flowchart of the compression pipeline, including both failure branches (unparseable extraction and failed certificate).
- README and evidence documents rewritten in a neutral, report-style voice (organization as author, no first-person narration), with explicit definitions for every cost unit. The Chinese and English versions were both rewritten, and the example checkpoint now uses the renderer's real section names.
- `docs/EVIDENCE.md` and `docs/EVIDENCE.zh-CN.md` restructured as measurement reports: objective, data and method, baseline, measured cost, attribution, mode comparison, quality constraints, uncertainty, reproduction.
- Documentation now reports measured cache behavior instead of the earlier warm-prefix expectation: `extract` mode claims cost parity with the shipped summarizer, and `deterministic` mode is documented as the zero-model-call, ~4× cheaper option on the measured events.
- Offline suite is now 80 assertions across structure, pipeline and benchmark.

## [0.3.0] - 2026-11-04

First public release: **结构性压缩 / Structural Compression**.

### Added

- Structural compressor behind the shipped compaction backend: one cited-atom extraction call, evidence-coupled stiffness assembly, KKT solve for the request load, Guyan static condensation, and a reconstruction certificate before any checkpoint is published.
- Deterministic cited renderer: only quotes verified as substrings of the replayed source appear in the checkpoint.
- Shipped-engine hook: the compressor is installed on `BasicCompactionEngine.prototype.summarize`, so both the Host plane and the isolated preset-plane backend (the one the desktop app actually uses) run it, while the shipped transaction, lock, overflow recovery, retained tail and warm-prefix replay stay untouched. Unloading restores the original method.
- Content-free operator surface: `/context_status`, `/context_inspect`, and a `/compact` fallback command; accounting for real cache hit rate, one-time publication cost, and the extraction call's own cached/uncached input.
- Loopback diagnostics: `GET /compaction-continuum/ping` and `GET /compaction-continuum/selftest` (with `?test=extract` for an end-to-end synthetic extraction-contract test).
- Bilingual documentation, design notes, CI, and community files.

### Fixed

- `/context_status` crashed with `Cannot read properties of null (reading 'outcome')` when no compaction audit existed yet (`lastAudit` starts as `null`).
- Status reporting resolves the policy of the engine that actually compacts, instead of the unused Host-plane row.
- Diagnostic probes no longer touch opaque Cordis services or assume a session surface shape.

### Notes

- Verified against DeepSeek Harness `0.2.1-rc.5` (packaged desktop app).
- Warm-prefix extraction requires the provider cache to still be warm; a manual `/compact` after a long idle period pays a full re-read, as any compaction backend does.

## [0.2.1] - 2026-11-04

### Fixed

- Preset-plane participation (internal revision): the compressor had no effect while the preset-isolated backend compacted sessions.

## [0.2.0] - 2026-11-03

### Added

- Initial structural compressor: extraction pipeline, stiffness/KKT/condensation core, certificates, deterministic render, offline tests.

[Unreleased]: https://github.com/2718labs/dsh-compaction-continuum/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/2718labs/dsh-compaction-continuum/releases/tag/v0.3.0
[0.2.1]: https://github.com/2718labs/dsh-compaction-continuum/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/2718labs/dsh-compaction-continuum/releases/tag/v0.2.0
