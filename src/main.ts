import { Plugin, WorkspaceLeaf, Notice, TFile, CliData } from "obsidian";
import { BetterTaskSettings, DEFAULT_SETTINGS, VIEW_TYPE_BETTER_TASK } from "./types";
import { BetterTaskSettingTab } from "./settings";
import { BetterTaskView } from "./view";
import {
  BetterTaskApi,
  formatList,
  formatShow,
  formatStats,
  formatOkWrite,
  formatAdd,
} from "./cli";
import { QuickAddModal } from "./quickadd";
import { t as tr } from "./i18n";
import { todayISO } from "./dates";
import { parseDurationToMinutes } from "./parser";
import { TaskWriterError } from "./writer";

// CliData / CliFlags / CliHandler come from obsidian.d.ts (since API 1.12.2).
// CliData has an index signature of `string | 'true'` — boolean flags arrive
// as the literal string "true".
type CliArgs = CliData;

export default class BetterTaskPlugin extends Plugin {
  settings!: BetterTaskSettings;
  api!: BetterTaskApi;
  private statusBar: HTMLElement | null = null;
  private statusBarTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.api = new BetterTaskApi(this.app);

    // View
    this.registerView(VIEW_TYPE_BETTER_TASK, (leaf) => new BetterTaskView(leaf, this));
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
        void this.refreshOpenViews();
        new Notice(tr("notice.reloaded"));
      },
    });

    // Settings tab
    this.addSettingTab(new BetterTaskSettingTab(this.app, this));

    // CLI — native Obsidian CLI handlers registered via the 1.12.2+ API.
    // All verbs are colon-grouped under `better-task:…`, matching the Obsidian
    // convention (compare `daily:read`, `base:query`).
    if (typeof (this as Plugin).registerCliHandler === "function") {
      try {
        this.registerAllCliHandlers();
      } catch (e) {
        // A collision with another plugin registering the same verb is a soft
        // failure — the GUI remains fully usable without the shell CLI.
        console.error("[better-task] CLI registration failed:", e);
        new Notice(
          "Better Task: CLI verbs failed to register (likely a namespace collision). GUI still works.",
          6000,
        );
      }
    } else {
      console.warn(
        "[better-task] app.cli.registerHandler not available — upgrade Obsidian to ≥ 1.12.2 for the CLI.",
      );
    }

    // Status bar — shows the active todo count, refreshed on vault changes.
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("better-task-status");
    this.statusBar.addEventListener("click", () => this.activateView());
    this.app.workspace.onLayoutReady(() => this.refreshStatusBar());
    const onVaultChange = (f: unknown) => {
      if (f instanceof TFile && f.extension === "md") this.scheduleStatusBarRefresh();
    };
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => this.scheduleStatusBarRefresh()),
    );

    // Open on startup
    if (this.settings.openOnStartup) {
      this.app.workspace.onLayoutReady(() => this.activateView());
    }
  }

  private scheduleStatusBarRefresh() {
    if (this.statusBarTimer !== null) window.clearTimeout(this.statusBarTimer);
    this.statusBarTimer = window.setTimeout(() => {
      this.statusBarTimer = null;
      this.refreshStatusBar();
    }, 500);
  }

  async refreshStatusBar() {
    if (!this.statusBar) return;
    try {
      const all = await this.api.allTasks();
      const today = todayISO();
      const todo = all.filter((t) => t.status === "todo" && !t.inheritsTerminal);
      const todayCount = todo.filter((t) => t.scheduled === today).length;
      const overdue = todo.filter((t) => t.deadline && t.deadline < today).length;
      const parts = [`📋 ${todayCount} today`];
      if (overdue > 0) parts.push(`⚠ ${overdue} overdue`);
      this.statusBar.setText(parts.join(" · "));
      this.statusBar.title = "Click to open Task Board";
    } catch {
      // ignore
    }
  }

  onunload() {
    if (this.statusBarTimer !== null) {
      window.clearTimeout(this.statusBarTimer);
      this.statusBarTimer = null;
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
    const existing = workspace.getLeavesOfType(VIEW_TYPE_BETTER_TASK);
    let leaf: WorkspaceLeaf;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_BETTER_TASK, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async refreshOpenViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BETTER_TASK)) {
      const view = leaf.view;
      if (view instanceof BetterTaskView) {
        await view.reloadTasks();
        view.render();
      }
    }
  }

  // ---------- CLI registration ----------

  private registerAllCliHandlers() {
    this.registerCliHandler(
      "better-task:list",
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
      "better-task:show",
      "Show one task in full detail",
      {
        ref: { value: "<path:line|hash>", description: "Task id", required: true },
      },
      (args) => this.cliShow(args),
    );

    this.registerCliHandler(
      "better-task:stats",
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
      "better-task:schedule",
      "Set or clear ⏳ scheduled date on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        date: { value: "<YYYY-MM-DD|null>", description: "'null' clears the date" },
      },
      (args) => this.cliSchedule(args),
    );

    this.registerCliHandler(
      "better-task:deadline",
      "Set or clear 📅 deadline on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        date: { value: "<YYYY-MM-DD|null>", description: "'null' clears the date" },
      },
      (args) => this.cliDeadline(args),
    );

    this.registerCliHandler(
      "better-task:actual",
      "Set or add actual minutes ([actual:: Nm]) on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        minutes: { value: "<Nm|+Nm>", description: "30m, 1h, +15m (additive)" },
      },
      (args) => this.cliActual(args),
    );

    this.registerCliHandler(
      "better-task:estimate",
      "Set or clear [estimate:: Nm] on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        minutes: { value: "<Nm|null>", description: "'null' clears" },
      },
      (args) => this.cliEstimate(args),
    );

    this.registerCliHandler(
      "better-task:done",
      "Mark a task done (✅ today unless at= given)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        at: { value: "<YYYY-MM-DD>", description: "Override completion date" },
      },
      (args) => this.cliDone(args),
    );

    this.registerCliHandler(
      "better-task:undone",
      "Unmark a task (remove ✅ and reset checkbox)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
      },
      (args) => this.cliUndone(args),
    );

    this.registerCliHandler(
      "better-task:drop",
      "Mark a task dropped ([-] + ❌ today; children cascade)",
      {
        ref: { value: "<id>", description: "Task id", required: true },
      },
      (args) => this.cliDrop(args),
    );

    this.registerCliHandler(
      "better-task:add",
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
      "better-task:tag",
      "Add or remove a tag on a task",
      {
        ref: { value: "<id>", description: "Task id", required: true },
        tag: { value: "<tag>", description: "Tag (with or without leading #)" },
        remove: { description: "Remove instead of add" },
      },
      (args) => this.cliTag(args),
    );
  }

  // ---------- CLI verb implementations ----------
  //
  // Each handler converts native Obsidian CLI args → BetterTaskApi call →
  // returns human-readable text (greppable, first column always an id).

  private async cliList(args: CliArgs): Promise<string> {
    const filters: Parameters<BetterTaskApi["list"]>[0] = {};
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
    return formatList(all, header);
  }

  private async cliShow(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    return formatShow(await this.api.show(ref));
  }

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
    void this.refreshOpenViews();
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "schedule cleared" : `scheduled ${date}`);
  }

  private async cliDeadline(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const date = args.date ?? "";
    const clear = date === "null" || date === "--" || date === "";
    const r = await this.api.deadline(ref, clear ? null : date);
    const t = await this.api.show(ref);
    void this.refreshOpenViews();
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "deadline cleared" : `deadline ${date}`);
  }

  private async cliActual(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const spec = requireArg(args.minutes, "minutes");
    const add = spec.startsWith("+");
    const value = add ? spec.slice(1) : spec;
    const minutes = parseDurationToMinutes(value);
    if (minutes === null) throw new TaskWriterError("invalid_date", `not a duration: ${spec}`);
    const r = await this.api.actual(ref, minutes, add ? "add" : "set");
    const t = await this.api.show(ref);
    void this.refreshOpenViews();
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
    void this.refreshOpenViews();
    return formatOkWrite(t, null, null, r.before, r.after, r.unchanged, clear ? "estimate cleared" : `estimate ${minutes}m`);
  }

  private async cliDone(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const at = args.at ?? null;
    const r = await this.api.done(ref, at);
    const t = await this.api.show(ref);
    void this.refreshOpenViews();
    if (r.unchanged) return formatOkWrite(t, null, null, r.before, r.after, true, "already done", `unchanged (already done ✅ ${t.completed ?? ""})`);
    return formatOkWrite(t, null, null, r.before, r.after, false, "done");
  }

  private async cliUndone(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const r = await this.api.undone(ref);
    const t = await this.api.show(ref);
    void this.refreshOpenViews();
    if (r.unchanged) return formatOkWrite(t, null, null, r.before, r.after, true, "already todo", "unchanged (already todo)");
    return formatOkWrite(t, null, null, r.before, r.after, false, "undone");
  }

  private async cliDrop(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const r = await this.api.drop(ref);
    const t = await this.api.show(ref);
    void this.refreshOpenViews();
    if (r.unchanged) return formatOkWrite(t, null, null, r.before, r.after, true, "already dropped", "unchanged (already dropped)");
    return formatOkWrite(t, null, null, r.before, r.after, false, "dropped");
  }

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
    void this.refreshOpenViews();
    return formatAdd(r);
  }

  private async cliTag(args: CliArgs): Promise<string> {
    const ref = requireArg(args.ref, "ref");
    const tag = requireArg(args.tag, "tag");
    const remove = !!args.remove;
    const r = remove ? await this.api.tag(ref, tag, true) : await this.api.tag(ref, tag);
    const t = await this.api.show(ref);
    void this.refreshOpenViews();
    if (r.unchanged) return formatOkWrite(t, null, null, r.before, r.after, true, "no-op", "unchanged");
    return formatOkWrite(t, null, null, r.before, r.after, false, remove ? "tag removed" : "tag added");
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

function describeFilters(f: Parameters<BetterTaskApi["list"]>[0]): string {
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
