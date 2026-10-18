// US-109d4: unit tests for the tag boolean expression parser / evaluator and the
// legacy-shape → expression migration helper (src/query/tag-expr.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function compile() {
  const result = spawnSync(
    "npx",
    [
      "esbuild",
      "src/query/tag-expr.ts",
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--outdir=test/.compiled",
      "--loader:.ts=ts",
    ],
    { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("esbuild compile failed:\n" + result.stderr);
}

let compileErr = null;
try {
  compile();
} catch (e) {
  compileErr = e;
}

async function load() {
  return import("../test/.compiled/tag-expr.js");
}

test("US-109d4: single tag — parse + eval", async () => {
  if (compileErr) throw compileErr;
  const { parseTagExpr, evalTagExpr } = await load();
  const { ast, error } = parseTagExpr("#a");
  assert.equal(error, null);
  assert.equal(evalTagExpr(ast, ["#a"]), true);
  assert.equal(evalTagExpr(ast, ["#b"]), false);
});

test("US-109d4: and / or / not semantics", async () => {
  if (compileErr) throw compileErr;
  const { parseTagExpr, evalTagExpr } = await load();
  const ev = (expr, tags) => evalTagExpr(parseTagExpr(expr).ast, tags);
  assert.equal(ev("#a and #b", ["#a", "#b"]), true);
  assert.equal(ev("#a and #b", ["#a"]), false);
  assert.equal(ev("#a or #b", ["#b"]), true);
  assert.equal(ev("#a or #b", ["#c"]), false);
  assert.equal(ev("not #a", ["#b"]), true);
  assert.equal(ev("not #a", ["#a"]), false);
});

test("US-109d4: precedence is not > and > or", async () => {
  if (compileErr) throw compileErr;
  const { parseTagExpr, evalTagExpr } = await load();
  const ev = (expr, tags) => evalTagExpr(parseTagExpr(expr).ast, tags);
  // #a or #b and #c  ==  #a or (#b and #c)
  assert.equal(ev("#a or #b and #c", ["#a"]), true);
  assert.equal(ev("#a or #b and #c", ["#b"]), false);
  assert.equal(ev("#a or #b and #c", ["#b", "#c"]), true);
  // not binds tightest: not #a and #b == (not #a) and #b
  assert.equal(ev("not #a and #b", ["#b"]), true);
  assert.equal(ev("not #a and #b", ["#a", "#b"]), false);
});

test("US-109d4: parentheses override precedence", async () => {
  if (compileErr) throw compileErr;
  const { parseTagExpr, evalTagExpr } = await load();
  const ev = (expr, tags) => evalTagExpr(parseTagExpr(expr).ast, tags);
  assert.equal(ev("(#a or #b) and #c", ["#a", "#c"]), true);
  assert.equal(ev("(#a or #b) and #c", ["#a"]), false);
  assert.equal(ev("(#a or #b) and not #c", ["#b", "#c"]), false);
});

test("US-109d4: # is optional and keywords are case-insensitive", async () => {
  if (compileErr) throw compileErr;
  const { parseTagExpr, evalTagExpr } = await load();
  const ev = (expr, tags) => evalTagExpr(parseTagExpr(expr).ast, tags);
  assert.equal(ev("a AND b", ["#a", "#b"]), true); // # optional, AND keyword
  assert.equal(ev("a OR NOT b", ["#a"]), true);
  assert.equal(ev("#And", ["#and"]), true); // a hashed `#And` is a tag, not the keyword
});

test("US-109d4: syntax errors are reported (and fail-open upstream)", async () => {
  if (compileErr) throw compileErr;
  const { parseTagExpr } = await load();
  assert.notEqual(parseTagExpr("(#a or #b").error, null); // missing close paren
  assert.notEqual(parseTagExpr("").error, null); // empty
  assert.notEqual(parseTagExpr("#a #b").error, null); // two atoms, no operator
  assert.notEqual(parseTagExpr("#a and").error, null); // trailing operator
});

test("US-109d4: tagSelectionToExpr migrates legacy shapes (normalize + dedup + parens)", async () => {
  if (compileErr) throw compileErr;
  const { tagSelectionToExpr } = await load();
  assert.equal(tagSelectionToExpr(["#a", "#b"], "and", []), "#a and #b");
  assert.equal(tagSelectionToExpr(["#a", "#b"], "or", []), "#a or #b");
  assert.equal(tagSelectionToExpr(["#a", "#b"], "or", ["#c"]), "(#a or #b) and not #c");
  assert.equal(tagSelectionToExpr(["#a"], "and", ["#c"]), "#a and not #c");
  assert.equal(tagSelectionToExpr([], "and", ["#c"]), "not #c");
  assert.equal(tagSelectionToExpr(["Work"], "and", []), "#work"); // #-prefix + lowercase
  assert.equal(tagSelectionToExpr(["#a", "#a"], "and", []), "#a"); // dedup
  assert.equal(tagSelectionToExpr(["#a"], "and", ["#a", "#b"]), "#a and not #b"); // include wins
});

test("US-109d4: appendTagToExpr inserts a tag into the expression", async () => {
  if (compileErr) throw compileErr;
  const { appendTagToExpr } = await load();
  assert.equal(appendTagToExpr("", "#a"), "#a");
  assert.equal(appendTagToExpr("#a", "#b"), "#a and #b");
  assert.equal(appendTagToExpr("#a or #b", "c"), "(#a or #b) and #c"); // normalizes the appended tag
});

test('US-109d4: tag insertion completes trailing operators and preserves OR grouping', async () => {
  const { appendTagToExpr, parseTagExpr, evalTagExpr } = await load();
  for (const expr of ['#a and', '#a or', '#a and not', 'not']) {
    assert.equal(appendTagToExpr(expr, '#c'), `${expr} #c`);
  }
  const expr = appendTagToExpr('#a or #b', '#c');
  assert.equal(expr, '(#a or #b) and #c');
  assert.equal(evalTagExpr(parseTagExpr(expr).ast, ['#a']), false);
});
test('US-109d4: parser errors report one-based character positions including whitespace', async () => {
  const { parseTagExpr } = await load();
  assert.equal(parseTagExpr('  #long #b').position, 9);
  assert.equal(parseTagExpr('#a and').position, 7);
  assert.equal(parseTagExpr('(#a').position, 4);
});
