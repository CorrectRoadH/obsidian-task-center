// Unit tests for pure tag display helpers. No Obsidian dependency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compilePure() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/tags.ts",
      "--bundle=false",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("esbuild compile failed:\n" + result.stderr);
  }
}

compilePure();
const { extractMarkdownTags, stripMarkdownTags, taskDisplayTags } = await import("../test/.compiled/tags.js");

test("US-151: taskDisplayTags preserves markdown tag text and order", () => {
  assert.deepEqual(taskDisplayTags(["#alpha", "#1象限", "#sample"]), ["#alpha", "#1象限", "#sample"]);
});

test("US-151: taskDisplayTags deduplicates repeated tags", () => {
  assert.deepEqual(taskDisplayTags(["#alpha", "#alpha", "gamma", ""]), ["#alpha", "#gamma"]);
});

test("US-108/109d: extractMarkdownTags ignores block refs and wikilink anchors", () => {
  assert.deepEqual(
    extractMarkdownTags("task [[Note#Heading]] [[Note#^abc123]] #alpha #^624c3648-bca7-4ee2"),
    ["#alpha"],
  );
});

test("US-109d: extractMarkdownTags stops at CJK punctuation and prose separators", () => {
  assert.deepEqual(
    extractMarkdownTags("task #第一象限、#第二象限 等。并通过`advance` #更好用的git工具箱"),
    ["#第一象限", "#第二象限", "#更好用的git工具箱"],
  );
});

test("US-109d: stripMarkdownTags removes tag separator punctuation from rendered text", () => {
  assert.equal(
    stripMarkdownTags("task #第一象限、#第二象限 等。并通过`advance` #更好用的git工具箱"),
    "task  等。并通过`advance` ",
  );
});
