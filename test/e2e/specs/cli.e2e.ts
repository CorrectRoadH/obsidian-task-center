/**
 * CLI API integration tests — exercises TaskCenterApi methods inside a real
 * Obsidian vault, verifying the contract documented in USER_STORIES.md §P2.
 *
 * US-201: list returns stable path:LN ids usable as grep/awk first column.
 * US-203: write operations are idempotent — done on an already-done task → unchanged.
 * US-204: every write returns before/after diff lines.
 * US-208: when a line number becomes stale after external edits, hash-based
 *         lookup falls back to resolve the task by title hash.
 * US-214: when two tasks hash-collide, resolving by hash returns ambiguous_slug
 *         with a candidate list — the API never silently guesses.
 *
 * No UI interaction. All assertions are against API return values and file content.
 * The only DOM coupling is the plugin registration path used by executeObsidian.
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
          if (file.path === p) { app.metadataCache.offref(ref); resolve(); }
        });
        setTimeout(() => { app.metadataCache.offref(ref); resolve(); }, 2000);
      });
    },
    path,
    body,
  );
}

async function forFlush() {
  await browser.executeObsidian(async ({ app }) => {
    // @ts-expect-error — runtime plugin
    await (app as any).plugins.plugins["task-center"].__forFlush();
  });
}

async function readFile(path: string): Promise<string> {
  return (await browser.executeObsidian(async ({ app }, p: string) => {
    const f = app.vault.getAbstractFileByPath(p);
    if (!f) return "";
    // @ts-expect-error — runtime TFile
    return await app.vault.read(f);
  }, path)) as unknown as string;
}

/**
 * Execute a function against the plugin's TaskCenterApi inside Obsidian.
 * The fn is serialised to string — it must be self-contained (no closures).
 */
async function callApi<T>(
  fn: (api: {
    list(filters: {
      status?: string;
      scheduled?: string;
      parent?: string;
      search?: string;
    }): Promise<{ id: string; title: string; status: string; hash: string }[]>;
    show(id: string): Promise<{ id: string; hash: string; title: string }>;
    done(id: string): Promise<{ before: string; after: string; unchanged: boolean }>;
    drop(id: string): Promise<{ before: string; after: string; unchanged: boolean }>;
    rename(id: string, title: string): Promise<{ before: string; after: string; unchanged: boolean }>;
    schedule(id: string, date: string | null): Promise<{ before: string; after: string; unchanged: boolean }>;
    nest(childId: string, parentId: string): Promise<{ before: string; after: string; unchanged: boolean }>;
    add(opts: {
      text: string;
      to?: string;
      scheduled?: string;
      stampCreated?: boolean;
    }): Promise<{ path: string; line: number; created: string }>;
  }) => Promise<T>,
): Promise<T> {
  return (await browser.executeObsidian(async ({ app }, fnSrc: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins?.getPlugin?.("task-center");
    if (!plugin?.api) throw new Error("plugin api not found");
    // eslint-disable-next-line no-new-func
    const callable = new Function("api", `return (${fnSrc})(api)`);
    return await callable(plugin.api);
  }, fn.toString())) as T;
}

