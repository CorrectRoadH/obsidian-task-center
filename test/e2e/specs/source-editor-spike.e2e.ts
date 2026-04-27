/**
 * US-168 Phase 1 spike:
 *
 * Prove the supported Obsidian-native Markdown editor path is a real
 * WorkspaceLeaf/MarkdownView. This does not assert Modal embedding; the
 * companion Node test (`test/source-dialog-api.test.mjs`) locks that API
 * boundary from official typings.
 */
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

const VAULT = "test/e2e/vaults/simple";

async function writeAndWait(path: string, body: string) {
  await browser.executeObsidian(
    async ({ app }, p: string, content: string) => {
      let f = app.vault.getAbstractFileByPath(p);
      if (!f) {
        const folder = p.split("/").slice(0, -1).join("/");
        if (folder) await app.vault.createFolder(folder).catch(() => undefined);
        f = await app.vault.create(p, content);
      } else {
        // @ts-expect-error — runtime TFile
        await app.vault.modify(f, content);
      }
      await new Promise<void>((resolve) => {
        // @ts-expect-error — runtime TFile
        const ref = app.metadataCache.on("changed", (file) => {
          if (file.path === p) {
            app.metadataCache.offref(ref);
            resolve();
          }
        });
        setTimeout(() => {
          app.metadataCache.offref(ref);
          resolve();
        }, 2000);
      });
    },
    path,
    body,
  );
}

describe("US-168 source editor architecture spike", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  it("real MarkdownView leaf can cursor, scroll, edit, and save source markdown", async function () {
    const path = "Tasks/Source Spike.md";
    await writeAndWait(
      path,
      [
        "# Source spike",
        "",
        "- [ ] Parent",
        "    - [ ] Target task",
        "        - [ ] Existing child",
        "",
      ].join("\n"),
    );

    const result = (await browser.executeObsidian(async ({ app }, p: string) => {
      const file = app.vault.getAbstractFileByPath(p);
      if (!file) throw new Error("file not found");

      const leaf = app.workspace.getLeaf("tab");
      // @ts-expect-error — runtime TFile
      await leaf.openFile(file);
      if (typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();

      const view = leaf.view as unknown as {
        getViewType?: () => string;
        editor?: {
          setCursor: (pos: { line: number; ch: number }) => void;
          getCursor: () => { line: number; ch: number };
          scrollIntoView: (
            range: {
              from: { line: number; ch: number };
              to: { line: number; ch: number };
            },
            center?: boolean,
          ) => void;
          replaceRange: (
            replacement: string,
            from: { line: number; ch: number },
            to?: { line: number; ch: number },
          ) => void;
        };
        save?: () => Promise<void>;
      };
      const editor = view.editor;
      if (!editor) throw new Error("MarkdownView editor missing");

      const targetLine = 3;
      editor.setCursor({ line: targetLine, ch: 0 });
      editor.scrollIntoView(
        { from: { line: targetLine, ch: 0 }, to: { line: targetLine, ch: 0 } },
        true,
      );
      editor.replaceRange(" edited", { line: targetLine, ch: "    - [ ] Target task".length });
      await view.save?.();

      // @ts-expect-error — runtime TFile
      const text = await app.vault.read(file);
      return {
        viewType: view.getViewType?.(),
        cursor: editor.getCursor(),
        text,
      };
    }, path)) as unknown as { viewType: string; cursor: { line: number; ch: number }; text: string };

    expect(result.viewType).toBe("markdown");
    expect(result.cursor.line).toBe(3);
    expect(result.text).toContain("    - [ ] Target task edited");
  });
});
