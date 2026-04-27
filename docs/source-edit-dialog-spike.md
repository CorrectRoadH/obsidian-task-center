# US-168 Source Edit Dialog Spike

Date: 2026-04-27

## Question

Can Task Center safely embed Obsidian's native Markdown editor inside a plugin `Modal` / source dialog?

## Evidence

Runnable checks:

- `node --test test/source-dialog-api.test.mjs`
  - Verifies the official `obsidian.d.ts` API boundary:
    - `MarkdownView` is constructed with `constructor(leaf: WorkspaceLeaf)`.
    - `WorkspaceLeaf.openFile(file, openState)` is the public native editor entry.
    - `Modal` exposes `containerEl` / `modalEl` / `contentEl`, but no public `WorkspaceLeaf`, `openFile`, `setViewState`, or MarkdownView mounting API.
    - `MarkdownEditView` also requires an existing `MarkdownView`; it is not an independent editor component for arbitrary DOM.
- `WDIO_MAX_INSTANCES=1 pnpm exec wdio run ./wdio.conf.mts --spec test/e2e/specs/source-editor-spike.e2e.ts`
  - Proves the supported native path works: open a real `MarkdownView` in a `WorkspaceLeaf`, then `editor.setCursor()`, `editor.scrollIntoView(..., true)`, `editor.replaceRange()`, and `view.save()` write back to the vault.

## Decision

There is no safe public API to mount Obsidian's native `MarkdownView` directly inside a plugin `Modal`.

Do not implement US-168 by:

- constructing `MarkdownView` with a fake leaf,
- moving a live workspace leaf's DOM into a modal,
- using `MarkdownRenderer` as a read-only substitute.

The only verified Obsidian-native editor path is a real `WorkspaceLeaf` running a `MarkdownView`.

## Implementation Direction For US-168

Use a "source edit dialog" shell that drives a real Obsidian Markdown leaf, not a read-only renderer:

- Open the task file in a dedicated/ephemeral `WorkspaceLeaf`.
- Use `MarkdownView.editor.setCursor({ line, ch: 0 })` and `editor.scrollIntoView(range, true)`.
- Let Obsidian's editor handle markdown editing and save semantics.
- Close/remove the temporary leaf when the source dialog closes, then refresh Task Center from vault/cache events.

If product insists on visual modal chrome, treat the modal as a controller/shell around the real leaf workflow. Do not attempt DOM transplanting of `MarkdownView` into `Modal.contentEl`; that path is unsupported and likely to break workspace focus, scope, and lifecycle.

## Consequence

Phase 3 implementation should be honest about the fallback: it can provide a dialog-like task source editing journey backed by a real Obsidian editor leaf, but it cannot safely be a pure `Modal` containing a native `MarkdownView` with current public APIs.
