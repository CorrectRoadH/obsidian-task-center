import { Plugin, WorkspaceLeaf, Notice, CliData } from "obsidian";
import { TaskCenterSettings, DEFAULT_SETTINGS, VIEW_TYPE_TASK_CENTER, QueryPreset } from "./types";
import { TaskCenterSettingTab } from "./settings";
import { TaskCenterView } from "./view";
import {
  formatList,
  formatShow,
  formatStats,
  formatAgentBrief,
  formatReviewSummary,
  formatQueryRun,
  formatOkWrite,
  formatAdd,
  formatError,
} from "./cli";
import { TaskCenterApi, type QueryRunResult } from "./api";
import { TaskCache } from "./cache";
import { StatusBar } from "./status-bar";
import { DepHealthBanner } from "./dep-health";
import { QuickAddModal } from "./quickadd";
import { t as tr } from "./i18n";
import { todayISO } from "./dates";
import { parseDurationToMinutes } from "./parser";
import { resolveDateInput } from "./dates";
import { TaskWriterError } from "./writer";
import { __setTestForceMobile } from "./platform";
import {
  builtinSavedViewIdForLegacyTab,
  ensureBuiltinQueryPresets,
  createSavedViewId,
  deleteQueryPresetById,
  duplicateQueryPreset,
  isLegacyQueryPresetShape,
  migrateLegacyQueryPreset,
  normalizeQueryPreset,
  parseQueryDsl,
  renameQueryPresetById,
  setQueryPresetHiddenById,
  stringifyQueryPreset,
  upsertQueryPreset,
  visibleQueryPresets,
} from "./saved-views";

// CliData / CliFlags / CliHandler come from obsidian.d.ts (since API 1.12.2).
// CliData has an index signature of `string | 'true'` — boolean flags arrive
// as the literal string "true".
type CliArgs = CliData;

function isExistingViewTypeError(error: unknown, type: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`register an existing view type "${type}"`);
}

function isExistingCliHandlerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already registered as a handler");
}

function isDevReloadToleranceEnabled(): boolean {
  return false;
}

export default class TaskCenterPlugin extends Plugin {
  settings!: TaskCenterSettings;
  api!: TaskCenterApi;
  cache!: TaskCache;
  private statusBar: StatusBar | null = null;
  private depHealth: DepHealthBanner | null = null;
  // US-414 / US-415: number of legacy SavedTaskView entries detected and
  // migrated in-memory during the last `loadSettings`. While > 0 the migration
  // has NOT been persisted yet — the board must not render; TaskCenterView
  // shows the full-view upgrade gate instead, and only `completeMigration`
  // (the gate's confirm action) writes the migrated data back to disk.
  migratedLegacyCount = 0;
  // US-415: the resolved name + kind (builtin vs custom) of each legacy view
  // detected in the last `loadSettings`, so the upgrade gate can LIST exactly
  // which views are about to migrate instead of only showing a count. Kept in
  // lockstep with `migratedLegacyCount`; cleared together on confirm.
  migratedLegacyViews: { name: string; builtin: boolean }[] = [];

