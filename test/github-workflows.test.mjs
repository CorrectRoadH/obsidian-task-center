import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("US-602: pre-push runs the remote gate without local dependencies and propagates failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-center-pre-push-"));
  try {
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "hook"), await readFile(".githooks/pre-push"));
    await writeFile(join(dir, "bin", "pnpm"), '#!/bin/sh\n[ "$*" = "run test:remote" ] || exit 91\nexit "$GATE_STATUS"\n', { mode: 0o755 });
    for (const status of [0, 23]) {
      const result = spawnSync("/bin/sh", [join(dir, "hook")], {
        cwd: dir,
        env: { PATH: join(dir, "bin"), GATE_STATUS: String(status) },
        encoding: "utf8",
      });
      assert.equal(result.status, status, result.stderr + result.stdout);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("US-602: remote gate fails closed on missing config, empty command, and prepare failure", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const dir = await mkdtemp(join(tmpdir(), "task-center-remote-gate-"));
  const run = () => spawnSync("/bin/sh", ["-c", pkg.scripts["test:remote"]], { cwd: dir, encoding: "utf8" });
  try {
    assert.notEqual(run().status, 0, "missing configuration must block the gate");
    await mkdir(join(dir, ".crabbox"));
    for (const [config, expected] of [
      ["CRABBOX_TEST_GATE=''\n", 1],
      ["CRABBOX_TEST_PREPARE='false'\nCRABBOX_TEST_GATE='true'\n", 1],
      ["CRABBOX_TEST_PREPARE='exit 17'\nCRABBOX_TEST_GATE='true'\n", 17],
      ["CRABBOX_TEST_PREPARE=''\nCRABBOX_TEST_GATE='exit 23'\n", 23],
      ["CRABBOX_TEST_PREPARE=''\nCRABBOX_TEST_GATE='true'\n", 0],
    ]) {
      await writeFile(join(dir, ".crabbox", "remote-test.env"), config);
      const result = run();
      if (expected === 1) assert.notEqual(result.status, 0, "invalid configuration or failed prepare must block the gate");
      else assert.equal(result.status, expected, result.stderr);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function readWorkflow(name) {
  return readFile(`.github/workflows/${name}`, "utf8");
}

function assertLinuxObsidianE2eGate(workflow, filename) {
  assert.match(
    workflow,
    /Install Xvfb \+ Electron Linux deps/,
    `${filename} must install Xvfb and Electron runtime deps before Obsidian e2e`,
  );
  assert.match(
    workflow,
    /xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24"/,
    `${filename} must run WebDriverIO through xvfb-run on ubuntu`,
  );
  assert.match(
    workflow,
    /libgtk-3-0t64|libgtk-3-0/,
    `${filename} must provision GTK for the Linux Obsidian runtime`,
  );
  assert.match(
    workflow,
    /kernel\.apparmor_restrict_unprivileged_userns=0/,
    `${filename} must relax the Ubuntu 24.04 AppArmor userns restriction before Electron e2e`,
  );
}

test("ci workflow runs Obsidian e2e under Xvfb on ubuntu", async () => {
  const workflow = await readWorkflow("ci.yml");
  assertLinuxObsidianE2eGate(workflow, "ci.yml");
});

test("release workflow runs Obsidian e2e under Xvfb on ubuntu", async () => {
  const workflow = await readWorkflow("release.yml");
  assertLinuxObsidianE2eGate(workflow, "release.yml");
});

test("CI e2e gate runs the FULL spec suite, not a --spec whitelist", async () => {
  // Policy (2026-06-25): the gate runs every spec via the wdio.conf `specs`
  // glob. Flaky specs are FIXED, not quarantined out of the gate with a
  // hand-picked `--spec` subset — a whitelist silently hides regressions in the
  // excluded specs (the original "tests too few" gap). Keeping the gate ≡ full
  // suite forces the long tail to stay green.
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const script = pkg.scripts["test:e2e:ci"];
  assert.match(script, /wdio run \.\/wdio\.conf\.mts/);
  assert.doesNotMatch(
    script,
    /--spec/,
    "test:e2e:ci must run the full suite; do not narrow it with --spec — fix flaky specs instead",
  );
});

test("US-602 / US-111: the protective e2e specs still exist on disk", async () => {
  // The gate covers these via the glob; assert the specs that motivated US-602
  // (source-edit regressions) and US-111 (Dataview/flavor journeys) are present
  // so a rename/delete can't silently drop their coverage.
  for (const spec of [
    "board-basics",
    "source-edit-dialog",
    "dataview-format",
    "format-matrix",
  ]) {
    await access(`test/e2e/specs/${spec}.e2e.ts`);
  }
});

test("release workflow attests Obsidian release assets", async () => {
  const workflow = await readWorkflow("release.yml");

  assert.match(
    workflow,
    /id-token:\s*write/,
    "release.yml must allow OIDC token minting for Sigstore artifact attestations",
  );
  assert.match(
    workflow,
    /attestations:\s*write/,
    "release.yml must allow persisting GitHub artifact attestations",
  );
  assert.match(
    workflow,
    /uses:\s*actions\/attest@v4/,
    "release.yml must generate artifact attestations before publishing assets",
  );
  assert.match(workflow, /subject-path:\s*\|\s*[\s\S]*main\.js/);
  assert.match(workflow, /subject-path:\s*\|\s*[\s\S]*manifest\.json/);
  assert.match(workflow, /subject-path:\s*\|\s*[\s\S]*styles\.css/);
});

test("release notes diff from the previous strict semver tag only", async () => {
  const workflow = await readWorkflow("release.yml");

  assert.match(
    workflow,
    /git tag --list --sort=-v:refname \| grep -E '\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$' \| grep -v "\^\$\{TAG_VERSION\}\$" \| head -1/,
    "release notes must ignore non-release tags such as test-upload-delete-me when choosing the previous tag",
  );
});
