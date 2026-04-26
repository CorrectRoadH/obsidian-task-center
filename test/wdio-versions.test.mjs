// Unit test for wdio.conf.mts default version selection — task #45.
//
// Run with: `node --test test/wdio-versions.test.mjs`

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

before(() => {
  const r = spawnSync(
    "npx",
    [
      "esbuild",
      "wdio-versions.mts",
      "--bundle=false",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.mts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error("esbuild failed:\n" + r.stderr);
});

// task #45: clean local install has no `OBSIDIAN_USE_BETA` env, so even
// when a beta is cached from a prior run the default matrix must NOT
// include `latest-beta/latest`. Otherwise wdio-obsidian-service tries to
// refresh the beta image and prompts for Insiders credentials which most
// contributors don't have, blocking `pnpm test:e2e` outright.
test("task #45 — default version matrix excludes beta when OBSIDIAN_USE_BETA is unset (even if beta is cached)", async () => {
  const { pickWdioVersions } = await import(
    `../test/.compiled/wdio-versions.js?cachebust=${Date.now()}`
  );
  const v = pickWdioVersions({}, /* betaCached */ true);
  assert.equal(v, "earliest/earliest latest/latest");
  assert.doesNotMatch(v, /beta/);
});

// task #45 inverse: explicit opt-in keeps the beta workflow available
// for maintainers who have the Insiders login and want broad coverage.
test("task #45 — OBSIDIAN_USE_BETA=1 + cached beta opts back into the beta matrix", async () => {
  const { pickWdioVersions } = await import(
    `../test/.compiled/wdio-versions.js?cachebust=${Date.now()}_optin`
  );
  const v = pickWdioVersions({ OBSIDIAN_USE_BETA: "1" }, /* betaCached */ true);
  assert.equal(v, "earliest/earliest latest/latest latest-beta/latest");
});

// Opt-in without the cached beta image also stays beta-free — running
// the matrix would still hit the login path because the image must be
// downloaded fresh.
test("task #45 — OBSIDIAN_USE_BETA=1 but beta not cached → still no beta (avoid login download)", async () => {
  const { pickWdioVersions } = await import(
    `../test/.compiled/wdio-versions.js?cachebust=${Date.now()}_optin_nocache`
  );
  const v = pickWdioVersions({ OBSIDIAN_USE_BETA: "1" }, /* betaCached */ false);
  assert.equal(v, "earliest/earliest latest/latest");
});

// Manual `OBSIDIAN_VERSIONS=...` override always wins (CI uses this to
// pin a specific Obsidian version).
test("task #45 — explicit OBSIDIAN_VERSIONS env overrides everything", async () => {
  const { pickWdioVersions } = await import(
    `../test/.compiled/wdio-versions.js?cachebust=${Date.now()}_override`
  );
  const v = pickWdioVersions(
    { OBSIDIAN_VERSIONS: "1.5.0/1.5.0", OBSIDIAN_USE_BETA: "1" },
    /* betaCached */ true,
  );
  assert.equal(v, "1.5.0/1.5.0");
});
