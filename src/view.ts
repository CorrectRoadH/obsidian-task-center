import {
  ItemView,
  WorkspaceLeaf,
  Menu,
  Notice,
  Platform,
  TFile,
  MarkdownView,
} from "obsidian";
import { ParsedTask, VIEW_TYPE_TASK_CENTER } from "./types";
import { formatMinutes } from "./parser";
import { TaskCenterApi, computeStats } from "./cli";
import {
  todayISO,
  fromISO,
  addDays,
  shiftMonth,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  daysBetween,
  isoWeekNumber,
  pad,
} from "./dates";
import { QuickAddModal } from "./quickadd";
import { DatePromptModal } from "./dateprompt";
import { t as tr, getLocale } from "./i18n";
import { animateOut } from "./anim";
import { TabDwellTracker } from "./view/dnd";
import { UndoStack, UndoEntry, UndoOp } from "./view/undo";
import { ContextPopoverController } from "./view/popover";
import { BottomSheet } from "./view/bottom-sheet";
import { attachCardGestures } from "./view/touch";
import { MobileDragController } from "./view/drag-mobile";
import type TaskCenterPlugin from "./main";

type TabKey = "week" | "month" | "completed" | "unscheduled";

interface ViewState {
  tab: TabKey;
  anchorISO: string; // For week/month nav
  selectedTaskId: string | null;
  filter: string;
  showUnscheduledPool: boolean;
  collapsedWeeks: Set<string>; // Week-start ISO → collapsed in completed view
  // Mobile week view: each day-row collapses by default; today is open and
  // tapping a day's head adds its ISO to this set to expand. Desktop ignores
  // this — CSS forces the list visible regardless of the class.
  expandedDays: Set<string>;
}

// `UndoOp` and `UndoEntry` re-exported from `./view/undo` (the canonical
// definitions). Local re-export so existing usage in this file compiles.
export type { UndoOp, UndoEntry };

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

