# CI Test Matrix

Date: 2026-04-27

This document records the current test split and the recommended next steps for
turning the Xvfb proof-of-concept into a stable CI signal. It is intentionally
report-only: this task does not change release gates.

## Current Matrix

| Surface | Trigger | Checks | E2E coverage | Purpose |
| --- | --- | --- | --- | --- |
| Local quick check | Maintainer decides | `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` | None | Fast code/doc confidence without touching the user's running Obsidian app. |
| `CI` | Pull request and `main` push | `npm ci`, lint, typecheck, build, unit tests | None | Merge confidence for normal code changes. |
| `Release` | Strict semver tag, no `v` prefix | typecheck, lint, unit, full e2e, build, GitHub Release asset upload | Full `npm run test:e2e` with `OBSIDIAN_VERSIONS=latest/latest` | Hard release gate. A red e2e blocks publishing assets. |
| `CI Xvfb POC` | Manual dispatch or changes to `.github/workflows/ci-xvfb-poc.yml` only | install Xvfb/Electron deps, install deps, build | One non-timing-sensitive spec: `board-basics.e2e.ts` | Proves hosted Linux + Xvfb can boot and drive Obsidian without becoming a PR/release gate. |

## Existing Decisions

- Task #48 changed the WDIO default to `WDIO_MAX_INSTANCES=1`. This is the
  baseline for avoiding shared-vault interference in e2e.
- Task #52 proved `ubuntu-latest` + Xvfb can boot Obsidian and drive a minimal
  WDIO spec. That POC remains intentionally narrow.
- While the user is actively using Obsidian, agents should not run local WDIO.
  Use GitHub Actions for e2e evidence; keep local checks to typecheck, lint,
  unit tests, and build.
- Release tags are strict semver without a `v` prefix. Tag pushes run the full
  release pre-flight gate before publishing assets.

## Recommended Expansion Plan

1. Keep `CI` fast: no e2e on ordinary PR/main by default yet.
2. Add a report-only Xvfb smoke workflow as a follow-up task, not as part of
   this document task. Scope it to one or two stable specs and keep
   `WDIO_MAX_INSTANCES=1`.
3. Require several consecutive green report-only runs before making any Xvfb
   smoke test a required PR gate.
4. If the PR-time smoke gate proves stable, consider migrating a small subset
   into main CI. Full e2e should remain a release gate unless flake rate and
   runtime are proven acceptable.
5. Do not expand Xvfb scope to mobile, drag, or subtask specs without a specific
   task and failure budget. Those specs have historically been more sensitive
   to timing, viewport, cache, and date state.

## Follow-Up Task Splits

- Add `ci-e2e-smoke.yml` as a report-only workflow:
  `board-basics.e2e.ts` plus one source-edit smoke spec, Xvfb, latest/latest,
  maxInstances=1.
- Add an Actions summary artifact for e2e failures: failed spec name,
  screenshot path, Obsidian version, and retry instructions.
- Add a date-fixture helper audit for specs that depend on "today" or week
  navigation, so tag releases do not fail because stale dates crossed a week.
- Revisit PR gating after five consecutive green smoke runs on main.

