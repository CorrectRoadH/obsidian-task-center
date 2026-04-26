// Platform-mode resolver. Wraps Obsidian's `Platform.isMobile` with a
// tiny test escape hatch so the WDIO desktop Chromium runner (where
// `Platform.isMobile` is always false) can still exercise the gestures
// and bottom-sheet behaviors gated on it.
//
// Production behavior is unchanged: `__testForceMobile` defaults to
// `false`, so `isMobileMode()` returns exactly what `Platform.isMobile`
// would. Only the e2e suite calls `__setTestForceMobile(true)` (via
// the `plugin.__setTestForceMobile()` thin wrapper in main.ts) and
// each test resets to false in afterEach to avoid cross-spec bleed.
//
// task #44 (US-501–510) — see test/e2e/specs/mobile-coverage.e2e.ts.

import { Platform } from "obsidian";

let __testForceMobile = false;

export function isMobileMode(): boolean {
  return Platform.isMobile || __testForceMobile;
}

/**
 * Test-only hook. Do NOT call from product code paths. Lets e2e specs
 * exercise mobile-only behavior in the WDIO desktop Chromium runner
 * where Platform.isMobile is always false. Default value is false so
 * production behavior stays exactly as before this hook landed.
 */
export function __setTestForceMobile(v: boolean): void {
  __testForceMobile = v;
}
