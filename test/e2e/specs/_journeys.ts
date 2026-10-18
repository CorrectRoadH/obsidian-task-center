/**
 * Shared e2e journey + flavor helpers.
 *
 * Why this module exists
 * ----------------------
 * Until now every spec copy-pasted `todayISO` / `writeAndWait` / `forFlush` /
 * `simulateDrag` / `openBoardWeekView`, and only `dataview-format.e2e.ts`
 * exercised the Dataview flavor — and only on its *diagonal* (setting=dataview,
 * content=dataview). That left the format story half-tested:
 *
 *   - `taskFormatFlavor` is a WRITE-only setting. `src/writer.ts` branches on it
 *     to decide whether a mutated field is emitted as an emoji (`⏳ <date>`) or a
 *     Dataview inline field (`[scheduled:: <date>]`).
 *   - READING is flavor-agnostic: `src/parser.ts` reads `⏳` first and falls back
 *     to `[scheduled::]`, so a user's *pre-existing* content in either format
 *     must render no matter what the setting is.
 *
 * So the real contract is a 2D matrix of (write setting) × (on-disk content
 * format). `format-matrix.e2e.ts` drives that matrix using the descriptors and
 * helpers below. This module is intentionally additive — it does not touch the
 * existing single-flavor specs.
 *
 * Note on settings isolation (parallel safety): `obsidianPage.resetVault` only
 * rewrites regular vault files; it does NOT reset `.obsidian` config or plugin
 * settings (see wdio-obsidian-service docs). A spec that flips
 * `taskFormatFlavor` therefore leaks it into later specs in the same worker
 * unless it resets the setting itself. `resetForWriteFlavor()` below pairs the
 * vault reset with an explicit setting write so each test is self-contained.
 */
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

export const VAULT = "test/e2e/vaults/simple";

/* ------------------------------------------------------------------ dates -- */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today in local time, ISO `YYYY-MM-DD`. Mirrors `src/dates.ts` `today()`. */
export function todayISO(): string {
  return iso(new Date());
}

/** Today shifted by `deltaDays` (may cross week/month boundaries). */
export function offsetISO(deltaDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + deltaDays);
  return iso(d);
}

/**
 * A date guaranteed to fall in the SAME visible week as today, so week-view
 * drag targets exist regardless of which weekday the suite runs on. On Sunday
 * we step back one day (Saturday); otherwise forward one day. This is the
 * week-boundary-safe neighbor every drag/reschedule journey should use instead
 * of a raw `offsetISO(1)`, which silently leaves the week on Saturday/Sunday.
 */
export function inWeekNeighbor(): string {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 0 ? -1 : 1));
  return iso(d);
}

/* ------------------------------------------------------- vault + flushing -- */

/**
 * Write content to a vault file and wait for the metadata cache to index it,
 * THEN invalidate the plugin's TaskCache for that file.
 *
 * The invalidate step is not optional: write verbs resolve refs through
 * `cache.resolveRef(id)` (see src/api.ts). When a spec rewrites the same path
 * many times (e.g. `Tasks/Inbox.md` across a matrix of tests), a stale
 * `path:Ln → hash` entry survives in the TaskCache and `resolveRef` returns a
 * task whose line no longer parses — surfacing as `not_found: <path>:L1 is not
 * a task line`. Forcing `invalidateFile` + `__forFlush` rebuilds the cache from
 * the freshly written content, exactly like the proven dataview-format helper.
 */
export async function writeAndWait(path: string, body: string): Promise<void> {
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
        // Hard upper-bound so we never stall the suite.
        setTimeout(() => {
          app.metadataCache.offref(ref);
          resolve();
        }, 2000);
      });
    },
    path,
    body,
  );
  await browser.executeObsidian(async ({ app }, p: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins.plugins["task-center"];
    await plugin.cache.invalidateFile(p);
    await plugin.__forFlush();
  }, path);
}

/** Read a vault file's raw content (empty string if missing). */
export async function readFile(path: string): Promise<string> {
  return (await browser.executeObsidian(async ({ app }, p: string) => {
    const f = app.vault.getAbstractFileByPath(p);
    if (!f) return "";
    // @ts-expect-error — runtime TFile
    return await app.vault.read(f);
  }, path)) as unknown as string;
}

/** Flush the plugin's debounced cache/render pipeline deterministically. */
export async function forFlush(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (app as any).plugins.plugins["task-center"].__forFlush();
  });
}

/**
 * Synthetic HTML5 DnD: dragstart → dragenter → dragover → drop → dragend with a
 * shared DataTransfer carrying `text/task-id`. Dispatching events directly
 * bypasses Chromium's gesture requirement that wdio's dragAndDrop can't satisfy
 * for day-column targets.
 */
export async function simulateDrag(srcSel: string, tgtSel: string): Promise<void> {
  await browser.execute(
    (src: string, tgt: string) => {
      const srcEl = document.querySelector<HTMLElement>(src);
      const tgtEl = document.querySelector<HTMLElement>(tgt);
      if (!srcEl || !tgtEl) throw new Error(`simulateDrag: missing ${src} | ${tgt}`);
      const taskId = srcEl.dataset.taskId ?? "";
      const dt = new DataTransfer();
      dt.setData("text/task-id", taskId);
      const mk = (type: string) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      srcEl.dispatchEvent(mk("dragstart"));
      tgtEl.dispatchEvent(mk("dragenter"));
      tgtEl.dispatchEvent(mk("dragover"));
      tgtEl.dispatchEvent(mk("drop"));
      srcEl.dispatchEvent(mk("dragend"));
    },
    srcSel,
    tgtSel,
  );
}

