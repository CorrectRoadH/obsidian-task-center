# CI Test Matrix

Date: 2026-04-28

This document records the current test split. As of 2026-04-28, PR/main CI and
the release pre-flight gate both run the full unit + e2e command chain, so a PR
cannot merge while relying on a release-only e2e surprise.

## Current Matrix

| Surface | Trigger | Checks | E2E coverage | Purpose |
| --- | --- | --- | --- | --- |
| Local quick check | Maintainer decides | Avoid local e2e while the user is active; run only explicit lightweight checks if requested | None by default | Protect the user's running Obsidian app. |
| `CI` | Pull request and `main` push | `pnpm install --frozen-lockfile`, typecheck, lint, unit, full e2e | Full `pnpm run test:e2e` with `OBSIDIAN_VERSIONS=latest/latest` | Merge confidence for normal code changes; same behavioral gate as release preflight. |
| `Release` | Strict semver tag, no `v` prefix | typecheck, lint, unit, full e2e, build, GitHub Release asset upload | Full `pnpm run test:e2e` with `OBSIDIAN_VERSIONS=latest/latest` | Hard release gate. A red e2e blocks publishing assets. |
| `CI Xvfb POC` | Manual dispatch or changes to `.github/workflows/ci-xvfb-poc.yml` only | install Xvfb/Electron deps, install deps, build | One non-timing-sensitive spec: `board-basics.e2e.ts` | Proves hosted Linux + Xvfb can boot and drive Obsidian without becoming a PR/release gate. |

## Existing Decisions

- Task #48 changed the WDIO default to `WDIO_MAX_INSTANCES=1`. This is the
  baseline for avoiding shared-vault interference in e2e.
- Task #52 proved `ubuntu-latest` + Xvfb can boot Obsidian and drive a minimal
  WDIO spec. That POC remains intentionally narrow.
- While the user is actively using Obsidian, agents should not run local WDIO.
  Use GitHub Actions for e2e evidence.
- PR/main CI and Release preflight intentionally run the same behavioral gate:
  typecheck, lint, unit, then full e2e.
- Release tags are strict semver without a `v` prefix. Tag pushes repeat the
  full pre-flight gate before publishing assets.

## Recommended Expansion Plan

1. Keep `CI` and `Release` preflight aligned; if one gate adds or removes a
   required check, mirror it in the other workflow in the same PR.
2. Keep `CI Xvfb POC` narrow unless a follow-up task explicitly promotes it to
   a required signal.
3. Add an Actions summary artifact for e2e failures: failed spec name,
   screenshot path, Obsidian version, and retry instructions.
4. Add a date-fixture helper audit for specs that depend on "today" or week
   navigation, so tag releases do not fail because stale dates crossed a week.

## Follow-Up Task Splits

- Add an Actions summary artifact for e2e failures: failed spec name,
  screenshot path, Obsidian version, and retry instructions.
- Add a date-fixture helper audit for specs that depend on "today" or week
  navigation, so tag releases do not fail because stale dates crossed a week.