describe("Task Center — CLI API (US-201/203/204/208/214)", function () {
  beforeEach(async function () {
    await obsidianPage.resetVault(VAULT);
  });

  // US-201: every list entry carries a stable path:LN id as the primary key
  it("US-201: list entries have stable path:LN id format", async function () {
    const today = new Date().toISOString().slice(0, 10);
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] First task ⏳ ${today}\n- [ ] Second task ⏳ ${today}\n`,
    );

    await forFlush();

    const tasks = await callApi((api) => api.list({ status: "todo" }));

    const inboxTasks = (tasks as { id: string; title: string; status: string; hash: string }[]).filter(
      (t) => t.id.startsWith("Tasks/Inbox.md:"),
    );
    await expect(inboxTasks.length).toBeGreaterThanOrEqual(2);

    // Each id must match the path:LN format — stable and grep-able.
    for (const t of inboxTasks) {
      await expect(t.id).toMatch(/^Tasks\/Inbox\.md:L\d+$/);
    }

    // Ids are distinct.
    const ids = inboxTasks.map((t) => t.id);
    await expect(new Set(ids).size).toBe(ids.length);
  });

  // US-203: done is idempotent — calling it twice on the same task is not an error
  it("US-203: marking done twice returns unchanged=true on second call", async function () {
    const today = new Date().toISOString().slice(0, 10);
    await writeAndWait("Tasks/Inbox.md", `- [ ] Idempotent task ⏳ ${today}\n`);
    await forFlush();

    // First call: marks done, before ≠ after.
    const first = await callApi((api) => api.done("Tasks/Inbox.md:L1")) as {
      before: string; after: string; unchanged: boolean
    };
    await expect(first.unchanged).toBe(false);
    await expect(first.before).toContain("[ ]");
    await expect(first.after).toContain("[x]");

    // Reload so the API picks up the written state.
    await forFlush();

    // Second call: already done, must not throw and must report unchanged.
    const second = await callApi((api) => api.done("Tasks/Inbox.md:L1")) as {
      before: string; after: string; unchanged: boolean
    };
    await expect(second.unchanged).toBe(true);
  });

  // US-204: every mutating API call returns before and after lines of the diff
  it("US-204: write operations return before/after diff for schedule, rename, done", async function () {
    const today = new Date().toISOString().slice(0, 10);
    await writeAndWait("Tasks/Inbox.md", `- [ ] Diff task ⏳ ${today}\n`);
    await forFlush();

    const scheduled = await callApi((api) => api.schedule("Tasks/Inbox.md:L1", "2099-12-31")) as {
      before: string; after: string; unchanged: boolean
    };
    await expect(scheduled.before).toContain(`⏳ ${today}`);
    await expect(scheduled.after).toContain("⏳ 2099-12-31");
    await expect(scheduled.unchanged).toBe(false);

    await forFlush();

    const renamed = await callApi((api) => api.rename("Tasks/Inbox.md:L1", "Renamed diff task")) as {
      before: string; after: string; unchanged: boolean
    };
    await expect(renamed.before).toContain("Diff task");
    await expect(renamed.after).toContain("Renamed diff task");

    await forFlush();

    const doneResult = await callApi((api) => api.done("Tasks/Inbox.md:L1")) as {
      before: string; after: string; unchanged: boolean
    };
    await expect(doneResult.before).toContain("[ ]");
    await expect(doneResult.after).toContain("[x]");
    await expect(doneResult.after).toContain("✅");
  });

  // US-208: after a file is edited externally (shifting lines), a hash-based ref resolves correctly
  it("US-208: hash-based id resolves the task even when its line number has shifted", async function () {
    const today = new Date().toISOString().slice(0, 10);
    await writeAndWait("Tasks/Inbox.md", `- [ ] Hash-fallback task ⏳ ${today}\n`);
    await forFlush();

    // Capture the task's hash before modifying the file.
    const taskInfo = await callApi((api) => api.show("Tasks/Inbox.md:L1")) as {
      id: string; hash: string; title: string
    };
    const hash = taskInfo.hash;
    await expect(hash).toMatch(/^[a-f0-9]{12}$/);

    // Prepend a line to shift the task from L1 to L2.
    const original = await readFile("Tasks/Inbox.md");
    await writeAndWait("Tasks/Inbox.md", `- [ ] Prepended line ⏳ ${today}\n` + original);
    await forFlush();

    // L1 now points to the prepended task, not the original one.
    const l1Info = await callApi((api) => api.show("Tasks/Inbox.md:L1")) as { title: string };
    await expect(l1Info.title).toBe("Prepended line");

    // Resolving by hash must still find the original task at its new location.
    // callApi can't capture outer variables (function is serialised), so call executeObsidian directly.
    const byHashActual = (await browser.executeObsidian(
      async ({ app }, h: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plugin = (app as any).plugins?.getPlugin?.("task-center");
        return await plugin?.api?.show(`hash:${h}`);
      },
      hash,
    )) as { id: string; title: string };

    await expect(byHashActual.title).toBe("Hash-fallback task");
    await expect(byHashActual.id).toBe("Tasks/Inbox.md:L2");
  });

  // US-214: hash collision → ambiguous_slug error with candidate list, never a silent guess
  it("US-214: duplicate-title tasks cause ambiguous_slug error, not a silent guess", async function () {
    const today = new Date().toISOString().slice(0, 10);
    // Two tasks with identical cleaned titles → identical hashes.
    await writeAndWait(
      "Tasks/Inbox.md",
      `- [ ] Collision task ⏳ ${today}\n- [ ] Collision task ⏳ ${today}\n`,
    );
    await forFlush();

    // Grab the hash (both tasks will have the same one).
    const taskInfo = await callApi((api) => api.show("Tasks/Inbox.md:L1")) as { hash: string };
    const hash = taskInfo.hash;

    // Resolving by that hash must throw ambiguous_slug, not return a random task.
    const result = await (async () => {
      return (await browser.executeObsidian(
        async ({ app }, h: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const plugin = (app as any).plugins?.getPlugin?.("task-center");
          try {
            await plugin?.api?.show(`hash:${h}`);
            return { threw: false };
          } catch (e: unknown) {
            return {
              threw: true,
              code: (e as { code?: string }).code,
              message: (e as Error).message,
            };
          }
        },
        hash,
      )) as { threw: boolean; code?: string; message?: string };
    })();

    await expect(result.threw).toBe(true);
    await expect(result.code).toBe("ambiguous_slug");
    // The error message must mention both candidate task IDs.
    await expect(result.message).toContain("Tasks/Inbox.md:L1");
    await expect(result.message).toContain("Tasks/Inbox.md:L2");
  });
});