  async onload() {
    await this.loadSettings();
    this.cache = new TaskCache(this.app);
    for (const ref of this.cache.bind()) this.registerEvent(ref);
    this.api = new TaskCenterApi(this.app, this.cache, () => ({
      taskFormatFlavor: this.settings.taskFormatFlavor,
      weekStartsOn: this.settings.weekStartsOn,
    }));

    // View
    this.registerTaskCenterView();
    this.addRibbonIcon("kanban-square", tr("ribbon.open"), () => this.activateView());

    // Commands (Obsidian command palette). Default hotkey Cmd/Ctrl+Shift+T is
    // a suggestion — users can rebind in Settings → Hotkeys if it collides.
    this.addCommand({
      id: "open",
      name: tr("cmd.open"),
      callback: () => { void this.activateView(); },
    });
    this.addCommand({
      id: "quick-add",
      name: tr("cmd.quickAdd"),
      callback: () => { new QuickAddModal(this.app, this.api, () => { void this.refreshOpenViews(); }, this.settings).open(); },
    });
    this.addCommand({
      id: "reload-tasks",
      name: tr("cmd.reloadTasks"),
      callback: async () => {
        // Awaited so e2e specs that issue this command (and anyone using it
        // as a "settle now" handle) see updated state when the Promise
        // resolves. After Phase 1 e2e migration, prefer `plugin.__forFlush()`.
        try {
          await this.__forFlush();
          await this.refreshOpenViews();
        } catch (e) {
          console.warn("[task-center] reload-tasks:", e);
        }
        new Notice(tr("notice.reloaded"));
      },
    });

    // Settings tab
    this.addSettingTab(new TaskCenterSettingTab(this.app, this));

    // CLI — native Obsidian CLI handlers registered via the 1.12.2+ API.
    // All verbs are colon-grouped under `task-center:…`, matching the Obsidian
    // convention (compare `daily:read`, `base:query`).
    if (typeof (this as Plugin).registerCliHandler === "function") {
      try {
        this.registerAllCliHandlers();
      } catch (e) {
        if (!isDevReloadToleranceEnabled() || !isExistingCliHandlerError(e)) {
          throw e;
        }
      }
    } else {
      console.warn(
        "[task-center] app.cli.registerHandler not available — upgrade Obsidian to ≥ 1.12.2 for the CLI.",
      );
    }

    // Status bar — implementation in `./status-bar`. The class owns its own
    // cache subscription, debounce, and click handler.
    this.statusBar = new StatusBar(this.addStatusBarItem(), this.cache, {
      onClick: () => { void this.activateView(); },
    });
    this.app.workspace.onLayoutReady(() => this.statusBar?.refresh());

    // US-701: surface dep-health for Daily Notes and task-format companions.
    // The banner owns its own status-bar item and `data-dep-warning`
    // attribute. We refresh on layout-ready (initial paint) and on
    // every `layout-change` (covers the user toggling the plugin in
    // settings → next workspace event clears the warning, US-701c).
    this.depHealth = new DepHealthBanner(this.addStatusBarItem(), this.app, {
      onClick: () => {
        // Best-effort jump to Obsidian's plugin settings; if the API
        // shape isn't there (older builds), fall back to no-op so the
        // banner is still informative.
        const setting = (this.app as unknown as { setting?: { open?: () => void } }).setting;
        try { setting?.open?.(); } catch { /* ignore */ }
      },
    });
    this.app.workspace.onLayoutReady(() => this.depHealth?.refresh());
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.depHealth?.refresh()),
    );

    // US-110: "open board on startup" — opt-in toggle in settings.
    // Defers to `onLayoutReady` so we don't fight Obsidian's own
    // workspace restore for the focused leaf.
    // see USER_STORIES.md
    if (this.settings.openOnStartup) {
      this.app.workspace.onLayoutReady(() => this.activateView());
    }
  }

  onunload() {
    this.statusBar?.dispose();
    this.statusBar = null;
    this.depHealth?.dispose();
    this.depHealth = null;
    this.cache?.dispose();
  }

  private registerTaskCenterView(): void {
    const creator = (leaf: WorkspaceLeaf) => new TaskCenterView(leaf, this);
    try {
      this.registerView(VIEW_TYPE_TASK_CENTER, creator);
      return;
    } catch (e) {
      if (!isExistingViewTypeError(e, VIEW_TYPE_TASK_CENTER)) throw e;
      if (!isDevReloadToleranceEnabled()) throw e;

      const workspace = this.app.workspace as unknown as {
        unregisterView?: (type: string) => void;
      };
      if (typeof workspace.unregisterView === "function") {
        try {
          workspace.unregisterView(VIEW_TYPE_TASK_CENTER);
          this.registerView(VIEW_TYPE_TASK_CENTER, creator);
          return;
        } catch (retryError) {
          if (!isExistingViewTypeError(retryError, VIEW_TYPE_TASK_CENTER)) {
            throw retryError;
          }
        }
      }

      return;
    }
  }

  /**
   * Test hook (task #44). Forces `isMobileMode()` to return true so the
   * WDIO desktop Chromium runner can exercise mobile-only behavior
   * (`Platform.isMobile`-gated long-press / swipe /
   * Quick Add bottom-sheet styling). Default value is false; production
   * never calls this.
   *
   * After-each in every mobile spec resets to false to keep neighbor
   * tests isolated. See test/e2e/specs/mobile-coverage.e2e.ts.
   */
  __setTestForceMobile(v: boolean): void {
    __setTestForceMobile(v);
  }

  /**
   * Test hook (ARCHITECTURE.md §8.5). Awaits all in-flight cache reparses,
   * the in-flight `ensureAll`, and any pending status-bar / view debounce
   * timers. Lets e2e tests advance deterministically without polling DOM.
   */
  async __forFlush(): Promise<void> {
    this.statusBar?.flush();
    // US-701: refresh the dep-health banner here too so e2e specs that
    // toggle the Daily Notes plugin and then call `__forFlush()` see a
    // deterministic post-event state without waiting for a layout event.
    this.depHealth?.refresh();
    await this.cache.forFlush();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_CENTER)) {
      const view = leaf.view;
      if (view instanceof TaskCenterView) {
        await view.__forFlush();
      }
    }
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<typeof DEFAULT_SETTINGS> | undefined;
    const merged = { ...DEFAULT_SETTINGS, ...loaded };

    // US-414: detect any legacy stored view that needs migrating —
    // (a) flat SavedTaskView (top-level search/tag/time/status), or
    // (b) an old-DSL QueryPreset whose `view` still uses {type/preset/sections/
    // tray/matrix} instead of {layout}. Both are migrated into normalized
    // QueryPresets instead of being discarded. Flat shapes need their flat
    // fields collapsed into `filters` first; old-DSL views are migrated by
    // `migrateLegacyQueryPreset`. Only legacy builtin layouts use factory JSON;
    // modern saved layouts and mixed tab order survive initialization.
    const rawViews: unknown[] = merged.queryPresets ?? [];
    const legacyRaw = rawViews.filter((v) => isLegacyQueryPresetShape(v));
    this.migratedLegacyCount = legacyRaw.length;
    const migratedViews = rawViews.map((v) =>
      isLegacyQueryPresetShape(v) ? migrateLegacyQueryPreset(v) : v,
    );

    // US-109l: permanently-deleted preset ids are skipped when re-seeding
    // builtins, so a deleted preset stays gone across restarts.
    const deletedBuiltinIds = Array.isArray(merged.deletedBuiltinIds) ? merged.deletedBuiltinIds : [];
    const queryPresets = ensureBuiltinQueryPresets(migratedViews as Parameters<typeof ensureBuiltinQueryPresets>[0], {
      today: tr("tab.today"),
      week: tr("tab.week"),
      month: tr("tab.month"),
      todo: tr("tab.todo"),
      unscheduled: tr("tab.unscheduled"),
      completed: tr("tab.completed"),
      dropped: tr("tab.dropped"),
    }, deletedBuiltinIds);
    // Resolve a friendly name + kind for every legacy view so the gate can list
    // them. Prefer the post-migration preset (matched by id) so a renamed
    // builtin shows its current label; fall back to the raw name, then a
    // placeholder for flat legacy views that carried none.
    this.migratedLegacyViews = legacyRaw.map((raw) => {
      const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const id = typeof rec.id === "string" ? rec.id : null;
      const matched = id ? queryPresets.find((p) => p.id === id) : undefined;
      const rawName = typeof rec.name === "string" ? rec.name.trim() : "";
      return {
        name: matched?.name || rawName || tr("migration.untitledView"),
        builtin: matched ? matched.builtin : !!rec.builtin,
      };
    });
    const defaultSavedViewId =
      merged.defaultSavedViewId
      ?? builtinSavedViewIdForLegacyTab(merged.defaultView)
      ?? queryPresets.find((view) => !view.hidden)?.id
      ?? null;
    const lastSavedViewId =
      merged.lastSavedViewId
      ?? builtinSavedViewIdForLegacyTab(merged.lastTab)
      ?? defaultSavedViewId;
    // Strip legacy flat savedViews from loaded data (VAL-CROSS-002):
    // old data.json may carry `savedViews` which must not leak into runtime.
    delete (merged as Record<string, unknown>).savedViews;
    const loadedTaskFormatFlavor =
      (merged as TaskCenterSettings & { scheduledWriteFormat?: unknown }).taskFormatFlavor
      ?? (merged as TaskCenterSettings & { scheduledWriteFormat?: unknown }).scheduledWriteFormat;
    delete (merged as Record<string, unknown>).scheduledWriteFormat;
    this.settings = {
      ...merged,
      queryPresets,
      defaultSavedViewId,
      lastSavedViewId,
      taskFormatFlavor: loadedTaskFormatFlavor === "dataview" ? "dataview" : "tasks",
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // US-415: confirm action of the full-view upgrade gate. Persists the
  // already-in-memory-migrated settings, clears the gate flag, and re-renders
  // every open board so it leaves the gate and shows the new-structure UI.
  // One-shot: once written back, the next load detects no legacy data, so the
  // gate never reappears. If the user never confirms, nothing is persisted and
  // the gate shows again on the next launch.
  async completeMigration() {
    if (this.migratedLegacyCount === 0) return;
    await this.saveSettings();
    this.migratedLegacyCount = 0;
    this.migratedLegacyViews = [];
    await this.refreshOpenViews();
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_TASK_CENTER);
    let leaf: WorkspaceLeaf;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_TASK_CENTER, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  async refreshOpenViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_CENTER)) {
      const view = leaf.view;
      if (view instanceof TaskCenterView) {
        await view.reloadTasks();
        view.render();
      }
    }
  }

  async openManageTabs() {
    await this.activateView();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_CENTER)) {
      const view = leaf.view;
      if (view instanceof TaskCenterView) {
        view.openManageTabs();
        break;
      }
    }
  }

  // ---------- CLI registration ----------

  // US-201: register every Task Center verb to Obsidian's native CLI
  // (`registerCliHandler`, requires Obsidian 1.12.2+) — no shell wrapper,
  // no `eval` hacks, the CLI is the same surface Obsidian itself ships.
  // see USER_STORIES.md
  private registerAllCliHandlers() {
    const register: Plugin["registerCliHandler"] = (command, description, flags, handler) =>
      this.registerCliHandler(command, description, flags, async (args) => {
        try { return await handler(args); }
        catch (error) {
          const e = error as { code?: string; hint?: string; message?: string };
          const aliases: Record<string, string> = { query_not_found: "not_found", invalid_nest: "invalid_arg", undo_diverged: "write_conflict" };
          const code = aliases[e.code ?? ""] ?? e.code ?? "invalid_arg";
          const known = ["not_found", "ambiguous_slug", "missing_arg", "invalid_arg", "invalid_date", "invalid_query", "daily_notes_missing", "daily_notes_folder_missing", "write_conflict", "nest_partial"];
          return formatError(known.includes(code) ? code : "invalid_arg", e.hint ?? e.message ?? String(error));
        }
      });
    register(
      "task-center",
      "Show Task Center CLI help",
      {},
      () => this.cliHelp(),
    );

    register(
      "task-center:list",
      "List tasks with filters",
      {
        scheduled: {
          value: "<when>",
          description:
            "today | tomorrow | yesterday | unscheduled | week | next-week | month | next-month | YYYY-MM-DD | FROM..TO",
        },
        done: { value: "<when>", description: "Completed in this range" },
        overdue: { description: "Only todo tasks past their 📅" },
        "has-deadline": { description: "Only tasks with a deadline" },
        status: { value: "todo|done|dropped|in_progress", description: "Filter by status" },
        tag: {
          value: "<tag,tag>",
          description: "Tag filter (comma-separated; supports '#*象限')",
        },
        parent: { value: "<id>", description: "Children of parent id" },
        search: { value: "<text>", description: "Title substring match" },
        limit: { value: "<n>", description: "Truncate results" },
        format: { value: "text|json", description: "Output format (default: text)" },
      },
      (args) => this.cliList(args),
    );

    register(
      "task-center:show",
      "Show one task in full detail",
      {
        format: { value: "text|json", description: "Output format (default: text)" },
        ref: { value: "<path:line|hash>", description: "Task id", required: true },
      },
      (args) => this.cliShow(args),
    );

    register(
      "task-center:stats",
      "Estimate accuracy + tag distribution (rolling window)",
      {
        days: { value: "<n>", description: "Rolling window in days (default 7)" },
        group: { value: "<prefix>", description: "Aggregate tags by substring (e.g. 象限)" },
        from: { value: "<YYYY-MM-DD>", description: "Explicit period start" },
        to: { value: "<YYYY-MM-DD>", description: "Explicit period end" },
        format: { value: "text|json", description: "Output format (default: text)" },
      },
      (args) => this.cliStats(args),
    );

    register(
      "task-center:brief",
      "Agent brief: today status + executable next actions",
      {
        today: { value: "<YYYY-MM-DD>", description: "Override today's date" },
        limit: { value: "<n>", description: "Max tasks per section (default 5)" },
        format: { value: "text|json", description: "Output format (default: text)" },
      },
      (args) => this.cliBrief(args),
    );

    register(
      "task-center:review",
      "Review mode: today/week completion, abandonment, delay, estimate accuracy, grouping",
      {
        today: { value: "<YYYY-MM-DD>", description: "Override today's date" },
        days: { value: "<n>", description: "Rolling week window in days (default 7)" },
        limit: { value: "<n>", description: "Sample tasks per bucket (default 5)" },
        format: { value: "text|json", description: "Output format (default: text)" },
      },
      (args) => this.cliReview(args),
    );

    register(
      "task-center:schedule",
      "Set or clear ⏳ scheduled date on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        date: { value: "<YYYY-MM-DD|null>", description: "'null' clears the date" },
      },
      (args) => this.cliSchedule(args),
    );

    register(
      "task-center:deadline",
      "Set or clear 📅 deadline on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        date: { value: "<YYYY-MM-DD|null>", description: "'null' clears the date" },
      },
      (args) => this.cliDeadline(args),
    );

    register(
      "task-center:actual",
      "Set or add actual minutes ([actual:: Nm]) on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        minutes: { value: "<Nm|+Nm>", description: "30m, 1h, +15m (additive)" },
      },
      (args) => this.cliActual(args),
    );

    register(
      "task-center:estimate",
      "Set or clear [estimate:: Nm] on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        minutes: { value: "<Nm|null>", description: "'null' clears" },
      },
      (args) => this.cliEstimate(args),
    );

    register(
      "task-center:done",
      "Mark a task done (✅ today unless at= given)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        at: { value: "<YYYY-MM-DD>", description: "Override completion date" },
      },
      (args) => this.cliDone(args),
    );

    register(
      "task-center:undone",
      "Unmark a task (remove ✅ and reset checkbox)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
      },
      (args) => this.cliUndone(args),
    );

    register(
      "task-center:abandon",
      "Mark a task abandoned ([-] + ❌ today; children cascade)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
      },
      (args) => this.cliAbandon(args, "abandoned"),
    );

    // Deprecated alias kept for backward compatibility — `abandon` is the
    // preferred verb (matches README's `[-] ❌` = "Abandoned" terminology).
    register(
      "task-center:drop",
      "Alias for task-center:abandon (deprecated)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
      },
      (args) => this.cliAbandon(args, "dropped"),
    );

    register(
      "task-center:add",
      "Create a new task line",
      {
        text: { value: "<text>", description: "Task title", required: true },
        to: { value: "<path>", description: "Target file (default: today's daily note)" },
        tag: { value: "<tag,tag>", description: "Comma-separated tags" },
        scheduled: { value: "<YYYY-MM-DD>", description: "⏳ scheduled date" },
        deadline: { value: "<YYYY-MM-DD>", description: "📅 deadline" },
        estimate: { value: "<Nm>", description: "[estimate:: Nm]" },
        parent: { value: "<id>", description: "Nest under this parent task" },
        "stamp-created": {
          value: "true|false",
          description: "Override the stampCreated setting for this one add",
        },
      },
      (args) => this.cliAdd(args),
    );

    register(
      "task-center:tag",
      "Add or remove a tag on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        tag: { value: "<tag>", description: "Tag (with or without leading #)" },
        remove: { description: "Remove instead of add" },
      },
      (args) => this.cliTag(args),
    );

    register(
      "task-center:nest",
      "Move a task (and its subtree) to become a subtask of another (works cross-file)",
      {
        ref: { value: "<id>", description: "Task to move", required: true },
        under: { value: "<id>", description: "New parent task id", required: true },
      },
      (args) => this.cliNest(args),
    );

    register(
      "task-center:rename",
      "Rename a task title (preserves all metadata)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        title: { value: "<text>", description: "New title text", required: true },
      },
      (args) => this.cliRename(args),
    );

    register(
      "task-center:query-list",
      "List saved query presets",
      {
        hidden: { description: "Include hidden presets" },
        format: { value: "text|json", description: "Output format (default: text)" },
      },
      (args) => this.cliQueryList(args),
    );

    register(
      "task-center:query-show",
      "Show one saved query preset as DSL",
      {
        id: { value: "<preset-id>", description: "Saved query preset id", required: true },
      },
      (args) => this.cliQueryShow(args),
    );

    register(
      "task-center:query-run",
      "Run a saved query preset and render its view",
      {
        id: { value: "<preset-id>", description: "Saved query preset id", required: true },
        view: { value: "list|week|month", description: "Temporary view override" },
        anchor: { value: "YYYY-MM-DD", description: "Date anchor for week/month projection" },
        format: { value: "text|json", description: "Output format (default: text)" },
      },
      (args) => this.cliQueryRun(args),
    );

    // VAL-CLI-006: query-create is an alias that reuses the same QueryPreset
    // create implementation as query-save (stable id, invalid_query rejection).
    register(
      "task-center:query-save",
      "Create a saved query preset from DSL JSON",
      {
        dsl: { value: "<json>", description: "Query preset DSL as JSON", required: true },
      },
      (args) => this.cliQuerySave(args),
    );

    register(
      "task-center:query-create",
      "Create a saved query preset from DSL JSON (alias for query-save)",
      {
        dsl: { value: "<json>", description: "Query preset DSL as JSON", required: true },
      },
      (args) => this.cliQuerySave(args),
    );

    register(
      "task-center:query-update",
      "Replace an existing saved query preset from DSL JSON",
      {
        id: { value: "<preset-id>", description: "Saved query preset id", required: true },
        dsl: { value: "<json>", description: "Query preset DSL as JSON", required: true },
      },
      (args) => this.cliQueryUpdate(args),
    );

    register(
      "task-center:query-rename",
      "Rename a saved query preset",
      {
        id: { value: "<preset-id>", description: "Saved query preset id", required: true },
        name: { value: "<name>", description: "New display name", required: true },
      },
      (args) => this.cliQueryRename(args),
    );

    register(
      "task-center:query-copy",
      "Duplicate a saved query preset",
      {
        id: { value: "<preset-id>", description: "Source preset id", required: true },
        name: { value: "<name>", description: "Optional copied preset name" },
      },
      (args) => this.cliQueryCopy(args),
    );

    register(
      "task-center:query-hide",
      "Hide or unhide a saved query preset",
      {
        id: { value: "<preset-id>", description: "Saved query preset id", required: true },
        hidden: { value: "true|false", description: "Whether the preset should be hidden", required: true },
      },
      (args) => this.cliQueryHide(args),
    );

    register(
      "task-center:query-delete",
      "Delete a saved query preset",
      {
        id: { value: "<preset-id>", description: "Saved query preset id", required: true },
      },
      (args) => this.cliQueryDelete(args),
    );

    register(
      "task-center:query-set-default",
      "Set or clear the default saved query preset",
      {
        id: { value: "<preset-id|null>", description: "Preset id or null to clear", required: true },
      },
      (args) => this.cliQuerySetDefault(args),
    );
  }

  // ---------- CLI verb implementations ----------
  //
  // Each handler converts native Obsidian CLI args → TaskCenterApi call →
  // returns human-readable text (greppable, first column always an id).

  private cliHelp(): string {
    return [
      "Task Center CLI",
      "",
      "Task verbs:",
      "  add creates a new task on each run; actual +/- applies the delta on each run. Check show/list before retrying.",
      "  task-center:list [scheduled=today|tomorrow|yesterday|unscheduled|week|next-week|month|next-month|YYYY-MM-DD|FROM..TO] [done=<date|range>] [overdue=true|false] [has-deadline=true|false] [parent=<task-id>] [search=<text>] [limit=<positive integer>] [status=todo|done|dropped|in_progress] [tag=#work] [format=json]",
      "  task-center:show ref=<task-id> [format=json]",
      "  task-center:add text=<text> [to=<path>] [tag=#work,#home] [scheduled=YYYY-MM-DD] [deadline=YYYY-MM-DD] [estimate=30m] [parent=<task-id>] [stamp-created=true|false]",
      "  task-center:schedule ref=<task-id> date=<YYYY-MM-DD|null>",
      "  task-center:deadline ref=<task-id> date=<YYYY-MM-DD|null>",
      "  task-center:done ref=<task-id> [at=YYYY-MM-DD]",
      "  task-center:undone ref=<task-id>",
      "  task-center:abandon ref=<task-id>",
      "  task-center:drop ref=<task-id> (alias of abandon)",
      "  task-center:actual ref=<task-id> minutes=<30m|1h30m|+15m|-15m>",
      "  task-center:estimate ref=<task-id> minutes=<30m|null>",
      "  task-center:tag ref=<task-id> tag=<#tag> [remove=true|false]",
      "  task-center:nest ref=<task-id> under=<parent-task-id>",
      "  task-center:rename ref=<task-id> title=<new-title>",
      "  task-center:stats [from=<date>] [to=<date>] [days=7] [group=象限] [format=json]",
      "  task-center:brief [today=<date>] [limit=<positive integer>] [format=json]",
      "  task-center:review [today=<date>] [limit=<positive integer>] [days=7] [format=json]",
      "",
      "Query Tab verbs:",
      "  task-center:query-list [hidden=true] [format=json]",
      "  task-center:query-show id=<tab-id>",
      "  task-center:query-run id=<tab-id> [view=list|week|month] [anchor=YYYY-MM-DD] [format=json]",
      "  task-center:query-create dsl=<json>",
      "  task-center:query-save dsl=<json>",
      "  task-center:query-update id=<tab-id> dsl=<json>",
      "  task-center:query-rename id=<tab-id> name=<name>",
      "  task-center:query-copy id=<tab-id> [name=<name>]",
      "  task-center:query-hide id=<tab-id> hidden=true|false",
      "  task-center:query-delete id=<tab-id>",
      "  task-center:query-set-default id=<tab-id|null>",
      "",
      "Companion AI skill:",
      "  npx skills add CorrectRoadH/obsidian-task-center",
    ].join("\n");
  }

  // US-205: `list` defaults to human-readable text — `format=json` is opt-in,
  //          never the default. Same convention applies to `stats` below.
  // US-202: text rows always start with the stable id (`path:Lnnn`) at
  //          column 0 so `grep`, `awk`, `cut` work without parsing further.
  // US-212: `parent=<id>` filter surfaces the children of one parent
  //          (filterTasks branch in cli.ts handles the actual narrowing).
  // see USER_STORIES.md
  private async cliList(args: CliArgs): Promise<string> {
    const filters: Parameters<TaskCenterApi["list"]>[0] = {};
    if (args.scheduled) filters.scheduled = args.scheduled;
    if (args.done) filters.done = args.done;
    filters.overdue = booleanArg(args.overdue);
    filters.hasDeadline = booleanArg(args["has-deadline"]);
    if (args.status && !["todo", "done", "dropped", "in_progress"].includes(args.status)) throw new TaskWriterError("invalid_arg", "status=todo|done|dropped|in_progress");
    if (args.status) filters.status = args.status as "todo" | "done" | "dropped";
    if (args.tag) filters.tag = splitList(args.tag);
    if (args.parent) filters.parent = args.parent;
    if (args.search) filters.search = args.search;
    if (args.limit !== undefined) filters.limit = positiveInteger(args.limit);
    const all = await this.api.list(filters);
    if (args.format === "json") {
      return JSON.stringify(
        all.map((t) => ({
          id: t.id,
          path: t.path,
          line: t.line + 1,
          status: t.status,
          title: t.title,
          tags: t.tags,
          scheduled: t.scheduled,
          deadline: t.deadline,
          created: t.created,
          completed: t.completed,
          cancelled: t.cancelled,
          estimate_minutes: t.estimate,
          actual_minutes: t.actual,
          parent_id: t.parentLine !== null ? `${t.path}:L${t.parentLine + 1}` : null,
          children_ids: t.childrenLines.map((l) => `${t.path}:L${l + 1}`),
          hash: t.hash,
        })),
        null,
        2,
      );
    }
    const desc = describeFilters(filters);
    const header = `${all.length} tasks · ${desc} · ${todayISO()}`;
    return formatList(all, header, { groupingTags: this.settings.groupingTags });
  }

  private async cliShow(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const task = await this.api.show(ref);
    if (args.format === "json") return JSON.stringify({
      ...task, line: task.line + 1, raw: task.rawLine, estimate_minutes: task.estimate, actual_minutes: task.actual,
      parent_id: task.parentLine === null ? null : `${task.path}:L${task.parentLine + 1}`,
      children_ids: task.childrenLines.map(line => `${task.path}:L${line + 1}`),
    }, null, 2);
    return formatShow(task, { groupingTags: this.settings.groupingTags });
  }

  // US-206: `stats days=N` returns the estimate-vs-actual ratio plus the
  //          top tag-minute contributors so an AI can give the user
  //          calibration feedback. `group=<prefix>` (e.g. `象限`) bucket-
  //          sums tags with that substring — Covey 4-quadrant rollup, and
  //          works for any user-defined group convention (US-108).
  // US-205: text format default; `format=json` is opt-in for downstream
  //          machine consumers.
  // see USER_STORIES.md
  private async cliStats(args: CliArgs): Promise<string> {
    const days = args.days !== undefined ? positiveInteger(args.days) : 7;
    const stats = await this.api.stats({
      days,
      group: args.group,
      from: args.from === undefined ? undefined : cliDate(args.from),
      to: args.to === undefined ? undefined : cliDate(args.to),
    });
    if (args.format === "json") return JSON.stringify(stats, null, 2);
    return formatStats(stats);
  }

  private async cliBrief(args: CliArgs): Promise<string> {
    const brief = await this.api.agentBrief({
      today: args.today === undefined ? undefined : cliDate(args.today),
      limit: args.limit !== undefined ? positiveInteger(args.limit) : undefined,
    });
    if (args.format === "json") return JSON.stringify(brief, null, 2);
    return formatAgentBrief(brief);
  }

  private async cliReview(args: CliArgs): Promise<string> {
    const review = await this.api.review({
      today: args.today === undefined ? undefined : cliDate(args.today),
      days: args.days !== undefined ? positiveInteger(args.days) : undefined,
      limit: args.limit !== undefined ? positiveInteger(args.limit) : undefined,
      groupingTags: this.settings.groupingTags,
    });
    if (args.format === "json") return JSON.stringify(review, null, 2);
    return formatReviewSummary(review);
  }

  private async cliSchedule(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const date = requireArg(args.date, "date");
    const clear = date === "null";
    const r = await this.api.schedule(ref, clear ? null : cliDate(date));
    const t = await this.api.show(ref);
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "schedule cleared" : `scheduled ${date}`);
  }

  private async cliDeadline(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const date = requireArg(args.date, "date");
    const clear = date === "null";
    const r = await this.api.deadline(ref, clear ? null : cliDate(date));
    const t = await this.api.show(ref);
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "deadline cleared" : `deadline ${date}`);
  }

  // US-209: incremental `actual minutes=+30m` — the leading `+` switches
  // to additive mode so the agent doesn't have to read the current value
  // before writing. Plain `minutes=Nm` still does a `set` overwrite.
  // see USER_STORIES.md
  private async cliActual(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const spec = requireArg(args.minutes, "minutes");
    const add = /^[+-]/.test(spec);
    const value = add ? spec.slice(1) : spec;
    const minutes = durationArg(value);
    if (minutes === null) throw new TaskWriterError("invalid_arg", `not a duration: ${spec}`);
    const r = await this.api.actual(ref, spec.startsWith("-") ? -minutes : minutes, add ? "add" : "set");
    const t = await this.api.show(ref);
    const action = `actual ${add ? (spec.startsWith("-") ? "-=" : "+=") : "="} ${minutes}m${add ? " (each run applies the delta)" : ""}`;
    return `${formatOkWrite(t, null, null, r.before, r.after, r.unchanged, action)}\n    ${action}`;
  }

  private async cliEstimate(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const spec = requireArg(args.minutes, "minutes");
    const clear = spec === "null" || spec === "--";
    const minutes = clear ? null : durationArg(spec);
    if (!clear && minutes === null) throw new TaskWriterError("invalid_arg", `not a duration: ${spec}`);
    const r = await this.api.estimate(ref, minutes);
    const t = await this.api.show(ref);
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "estimate cleared" : `estimate ${minutes}m`);
  }

  // US-203: write idempotency — running `done` on an already-done task
  // returns `ok ... unchanged (already done ✅ <date>)` instead of erroring.
  // The unchanged signal is computed in the writer and surfaced by
  // formatOkWrite below.
  // see USER_STORIES.md
  private async cliDone(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const at = args.at === undefined ? null : cliDate(args.at);
    const r = await this.api.done(ref, at);
    return r.results.map(row => formatOkWrite(null, row.path, row.line, row.before, row.after, row.unchanged, "done")).join("\n");
  }

  private async cliUndone(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const r = await this.api.undone(ref);
    const t = await this.api.show(ref);
    if (r.unchanged) return formatOkWrite(t, null, null, r.before, r.after, true, "already todo", "unchanged (already todo)");
    return formatOkWrite(t, null, null, r.before, r.after, false, "undone");
  }

  private async cliAbandon(args: CliArgs, label: "abandoned" | "dropped"): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const r = await this.api.drop(ref);
    return r.results.map(row => formatOkWrite(null, row.path, row.line, row.before, row.after, row.unchanged, label)).join("\n");
  }

  // US-213: `add stamp-created=true|false` lets the caller override the
  // global stampCreated setting for one write. Agents back-filling
  // historical tasks set it to `false` so the auto `➕ today` stamp
  // doesn't pollute the timeline with bulk-import "creation" dates.
  // see USER_STORIES.md
  private async cliAdd(args: CliArgs): Promise<string> {
    const text = requireArg(args.text, "text");
    const estimateSpec = args.estimate;
    const estimate = estimateSpec !== undefined ? durationArg(estimateSpec) : undefined;
    // `stampCreated` flag lets caller override the setting (default: true). Pass
    // `stamp-created=false` on the CLI to disable.
    const stampCreated =
      args["stamp-created"] !== undefined
        ? booleanArg(args["stamp-created"])
        : this.settings.stampCreated;
    const r = await this.api.add({
      text,
      to: args.to,
      tag: args.tag ? splitList(args.tag) : undefined,
      scheduled: args.scheduled === undefined ? undefined : cliDate(args.scheduled),
      deadline: args.deadline === undefined ? undefined : cliDate(args.deadline),
      estimate,
      parent: args.parent,
      stampCreated,
    });
    return formatAdd(r);
  }

  private async cliTag(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const tag = requireArg(args.tag, "tag");
    const remove = booleanArg(args.remove);
    const r = remove ? await this.api.tag(ref, tag, true) : await this.api.tag(ref, tag);
    const t = await this.api.show(ref);
    if (r.unchanged) return formatOkWrite(t, null, null, r.before, r.after, true, "no-op", "unchanged");
    return formatOkWrite(t, null, null, r.before, r.after, false, remove ? "tag removed" : "tag added");
  }

  // US-228: `nest ref=A under=B` — the CLI sibling of the GUI drag-card-
  // onto-card gesture. Works cross-file; cycles are rejected by
  // writer.nestUnder (US-126). On success returns the parent ref so
  // chained scripts can keep working with a stable id.
  // see USER_STORIES.md
  private async cliNest(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const under = requireArg(args.under, "under");
    const r = await this.api.nest(ref, under);
    const insertion = r.undoOps.find(op => op.after.length > 0);
    const path = insertion?.path ?? ref.slice(0, ref.lastIndexOf(":L"));
    const line = insertion?.line ?? Number(ref.slice(ref.lastIndexOf(":L") + 2)) - 1;
    if (r.unchanged) return formatOkWrite(null, path, line, r.before, r.after, true, "nested");
    return `ok  ${path}:L${line + 1}  nested\n` + r.undoOps.map(op =>
      formatOkWrite(null, op.path, op.line, op.before.join("\n"), op.after.join("\n"), false, "nested")
    ).join("\n");
  }

  // US-227: `rename ref=<id> title=<new title>` — rename a task's title
  // while preserving all metadata (tags, emoji dates, inline fields,
  // block anchors). Unchanged when title already matches.
  // see USER_STORIES.md
  private async cliRename(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const title = requireArg(args.title, "title");
    const t = await this.api.show(ref);
    const r = await this.api.rename(ref, title);
    // US-227: pass titleOverride so the output header reflects the new title
    // even when the cache is stale (metadataCache.changed fires asynchronously
    // after vault.process). Without this, the header shows the old title from
    // the pre-rename cache entry.
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, "renamed", undefined, title);
  }

  private cliQueryList(args: CliArgs): string {
    const all = booleanArg(args.hidden) ? this.settings.queryPresets.map((view) => normalizeQueryPreset(view)) : visibleQueryPresets(this.settings.queryPresets);
    if (args.format === "json") {
      return JSON.stringify(
        all.map((view) => ({
          id: view.id,
          name: view.name,
          builtin: !!view.builtin,
          hidden: !!view.hidden,
          default: view.id === this.settings.defaultSavedViewId,
        })),
        null,
        2,
      );
    }
    if (all.length === 0) return "0 query presets";
    const lines = [`${all.length} query presets`];
    for (const view of all) {
      const flags = [
        view.builtin ? "builtin" : "custom",
        view.id === this.settings.defaultSavedViewId ? "default" : null,
        view.hidden ? "hidden" : "visible",
      ].filter(Boolean).join(" · ");
      lines.push(`${view.id}  ${view.name}${flags ? `  ${flags}` : ""}`);
    }
    return lines.join("\n");
  }

  private cliQueryShow(args: CliArgs): string {
    const view = this.requireQueryPreset(requireArg(args.id, "id"));
    return stringifyQueryPreset(view);
  }

  private async cliQueryRun(args: CliArgs): Promise<string> {
    const preset = this.requireQueryPreset(requireArg(args.id, "id"));
    const view = args.view ? parseQueryViewType(args.view) : undefined;
    const anchorISO = args.anchor === undefined ? todayISO() : cliDate(args.anchor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorISO)) {
      throw new TaskWriterError("invalid_date", `anchor requires YYYY-MM-DD: ${anchorISO}`);
    }
    const result = await this.api.runQueryPreset(preset, {
      weekStartsOn: this.settings.weekStartsOn ?? 1,
      anchorISO,
      view,
    });
    if (args.format === "json") return JSON.stringify(toQueryRunJson(result), null, 2);
    return formatQueryRun(result, { groupingTags: this.settings.groupingTags });
  }

  private async cliQuerySave(args: CliArgs): Promise<string> {
    const dsl = requireArg(args.dsl, "dsl");
    // VAL-CORE-005 / VAL-CORE-006 / VAL-CROSS-002: shared parse+validate
    // rejects legacy flat SavedTaskView DSL and invalid structures. Error is
    // surfaced as `invalid_query` so agents can match the stable code.
    let parsed: QueryPreset;
    try {
      parsed = parseQueryDsl(dsl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TaskWriterError("invalid_query", message);
    }
    const created = normalizeQueryPreset({
      ...parsed,
      id: createSavedViewId(),
      builtin: false,
      hidden: false,
    });
    this.settings.queryPresets = upsertQueryPreset(this.settings.queryPresets, created);
    await this.saveSettings();
    await this.refreshOpenViews();
    return `ok  ${created.id}  ${created.name}\n    saved query preset`;
  }

  private async cliQueryUpdate(args: CliArgs): Promise<string> {
    const id = requireArg(args.id, "id");
    const existing = this.requireQueryPreset(id);
    // VAL-CORE-005 / VAL-CORE-006 / VAL-CROSS-002: validate before any mutation.
    // Invalid DSL (including legacy flat shape) leaves the existing preset
    // completely unchanged — we throw before touching settings.
    const dsl = requireArg(args.dsl, "dsl");
    let parsed: QueryPreset;
    try {
      parsed = parseQueryDsl(dsl, existing);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TaskWriterError("invalid_query", message);
    }
    const normalized = normalizeQueryPreset({
      ...parsed,
      id: existing.id,
      builtin: existing.builtin,
    });
    if (JSON.stringify(existing) === JSON.stringify(normalized)) return `ok  ${id}  unchanged`;
    this.settings.queryPresets = this.settings.queryPresets.map((view) => (view.id === id ? normalized : view));
    await this.saveSettings();
    await this.refreshOpenViews();
    return `ok  ${normalized.id}  ${normalized.name}\n    updated query preset`;
  }

  private async cliQueryRename(args: CliArgs): Promise<string> {
    const id = requireArg(args.id, "id");
    const existing = this.requireQueryPreset(id);
    const name = requireArg(args.name, "name").trim();
    if (existing.name === name) return `ok  ${id}  unchanged`;
    this.settings.queryPresets = renameQueryPresetById(this.settings.queryPresets, id, name);
    await this.saveSettings();
    await this.refreshOpenViews();
    const renamed = this.requireQueryPreset(id);
    return `ok  ${renamed.id}  ${renamed.name}\n    renamed query preset`;
  }

  private async cliQueryCopy(args: CliArgs): Promise<string> {
    const source = this.requireQueryPreset(requireArg(args.id, "id"));
    const copy = duplicateQueryPreset(
      this.settings.queryPresets,
      source.id,
      (args.name && args.name.trim()) || `${source.name} Copy`,
    );
    this.settings.queryPresets = upsertQueryPreset(this.settings.queryPresets, copy);
    await this.saveSettings();
    await this.refreshOpenViews();
    return `ok  ${copy.id}  ${copy.name}\n    copied query preset from ${source.id}`;
  }

  private async cliQueryHide(args: CliArgs): Promise<string> {
    const id = requireArg(args.id, "id");
    this.requireQueryPreset(id);
    const raw = requireArg(args.hidden, "hidden");
    if (raw !== "true" && raw !== "false") {
      throw new TaskWriterError("invalid_arg", "hidden is required (pass hidden=true|false)");
    }
    const hidden = raw === "true";
    if (Boolean(this.requireQueryPreset(id).hidden) === hidden && !(hidden && (this.settings.defaultSavedViewId === id || this.settings.lastSavedViewId === id))) return `ok  ${id}  unchanged`;
    this.settings.queryPresets = setQueryPresetHiddenById(this.settings.queryPresets, id, hidden);
    if (hidden && this.settings.defaultSavedViewId === id) {
      this.settings.defaultSavedViewId = null;
    }
    if (hidden && this.settings.lastSavedViewId === id) {
      this.settings.lastSavedViewId = null;
    }
    await this.saveSettings();
    await this.refreshOpenViews();
    const updated = this.requireQueryPreset(id);
    return `ok  ${updated.id}  ${updated.name}\n    ${hidden ? "hidden" : "visible"} query preset`;
  }

  private async cliQueryDelete(args: CliArgs): Promise<string> {
    const view = this.requireQueryPreset(requireArg(args.id, "id"));
    this.settings.queryPresets = deleteQueryPresetById(this.settings.queryPresets, view.id);
    // US-109l: deleting a builtin preset tombstones its id so it is not
    // re-seeded on the next load. "恢复预设 Tabs" / 行内「恢复预设」 clears it.
    if (view.builtin && !this.settings.deletedBuiltinIds.includes(view.id)) {
      this.settings.deletedBuiltinIds = [...this.settings.deletedBuiltinIds, view.id];
    }
    if (this.settings.defaultSavedViewId === view.id) this.settings.defaultSavedViewId = null;
    if (this.settings.lastSavedViewId === view.id) this.settings.lastSavedViewId = null;
    await this.saveSettings();
    await this.refreshOpenViews();
    return `ok  ${view.id}  ${view.name}\n    deleted query preset`;
  }

  private async cliQuerySetDefault(args: CliArgs): Promise<string> {
    const id = requireArg(args.id, "id");
    if (id === "null") {
      if (this.settings.defaultSavedViewId === null) return "ok  default-query-preset  unchanged";
      this.settings.defaultSavedViewId = null;
      await this.saveSettings();
      await this.refreshOpenViews();
      return "ok  default-query-preset\n    cleared";
    }
    const view = this.requireQueryPreset(id);
    if (view.hidden) {
      throw new TaskWriterError("invalid_query", `query preset is hidden: ${id}`);
    }
    if (this.settings.defaultSavedViewId === view.id) return `ok  ${id}  unchanged`;
    this.settings.defaultSavedViewId = view.id;
    await this.saveSettings();
    await this.refreshOpenViews();
    return `ok  ${view.id}  ${view.name}\n    set as default query preset`;
  }

  private requireQueryPreset(id: string): QueryPreset {
    const view = this.settings.queryPresets.find((item) => item.id === id);
    if (!view) throw new TaskWriterError("query_not_found", id);
    return normalizeQueryPreset(view);
  }
}