export class TaskCenterView extends ItemView {
  plugin: TaskCenterPlugin;
  api: TaskCenterApi;
  tasks: ParsedTask[] = [];
  state: ViewState;
  private refreshTimer: number | null = null;
  private cacheVersion = 0;
  private cacheUnsub: (() => void) | null = null;
  // Cross-tab drag dwell: hovering a card over a tab head for 600ms switches
  // tabs. UX.md §6.1 / ARCHITECTURE.md §11. One tracker for the whole view —
  // tab heads route their dragover events through `update()`.
  private dwellTracker = new TabDwellTracker<TabKey>({
    durationMs: 600,
    onCommit: (tab) => this.setTab(tab),
  });
  // Card hover popover — implementation in src/view/popover.ts.
  private contextPopover: ContextPopoverController;
  // Undo stack — only records writes initiated from this view (drag / keyboard).
  // CLI writes are not captured. Max 20 entries (UndoStack.MAX).
  private undoStack: UndoStack;
  // Mobile drag controller (US-507) — pointer-based replacement for HTML5
  // DnD that doesn't fire from touch. Lazily created on first mobile drag.
  private mobileDrag: MobileDragController<TabKey> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TaskCenterPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.api = plugin.api;
    this.undoStack = new UndoStack(this.app, {
      onApplied: () => this.scheduleRefresh(),
      notify: (msg, ms) => new Notice(msg, ms),
    });
    this.contextPopover = new ContextPopoverController({
      app: this.app,
      addChild: (c) => this.addChild(c),
      removeChild: (c) => this.removeChild(c),
      isDragging: () => this.contentEl.hasClass("dragging-active"),
    });
    this.state = {
      // Priority: last-closed tab → defaultView setting → "week"
      tab: plugin.settings.lastTab ?? plugin.settings.defaultView ?? "week",
      anchorISO: todayISO(),
      selectedTaskId: null,
      filter: "",
      showUnscheduledPool: true,
      collapsedWeeks: new Set(),
      expandedDays: new Set(),
    };
  }

  getViewType(): string {
    return VIEW_TYPE_TASK_CENTER;
  }
  getDisplayText(): string {
    return "Task Board";
  }
  getIcon(): string {
    return "kanban-square";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("task-center-view");
    // Immediate placeholder so the tab doesn't flash blank on slow-parse vaults.
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "bt-loading", text: tr("loading") });
    await this.reloadTasks();
    this.bumpCacheVersion();
    this.render();

    // Subscribe to the cache — and ONLY the cache. Vault and metadataCache
    // events are handled in one place (cache.bind in main.ts); the view reads
    // a settled snapshot via flatten() after each `cache.changed`. This is
    // the structural fix for BUG.md #3 (double subscription → event flood).
    this.cacheUnsub = this.plugin.cache.on("changed", () => this.scheduleRefresh());

    // Keyboard
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleKey(e));

    // US-510: best-effort portrait lock on mobile when user has the setting
    // on. screen.orientation.lock requires fullscreen on most browsers and
    // is blocked entirely on iOS Safari — we silently swallow the rejection
    // rather than show an error nobody can act on.
    if (Platform.isMobile && this.plugin.settings.mobileForcePortrait) {
      const ori = (screen as Screen & {
        orientation?: { lock?: (o: string) => Promise<void> };
      }).orientation;
      if (ori?.lock) {
        ori.lock("portrait").catch(() => {
          /* OS denied — expected on iOS Safari and Obsidian Mobile in some modes */
        });
      }
    }
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    if (this.cacheUnsub) {
      this.cacheUnsub();
      this.cacheUnsub = null;
    }
    this.dwellTracker.reset();
    this.contextPopover.close();
    if (this.mobileDrag) {
      this.mobileDrag.destroy();
      this.mobileDrag = null;
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(async () => {
      this.refreshTimer = null;
      await this.reloadTasks();
      this.bumpCacheVersion();
      this.render();
    }, 400);
  }

  private bumpCacheVersion() {
    this.cacheVersion++;
    this.contentEl.dataset.testCacheVersion = String(this.cacheVersion);
  }

  private findCardEl(taskId: string): HTMLElement | null {
    return this.contentEl.querySelector(
      `[data-task-id="${CSS.escape(taskId)}"]`,
    ) as HTMLElement | null;
  }

  /**
   * Animate the source card out while running the data mutation in parallel,
   * then refresh immediately (bypassing the debounce so there's no awkward
   * 400ms gap between the fade-out and the layout settling).
   *
   * If the action no-ops (e.g. drop on the same day), the card briefly fades
   * and then reappears in the next render — accepted as a minor cost in
   * exchange for keeping every removal-style action smooth.
   *
   * For actions that add/remove lines (nest, add) the metadata cache lags
   * the file write — its cached `listItems` line numbers point at the wrong
   * content until the cache reparses. Pass `awaitCachePaths` so we wait for
   * `metadataCache.on('changed')` on each affected file before the render.
   */
  private async runWithRemoveAnim(
    taskId: string,
    action: () => Promise<unknown>,
    opts: { awaitCachePaths?: string[] } = {},
  ): Promise<void> {
    const card = this.findCardEl(taskId);
    // Register the cache listener BEFORE kicking off the action so we can't
    // miss a 'changed' event that fires while our awaits are queued.
    const cacheReady = opts.awaitCachePaths && opts.awaitCachePaths.length > 0
      ? this.waitForCacheUpdate(opts.awaitCachePaths)
      : Promise.resolve();
    await Promise.all([
      card ? animateOut(card) : Promise.resolve(),
      action(),
    ]);
    await cacheReady;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.reloadTasks();
    this.render();
  }

  /**
   * Resolve once `TaskCache` has emitted `'changed'` for every file in
   * `paths` (or after `timeoutMs` as a safety net). Used after structural
   * mutations so the next render sees up-to-date list-item line numbers.
   *
   * Reads `cache.on("changed")` (post-reparse), not raw metadataCache
   * (ARCHITECTURE.md §3.1: cache is the sole subscriber to vault events).
   */
  private waitForCacheUpdate(paths: string[], timeoutMs = 1500): Promise<void> {
    const remaining = new Set(paths);
    if (remaining.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: number | null = null;
      const off = this.plugin.cache.on("changed", (changedPaths: Set<string>) => {
        for (const p of changedPaths) remaining.delete(p);
        if (remaining.size === 0) {
          if (timer !== null) window.clearTimeout(timer);
          off();
          resolve();
        }
      });
      timer = window.setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
    });
  }

  async reloadTasks() {
    // Wait for any in-flight single-file reparses to settle, so the snapshot
    // we take below reflects every metadataCache event Obsidian has dispatched
    // up to now. Without this, a write-then-reload race could read pre-parse
    // state.
    //
    // First reload also primes the cache (single full-vault pass, skipping
    // files Obsidian has confirmed task-free). Subsequent calls are cache
    // hits — `cache.ensureAll` returns the existing flatten().
    await this.plugin.cache.forFlush();
    const all = await this.plugin.cache.ensureAll();
    // US-107: silently drop blank-title task lines from the board. They're
    // valid markdown (`- [ ] ⏳ 2026-04-25`) but produce no useful card.
    // Filtering here also removes them from tab counts and tree traversals.
    this.tasks = all.filter((t) => t.title.trim() !== "");
  }

  /**
   * Test hook (ARCHITECTURE.md §8.5). Flushes the 400ms `scheduleRefresh`
   * debounce and any reparse the cache has in flight, so e2e can wait on a
   * single Promise instead of polling DOM versions.
   */
  async __forFlush(): Promise<void> {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      await this.reloadTasks();
      this.bumpCacheVersion();
      this.render();
    }
    await this.plugin.cache.forFlush();
  }

  setTab(tab: TabKey) {
    this.state.tab = tab;
    // Persist so next Obsidian open lands on the same tab.
    this.plugin.settings.lastTab = tab;
    this.plugin.saveSettings().catch(() => undefined);
    this.render();
  }

  render() {
    const el = this.contentEl;
    // Preserve scroll position of the body across rebuilds
    const oldBody = el.querySelector(".bt-body");
    const savedScrollTop = oldBody ? (oldBody as HTMLElement).scrollTop : 0;

    el.empty();
    el.addClass("task-center-view");

    const header = el.createDiv({ cls: "bt-header" });
    this.renderTabBar(header);
    this.renderMobileStatusRow(header);
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
    this.renderMobileActionBar(el);

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

  /**
   * US-507 (mobile portion): on narrow viewports there's no Obsidian status
   * bar slot, so we mirror `📋 N today · ⚠ M overdue` inside the board
   * header. Always rendered; styles.css hides it on ≥600px (where the real
   * status bar widget is visible).
   */
  private renderMobileStatusRow(header: HTMLElement) {
    const row = header.createDiv({ cls: "bt-mobile-status" });
    const today = todayISO();
    const todo = this.tasks.filter((t) => t.status === "todo" && !t.inheritsTerminal);
    const todayCount = todo.filter((t) => t.scheduled === today).length;
    const overdue = todo.filter((t) => t.deadline && t.deadline < today).length;
    const parts = [`📋 ${todayCount} today`];
    if (overdue > 0) parts.push(`⚠ ${overdue} overdue`);
    row.setText(parts.join(" · "));
  }

  /**
   * US-502 mobile sticky action bar: 🗑 (drop = drop task) on the left,
   * ➕ Add (open Quick Add) on the right. Always rendered; styles.css
   * hides it on ≥600px viewports. Drop semantics share the same wiring
   * as the desktop pool trash zone via `wireTrashDropTarget`.
   */
  private renderMobileActionBar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-mobile-action-bar" });

    const trash = bar.createDiv({ cls: "bt-mobile-trash" });
    trash.dataset.dropZone = "trash";
    trash.createSpan({ cls: "bt-mobile-trash-icon", text: "🗑" });
    this.wireTrashDropTarget(trash);

    const add = bar.createEl("button", {
      text: tr("toolbar.add"),
      cls: "bt-mobile-add-btn",
    });
    add.addEventListener("click", () => this.openQuickAdd());
  }

  private renderOnboarding(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "bt-onboarding" });
    wrap.createEl("h2", { text: tr("onboarding.title") });
    // UX-mobile §10: desktop body mentions Cmd/Ctrl+T which doesn't apply.
    wrap.createEl("p", { text: tr(Platform.isMobile ? "onboarding.mobileBody" : "onboarding.body") });
    const btn = wrap.createEl("button", { text: tr("onboarding.cta"), cls: "bt-onboarding-cta" });
    btn.addEventListener("click", () => this.openQuickAdd());
  }

  // ---------- Header ----------

  private renderTabBar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-tabbar" });
    const today = todayISO();
    const weekStart = startOfWeek(today, this.plugin.settings.weekStartsOn);
    const weekEnd = addDays(weekStart, 6);
    const monthStart = startOfMonth(today);
    const monthEnd = endOfMonth(today);
    const activeTodos = this.tasks.filter((t) => t.status === "todo" && !t.inheritsTerminal);
    const counts = {
      week: activeTodos.filter((t) => t.scheduled && t.scheduled >= weekStart && t.scheduled <= weekEnd).length,
      month: activeTodos.filter((t) => t.scheduled && t.scheduled >= monthStart && t.scheduled <= monthEnd).length,
      completed: this.tasks.filter((t) => t.status === "done").length,
      unscheduled: activeTodos.filter((t) => !t.scheduled).length,
    };
    const tabs: Array<{ key: TabKey; label: string; hotkey: string; count: number }> = [
      { key: "week", label: tr("tab.week"), hotkey: "⌃1", count: counts.week },
      { key: "month", label: tr("tab.month"), hotkey: "⌃2", count: counts.month },
      { key: "completed", label: tr("tab.completed"), hotkey: "⌃3", count: counts.completed },
      { key: "unscheduled", label: tr("tab.unscheduled"), hotkey: "⌃4", count: counts.unscheduled },
    ];
    for (const t of tabs) {
      const btn = bar.createDiv({ cls: "bt-tab" + (this.state.tab === t.key ? " active" : "") });
      // Stable e2e selector: `[data-tab="week|month|completed|unscheduled"]`.
      // The visible label changes (i18n + week-number formatting), so tests
      // must not depend on text content.
      btn.dataset.tab = t.key;
      btn.createSpan({ text: t.label });
      if (t.count > 0) {
        btn.createSpan({ text: String(t.count), cls: "bt-tab-count" });
      }
      btn.createSpan({ text: t.hotkey, cls: "bt-hotkey" });
      btn.addEventListener("click", () => this.setTab(t.key));

      // Cross-tab drag: hover a card over a tab head for 600ms to switch to
      // it mid-drag. Tab heads themselves do not accept drops — the user
      // picks a day within the newly-switched view. Dwell timing is rAF +
      // performance.now() (drift-free under main-thread stalls; UX.md §6.1).
      btn.addEventListener("dragover", (e) => {
        const dt = e.dataTransfer;
        if (!dt || !Array.from(dt.types).includes("text/task-id")) return;
        e.preventDefault();
        dt.dropEffect = "move";
        btn.addClass("drag-hover");
        this.dwellTracker.update(t.key, btn, this.state.tab);
      });
      btn.addEventListener("dragleave", () => {
        btn.removeClass("drag-hover");
        this.dwellTracker.reset();
      });
    }
  }

  private renderToolbar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-toolbar" });

    // Navigation arrows for week/month
    if (this.state.tab === "week" || this.state.tab === "month") {
      const nav = bar.createDiv({ cls: "bt-nav" });
      const prev = nav.createEl("button", { text: "◀" });
      // Stable e2e selector — the visible label changes (in week tab the
      // "today" button shows the week number; in month tab it shows
      // localized "Today"). Tests select via `[data-action="nav-*"]`.
      prev.dataset.action = "nav-prev";
      const todayLabel =
        this.state.tab === "week"
          ? tr("toolbar.weekNo", { n: isoWeekNumber(this.state.anchorISO) })
          : tr("toolbar.today");
      const today = nav.createEl("button", { text: todayLabel });
      today.dataset.action = "nav-today";
      const next = nav.createEl("button", { text: "▶" });
      next.dataset.action = "nav-next";
      const label = nav.createSpan({ cls: "bt-nav-label" });
      label.setText(this.navLabel());
      prev.addEventListener("click", () => {
        this.state.anchorISO =
          this.state.tab === "week"
            ? addDays(this.state.anchorISO, -7)
            : shiftMonth(this.state.anchorISO, -1);
        this.render();
      });
      next.addEventListener("click", () => {
        this.state.anchorISO =
          this.state.tab === "week"
            ? addDays(this.state.anchorISO, 7)
            : shiftMonth(this.state.anchorISO, 1);
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
      const caret = search.selectionStart;
      this.render();
      const el = this.contentEl.querySelector(".bt-search") as HTMLInputElement | null;
      if (el) {
        el.focus();
        const pos = caret ?? el.value.length;
        el.selectionStart = el.selectionEnd = pos;
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
      (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById("obsidian-task-center");
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
      // Mobile collapsible per-day rows (UX-mobile §3.1): `today` always
      // shows its body; other days show body only when `expanded` class
      // is present. Desktop CSS overrides and shows body unconditionally,
      // so this class is mobile-only state.
      const isToday = day === today;
      const isExpanded = this.state.expandedDays.has(day);
      let cls = "bt-week-col";
      if (isToday) cls += " today";
      if (isExpanded) cls += " expanded";
      const col = wrapper.createDiv({ cls });
      // e2e drop-target selector: `[data-date="YYYY-MM-DD"]`. Stable across
      // i18n / weekday labels.
      col.dataset.date = day;
      const head = col.createDiv({ cls: "bt-week-head" });
      // Tap-to-toggle on mobile. Today's row stays open (no toggle).
      if (!isToday) {
        head.addEventListener("click", (e) => {
          // Ignore clicks that bubbled up from the card area inside the body.
          if ((e.target as HTMLElement).closest(".bt-card, .bt-subcard")) return;
          if (this.state.expandedDays.has(day)) this.state.expandedDays.delete(day);
          else this.state.expandedDays.add(day);
          this.render();
        });
      }
      const d = fromISO(day);
      head.createSpan({
        text: weekdayLabel(d.getDay()),
        cls: "bt-week-dow",
      });
      head.createSpan({ text: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, cls: "bt-week-date" });

      const dayTasks = this.tasks
        .filter((t) => t.scheduled === day && t.status === "todo" && !t.inheritsTerminal)
        .filter(filter);
      dayTasks.sort((a, b) => {
        if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return 0;
      });
      const topLevel = this.hideChildrenOfVisibleParents(dayTasks);
      const stats = col.createSpan({
        text: this.columnStats(dayTasks),
        cls: "bt-week-stats",
      });
      stats.title = "scheduled estimate (hours)";

      const list = col.createDiv({ cls: "bt-week-list" });
      // Drop handler on the COLUMN (which carries `data-date`), not the
      // inner list. The column is the published e2e drop target; if the
      // handler lives on a child the synthesized drop event from
      // `simulateDrag()` never reaches it.
      this.makeDropZone(col, day);
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
      // Already in this list? Parent will render the child inline.
      if (ids.has(parentId)) return false;
      // Parent lives in another day column (has its own scheduled) — the
      // child renders inline under it there. Without this check, a subtask
      // with no scheduled but a scheduled parent would leak into the
      // Unscheduled pool as a standalone card.
      const parent = this.tasks.find(
        (x) => x.path === t.path && x.line === t.parentLine,
      );
      if (parent && parent.scheduled) return false;
      return true;
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
      // e2e drop-target selector — same contract as the week view.
      cell.dataset.date = day;
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
      // Mobile (US-504): tap a cell opens that day's task list as a
      // bottom sheet. The desktop path leaves the click as a no-op (chips
      // inside handle their own drag / select). Detection is by viewport
      // width, not Platform — a narrow desktop pane still gets the sheet.
      cell.addEventListener("click", (e) => {
        if (window.innerWidth >= 600) return;
        // Don't fire when the click bubbled from a chip — that's a select
        // intent, not "open the day".
        if ((e.target as HTMLElement).closest(".bt-mini-card")) return;
        this.openDayTasksSheet(day, dayTasks);
      });
    }
  }

  /**
   * Mobile-only: long-press a card → bottom sheet with task actions.
   * Mirrors the desktop right-click menu + hover popover (UX-mobile.md
   * §5.1 / US-506) into a single thumb-reachable surface. Buttons call
   * the same `api.*` methods as the desktop UI; rendered as a flat list
   * of large tap targets.
   */
  private openCardActionSheet(t: ParsedTask): void {
    const today = todayISO();
    const tomorrow = addDays(today, 1);
    let sheet: BottomSheet | null = null;
    const run = async (label: string, op: () => Promise<unknown>) => {
      sheet?.close();
      try {
        await op();
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
      }
      this.scheduleRefresh();
      void label; // for future telemetry; intentional no-op
    };

    sheet = new BottomSheet(this.app, {
      title: t.title,
      populate: (el) => {
        // Source location — replaces the desktop hover popover preview.
        const source = el.createDiv({ cls: "bt-sheet-source" });
        source.setText(`${t.path}:L${t.line + 1}`);

        const actions = el.createDiv({ cls: "bt-sheet-actions" });

        const btn = (text: string, action: () => Promise<unknown> | unknown) => {
          const b = actions.createEl("button", {
            cls: "bt-sheet-action",
            text,
          });
          b.addEventListener("click", () => {
            void run(text, async () => action());
          });
        };

        btn(
          t.status === "done" ? "↩ Mark undone" : "✓ Done",
          () => (t.status === "done" ? this.api.undone(t.id) : this.api.done(t.id)),
        );
        btn(`⏳ ${today}`, () => this.api.schedule(t.id, today));
        btn(`⏳ ${tomorrow}`, () => this.api.schedule(t.id, tomorrow));
        btn("⏳ —", () => this.api.schedule(t.id, null));
        btn("📂 Open source", async () => {
          sheet?.close();
          const file = this.app.vault.getAbstractFileByPath(t.path);
          if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file, { eState: { line: t.line } });
          }
        });
        btn("🗑 Drop", () => this.api.drop(t.id));
      },
    });
    sheet.open();
  }

  /**
   * Mobile-only: bottom sheet listing every todo task scheduled to `day`.
   * Tapping a row switches to the week tab anchored on that day with the
   * row's day expanded (so the user can act on the task with the full
   * card UI rather than re-implementing card actions inside the sheet).
   */
  private openDayTasksSheet(day: string, dayTasks: ParsedTask[]): void {
    const sheet = new BottomSheet(this.app, {
      title: day,
      populate: (el) => {
        if (dayTasks.length === 0) {
          el.createDiv({ cls: "bt-sheet-empty", text: tr("sheet.empty") });
          return;
        }
        for (const t of dayTasks) {
          const row = el.createDiv({ cls: "bt-sheet-task" });
          row.dataset.taskId = t.id;
          row.createSpan({ cls: "bt-sheet-task-title", text: t.title });
          if (t.deadline) {
            row.createSpan({
              cls: "bt-sheet-task-meta",
              text: `📅 ${t.deadline}`,
            });
          }
          row.addEventListener("click", () => {
            this.state.tab = "week";
            this.state.anchorISO = day;
            this.state.expandedDays.add(day);
            this.state.selectedTaskId = t.id;
            sheet.close();
            this.render();
          });
        }
      },
    });
    sheet.open();
  }

  // ---------- Completed ----------

  private renderCompleted(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const completed = this.tasks
      .filter((t) => t.status === "done" && t.completed)
      .filter(filter)
      .sort((a, b) => (b.completed! < a.completed! ? -1 : 1));

    const wrap = parent.createDiv({ cls: "bt-completed" });

    // 7-day headline: estimate ratio + top 4 tags. Gives the GUI user the same
    // calibration signal the CLI `stats` verb surfaces to an AI.
    const stats = computeStats(this.tasks, { days: 7 });
    if (stats.doneCount > 0) {
      const header = wrap.createDiv({ cls: "bt-stats-header" });
      const left = header.createDiv({ cls: "bt-stats-left" });
      left.createSpan({
        text: `7-day · ${stats.doneCount} done`,
        cls: "bt-stats-period",
      });
      if (stats.ratio !== null) {
        const delta = Math.round((stats.ratio - 1) * 100);
        const sign = delta >= 0 ? "+" : "";
        const cls =
          stats.ratio >= 0.8 && stats.ratio <= 1.25
            ? "bt-stats-ok"
            : "bt-stats-off";
        left.createSpan({
          text: `ratio ${stats.ratio.toFixed(2)} (${sign}${delta}%)`,
          cls: "bt-stats-ratio " + cls,
        });
        left.createSpan({
          text: `${stats.sumActual}m / ${stats.sumEstimate}m`,
          cls: "bt-stats-time",
        });
      }
      const tagsRow = header.createDiv({ cls: "bt-stats-tags" });
      for (const t of stats.byTag.slice(0, 4)) {
        const chip = tagsRow.createDiv({ cls: "bt-stats-chip" });
        chip.createSpan({ text: t.tag, cls: "bt-stats-chip-tag" });
        chip.createSpan({ text: `${t.minutes}m`, cls: "bt-stats-chip-min" });
      }
    }


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

    const currentWeek = startOfWeek(todayISO(), this.plugin.settings.weekStartsOn);
    for (const wk of weekKeys) {
      // Default: collapse weeks older than the current week on first render.
      // User's explicit expand/collapse lives in collapsedWeeks and overrides.
      const hasUserPreference =
        this.state.collapsedWeeks.has(wk) || this.state.collapsedWeeks.has("EXPANDED:" + wk);
      const collapsed = hasUserPreference
        ? this.state.collapsedWeeks.has(wk)
        : wk < currentWeek;
      const group = wrap.createDiv({ cls: "bt-completed-week" + (collapsed ? " collapsed" : "") });
      const items = weeks.get(wk)!;
      const sumActual = items.reduce((s, t) => s + (t.actual ?? 0), 0);
      const sumEst = items.reduce((s, t) => s + (t.estimate ?? 0), 0);
      const accuracy = sumEst > 0 ? (sumActual / sumEst) : null;
      const accLabel =
        accuracy !== null
          ? tr("completed.accuracy", { ratio: accuracy.toFixed(2), actual: sumActual, est: sumEst })
          : tr("completed.total", { actual: sumActual });

      const head = group.createDiv({ cls: "bt-completed-week-head" });
      head.createSpan({ text: collapsed ? "▸" : "▾", cls: "bt-completed-toggle" });
      head.createSpan({ text: tr("completed.weekOf", { date: wk }), cls: "bt-completed-week-label" });
      head.createSpan({ text: tr("completed.tasks", { n: items.length }), cls: "bt-completed-count" });
      head.createSpan({ text: accLabel, cls: "bt-completed-accuracy" });
      head.addEventListener("click", () => {
        const wasCollapsed = collapsed;
        if (wasCollapsed) {
          this.state.collapsedWeeks.delete(wk);
          this.state.collapsedWeeks.add("EXPANDED:" + wk); // mark as user-chosen expanded
        } else {
          this.state.collapsedWeeks.delete("EXPANDED:" + wk);
          this.state.collapsedWeeks.add(wk);
        }
        this.render();
      });

      if (!collapsed) {
        const list = group.createDiv({ cls: "bt-completed-list" });
        for (const t of items) {
          const row = list.createDiv({ cls: "bt-completed-row" });
          row.dataset.taskId = t.id;
          row.createSpan({ text: `${t.completed}`, cls: "bt-completed-date" });
          row.createSpan({ text: t.title, cls: "bt-completed-title" });
          const meta = row.createSpan({ cls: "bt-completed-meta" });
          if (t.estimate || t.actual) {
            meta.setText(
              `${t.actual ? formatMinutes(t.actual) : "—"} / ${t.estimate ? formatMinutes(t.estimate) : "—"}`,
            );
          }
          row.addEventListener("click", () => this.openAtSource(t));
        }
      }
    }
  }

  // ---------- Unscheduled ----------

  private renderUnscheduledPool(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const unscheduledAll = this.tasks
      .filter((t) => !t.scheduled && t.status === "todo" && !t.inheritsTerminal)
      .filter(filter);
    // Sort for triage: deadline ascending first (nearest deadline is urgent),
    // tasks without deadline fall to the end; tie-break by created date desc
    // (newer tasks first). Children-of-visible-parents dedup happens after.
    unscheduledAll.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      if (a.created && b.created) return b.created.localeCompare(a.created);
      if (a.created) return -1;
      if (b.created) return 1;
      return 0;
    });
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
    // e2e drop-zone selector: `[data-drop-zone="trash"]`. Stable across the
    // visible icon / label / theme. (The mobile action bar carries the
    // same data attribute on a different element; styles.css hides one
    // or the other based on viewport width — see UX-mobile.md §2 / §13.)
    trash.dataset.dropZone = "trash";
    trash.createDiv({ cls: "bt-trash-icon", text: "🗑" });
    const label = trash.createDiv({ cls: "bt-trash-label" });
    label.createSpan({ text: tr("trash.title"), cls: "bt-trash-title" });
    label.createSpan({
      text: tr("trash.hint"),
      cls: "bt-trash-hint",
    });
    this.wireTrashDropTarget(trash);
  }

  /**
   * Wires `dragover` / `dragleave` / `drop` for any element acting as a
   * trash drop target. Drop = `api.drop(id)` (mark `[-] ❌`). Used by both
   * the desktop pool trash zone (UX.md §6) and the mobile sticky action
   * bar (UX-mobile.md §2). Single helper so semantics never diverge.
   */
  private wireTrashDropTarget(el: HTMLElement) {
    el.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (!dt || !Array.from(dt.types).includes("text/task-id")) return;
      e.preventDefault();
      dt.dropEffect = "move";
      el.addClass("drop-hover");
    });
    el.addEventListener("dragleave", () => el.removeClass("drop-hover"));
    el.addEventListener("drop", async (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const id = dt.getData("text/task-id");
      if (!id) return;
      e.preventDefault();
      el.removeClass("drop-hover");
      try {
        await this.runWithRemoveAnim(id, async () => {
          await this.api.drop(id);
          new Notice(tr("trash.dropped"));
        });
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
        this.scheduleRefresh();
      }
    });
  }

  private renderUnscheduledBig(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const unscheduledAll = this.tasks
      .filter((t) => !t.scheduled && t.status === "todo" && !t.inheritsTerminal)
      .filter(filter);
    unscheduledAll.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      if (a.created && b.created) return b.created.localeCompare(a.created);
      if (a.created) return -1;
      if (b.created) return 1;
      return 0;
    });
    const unscheduled = this.hideChildrenOfVisibleParents(unscheduledAll);

    const wrap = parent.createDiv({ cls: "bt-unscheduled-big" });
    const head = wrap.createDiv({ cls: "bt-unscheduled-big-head" });
    head.createSpan({
      text: `${tr("pool.unscheduled")} (${unscheduled.length})`,
      cls: "bt-unscheduled-big-label",
    });
    const hint = head.createSpan({ cls: "bt-unscheduled-big-hint" });
    // UX-mobile §10: shortcut hint is desktop-only.
    hint.setText(tr(Platform.isMobile ? "unscheduled.mobileHint" : "unscheduled.hint"));

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

    // Deadline signals — both a CSS hook (`bt-overdue` / `bt-near-deadline`)
    // and a data attribute. e2e selectors live on the data attrs per
    // ARCHITECTURE.md §8.6 (CSS class names are not part of the contract).
    //
    // Only annotate active (todo) tasks. A done / dropped task that happens
    // to have a past deadline shouldn't render with the urgency styling — its
    // outcome is already settled.
    if (t.deadline && t.status === "todo") {
      const today = todayISO();
      const dd = daysBetween(today, t.deadline);
      if (dd < 0) {
        card.addClass("bt-overdue");
        card.dataset.overdue = "true";
      } else if (dd <= 3) {
        card.addClass("bt-near-deadline");
        card.dataset.nearDeadline = "true";
      }
    }

    // Title row
    const titleRow = card.createDiv({ cls: "bt-card-title-row" });
    const check = titleRow.createDiv({ cls: "bt-check" });
    check.setText(statusIcon(t.status));
    check.title = "Toggle done (Space)";
    check.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.runWithRemoveAnim(t.id, async () => {
        if (t.status === "done") await this.api.undone(t.id);
        else await this.api.done(t.id);
      });
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

    // Children expansion (recursive — renders grandchildren and deeper)
    const childLines = t.childrenLines;
    if (childLines.length > 0) {
      const expander = card.createDiv({ cls: "bt-card-children" });
      const children = childLines
        .map((l) => this.tasks.find((x) => x.path === t.path && x.line === l))
        .filter((x): x is ParsedTask => !!x);
      for (const c of children) this.renderSubcard(expander, c, t);
    }

    // Inline "+ subtask" affordance — visible on every card so adding a
    // subtask is one click, no shortcuts required. Subtask inherits the
    // parent's ⏳ so it lands in the same column / day automatically.
    if (t.status === "todo") this.renderAddSubtaskRow(card, t);

    this.wireCardEvents(card, t);
    // Hover popover is desktop-only — UX-mobile.md §4: "不显 hover popover".
    // On touch, browsers fire emulated mouseenter on first tap and stale
    // mouseleave on next tap elsewhere; the popover would flash and stay.
    // Long-press menu replaces it on mobile (UX-mobile §5.1 / US-506).
    if (!Platform.isMobile) {
      this.contextPopover.attach(card, t);
    } else {
      // Unified mobile gesture controller (UX-mobile §13 #6: long-press +
      // drag + swipe must share one state machine). attachCardGestures
      // routes:
      //   - hold N ms still      → openCardActionSheet (US-506)
      //   - swipe ≥ 30% left     → done (US-508; settings can disable)
      //   - swipe ≥ 30% right    → drop (US-508; settings can disable)
      //   - hold 250ms then move → enter pointer-drag (US-507)
      const settings = this.plugin.settings;
      attachCardGestures(card, {
        longPressMs: settings.mobileLongPressMs,
        dragArmMs: 250,
        moveThresholdPx: 4,
        swipeThresholdRatio: 0.3,
        onLongPress: () => this.openCardActionSheet(t),
        // Per US-510, swipe is opt-out via settings. When disabled the
        // gesture controller still parses left/right but never commits.
        onSwipeLeft: settings.mobileSwipeEnabled
          ? () => this.swipeAction(t, "done")
          : undefined,
        onSwipeRight: settings.mobileSwipeEnabled
          ? () => this.swipeAction(t, "drop")
          : undefined,
        onDragArmed: (e) => this.mobileDragSession(card, t, e.clientX, e.clientY),
      });
    }
  }

  /**
   * Lazy-initialise the mobile drag controller and start a session for
   * `card`. Called from `attachCardGestures.onDragArmed`. The controller
   * owns the floating clone + hit-testing + dwell + edge-scroll; this
   * function only wires its drop handlers back into the existing
   * api.schedule / api.drop / api.nest pipeline (so undo + animation +
   * notice toasts all reuse the desktop code paths).
   */
  private mobileDragSession(card: HTMLElement, t: ParsedTask, x: number, y: number) {
    if (!this.mobileDrag) {
      this.mobileDrag = new MobileDragController<TabKey>({
        scrollEl: this.contentEl,
        contentEl: this.contentEl,
        // UX-mobile §5.2: 800ms (vs desktop 600ms — fingers are jitterier).
        dwellMs: 800,
        // UX-mobile §5.2: 60px edge → auto-scroll.
        edgeScrollPx: 60,
        edgeScrollMaxSpeed: 600,
        getCurrentTab: () => this.state.tab,
        onTabSwitch: (tab) => this.setTab(tab),
        onScheduleDrop: (taskId, dateISO) => this.handleMobileScheduleDrop(taskId, dateISO),
        onTrashDrop: (taskId) => this.handleMobileTrashDrop(taskId),
        onNestDrop: (droppedId, parentId) => this.handleMobileNestDrop(droppedId, parentId),
      });
    }
    return this.mobileDrag.begin(card, t.id, x, y);
  }

  private async handleMobileScheduleDrop(taskId: string, dateISO: string): Promise<void> {
    const task = this.tasks.find((x) => x.id === taskId);
    if (!task) return;
    if ((task.scheduled ?? null) === dateISO) return; // no-op same-day drop
    try {
      await this.runWithRemoveAnim(taskId, async () => {
        const r = await this.api.schedule(taskId, dateISO);
        if (!r.unchanged) {
          this.undoStack.push({
            label: `⏳ ${dateISO}`,
            ops: [{ path: task.path, line: task.line, before: [r.before], after: [r.after] }],
          });
          new Notice(tr("notice.scheduled", { date: dateISO }));
        }
      });
    } catch (err) {
      new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
      this.scheduleRefresh();
    }
  }

  private async handleMobileTrashDrop(taskId: string): Promise<void> {
    const task = this.tasks.find((x) => x.id === taskId);
    if (!task) return;
    try {
      await this.runWithRemoveAnim(taskId, async () => {
        const r = await this.api.drop(taskId);
        if (!r.unchanged) {
          this.undoStack.push({
            label: "🗑 dropped",
            ops: [{ path: task.path, line: task.line, before: [r.before], after: [r.after] }],
          });
          new Notice(tr("trash.dropped"));
        }
      });
    } catch (err) {
      new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
      this.scheduleRefresh();
    }
  }

  private async handleMobileNestDrop(droppedId: string, parentId: string): Promise<void> {
    if (droppedId === parentId) return;
    const droppedTask = this.tasks.find((x) => x.id === droppedId);
    const parentTask = this.tasks.find((x) => x.id === parentId);
    if (!droppedTask || !parentTask) return;
    const awaitCachePaths = [parentTask.path];
    if (droppedTask.path !== parentTask.path) awaitCachePaths.push(droppedTask.path);
    try {
      await this.runWithRemoveAnim(droppedId, async () => {
        const r = await this.api.nest(droppedId, parentId);
        if (!r.unchanged) {
          if (r.undoOps && r.undoOps.length > 0) {
            this.undoStack.push({
              label: `nest under "${parentTask.title.slice(0, 20)}"`,
              ops: r.undoOps,
            });
          }
          new Notice(
            tr("notice.nested", {
              title: parentTask.title,
              where: r.crossFile ? tr("notice.crossFile") : "",
            }),
          );
        }
      }, { awaitCachePaths });
    } catch (err) {
      new Notice(tr("notice.error", { msg: (err as Error).message }), 6000);
      this.scheduleRefresh();
    }
  }

  /**
   * US-508: commit a swipe action. Pushes the resulting byte-level diff to
   * the undo stack so the user can recover via the long-press menu (M-3
   * step 3 will surface an explicit undo button there). Notice toast is
   * 1s — short enough not to block, long enough to register what happened.
   */
  private async swipeAction(t: ParsedTask, kind: "done" | "drop"): Promise<void> {
    try {
      const r =
        kind === "done" ? await this.api.done(t.id) : await this.api.drop(t.id);
      if (!r.unchanged) {
        this.undoStack.push({
          label: kind === "done" ? "swipe done" : "swipe drop",
          ops: [
            {
              path: t.path,
              line: t.line,
              before: [r.before],
              after: [r.after],
            },
          ],
        });
      }
      new Notice(kind === "done" ? "✓ Done" : "🗑 Dropped", 1000);
    } catch (err) {
      new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
    }
    this.scheduleRefresh();
  }

  // Renders a subcard + its own children recursively. The nested
  // `.bt-card-children` block is a sibling of the subcard so each level
  // inherits the 22px margin-left from CSS, producing a staircase indent.
  private renderSubcard(container: HTMLElement, c: ParsedTask, parent: ParsedTask) {
    const subCard = container.createDiv({ cls: "bt-subcard" });
    subCard.dataset.taskId = c.id;
    subCard.draggable = true;
    if (this.state.selectedTaskId === c.id) subCard.addClass("selected");

    const check = subCard.createDiv({ cls: "bt-sub-check", text: statusIcon(c.status) });
    check.title = "Toggle done";
    check.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.runWithRemoveAnim(c.id, async () => {
        if (c.status === "done") await this.api.undone(c.id);
        else await this.api.done(c.id);
      });
    });

    const title = subCard.createDiv({ cls: "bt-subcard-title", text: c.title });
    title.title = c.title;
    title.addEventListener("click", (e) => {
      e.stopPropagation();
      this.enterTitleEdit(title, c);
    });

    if (c.scheduled && c.scheduled !== parent.scheduled) {
      // Flag when a subtask is scheduled to a different day than its parent
      subCard.createDiv({ cls: "bt-sub-sched", text: `⏳${c.scheduled}` });
    }
    if (c.estimate) subCard.createDiv({ cls: "bt-sub-est", text: formatMinutes(c.estimate) });
    if (c.status === "done") subCard.addClass("done");
    this.wireCardEvents(subCard, c);

    const grandLines = c.childrenLines;
    if (grandLines.length > 0) {
      if (Platform.isMobile) {
        // US-505: mobile collapses to 1 level. Each subcard with deeper
        // children gets a `+N` chip; tapping it opens a bottom-sheet
        // preview of the full subtree (recursive semantic preserved per
        // US-142 — just visually deferred).
        const total = this.countDescendants(c);
        const more = subCard.createDiv({ cls: "bt-subcard-more" });
        more.setText(`+${total}`);
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openSubtreeSheet(c);
        });
      } else {
        const sub = container.createDiv({ cls: "bt-card-children" });
        const grand = grandLines
          .map((l) => this.tasks.find((x) => x.path === c.path && x.line === l))
          .filter((x): x is ParsedTask => !!x);
        for (const g of grand) this.renderSubcard(sub, g, c);
      }
    }
  }

  /** Count all descendants (children + grandchildren + …) of a task. */
  private countDescendants(c: ParsedTask): number {
    let count = 0;
    const queue: number[] = [...c.childrenLines];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const line = queue.shift()!;
      if (seen.has(line)) continue;
      seen.add(line);
      const child = this.tasks.find((t) => t.path === c.path && t.line === line);
      if (child) {
        count++;
        queue.push(...child.childrenLines);
      }
    }
    return count;
  }

  /**
   * Mobile-only: open a bottom-sheet preview of a subtree. Each descendant
   * renders as one row, indented by depth. Used by the `+N` chip on
   * subcards (US-505 second sentence — visual collapse to 1 level, full
   * tree available on demand).
   */
  private openSubtreeSheet(root: ParsedTask): void {
    // Walk the subtree depth-first, recording each task with its depth
    // relative to the root. Same-file children only (ARCHITECTURE §1.4).
    // Cycle guard mirrors `countDescendants` — production data shouldn't
    // produce cycles, but parser bugs / hand-edited files could, and a
    // BottomSheet that hangs is worse than one that under-counts.
    const rows: Array<{ task: ParsedTask; depth: number }> = [];
    const seen = new Set<number>();
    const walk = (parent: ParsedTask, depth: number) => {
      for (const line of parent.childrenLines) {
        if (seen.has(line)) continue;
        seen.add(line);
        const child = this.tasks.find(
          (t) => t.path === parent.path && t.line === line,
        );
        if (!child) continue;
        rows.push({ task: child, depth });
        walk(child, depth + 1);
      }
    };
    walk(root, 0);

    const sheet = new BottomSheet(this.app, {
      title: root.title,
      populate: (el) => {
        if (rows.length === 0) {
          el.createDiv({ cls: "bt-sheet-empty", text: tr("sheet.empty") });
          return;
        }
        for (const { task, depth } of rows) {
          const row = el.createDiv({ cls: "bt-sheet-task" });
          row.dataset.taskId = task.id;
          // Indent visually by depth — uses padding-left so the row stays
          // a normal flex container for the title + meta.
          row.style.paddingLeft = `${8 + depth * 16}px`;
          row.createSpan({
            cls: "bt-sheet-task-title",
            text: `${statusIcon(task.status)} ${task.title}`,
          });
          if (task.scheduled) {
            row.createSpan({
              cls: "bt-sheet-task-meta",
              text: `⏳ ${task.scheduled}`,
            });
          }
          row.addEventListener("click", () => {
            sheet.close();
            this.state.selectedTaskId = task.id;
            this.render();
          });
        }
      },
    });
    sheet.open();
  }

  // Context hover popover lives in `./view/popover` (ContextPopoverController).
  // Wired in the constructor; cards register via `this.contextPopover.attach()`
  // in renderCard.

  private renderAddSubtaskRow(card: HTMLElement, parent: ParsedTask) {
    const row = card.createDiv({ cls: "bt-subtask-add" });
    // Don't let this row trigger card-level drag or selection
    row.draggable = false;
    row.addEventListener("dragstart", (e) => e.preventDefault());
    row.addEventListener("click", (e) => e.stopPropagation());
    row.addEventListener("dblclick", (e) => e.stopPropagation());
    this.renderSubtaskAddIdle(row, parent);
  }

  private renderSubtaskAddIdle(row: HTMLElement, parent: ParsedTask) {
    row.empty();
    row.removeClass("editing");
    const trigger = row.createDiv({ cls: "bt-subtask-add-trigger" });
    trigger.setText(tr("card.addSubtask"));
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.renderSubtaskAddEditing(row, parent);
    });
  }

  private renderSubtaskAddEditing(row: HTMLElement, parent: ParsedTask) {
    row.empty();
    row.addClass("editing");
    const input = row.createEl("input", { type: "text", cls: "bt-subtask-add-input" });
    input.placeholder = tr("card.subtaskPlaceholder");
    const commit = row.createDiv({ cls: "bt-subtask-add-commit", text: "✓" });
    const cancel = row.createDiv({ cls: "bt-subtask-add-cancel", text: "✕" });

    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      if (save && text) {
        try {
          await this.api.add({
            text,
            parent: parent.id,
            // Intentionally do NOT inherit parent's scheduled. An unset
            // scheduled means "follows the parent" — the child renders inline
            // under the parent card regardless of day. Inheriting created
            // stale dates the moment the parent got rescheduled.
            inboxFallback: this.plugin.settings.inboxPath,
            stampCreated: this.plugin.settings.stampCreated,
          });
        } catch (err) {
          new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
        }
        this.scheduleRefresh();
      } else {
        // Nothing to save — restore the trigger in place without a re-render
        this.renderSubtaskAddIdle(row, parent);
      }
    };

    input.addEventListener("keydown", (e) => {
      // Stop view-wide hotkeys (1-4, Space, D, E, Delete, arrows) firing while typing
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dragstart", (e) => e.preventDefault());

    // mousedown preventDefault keeps focus in input → click event still fires
    // on the button; without this, blur would trigger commit before the click
    // is processed and the cancel ✕ would never get to actually cancel.
    commit.addEventListener("mousedown", (e) => e.preventDefault());
    cancel.addEventListener("mousedown", (e) => e.preventDefault());
    commit.addEventListener("click", (e) => {
      e.stopPropagation();
      finish(true);
    });
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      finish(false);
    });

    input.focus();
  }

  private wireCardEvents(el: HTMLElement, t: ParsedTask) {
    // Drag source
    el.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData("text/task-id", t.id);
      e.dataTransfer.effectAllowed = "move";
      el.addClass("dragging");
      // View-wide "a drag is in progress" marker so drop zones (esp. the
      // trash bin) can attract attention without waiting for direct hover.
      this.contentEl.addClass("dragging-active");
    });
    el.addEventListener("dragend", () => {
      el.removeClass("dragging");
      this.contentEl.removeClass("dragging-active");
    });

    // Drop target: dropping another card onto this one nests it as a subtask
    // (works cross-file). stopPropagation prevents the underlying day column
    // from also receiving the drop and just rescheduling.
    el.addEventListener("dragover", (e) => {
      const dt = e.dataTransfer;
      if (!dt || !Array.from(dt.types).includes("text/task-id")) return;
      if (el.classList.contains("dragging")) return; // self
      e.preventDefault();
      e.stopPropagation();
      dt.dropEffect = "move";
      el.addClass("nest-target");
    });
    el.addEventListener("dragleave", (e) => {
      // dragleave fires for child elements as the cursor moves between them;
      // only clear the class when the cursor truly leaves this card.
      const related = e.relatedTarget as Node | null;
      if (related && el.contains(related)) return;
      el.removeClass("nest-target");
    });
    el.addEventListener("drop", async (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const droppedId = dt.getData("text/task-id");
      if (!droppedId || droppedId === t.id) return;
      e.preventDefault();
      e.stopPropagation();
      el.removeClass("nest-target");
      // Nest writes to one or two files (cross-file). Wait for metadataCache to
      // reparse them before rendering so the new parent shows the new child.
      const droppedTask = this.tasks.find((x) => x.id === droppedId);
      const awaitCachePaths = [t.path];
      if (droppedTask && droppedTask.path !== t.path) awaitCachePaths.push(droppedTask.path);
      try {
        await this.runWithRemoveAnim(droppedId, async () => {
          const r = await this.api.nest(droppedId, t.id);
          if (!r.unchanged) {
            if (r.undoOps && r.undoOps.length > 0) {
              this.undoStack.push({
                label: `nest under "${t.title.slice(0, 20)}"`,
                ops: r.undoOps,
              });
            }
            new Notice(
              tr("notice.nested", {
                title: t.title,
                where: r.crossFile ? tr("notice.crossFile") : "",
              }),
            );
          }
        }, { awaitCachePaths });
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 6000);
        this.scheduleRefresh();
      }
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
      const task = this.tasks.find((t) => t.id === id);
      const willMove = !task || (task.scheduled ?? null) !== targetDate;
      const work = async () => {
        const r = await this.api.schedule(id, targetDate);
        if (!r.unchanged && task) {
          this.undoStack.push({
            label: targetDate ? `⏳ ${targetDate}` : "⏳ cleared",
            ops: [{ path: task.path, line: task.line, before: [r.before], after: [r.after] }],
          });
          new Notice(
            targetDate ? tr("notice.scheduled", { date: targetDate }) : tr("notice.clearedSchedule"),
          );
        }
      };
      try {
        if (willMove) {
          await this.runWithRemoveAnim(id, work);
        } else {
          await work();
          this.scheduleRefresh();
        }
      } catch (err) {
        new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
        this.scheduleRefresh();
      }
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
      // UX-mobile §10: keyboard shortcut hints don't apply on touch — the
      // gestures replace them — so suppress the hint string entirely on
      // mobile. The selected-task line itself remains useful.
      if (!Platform.isMobile) {
        bar.createSpan({
          text: " · " + tr("footer.hint"),
          cls: "bt-footer-selected-hint",
        });
      } else {
        bar.createSpan({
          text: " · " + tr("footer.mobileHint"),
          cls: "bt-footer-selected-hint",
        });
      }
    }
  }

  // ---------- Keyboard ----------

  async handleKey(e: KeyboardEvent) {
    // US-501: keyboard shortcuts silent no-op on Obsidian Mobile (no
    // physical keyboard expected; virtual-keyboard `keydown` we drop on
    // purpose so the board never claims to handle a key the user can't
    // produce). Layout switching is screen-width based (CSS @media), but
    // *capability* gating like this is a Platform check — allowed at the
    // UI layer per UX-mobile §13 #7.
    if (Platform.isMobile) return;

    // Global tab switching
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const map: Record<string, TabKey> = { "1": "week", "2": "month", "3": "completed", "4": "unscheduled" };
      if (map[e.key]) {
        e.preventDefault();
        this.setTab(map[e.key]);
        return;
      }
    }

    // Undo (Ctrl/Cmd+Z) — view-scoped undo of the most recent drag/keyboard mutation.
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && !e.altKey) {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      e.preventDefault();
      e.stopPropagation();
      void this.undoStack.pop();
      return;
    }

    // Quick add
    if ((e.ctrlKey || e.metaKey) && e.key === "t" && !e.shiftKey && !e.altKey) {
      // Ctrl+T / Cmd+T — quick add
      e.preventDefault();
      this.openQuickAdd();
      return;
    }

    // Focus search
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      e.preventDefault();
      const search = this.contentEl.querySelector(".bt-search") as HTMLInputElement | null;
      if (search) {
        search.focus();
        search.select();
      }
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
      await this.runWithRemoveAnim(sel.id, async () => {
        const r = await this.api.schedule(sel.id, newDate);
        if (!r.unchanged) {
          this.undoStack.push({
            label: `⏳ ${newDate}`,
            ops: [{ path: sel.path, line: sel.line, before: [r.before], after: [r.after] }],
          });
        }
      });
      return;
    }
    if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      this.openDatePrompt(sel);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      await this.runWithRemoveAnim(sel.id, async () => {
        if (sel.status === "done") await this.api.undone(sel.id);
        else await this.api.done(sel.id);
      });
      return;
    }
    if (e.key === "e" || e.key === "E") {
      e.preventDefault();
      this.openAtSource(sel);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      await this.runWithRemoveAnim(sel.id, () => this.api.drop(sel.id));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.openAtSource(sel);
      return;
    }
  }

  // Undo stack push / pop now live on `this.undoStack` (UndoStack instance).
  // Kept callsites use `this.undoStack.push(entry)` and
  // `this.undoStack.pop()` — see `./view/undo` for the implementation.

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
        await this.runWithRemoveAnim(task.id, async () => {
          if (task.status === "done") await this.api.undone(task.id);
          else await this.api.done(task.id);
        });
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.scheduleToday")).onClick(async () => {
        const target = todayISO();
        if ((task.scheduled ?? null) !== target) {
          await this.runWithRemoveAnim(task.id, () => this.api.schedule(task.id, target));
        } else {
          this.scheduleRefresh();
        }
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.scheduleTomorrow")).onClick(async () => {
        const target = addDays(todayISO(), 1);
        if ((task.scheduled ?? null) !== target) {
          await this.runWithRemoveAnim(task.id, () => this.api.schedule(task.id, target));
        } else {
          this.scheduleRefresh();
        }
      }),
    );
    m.addItem((i) =>
      i.setTitle(tr("ctx.clearSchedule")).onClick(async () => {
        if (task.scheduled) {
          await this.runWithRemoveAnim(task.id, () => this.api.schedule(task.id, null));
        } else {
          this.scheduleRefresh();
        }
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
        await this.runWithRemoveAnim(task.id, () => this.api.drop(task.id));
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
    new DatePromptModal(
      this.app,
      tr("prompt.setScheduled", { title: task.title }),
      task.scheduled ?? todayISO(),
      async (resolved) => {
        if (resolved === undefined) return;
        const willMove = (task.scheduled ?? null) !== (resolved ?? null);
        const work = async () => {
          const r = await this.api.schedule(task.id, resolved);
          if (!r.unchanged) {
            this.undoStack.push({
              label: resolved ? `⏳ ${resolved}` : "⏳ cleared",
              ops: [{ path: task.path, line: task.line, before: [r.before], after: [r.after] }],
            });
          }
        };
        if (willMove) {
          await this.runWithRemoveAnim(task.id, work);
        } else {
          await work();
          this.scheduleRefresh();
        }
      },
    ).open();
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
          const r = await this.api.rename(task.id, newVal);
          if (!r.unchanged) {
            this.undoStack.push({
              label: `rename "${oldText.slice(0, 20)}" → "${newVal.slice(0, 20)}"`,
              ops: [{ path: task.path, line: task.line, before: [r.before], after: [r.after] }],
            });
          }
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
