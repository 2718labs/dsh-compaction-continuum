# Pull requests

## What must be true before review

- [ ] `npm test` passes (offline; no Harness install required).
- [ ] `npm run check` passes.
- [ ] Behavior changes are reflected in `README.md` **and** `README.zh-CN.md` (the two stay in sync), and in `CHANGELOG.md` under `Unreleased`.
- [ ] Cache invariants hold: one publication per epoch, no mid-history rewrite, no per-turn summarization, and the extraction call still replays the conversation prefix instead of introducing its own system prompt. If a change touches compaction frequency or retention, include the measured numbers in the PR body.
- [ ] No conversation content, prompts, session logs, or credentials in code, tests, fixtures, screenshots, or logs.
- [ ] Failure paths stay fail-open: structural failure → deterministic render → shipped summarizer. A bug must never leave a session without a checkpoint.
- [ ] New public seams are documented in `docs/DESIGN.md` and `docs/DESIGN.zh-CN.md`.

## Commits and scope

Conventional Commits prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) with the touched area in the subject when useful (for example `fix(pipeline): reject quotes that only normalize to a match`). Keep a PR to one concern; refactors and behavior changes are separate PRs.

## Testing against a live Harness

The plugin is validated against the packaged desktop app. For manual checks:

1. Install the working copy as a local bundle (`link:` dependency in the profile).
2. Apply it, then read back the diagnostics:
   - `GET /compaction-continuum/ping`
   - `GET /compaction-continuum/selftest` (free, content-free)
   - `GET /compaction-continuum/selftest?test=extract` (one small synthetic model call)
3. Run `/context_status` and `/context_inspect` in a session, and for real compression behavior `/compact`.

Document the DSH version you tested against in the PR body. The hook targets the shipped `BasicCompactionEngine` seam; the plugin degrades to the shipped summarizer when that seam is unavailable or behaves differently.
