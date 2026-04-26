import { Plugin, WorkspaceLeaf, Notice, CliData } from "obsidian";
import { TaskCenterSettings, DEFAULT_SETTINGS, VIEW_TYPE_TASK_CENTER } from "./types";
import { TaskCenterSettingTab } from "./settings";
import { TaskCenterView } from "./view";
import {
  TaskCenterApi,
  formatList,
  formatShow,
  formatStats,
  formatOkWrite,
  formatAdd,
} from "./cli";
import { TaskCache } from "./cache";
import { StatusBar } from "./status-bar";
import { QuickAddModal } from "./quickadd";
import { t as tr } from "./i18n";
import { todayISO } from "./dates";
import { parseDurationToMinutes } from "./parser";
import { TaskWriterError } from "./writer";
import { __setTestForceMobile } from "./platform";

// CliData / CliFlags / CliHandler come from obsidian.d.ts (since API 1.12.2).
// CliData has an index signature of `string | 'true'` — boolean flags arrive
// as the literal string "true".
type CliArgs = CliData;

export default class TaskCenterPlugin extends Plugin {
  settings!: TaskCenterSettings;
  api!: TaskCenterApi;
  cache!: TaskCache;
  private statusBar: StatusBar | null = null;

  async onload() {
    await this.loadSettings();
    this.cache = new TaskCache(this.app);
    for (const ref of this.cache.bind()) this.registerEvent(ref);
    this.api = new TaskCenterApi(this.app, this.cache);

    // View
    this.registerView(VIEW_TYPE_TASK_CENTER, (leaf) => new TaskCenterView(leaf, this));
    this.addRibbonIcon("kanban-square", tr("ribbon.open"), () => this.activateView());

    // Commands (Obsidian command palette). Default hotkey Cmd/Ctrl+Shift+T is
    // a suggestion — users can rebind in Settings → Hotkeys if it collides.
    this.addCommand({
      id: "open",
      name: tr("cmd.open"),
      callback: () => this.activateView(),
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }],
    });
    this.addCommand({
      id: "quick-add",
      name: tr("cmd.quickAdd"),
      callback: () => new QuickAddModal(this.app, this.api, () => this.refreshOpenViews(), this.settings).open(),
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
        // A collision with another plugin registering the same verb is a soft
        // failure — the GUI remains fully usable without the shell CLI.
        console.error("[task-center] CLI registration failed:", e);
        new Notice(
          "Task Center: CLI verbs failed to register (likely a namespace collision). GUI still works.",
          6000,
        );
      }
    } else {
      console.warn(
        "[task-center] app.cli.registerHandler not available — upgrade Obsidian to ≥ 1.12.2 for the CLI.",
      );
    }

    // Status bar — implementation in `./status-bar`. The class owns its own
    // cache subscription, debounce, and click handler.
    this.statusBar = new StatusBar(this.addStatusBarItem(), this.cache, {
      onClick: () => this.activateView(),
    });
    this.app.workspace.onLayoutReady(() => this.statusBar?.refresh());

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
    this.cache?.dispose();
  }

  /**
   * Test hook (task #44). Forces `isMobileMode()` to return true so the
   * WDIO desktop Chromium runner can exercise mobile-only behavior
   * (`Platform.isMobile`-gated long-press / swipe / pointer-drag /
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
    await this.cache.forFlush();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_CENTER)) {
      const view = leaf.view;
      if (view instanceof TaskCenterView) {
        await view.__forFlush();
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
    workspace.revealLeaf(leaf);
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

  // ---------- CLI registration ----------

  // US-201: register every Task Center verb to Obsidian's native CLI
  // (`registerCliHandler`, requires Obsidian 1.12.2+) — no shell wrapper,
  // no `eval` hacks, the CLI is the same surface Obsidian itself ships.
  // see USER_STORIES.md
  private registerAllCliHandlers() {
    this.registerCliHandler(
      "task-center:list",
      "List tasks with filters",
      {
        scheduled: {
          value: "<when>",
          description:
            "today | tomorrow | unscheduled | week | next-week | month | next-month | YYYY-MM-DD | FROM..TO",
        },
        done: { value: "<when>", description: "Completed in this range" },
        overdue: { description: "Only todo tasks past their 📅" },
        "has-deadline": { description: "Only tasks with a deadline" },
        status: { value: "todo|done|dropped", description: "Filter by status" },
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

    this.registerCliHandler(
      "task-center:show",
      "Show one task in full detail",
      {
        ref: { value: "<path:line|hash>", description: "Task id", required: true },
      },
      (args) => this.cliShow(args),
    );

    this.registerCliHandler(
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

    this.registerCliHandler(
      "task-center:schedule",
      "Set or clear ⏳ scheduled date on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        date: { value: "<YYYY-MM-DD|null>", description: "'null' clears the date" },
      },
      (args) => this.cliSchedule(args),
    );

    this.registerCliHandler(
      "task-center:deadline",
      "Set or clear 📅 deadline on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        date: { value: "<YYYY-MM-DD|null>", description: "'null' clears the date" },
      },
      (args) => this.cliDeadline(args),
    );

    this.registerCliHandler(
      "task-center:actual",
      "Set or add actual minutes ([actual:: Nm]) on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        minutes: { value: "<Nm|+Nm>", description: "30m, 1h, +15m (additive)" },
      },
      (args) => this.cliActual(args),
    );

    this.registerCliHandler(
      "task-center:estimate",
      "Set or clear [estimate:: Nm] on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        minutes: { value: "<Nm|null>", description: "'null' clears" },
      },
      (args) => this.cliEstimate(args),
    );

    this.registerCliHandler(
      "task-center:done",
      "Mark a task done (✅ today unless at= given)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        at: { value: "<YYYY-MM-DD>", description: "Override completion date" },
      },
      (args) => this.cliDone(args),
    );

    this.registerCliHandler(
      "task-center:undone",
      "Unmark a task (remove ✅ and reset checkbox)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
      },
      (args) => this.cliUndone(args),
    );

    this.registerCliHandler(
      "task-center:abandon",
      "Mark a task abandoned ([-] + ❌ today; children cascade)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
      },
      (args) => this.cliAbandon(args, "abandoned"),
    );

    // Deprecated alias kept for backward compatibility — `abandon` is the
    // preferred verb (matches README's `[-] ❌` = "Abandoned" terminology).
    this.registerCliHandler(
      "task-center:drop",
      "Alias for task-center:abandon (deprecated)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
      },
      (args) => this.cliAbandon(args, "dropped"),
    );

    this.registerCliHandler(
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

    this.registerCliHandler(
      "task-center:tag",
      "Add or remove a tag on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        tag: { value: "<tag>", description: "Tag (with or without leading #)" },
        remove: { description: "Remove instead of add" },
      },
      (args) => this.cliTag(args),
    );

    this.registerCliHandler(
      "task-center:nest",
      "Move a task (and its subtree) to become a subtask of another (works cross-file)",
      {
        ref: { value: "<id>", description: "Task to move", required: true },
        under: { value: "<id>", description: "New parent task id", required: true },
      },
      (args) => this.cliNest(args),
    );
  }

  // ---------- CLI verb implementations ----------
  //
  // Each handler converts native Obsidian CLI args → TaskCenterApi call →
  // returns human-readable text (greppable, first column always an id).

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
    if (args.overdue) filters.overdue = true;
    if (args["has-deadline"]) filters.hasDeadline = true;
    if (args.status) filters.status = args.status as "todo" | "done" | "dropped";
    if (args.tag) filters.tag = splitList(args.tag);
    if (args.parent) filters.parent = args.parent;
    if (args.search) filters.search = args.search;
    if (args.limit) filters.limit = parseInt(args.limit, 10);
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
    return formatShow(await this.api.show(ref), { groupingTags: this.settings.groupingTags });
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
    const days = args.days ? parseInt(args.days, 10) : 7;
    const stats = await this.api.stats({
      days,
      group: args.group,
      from: args.from,
      to: args.to,
    });
    if (args.format === "json") return JSON.stringify(stats, null, 2);
    return formatStats(stats);
  }

  private async cliSchedule(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const date = args.date ?? "";
    const clear = date === "null" || date === "--" || date === "";
    const r = await this.api.schedule(ref, clear ? null : date);
    const t = await this.api.show(ref);
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "schedule cleared" : `scheduled ${date}`);
  }

  private async cliDeadline(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const date = args.date ?? "";
    const clear = date === "null" || date === "--" || date === "";
    const r = await this.api.deadline(ref, clear ? null : date);
    const t = await this.api.show(ref);
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "deadline cleared" : `deadline ${date}`);
  }

  // US-209: incremental `actual minutes=+30m` — the leading `+` switches
  // to additive mode so the agent doesn't have to read the current value
  // before writing. Plain `minutes=Nm` still does a `set` overwrite.
  // see USER_STORIES.md
  private async cliActual(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const spec = requireArg(args.minutes, "minutes");
    const add = spec.startsWith("+");
    const value = add ? spec.slice(1) : spec;
    const minutes = parseDurationToMinutes(value);
    if (minutes === null) throw new TaskWriterError("invalid_date", `not a duration: ${spec}`);
    const r = await this.api.actual(ref, minutes, add ? "add" : "set");
    const t = await this.api.show(ref);
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, `actual ${add ? "+=" : "="} ${minutes}m`);
  }

  private async cliEstimate(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const spec = requireArg(args.minutes, "minutes");
    const clear = spec === "null" || spec === "--";
    const minutes = clear ? null : parseDurationToMinutes(spec);
    if (!clear && minutes === null) throw new TaskWriterError("invalid_date", `not a duration: ${spec}`);
    const r = await this.api.estimate(ref, minutes);
    const t = await this.api.show(ref);
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "estimate cleared" : `estimate ${minutes}m`);
  }

  // US-203: write idempotency — running `done` on an already-done task
  // returns `ok ... unchanged (already done ✅ <date>)` instead of erroring.
  // The unchanged signal is computed in the writer and surfaced by
  // formatOkWrite below.
  // see USER_STORIES.md
  private async cliDone(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const at = args.at ?? null;
    const r = await this.api.done(ref, at);
    const t = await this.api.show(ref);
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    if (r.unchanged) return formatOkWrite(t, null, null, r.before, r.after, true, "already done", `unchanged (already done ✅ ${t.completed ?? ""})`);
    return formatOkWrite(t, null, null, r.before, r.after, false, "done");
  }

  private async cliUndone(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const r = await this.api.undone(ref);
    const t = await this.api.show(ref);
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    if (r.unchanged) return formatOkWrite(t, null, null, r.before, r.after, true, "already todo", "unchanged (already todo)");
    return formatOkWrite(t, null, null, r.before, r.after, false, "undone");
  }

  private async cliAbandon(args: CliArgs, label: "abandoned" | "dropped"): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const r = await this.api.drop(ref);
    const t = await this.api.show(ref);
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    if (r.unchanged) {
      return formatOkWrite(t, null, null, r.before, r.after, true, `already ${label}`, `unchanged (already ${label})`);
    }
    return formatOkWrite(t, null, null, r.before, r.after, false, label);
  }

  // US-213: `add stamp-created=true|false` lets the caller override the
  // global stampCreated setting for one write. Agents back-filling
  // historical tasks set it to `false` so the auto `➕ today` stamp
  // doesn't pollute the timeline with bulk-import "creation" dates.
  // see USER_STORIES.md
  private async cliAdd(args: CliArgs): Promise<string> {
    const text = requireArg(args.text, "text");
    const estimateSpec = args.estimate;
    const estimate = estimateSpec ? parseDurationToMinutes(estimateSpec) ?? undefined : undefined;
    // `stampCreated` flag lets caller override the setting (default: true). Pass
    // `stamp-created=false` on the CLI to disable.
    const stampCreated =
      args["stamp-created"] !== undefined
        ? args["stamp-created"] !== "false"
        : this.settings.stampCreated;
    const r = await this.api.add({
      text,
      to: args.to,
      tag: args.tag ? splitList(args.tag) : undefined,
      scheduled: args.scheduled,
      deadline: args.deadline,
      estimate,
      parent: args.parent,
      stampCreated,
      inboxFallback: this.settings.inboxPath,
    });
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    return formatAdd(r);
  }

  private async cliTag(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const tag = requireArg(args.tag, "tag");
    const remove = !!args.remove;
    const r = remove ? await this.api.tag(ref, tag, true) : await this.api.tag(ref, tag);
    const t = await this.api.show(ref);
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
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
    this.refreshOpenViews().catch((e) => console.warn("[task-center] refresh:", e));
    // After nest, the original ref may not resolve (line moved); show the parent instead.
    const parent = await this.api.show(under);
    const label = r.unchanged
      ? "already nested"
      : r.crossFile
        ? `nested under ${parent.id} (cross-file)`
        : `nested under ${parent.id}`;
    return formatOkWrite(parent, null, null, r.before, r.after, r.unchanged, label, r.unchanged ? "unchanged" : undefined);
  }
}

function requireArg(v: string | undefined, name: string): string {
  if (v === undefined || v === "" || v === "true") {
    throw new TaskWriterError("invalid_date", `${name} is required (pass ${name}=<value>)`);
  }
  return v;
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