/** Open the board and land on the active week tab. */
export async function openBoardWeekView(): Promise<void> {
  await browser.executeObsidianCommand("task-center:open");
  await forFlush();
  await browser.execute(() => {
    const tab = document.querySelector<HTMLElement>(".task-center-view [data-tab='week']");
    tab?.click();
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          !!document.querySelector(
            ".task-center-view [data-tab='week'].active, .task-center-view [data-tab='week'][aria-selected='true']",
          ),
      ),
    { timeout: 3000, interval: 100, timeoutMsg: "Week tab did not become active" },
  );
}

/* --------------------------------------------------------------- plugin api - */

export interface TaskCenterApi {
  add(opts: {
    text: string;
    to?: string;
    scheduled?: string;
    stampCreated?: boolean;
  }): Promise<{ path: string; line: number; created: string }>;
  done(id: string): Promise<{ before: string; after: string; unchanged: boolean }>;
  drop(id: string): Promise<{ before: string; after: string; unchanged: boolean }>;
  schedule(
    id: string,
    date: string | null,
  ): Promise<{ before: string; after: string; unchanged: boolean }>;
}

/**
 * Call the plugin's public API inside Obsidian. `fn` is serialized with
 * `.toString()`, so it must NOT close over module-level variables — those don't
 * exist in the browser-side `new Function` scope (the classic "X is not
 * defined" trap). Pass any dynamic values (paths, ids, dates) as trailing
 * `args`; they are forwarded and spread into `fn` after `api`.
 */
export async function callApi<T>(
  fn: (api: TaskCenterApi, ...args: string[]) => Promise<T>,
  ...args: string[]
): Promise<T> {
  return (await browser.executeObsidian(
    async ({ app }, fnSrc: string, fnArgs: string[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin = (app as any).plugins?.getPlugin?.("task-center");
      if (!plugin?.api) throw new Error("plugin api not found");
      // eslint-disable-next-line no-new-func
      const callable = new Function("api", "args", `return (${fnSrc})(api, ...args)`);
      // These journeys act on freshly rendered tasks; keep CLI stale-ref tests separate.
      const api = plugin.api.forSnapshot(await plugin.cache.ensureAll());
      return await callable(api, fnArgs);
    },
    fn.toString(),
    args,
  )) as T;
}

/* ----------------------------------------------------------------- flavors - */

/**
 * A task format flavor. `setting` is the value written into
 * `plugin.settings.taskFormatFlavor` (note: the emoji flavor's setting value is
 * the legacy string `"tasks"`, NOT `"emoji"`). `name` is the human label and
 * the on-disk *content* identity used by the read-parity matrix.
 *
 * The builders (`scheduled` / `due`) double as fixture writers AND output
 * assertions; the `*Re` matchers assert a field is present in this flavor's
 * shape with any date.
 */
export interface Flavor {
  setting: "tasks" | "dataview";
  name: "emoji" | "dataview";
  scheduled: (date: string) => string;
  due: (date: string) => string;
  scheduledRe: RegExp;
  completionRe: RegExp;
  cancelledRe: RegExp;
  createdRe: RegExp;
}

export const EMOJI: Flavor = {
  setting: "tasks",
  name: "emoji",
  scheduled: (d) => `⏳ ${d}`,
  due: (d) => `📅 ${d}`,
  scheduledRe: /⏳\s*\d{4}-\d{2}-\d{2}/,
  completionRe: /✅\s*\d{4}-\d{2}-\d{2}/,
  cancelledRe: /❌\s*\d{4}-\d{2}-\d{2}/,
  createdRe: /➕\s*\d{4}-\d{2}-\d{2}/,
};

export const DATAVIEW: Flavor = {
  setting: "dataview",
  name: "dataview",
  scheduled: (d) => `[scheduled:: ${d}]`,
  due: (d) => `[due:: ${d}]`,
  scheduledRe: /\[scheduled::\s*\d{4}-\d{2}-\d{2}\]/i,
  completionRe: /\[completion::\s*\d{4}-\d{2}-\d{2}\]/i,
  cancelledRe: /\[cancelled::\s*\d{4}-\d{2}-\d{2}\]/i,
  createdRe: /\[created::\s*\d{4}-\d{2}-\d{2}\]/i,
};

export const FLAVORS: readonly Flavor[] = [EMOJI, DATAVIEW];

/** The other flavor — used to assert a field was NOT left in the foreign shape. */
export function otherFlavor(f: Flavor): Flavor {
  return f.name === "emoji" ? DATAVIEW : EMOJI;
}

/** Set the plugin's write flavor and persist it (write-path control). */
export async function setWriteFlavor(setting: Flavor["setting"]): Promise<void> {
  await browser.executeObsidian(async ({ app }, value: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins.plugins["task-center"];
    plugin.settings.taskFormatFlavor = value;
    await plugin.saveSettings();
  }, setting);
}

/**
 * Canonical self-isolating beforeEach for flavor specs: reset the vault FILES
 * and explicitly set the write flavor, so neither stale files nor a leaked
 * `taskFormatFlavor` from a sibling spec can contaminate this test. Returns
 * after the setting is persisted.
 */
export async function resetForWriteFlavor(setting: Flavor["setting"]): Promise<void> {
  await obsidianPage.resetVault(VAULT);
  await setWriteFlavor(setting);
}

/** Assert a markdown blob carries `field` ONLY in `expected`'s shape. */
export async function expectFlavorField(
  content: string,
  expected: Flavor,
  re: (f: Flavor) => RegExp,
): Promise<void> {
  await expect(content).toMatch(re(expected));
  await expect(content).not.toMatch(re(otherFlavor(expected)));
}
