import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const dts = readFileSync("node_modules/obsidian/obsidian.d.ts", "utf8");

function classBody(name) {
  const start = dts.indexOf(`export class ${name} `);
  assert.notEqual(start, -1, `${name} must exist in obsidian.d.ts`);
  const next = dts.indexOf("\nexport ", start + 1);
  return dts.slice(start, next === -1 ? dts.length : next);
}

test("US-168 spike: MarkdownView is a WorkspaceLeaf-backed view, not a Modal child API", () => {
  const markdownView = classBody("MarkdownView");
  const workspaceLeaf = classBody("WorkspaceLeaf");
  const modal = classBody("Modal");

  assert.match(
    markdownView,
    /constructor\(leaf: WorkspaceLeaf\);/,
    "Obsidian's native Markdown editor is constructed from a WorkspaceLeaf",
  );
  assert.match(
    workspaceLeaf,
    /openFile\(file: TFile, openState\?: OpenViewState\): Promise<void>;/,
    "public file-opening API lives on WorkspaceLeaf",
  );
  assert.doesNotMatch(
    modal,
    /openFile|WorkspaceLeaf|setViewState|MarkdownView/,
    "Modal exposes contentEl/modalEl but no public leaf or MarkdownView mounting API",
  );
});

test("US-168 spike: MarkdownEditView also requires an existing MarkdownView", () => {
  const editView = classBody("MarkdownEditView");
  assert.match(
    editView,
    /constructor\(view: MarkdownView\);/,
    "MarkdownEditView cannot be constructed independently for an arbitrary Modal contentEl",
  );
});