function requireArg(v: string | undefined, name: string): string {
  if (v === undefined || v.trim() === "") {
    throw new TaskWriterError("missing_arg", `${name} is required (pass ${name}=<value>)`);
  }
  return v;
}

function parseQueryViewType(raw: string): "list" | "week" | "month" {
  if (raw === "list" || raw === "week" || raw === "month") return raw;
  throw new TaskWriterError("invalid_query", `view must be list|week|month: ${raw}`);
}

function toQueryRunJson(result: QueryRunResult): unknown {
  return {
    preset: {
      id: result.preset.id,
      name: result.preset.name,
      builtin: result.preset.builtin,
      hidden: result.preset.hidden,
    },
    view: result.view,
    anchor: result.anchorISO,
    total: result.filteredTasks.length,
    model: mapViewModel(result.viewModel),
    areas: (result.areas ?? []).map(area => ({ title: area.title, total: area.filteredTasks.length, model: mapViewModel(area.viewModel) })),
  };
}

function mapViewModel(model: QueryRunResult["viewModel"]): unknown {
  if (model.type === "list") {
    return {
      type: "list",
      tasks: model.tasks.map(queryRunTaskJson),
    };
  }
  if (model.type === "week") {
    return {
      type: "week",
      days: model.days.map((day) => ({
        date: day.date,
        tasks: day.tasks.map(queryRunTaskJson),
      })),
    };
  }
  return {
    type: "month",
    cells: model.cells.map((cell) => ({
      date: cell.date,
      tasks: cell.tasks.map(queryRunTaskJson),
    })),
  };
}

