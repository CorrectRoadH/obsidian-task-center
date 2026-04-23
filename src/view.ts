import {
  ItemView,
  WorkspaceLeaf,
  Menu,
  Notice,
  TFile,
  App,
  EventRef,
  MarkdownView,
} from "obsidian";
import { ParsedTask, VIEW_TYPE_BETTER_TASK, BetterTaskSettings } from "./types";
import { parseVaultTasks, formatMinutes } from "./parser";
import {
  BetterTaskApi,
  filterTasks,
  formatShow,
} from "./cli";
import {
  todayISO,
  toISO,
  fromISO,
  addDays,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  daysBetween,
  pad,
} from "./dates";
import { QuickAddModal } from "./quickadd";
import { t as tr, getLocale } from "./i18n";
import type BetterTaskPlugin from "./main";

type TabKey = "week" | "month" | "completed" | "unscheduled";

interface ViewState {
  tab: TabKey;
  anchorISO: string; // For week/month nav
  selectedTaskId: string | null;
  filter: string;
  showUnscheduledPool: boolean;
}

const WEEKDAY_KEYS = [
  "weekday.0",
  "weekday.1",
  "weekday.2",
  "weekday.3",
  "weekday.4",
  "weekday.5",
  "weekday.6",
] as const;

function weekdayLabel(dow: number): string {
  const label = tr(WEEKDAY_KEYS[dow]);
  return getLocale() === "zh" ? `周${label}` : label;
}

