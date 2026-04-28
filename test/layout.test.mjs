import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/view/layout.ts",
      "--bundle=false",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled/view",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild compile failed:\n" + result.stderr);
  }
}

compilePure();
const { weekMinHeightFromViewHeightPx } = await import("../test/.compiled/view/layout.js");

test("US-101/US-503: week min height is half of the Task Center visible height", () => {
  assert.equal(weekMinHeightFromViewHeightPx(720), 360);
  assert.equal(weekMinHeightFromViewHeightPx(721), 361);
  assert.equal(weekMinHeightFromViewHeightPx(0), 0);
});