function queryRunTaskJson(task: QueryRunResult["filteredTasks"][number]): unknown {
  return {
    id: task.id,
    path: task.path,
    line: task.line + 1,
    status: task.effectiveStatus,
    rawStatus: task.status,
    title: task.title,
    tags: task.tags,
    scheduled: task.effectiveScheduled,
    deadline: task.effectiveDeadline,
    created: task.effectiveCreated,
    completed: task.completed,
    cancelled: task.cancelled,
    estimate_minutes: task.estimate,
    actual_minutes: task.actual,
    parent_id: task.parentLine !== null ? `${task.path}:L${task.parentLine + 1}` : null,
    children_ids: task.childrenLines.map((line) => `${task.path}:L${line + 1}`),
  };
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function describeFilters(f: Parameters<TaskCenterApi["list"]>[0]): string {
  const parts: string[] = [];
  if (f.scheduled) parts.push(`scheduled ${f.scheduled}`);
  if (f.done) parts.push(`done ${f.done}`);
  if (f.overdue) parts.push("overdue");
  if (f.status) parts.push(`status ${f.status}`);
  if (f.tag) parts.push(`tag ${f.tag.join(",")}`);
  if (f.search) parts.push(`search "${f.search}"`);
  if (f.limit) parts.push(`limit ${f.limit}`);
  return parts.length > 0 ? parts.join(" · ") : "all";
}

function booleanArg(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new TaskWriterError("invalid_arg", `expected true|false: ${value}`);
}
function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new TaskWriterError("invalid_arg", `expected positive integer: ${value}`);
  return Number(value);
}
function cliDate(value: string): string {
  const date = resolveDateInput(value);
  if (!date) throw new TaskWriterError("invalid_date", value);
  return date;
}
function durationArg(value: string): number {
  value = value.trim().toLowerCase();
  if (/^0(?:m|h)?$/.test(value)) return 0;
  if (!/^(?:\d+(?:\.\d+)?h(?:\d+m)?|\d+(?:\.\d+)?m?|\d+h\d+m)$/.test(value.trim())) throw new TaskWriterError("invalid_arg", `invalid duration: ${value}`);
  const minutes = parseDurationToMinutes(value);
  if (minutes === null || !Number.isFinite(minutes) || !Number.isSafeInteger(minutes)) throw new TaskWriterError("invalid_arg", value);
  return minutes;
}