export class BetterTaskView extends ItemView {
  plugin: BetterTaskPlugin;
  api: BetterTaskApi;
  tasks: ParsedTask[] = [];
  state: ViewState;
  private refreshTimer: number | null = null;
  private modifyRef: EventRef | null = null;
  private metadataRef: EventRef | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BetterTaskPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.api = plugin.api;
    this.state = {
      tab: plugin.settings.defaultView ?? "week",
      anchorISO: todayISO(),
      selectedTaskId: null,
      filter: "",
      showUnscheduledPool: true,
    };
  }

  getViewType(): string {
    return VIEW_TYPE_BETTER_TASK;
  }
  getDisplayText(): string {
    return "Task Board";
  }
  getIcon(): string {
    return "kanban-square";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("better-task-view");
    await this.reloadTasks();
    this.render();

    // Subscribe to file modifications
    this.modifyRef = this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "md") {
        this.scheduleRefresh();
      }
    });
    this.metadataRef = this.app.metadataCache.on("resolved", () => {
      this.scheduleRefresh();
    });
    this.registerEvent(this.modifyRef);
    this.registerEvent(this.metadataRef);

    // Keyboard
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleKey(e));
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(async () => {
      this.refreshTimer = null;
      await this.reloadTasks();
      this.render();
    }, 400);
  }

  async reloadTasks() {
    this.tasks = await parseVaultTasks(this.app);
  }

  setTab(tab: TabKey) {
    this.state.tab = tab;
    this.render();
  }

  render() {
    const el = this.contentEl;
    // Preserve scroll position of the body across rebuilds
    const oldBody = el.querySelector(".bt-body");
    const savedScrollTop = oldBody ? (oldBody as HTMLElement).scrollTop : 0;

    el.empty();
    el.addClass("better-task-view");

    const header = el.createDiv({ cls: "bt-header" });
    this.renderTabBar(header);
    this.renderToolbar(header);

    const body = el.createDiv({ cls: "bt-body" });
    if (this.tasks.length === 0) {
      this.renderOnboarding(body);
    } else {
      switch (this.state.tab) {
        case "week":
          this.renderWeek(body);
          this.renderUnscheduledPool(body);
          break;
        case "month":
          this.renderMonth(body);
          this.renderUnscheduledPool(body);
          break;
        case "completed":
          this.renderCompleted(body);
          break;
        case "unscheduled":
          this.renderUnscheduledBig(body);
          break;
      }
    }

    this.renderFooter(el);

    // Restore scroll after layout settles
    if (savedScrollTop > 0) {
      const newBody = el.querySelector(".bt-body") as HTMLElement | null;
      if (newBody) {
        // rAF ensures contents are laid out so scrollTop clamps correctly
        window.requestAnimationFrame(() => {
          newBody.scrollTop = savedScrollTop;
        });
      }
    }
  }

  private renderOnboarding(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "bt-onboarding" });
    wrap.createEl("h2", { text: tr("onboarding.title") });
    wrap.createEl("p", { text: tr("onboarding.body") });
    const btn = wrap.createEl("button", { text: tr("onboarding.cta"), cls: "bt-onboarding-cta" });
    btn.addEventListener("click", () => this.openQuickAdd());
  }

  // ---------- Header ----------

  private renderTabBar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-tabbar" });
    const tabs: Array<{ key: TabKey; label: string; hotkey: string }> = [
      { key: "week", label: tr("tab.week"), hotkey: "⌃1" },
      { key: "month", label: tr("tab.month"), hotkey: "⌃2" },
      { key: "completed", label: tr("tab.completed"), hotkey: "⌃3" },
      { key: "unscheduled", label: tr("tab.unscheduled"), hotkey: "⌃4" },
    ];
    for (const t of tabs) {
      const btn = bar.createDiv({ cls: "bt-tab" + (this.state.tab === t.key ? " active" : "") });
      btn.createSpan({ text: t.label });
      btn.createSpan({ text: t.hotkey, cls: "bt-hotkey" });
      btn.addEventListener("click", () => this.setTab(t.key));
    }
  }

  private renderToolbar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-toolbar" });

    // Navigation arrows for week/month
    if (this.state.tab === "week" || this.state.tab === "month") {
      const nav = bar.createDiv({ cls: "bt-nav" });
      const prev = nav.createEl("button", { text: "◀" });
      const today = nav.createEl("button", { text: tr("toolbar.today") });
      const next = nav.createEl("button", { text: "▶" });
      const label = nav.createSpan({ cls: "bt-nav-label" });
      label.setText(this.navLabel());
      prev.addEventListener("click", () => {
        this.state.anchorISO = addDays(this.state.anchorISO, this.state.tab === "week" ? -7 : -28);
        this.render();
      });
      next.addEventListener("click", () => {
        this.state.anchorISO = addDays(this.state.anchorISO, this.state.tab === "week" ? 7 : 28);
        this.render();
      });
      today.addEventListener("click", () => {
        this.state.anchorISO = todayISO();
        this.render();
      });
    }

    // Search box
    const search = bar.createEl("input", { type: "text", placeholder: tr("toolbar.filter") });
    search.addClass("bt-search");
    search.value = this.state.filter;
    search.addEventListener("input", () => {
      this.state.filter = search.value;
      this.render();
      // keep focus
      const el = this.contentEl.querySelector(".bt-search") as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });

    // + button
    const add = bar.createEl("button", { text: tr("toolbar.add") });
    add.addClass("bt-add-btn");
    add.addEventListener("click", () => this.openQuickAdd());

    // settings gear
    const gear = bar.createEl("button", { text: "⚙" });
    gear.addClass("bt-gear");
    gear.addEventListener("click", () => {
      (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
      (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById("obsidian-better-task");
    });
  }

  private navLabel(): string {
    if (this.state.tab === "week") {
      const start = startOfWeek(this.state.anchorISO, this.plugin.settings.weekStartsOn);
      const end = addDays(start, 6);
      return `${start} → ${end}`;
    } else if (this.state.tab === "month") {
      const d = fromISO(this.state.anchorISO);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    }
    return "";
  }

  // ---------- Week ----------

  private renderWeek(parent: HTMLElement) {
    const today = todayISO();
    const weekStart = startOfWeek(this.state.anchorISO, this.plugin.settings.weekStartsOn);
    const days: string[] = [];
    for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i));

    const wrapper = parent.createDiv({ cls: "bt-week" });
    const filter = this.getTextFilter();

    for (const day of days) {
      const col = wrapper.createDiv({ cls: "bt-week-col" + (day === today ? " today" : "") });
      const head = col.createDiv({ cls: "bt-week-head" });
      const d = fromISO(day);
      head.createSpan({
        text: weekdayLabel(d.getDay()),
        cls: "bt-week-dow",
      });
      head.createSpan({ text: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, cls: "bt-week-date" });

      const dayTasks = this.tasks
        .filter((t) => t.scheduled === day && t.status === "todo" && !t.inheritsTerminal)
        .filter(filter);
      const topLevel = this.hideChildrenOfVisibleParents(dayTasks);
      const stats = col.createSpan({
        text: this.columnStats(dayTasks),
        cls: "bt-week-stats",
      });
      stats.title = "scheduled estimate (hours)";

      const list = col.createDiv({ cls: "bt-week-list" });
      this.makeDropZone(list, day);
      for (const t of topLevel) {
        this.renderCard(list, t);
      }
    }
  }

  private columnStats(tasks: ParsedTask[]): string {
    const sum = tasks.reduce((s, t) => s + (t.estimate ?? 0), 0);
    if (sum === 0) return `${tasks.length}`;
    return `${tasks.length} · ${formatMinutes(sum)}`;
  }

  /**
   * If a task's parent is also in the visible set, hide the child at the top
   * level — it will still render inside the parent's children block.
   */
  private hideChildrenOfVisibleParents(visible: ParsedTask[]): ParsedTask[] {
    const ids = new Set(visible.map((t) => t.id));
    return visible.filter((t) => {
      if (t.parentLine === null) return true;
      const parentId = `${t.path}:L${t.parentLine + 1}`;
      return !ids.has(parentId);
    });
  }

  // ---------- Month ----------

  private renderMonth(parent: HTMLElement) {
    const today = todayISO();
    const weekStart = this.plugin.settings.weekStartsOn;
    const first = startOfMonth(this.state.anchorISO);
    const last = endOfMonth(this.state.anchorISO);
    const gridStart = startOfWeek(first, weekStart);
    const gridDays: string[] = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      gridDays.push(d);
      if (i >= 27 && d > last) break;
    }

    const wrapper = parent.createDiv({ cls: "bt-month" });
    // DOW header
    const header = wrapper.createDiv({ cls: "bt-month-header" });
    for (let i = 0; i < 7; i++) {
      const d = fromISO(addDays(gridStart, i));
      header.createDiv({ text: weekdayLabel(d.getDay()), cls: "bt-month-dow" });
    }

    const grid = wrapper.createDiv({ cls: "bt-month-grid" });
    const filter = this.getTextFilter();

    for (const day of gridDays) {
      const dObj = fromISO(day);
      const isCurMonth = day >= first && day <= last;
      const cell = grid.createDiv({
        cls:
          "bt-month-cell" +
          (day === today ? " today" : "") +
          (isCurMonth ? "" : " other-month"),
      });
      const dayTasksAll = this.tasks
        .filter((t) => t.scheduled === day && t.status === "todo" && !t.inheritsTerminal)
        .filter(filter);
      const dayTasks = this.hideChildrenOfVisibleParents(dayTasksAll);
      const head = cell.createDiv({ cls: "bt-month-cell-head" });
      head.createSpan({ text: `${dObj.getDate()}`, cls: "bt-month-cell-date" });
      if (dayTasks.length > 0) {
        head.createSpan({ text: `${dayTasks.length}`, cls: "bt-month-cell-count" });
      }
      const list = cell.createDiv({ cls: "bt-month-cell-list" });
      this.makeDropZone(cell, day);
      for (const t of dayTasks.slice(0, 6)) {
        const chip = list.createDiv({ cls: "bt-mini-card" });
        chip.dataset.taskId = t.id;
        chip.draggable = true;
        chip.setText(t.title);
        if (t.deadline) {
          const deadlineDays = daysBetween(today, t.deadline);
          if (deadlineDays < 0) chip.addClass("overdue");
          else if (deadlineDays <= 3) chip.addClass("near-deadline");
        }
        this.wireCardEvents(chip, t);
      }
      if (dayTasks.length > 6) {
        list.createDiv({ text: `+${dayTasks.length - 6} more`, cls: "bt-mini-more" });
      }
    }
  }

  // ---------- Completed ----------

  private renderCompleted(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const completed = this.tasks
      .filter((t) => t.status === "done" && t.completed)
      .filter(filter)
      .sort((a, b) => (b.completed! < a.completed! ? -1 : 1));

    const wrap = parent.createDiv({ cls: "bt-completed" });

    // Group by week
    const weeks = new Map<string, ParsedTask[]>();
    for (const t of completed) {
      const weekKey = startOfWeek(t.completed!, this.plugin.settings.weekStartsOn);
      if (!weeks.has(weekKey)) weeks.set(weekKey, []);
      weeks.get(weekKey)!.push(t);
    }
    const weekKeys = Array.from(weeks.keys()).sort((a, b) => (a < b ? 1 : -1));

    if (weekKeys.length === 0) {
      wrap.createDiv({ text: tr("completed.empty"), cls: "bt-empty" });
      return;
    }

    for (const wk of weekKeys) {
      const group = wrap.createDiv({ cls: "bt-completed-week" });
      const items = weeks.get(wk)!;
      const sumActual = items.reduce((s, t) => s + (t.actual ?? 0), 0);
      const sumEst = items.reduce((s, t) => s + (t.estimate ?? 0), 0);
      const accuracy = sumEst > 0 ? (sumActual / sumEst) : null;
      const accLabel =
        accuracy !== null
          ? tr("completed.accuracy", { ratio: accuracy.toFixed(2), actual: sumActual, est: sumEst })
          : tr("completed.total", { actual: sumActual });

      const head = group.createDiv({ cls: "bt-completed-week-head" });
      head.createSpan({ text: tr("completed.weekOf", { date: wk }), cls: "bt-completed-week-label" });
      head.createSpan({ text: tr("completed.tasks", { n: items.length }), cls: "bt-completed-count" });
      head.createSpan({ text: accLabel, cls: "bt-completed-accuracy" });

      const list = group.createDiv({ cls: "bt-completed-list" });
      for (const t of items) {
        const row = list.createDiv({ cls: "bt-completed-row" });
        row.dataset.taskId = t.id;
        row.createSpan({ text: `${t.completed}`, cls: "bt-completed-date" });
        const titleEl = row.createSpan({ text: t.title, cls: "bt-completed-title" });
        const meta = row.createSpan({ cls: "bt-completed-meta" });
        if (t.estimate || t.actual) {
          meta.setText(
            `${t.actual ? formatMinutes(t.actual) : "—"} / ${t.estimate ? formatMinutes(t.estimate) : "—"}`,
          );
        }
        // click → jump to source
        row.addEventListener("click", () => this.openAtSource(t));
      }
    }
  }

  // ---------- Unscheduled ----------

  private renderUnscheduledPool(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const unscheduledAll = this.tasks
      .filter((t) => !t.scheduled && t.status === "todo" && !t.inheritsTerminal)
      .filter(filter);
    const unscheduled = this.hideChildrenOfVisibleParents(unscheduledAll);
    if (unscheduled.length === 0 && !this.state.showUnscheduledPool) return;

    const wrap = parent.createDiv({ cls: "bt-pool-wrap" });

    const section = wrap.createDiv({ cls: "bt-unscheduled-pool" });
    const head = section.createDiv({ cls: "bt-unscheduled-head" });
    head.createSpan({
      text: `${tr("pool.unscheduled")}  (${unscheduled.length})`,
      cls: "bt-unscheduled-label",
    });
    head.createSpan({
      text: tr("pool.hint"),
      cls: "bt-unscheduled-hint",
    });

    const list = section.createDiv({ cls: "bt-unscheduled-list" });
    this.makeDropZone(list, null);
    for (const t of unscheduled) {
      this.renderCard(list, t);
    }

    this.renderTrashZone(wrap);
  }

  private renderTrashZone(parent: HTMLElement) {
    const trash = parent.createDiv({ cls: "bt-trash" });
    trash.createDiv({ cls: "bt-trash-icon", text: "🗑" });
    const label = trash.createDiv({ cls: "bt-trash-label" });
    label.createSpan({ text: tr("trash.title"), cls: "bt-trash-title" });
    label.createSpan({
      text: tr("trash.hint"),
      cls: "bt-trash-hint",
    });

    trash.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (!dt || !Array.from(dt.types).includes("text/task-id")) return;
      e.preventDefault();
      dt.dropEffect = "move";
      trash.addClass("drop-hover");
    });
    trash.addEventListener("dragleave", () => trash.removeClass("drop-hover"));
    trash.addEventListener("drop", async (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const id = dt.getData("text/task-id");
      if (!id) return;
      e.preventDefault();
      trash.removeClass("drop-hover");
      try {
        await this.api.drop(id);
        new Notice(tr("trash.dropped"));
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
      }
      this.scheduleRefresh();
    });
  }

  private renderUnscheduledBig(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const unscheduledAll = this.tasks
      .filter((t) => !t.scheduled && t.status === "todo" && !t.inheritsTerminal)
      .filter(filter);
    const unscheduled = this.hideChildrenOfVisibleParents(unscheduledAll);

    const wrap = parent.createDiv({ cls: "bt-unscheduled-big" });
    const head = wrap.createDiv({ cls: "bt-unscheduled-big-head" });
    head.createSpan({
      text: `${tr("pool.unscheduled")} (${unscheduled.length})`,
      cls: "bt-unscheduled-big-label",
    });
    const hint = head.createSpan({ cls: "bt-unscheduled-big-hint" });
    hint.setText(tr("unscheduled.hint"));

    // Group by quadrant
    const otherLabel = tr("pool.other");
    const quads: Record<string, ParsedTask[]> = { "#1象限": [], "#2象限": [], "#3象限": [], "#4象限": [], [otherLabel]: [] };
    for (const task of unscheduled) {
      let assigned = false;
      for (const q of ["#1象限", "#2象限", "#3象限", "#4象限"]) {
        if (task.tags.includes(q)) {
          quads[q].push(task);
          assigned = true;
          break;
        }
      }
      if (!assigned) quads[otherLabel].push(task);
    }
    const grid = wrap.createDiv({ cls: "bt-unscheduled-grid" });
    for (const [label, list] of Object.entries(quads)) {
      if (list.length === 0) continue;
      const col = grid.createDiv({ cls: "bt-unscheduled-col" });
      col.createDiv({
        text: `${label} (${list.length})`,
        cls: "bt-unscheduled-col-head",
      });
      for (const t of list) this.renderCard(col, t);
    }

    this.renderTrashZone(wrap);
  }

  // ---------- Card ----------

  private renderCard(parent: HTMLElement, t: ParsedTask) {
    const card = parent.createDiv({ cls: "bt-card" });
    card.dataset.taskId = t.id;
    card.draggable = true;
    if (this.state.selectedTaskId === t.id) card.addClass("selected");

    const quad = this.quadrantClass(t.tags);
    if (quad) card.addClass(quad);

    // Deadline signals
    if (t.deadline) {
      const today = todayISO();
      const dd = daysBetween(today, t.deadline);
      if (dd < 0) card.addClass("overdue");
      else if (dd <= 3) card.addClass("near-deadline");
    }

    // Title row
    const titleRow = card.createDiv({ cls: "bt-card-title-row" });
    const check = titleRow.createDiv({ cls: "bt-check" });
    check.setText(statusIcon(t.status));
    check.title = "Toggle done (Space)";
    check.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (t.status === "done") await this.api.undone(t.id);
      else await this.api.done(t.id);
      this.scheduleRefresh();
    });

    const title = titleRow.createDiv({ cls: "bt-card-title", text: t.title });
    title.title = t.title; // tooltip for long titles
    title.addEventListener("click", (e) => {
      e.stopPropagation();
      this.enterTitleEdit(title, t);
    });
    if (t.status === "done") card.addClass("done");

    // Meta row
    const meta = card.createDiv({ cls: "bt-card-meta" });
    if (t.estimate) meta.createSpan({ text: `est ${formatMinutes(t.estimate)}`, cls: "bt-meta-est" });
    if (t.deadline) meta.createSpan({ text: `📅${t.deadline}`, cls: "bt-meta-deadline" });
    if (t.actual) meta.createSpan({ text: `act ${formatMinutes(t.actual)}`, cls: "bt-meta-actual" });
    if (t.scheduled && !isTodayISO(t.scheduled)) {
      meta.createSpan({ text: `⏳${t.scheduled}`, cls: "bt-meta-sched" });
    }
    const path = meta.createSpan({ text: compactPath(t.path), cls: "bt-meta-path" });
    path.title = t.path;

    // Children expansion
    const childLines = t.childrenLines;
    if (childLines.length > 0) {
      const expander = card.createDiv({ cls: "bt-card-children" });
      const children = childLines
        .map((l) => this.tasks.find((x) => x.path === t.path && x.line === l))
        .filter((x): x is ParsedTask => !!x);
      for (const c of children) {
        const subCard = expander.createDiv({ cls: "bt-subcard" });
        subCard.dataset.taskId = c.id;
        subCard.draggable = true;
        subCard.createDiv({ cls: "bt-sub-check", text: statusIcon(c.status) });
        subCard.createDiv({ cls: "bt-subcard-title", text: c.title });
        if (c.estimate) subCard.createDiv({ cls: "bt-sub-est", text: formatMinutes(c.estimate) });
        this.wireCardEvents(subCard, c);
      }
    }

    this.wireCardEvents(card, t);
  }

  private wireCardEvents(el: HTMLElement, t: ParsedTask) {
    // Drag source
    el.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData("text/task-id", t.id);
      e.dataTransfer.effectAllowed = "move";
      el.addClass("dragging");
    });
    el.addEventListener("dragend", () => {
      el.removeClass("dragging");
    });

    // Click → select
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      this.state.selectedTaskId = t.id;
      this.contentEl.focus();
      this.render();
    });

    // Right-click context menu
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openContextMenu(e as MouseEvent, t);
    });

    // Double-click → open source
    el.addEventListener("dblclick", () => this.openAtSource(t));
  }

  private makeDropZone(el: HTMLElement, targetDate: string | null) {
    el.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (!dt || !Array.from(dt.types).includes("text/task-id")) return;
      e.preventDefault();
      dt.dropEffect = "move";
      el.addClass("drop-hover");
    });
    el.addEventListener("dragleave", () => {
      el.removeClass("drop-hover");
    });
    el.addEventListener("drop", async (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const id = dt.getData("text/task-id");
      if (!id) return;
      e.preventDefault();
      el.removeClass("drop-hover");
      try {
        await this.api.schedule(id, targetDate);
        new Notice(
          targetDate ? tr("notice.scheduled", { date: targetDate }) : tr("notice.clearedSchedule"),
        );
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
      }
      this.scheduleRefresh();
    });
  }

  private getTextFilter(): (t: ParsedTask) => boolean {
    const q = this.state.filter.trim().toLowerCase();
    if (!q) return () => true;
    return (t) => {
      if (t.title.toLowerCase().includes(q)) return true;
      for (const tag of t.tags) if (tag.toLowerCase().includes(q)) return true;
      return false;
    };
  }

  private quadrantClass(tags: string[]): string | null {
    for (const tag of tags) {
      const m = tag.match(/^#([1-4])象限$/);
      if (m) return `q${m[1]}`;
    }
    return null;
  }

  // ---------- Footer / Add ----------

  private renderFooter(parent: HTMLElement) {
    const foot = parent.createDiv({ cls: "bt-footer" });
    const info = foot.createDiv({ cls: "bt-footer-info" });
    const total = this.tasks.filter((t) => t.status === "todo" && !t.inheritsTerminal).length;
    const done = this.tasks.filter((t) => t.status === "done").length;
    const overdue = this.tasks.filter(
      (t) => t.status === "todo" && !t.inheritsTerminal && t.deadline && t.deadline < todayISO(),
    ).length;
    info.setText(tr("footer.status", { todo: total, done, overdue }));

    const selected = this.getSelectedTask();
    if (selected) {
      const bar = foot.createDiv({ cls: "bt-footer-selected" });
      bar.createSpan({
        text: `${tr("footer.selected")}: ${selected.title}`,
        cls: "bt-footer-selected-title",
      });
      bar.createSpan({
        text: ` · ${selected.path}:L${selected.line + 1}`,
        cls: "bt-footer-selected-path",
      });
      bar.createSpan({
        text: " · " + tr("footer.hint"),
        cls: "bt-footer-selected-hint",
      });
    }
  }

  // ---------- Keyboard ----------

  async handleKey(e: KeyboardEvent) {
    // Global tab switching
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const map: Record<string, TabKey> = { "1": "week", "2": "month", "3": "completed", "4": "unscheduled" };
      if (map[e.key]) {
        e.preventDefault();
        this.setTab(map[e.key]);
        return;
      }
    }

    // Quick add
    if ((e.ctrlKey || e.metaKey) && e.key === "t" && !e.shiftKey && !e.altKey) {
      // Ctrl+T / Cmd+T — quick add
      e.preventDefault();
      this.openQuickAdd();
      return;
    }

    // Selected-card shortcuts
    const sel = this.getSelectedTask();
    if (!sel) return;
    // Don't interfere when input is focused
    if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) return;

    if (e.key >= "1" && e.key <= "4" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      await this.changeQuadrant(sel, e.key);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (!sel.scheduled) return;
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const newDate = addDays(sel.scheduled, delta);
      await this.api.schedule(sel.id, newDate);
      this.scheduleRefresh();
      return;
    }
    if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      this.openDatePrompt(sel);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (sel.status === "done") await this.api.undone(sel.id);
      else await this.api.done(sel.id);
      this.scheduleRefresh();
      return;
    }
    if (e.key === "e" || e.key === "E") {
      e.preventDefault();
      this.openAtSource(sel);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      await this.api.drop(sel.id);
      this.scheduleRefresh();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.openAtSource(sel);
      return;
    }
  }

  private getSelectedTask(): ParsedTask | null {
    if (!this.state.selectedTaskId) return null;
    return this.tasks.find((t) => t.id === this.state.selectedTaskId) ?? null;
  }

  private async changeQuadrant(t: ParsedTask, digit: string) {
    const target = `#${digit}象限`;
    // Remove existing #N象限 tags, add target
    for (const existing of t.tags) {
      if (/^#[1-4]象限$/.test(existing) && existing !== target) {
        await this.api.tag(t.id, existing, true);
      }
    }
    if (!t.tags.includes(target)) {
      await this.api.tag(t.id, target);
    }
    this.scheduleRefresh();
  }

  // ---------- Context menu / source ----------

  openContextMenu(e: MouseEvent, task: ParsedTask) {
    const m = new Menu();
    m.addItem((i) =>
      i.setTitle(tr("ctx.openSource")).onClick(() => this.openAtSource(task)),
    );
    m.addItem((i) =>
      i.setTitle(task.status === "done" ? tr("ctx.markTodo") : tr("ctx.markDone")).onClick(async () => {
        if (task.status === "done") await this.api.undone(task.id);
        else await this.api.done(task.id);
        this.scheduleRefresh();
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.scheduleToday")).onClick(async () => {
        await this.api.schedule(task.id, todayISO());
        this.scheduleRefresh();
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.scheduleTomorrow")).onClick(async () => {
        await this.api.schedule(task.id, addDays(todayISO(), 1));
        this.scheduleRefresh();
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.clearSchedule")).onClick(async () => {
        await this.api.schedule(task.id, null);
        this.scheduleRefresh();
      }),
    );
    m.addSeparator();
    for (let q = 1; q <= 4; q++) {
      m.addItem((i) =>
        i.setTitle(tr("ctx.quadrant", { n: q })).onClick(async () => {
          await this.changeQuadrant(task, q.toString());
        }),
      );
    }
    m.addSeparator();
    m.addItem((i) =>
      i.setTitle(tr("ctx.drop")).onClick(async () => {
        await this.api.drop(task.id);
        this.scheduleRefresh();
      }),
    );
    m.showAtMouseEvent(e);
  }

  async openAtSource(task: ParsedTask) {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) {
      new Notice(tr("notice.fileNotFound", { path: task.path }));
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const editor = view.editor;
      editor.setCursor({ line: task.line, ch: 0 });
      editor.scrollIntoView({ from: { line: task.line, ch: 0 }, to: { line: task.line, ch: 0 } }, true);
    }
  }

  openDatePrompt(task: ParsedTask) {
    const input = window.prompt(
      tr("prompt.setScheduled", { title: task.title }),
      task.scheduled ?? todayISO(),
    );
    if (input === null) return;
    const trimmed = input.trim();
    if (trimmed === "") {
      this.api.schedule(task.id, null).then(() => this.scheduleRefresh());
      return;
    }
    if (trimmed === "today") {
      this.api.schedule(task.id, todayISO()).then(() => this.scheduleRefresh());
      return;
    }
    if (trimmed === "tomorrow") {
      this.api.schedule(task.id, addDays(todayISO(), 1)).then(() => this.scheduleRefresh());
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      this.api.schedule(task.id, trimmed).then(() => this.scheduleRefresh());
      return;
    }
    new Notice(tr("notice.invalidDate"));
  }

  openQuickAdd() {
    new QuickAddModal(this.app, this.api, () => this.scheduleRefresh(), this.plugin.settings).open();
  }

  enterTitleEdit(el: HTMLElement, task: ParsedTask) {
    const oldText = task.title;
    el.empty();
    const input = el.createEl("input", { type: "text" });
    input.addClass("bt-title-edit");
    input.value = oldText;
    input.focus();
    input.select();
    let committed = false;
    const commit = async (save: boolean) => {
      if (committed) return;
      committed = true;
      const newVal = input.value.trim();
      if (save && newVal && newVal !== oldText) {
        try {
          await this.api.rename(task.id, newVal);
        } catch (e) {
          new Notice(tr("notice.error", { msg: (e as Error).message }), 4000);
        }
      }
      this.scheduleRefresh();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      } else {
        // Don't let parent view hotkeys (1-4, Space, D, E, Delete, arrows) fire while editing
        e.stopPropagation();
      }
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dragstart", (e) => e.preventDefault());
  }
}

function statusIcon(s: string): string {
  if (s === "done") return "✔";
  if (s === "dropped") return "✕";
  if (s === "in_progress") return "◐";
  return "○";
}

function isTodayISO(iso: string): boolean {
  return iso === todayISO();
}

function compactPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}
