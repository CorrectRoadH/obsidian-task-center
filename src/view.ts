import {
  App,
  ItemView,
  WorkspaceLeaf,
  Menu,
  Modal,
  Notice,
  Platform,
  TextComponent,
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
import { BottomSheet } from "./view/bottom-sheet";
import { attachCardGestures } from "./view/touch";
import { MobileDragController } from "./view/drag-mobile";
import { isMobileMode } from "./platform";
import { openTaskSourceEditShell } from "./view/source-dialog";
import { weekMinHeightFromViewHeightPx } from "./view/layout";
import { taskDisplayTags } from "./tags";
import { formatDateFilterLabel } from "./date-filter";
import { taskMatchesTimeToken, timeTokenAppliesToField } from "./time-filter";
import {
  applySavedViewFilters,
  clearSavedViewFilters as emptySavedViewFilters,
  createSavedView,
  hasSavedViewFilters,
  suggestSavedViewName as suggestSavedViewNameForFilters,
  upsertSavedView,
} from "./saved-views";
import type { SavedTaskView, SavedViewStatus } from "./types";
import type { SavedViewTimeField, SavedViewTimeFilters } from "./types";
import type TaskCenterPlugin from "./main";

type TabKey = "today" | "week" | "month" | "completed" | "unscheduled";
type FilterPopoverKey = "view" | "tag" | "status" | "time-more" | `time:${SavedViewTimeField}`;

const PRIMARY_TIME_FIELD: SavedViewTimeField = "scheduled";
const SECONDARY_TIME_FIELDS: SavedViewTimeField[] = ["deadline", "completed", "created"];

interface ViewState {
  tab: TabKey;
  anchorISO: string; // For week/month nav
  selectedTaskId: string | null;
  filter: string;
  savedViewId: string | null;
  savedViewTag: string;
  savedViewTime: SavedViewTimeFilters;
  savedViewStatus: SavedViewStatus;
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

function normalizeFilterTag(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed.toLowerCase() : `#${trimmed.toLowerCase()}`;
}

function parseFilterTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(",")) {
    const tag = normalizeFilterTag(part);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function taskHasTag(t: ParsedTask, tag: string): boolean {
  const wanted = normalizeFilterTag(tag);
  return t.tags.some((existing) => existing.toLowerCase() === wanted);
}

function taskMatchesText(t: ParsedTask, q: string): boolean {
  if (t.title.toLowerCase().includes(q)) return true;
  for (const tag of t.tags) if (tag.toLowerCase().includes(q)) return true;
  return false;
}

function taskTimeValue(t: ParsedTask, field: SavedViewTimeField): string | null {
  if (field === "scheduled") return t.scheduled;
  if (field === "deadline") return t.deadline;
  if (field === "completed") return t.completed;
  return t.created;
}

function taskMatchesTimeFilter(t: ParsedTask, field: SavedViewTimeField, token: string, weekStartsOn: 0 | 1): boolean {
  if (!timeTokenAppliesToField(field, token)) return false;
  return taskMatchesTimeToken(taskTimeValue(t, field), token, weekStartsOn);
}

function taskDateColumn(t: ParsedTask): string | null {
  if (t.status === "todo") return t.inheritsTerminal ? null : t.scheduled;
  if (t.status === "done") return t.completed;
  return null;
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
  // US-128: Ctrl/Cmd+Z undo stack. Only records writes initiated from this
  // view (drag / keyboard / quick-add). CLI writes are not captured —
  // they're scriptable and idempotent enough that auto-undo would be more
  // confusing than helpful (UX.md §6.7). Capped at 20 entries (UndoStack.MAX).
  // see USER_STORIES.md
  private undoStack: UndoStack;
  // Mobile drag controller (US-507) — pointer-based replacement for HTML5
  // DnD that doesn't fire from touch. Lazily created on first mobile drag.
  private mobileDrag: MobileDragController<TabKey> | null = null;
  private filterPopoverOpen: FilterPopoverKey | null = null;
  private dateCalendarAnchorISO = startOfMonth(todayISO());
  private pendingDateRangeStart: string | null = null;
  private viewResizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TaskCenterPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.api = plugin.api;
    this.undoStack = new UndoStack(this.app, {
      onApplied: () => this.scheduleRefresh(),
      notify: (msg, ms) => new Notice(msg, ms),
    });
    this.state = {
      // Priority: last-closed tab → defaultView setting → "week"
      tab: plugin.settings.lastTab ?? plugin.settings.defaultView ?? "week",
      anchorISO: todayISO(),
      selectedTaskId: null,
      filter: "",
      savedViewId: null,
      savedViewTag: "",
      savedViewTime: {},
      savedViewStatus: "all",
      showUnscheduledPool: true,
      collapsedWeeks: new Set(),
      expandedDays: new Set(),
    };
  }

  getViewType(): string {
    return VIEW_TYPE_TASK_CENTER;
  }
  getDisplayText(): string {
    return "Task Center";
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
    // the structural fix for #3 large-vault event-flood regression (double subscription → event flood).
    this.cacheUnsub = this.plugin.cache.on("changed", () => this.scheduleRefresh());

    // Keyboard
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleKey(e));

    // US-502: mobile layout gating. Reads viewport width (< 600px) OR
    // user setting `mobileForceLayout` (escape hatch for iPad / split-
    // screen) and writes `data-mobile-layout="true|false"` on contentEl;
    // styles.css attaches every mobile-only rule under
    // `[data-mobile-layout="true"]`. Driven by JS rather than @media so
    // the setting can override the viewport. UX-mobile §7.
    // see USER_STORIES.md
    this.applyMobileLayoutAttr();
    this.registerDomEvent(window, "resize", () => {
      this.applyMobileLayoutAttr();
      this.updateViewLayoutMetrics();
    });
    this.viewResizeObserver = new ResizeObserver(() => this.updateViewLayoutMetrics());
    this.viewResizeObserver.observe(this.contentEl);
    this.updateViewLayoutMetrics();

    // US-408: re-render when the user changes Obsidian's UI language.
    // Obsidian fires `css-change` on every theme/language reload; that's
    // our cheapest cross-platform signal. `t()` already re-detects the
    // locale on each call (i18n.ts), so a fresh render alone produces
    // localized strings — no manual locale-cache invalidation needed.
    this.registerEvent(this.app.workspace.on("css-change", () => this.render()));
  }

  /** Idempotent — recompute and write the data-mobile-layout attribute. */
  private applyMobileLayoutAttr(): void {
    const narrow = window.innerWidth < 600;
    const force = !!this.plugin.settings.mobileForceLayout;
    this.contentEl.dataset.mobileLayout = narrow || force ? "true" : "false";
  }

  private updateViewLayoutMetrics(): void {
    const rectHeight = this.contentEl.getBoundingClientRect().height;
    const viewHeight = rectHeight || this.contentEl.clientHeight;
    const weekMinHeight = weekMinHeightFromViewHeightPx(viewHeight);
    if (weekMinHeight > 0) {
      this.contentEl.style.setProperty("--tc-week-min-height", `${weekMinHeight}px`);
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
    this.viewResizeObserver?.disconnect();
    this.viewResizeObserver = null;
    this.dwellTracker.reset();
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

  private async openSourceEditShell(task: ParsedTask): Promise<void> {
    this.state.selectedTaskId = task.id;
    this.contentEl.focus();
    await openTaskSourceEditShell(this.app, this.leaf, task, {
      onSave: async () => {
        await this.waitForCacheUpdate([task.path], 2000);
        await this.reloadTasks();
        this.bumpCacheVersion();
        this.render();
      },
    });
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
  // US-125 task #33 observability gate. Set
  //   localStorage.setItem("task-center-debug","1")
  // in dev console to enable; reload Obsidian to take effect. Logs are
  // gated so they cost nothing for non-debug users.
  private isDebugLogging(): boolean {
    try {
      return window.localStorage.getItem("task-center-debug") === "1";
    } catch {
      return false;
    }
  }

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

  // US-405: persist the last-active tab so the next Obsidian open lands on
  // the same view the user closed on. Read back in the constructor's
  // ViewState init (priority: lastTab → defaultView → "week").
  // see USER_STORIES.md
  setTab(tab: TabKey) {
    this.state.tab = tab;
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
    // Settings can change between renders; recomputing the layout attr is
    // cheap and keeps the data attribute in sync without a separate hook.
    this.applyMobileLayoutAttr();

    const header = el.createDiv({ cls: "bt-header" });
    this.renderTabBar(header);
    this.renderMobileStatusRow(header);
    this.renderToolbar(header);

    const body = el.createDiv({ cls: "bt-body" });
    if (this.tasks.length === 0) {
      this.renderOnboarding(body);
    } else {
      switch (this.state.tab) {
        case "today":
          this.renderToday(body);
          break;
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
    this.updateViewLayoutMetrics();

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
    // task #43: same i18n keys as the desktop status bar so the two
    // surfaces stay in lock-step under any locale.
    const parts = [tr("status.today", { n: todayCount })];
    if (overdue > 0) parts.push(tr("status.overdue", { n: overdue }));
    row.setText(parts.join(" · "));
  }

  /**
   * US-502 mobile sticky action bar: abandon target on the left,
   * ➕ Add (open Quick Add) on the right. Always rendered; styles.css
   * hides it on ≥600px viewports. Drop semantics share the same wiring
   * as the desktop pool abandon zone via `wireTrashDropTarget`.
   */
  private renderMobileActionBar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "bt-mobile-action-bar" });
    bar.dataset.mobileEntry = "true";

    const home = bar.createEl("button", {
      text: tr("mobile.openTaskCenter"),
      cls: "bt-mobile-home-btn",
    });
    home.dataset.mobileAction = "open-task-center";
    home.addEventListener("click", () => this.setTab("today"));

    const abandon = bar.createDiv({ cls: "bt-mobile-trash" });
    abandon.dataset.dropZone = "abandon";
    abandon.createSpan({ cls: "bt-mobile-trash-icon", text: "⏹" });
    abandon.createSpan({ cls: "bt-mobile-trash-label", text: tr("trash.title") });
    this.wireTrashDropTarget(abandon);

    const add = bar.createEl("button", {
      text: tr("toolbar.add"),
      cls: "bt-mobile-add-btn",
    });
    add.dataset.mobileAction = "quick-add";
    add.addEventListener("click", () => this.openQuickAdd());
  }

  // US-113: empty-state onboarding card — "no tasks yet, press + to add" —
  // shown when the vault has zero parsed tasks. Beats a blank board: the
  // CTA also opens Quick Add so the first task is one click away.
  // see USER_STORIES.md
  private renderOnboarding(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "bt-onboarding" });
    wrap.dataset.emptyState = "first-use";
    if (this.contentEl.dataset.mobileLayout === "true") {
      wrap.dataset.mobileEmptyState = "true";
    }
    wrap.createEl("h2", { text: tr("onboarding.title") });
    // UX-mobile §10: mobile body avoids desktop keyboard language.
    wrap.createEl("p", { text: tr(isMobileMode() ? "onboarding.mobileBody" : "onboarding.body") });
    const btn = wrap.createEl("button", { text: tr("onboarding.cta"), cls: "bt-onboarding-cta" });
    btn.dataset.mobileAction = "empty-quick-add";
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
    // US-105: tab badge must match what the user sees after switching to
    // the tab. Each tab's body applies `hideChildrenOfVisibleParents` to
    // collapse children that ride with a visible parent — the badge has
    // to apply the same dedup or it overcounts (the reported bug:
    // Unscheduled tab said 15, body showed 1 because 14 children rode
    // with their parents).
    // US-720 (task #63): today tab badge counts overdue + today scheduled
    // todos. Unscheduled-rec is intentionally NOT counted — it's a single
    // recommendation slot, not a backlog measure.
    const overdueCount = activeTodos.filter((t) => t.deadline && t.deadline < today).length;
    const todayScheduled = activeTodos.filter((t) => t.scheduled === today).length;
    const counts = {
      today: overdueCount + todayScheduled,
      week: this.hideChildrenOfVisibleParents(
        this.tasks.filter((t) => {
          const date = taskDateColumn(t);
          return !!date && date >= weekStart && date <= weekEnd;
        }),
      ).length,
      month: this.hideChildrenOfVisibleParents(
        this.tasks.filter((t) => {
          const date = taskDateColumn(t);
          return !!date && date >= monthStart && date <= monthEnd;
        }),
      ).length,
      completed: this.hideChildrenOfVisibleParents(
        this.tasks.filter((t) => t.status === "done"),
      ).length,
      unscheduled: this.hideChildrenOfVisibleParents(
        activeTodos.filter((t) => !t.scheduled),
      ).length,
    };
    // US-720: Today is positioned first as the entry-point tab. Hotkeys
    // shifted from ⌃1..⌃4 → ⌃1..⌃5 so each tab still has a number key.
    const tabs: Array<{ key: TabKey; label: string; hotkey: string; count: number }> = [
      { key: "today", label: tr("tab.today"), hotkey: "⌃1", count: counts.today },
      { key: "week", label: tr("tab.week"), hotkey: "⌃2", count: counts.week },
      { key: "month", label: tr("tab.month"), hotkey: "⌃3", count: counts.month },
      { key: "completed", label: tr("tab.completed"), hotkey: "⌃4", count: counts.completed },
      { key: "unscheduled", label: tr("tab.unscheduled"), hotkey: "⌃5", count: counts.unscheduled },
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

    // US-109: title / tag search box. The matching impl in `getTextFilter`
    // also searches across tags so users can type `#3象限` or part of a
    // tag to narrow the board; CLI exposes the same filter via
    // `task-center:list search=…`.
    // see USER_STORIES.md
    const search = bar.createEl("input", { type: "text", placeholder: tr("toolbar.filter") });
    search.addClass("bt-search");
    search.value = this.state.filter;
    search.addEventListener("input", () => {
      this.state.filter = search.value;
      this.state.savedViewId = null;
      const caret = search.selectionStart;
      this.render();
      const el = this.contentEl.querySelector(".bt-search") as HTMLInputElement | null;
      if (el) {
        el.focus();
        const pos = caret ?? el.value.length;
        el.selectionStart = el.selectionEnd = pos;
      }
    });

    if (isMobileMode()) {
      const mobileFilters = bar.createEl("button", {
        text: tr("savedViews.mobileEntry"),
        cls: "bt-mobile-filter-btn",
      });
      mobileFilters.dataset.mobileAction = "filters";
      mobileFilters.addEventListener("click", () => this.openMobileFilterSheet());
    } else {
      this.renderSavedViewsToolbar(bar);
    }

    // US-163: toolbar `+` opens Quick Add, which writes the new line to
    // today's daily-note tail (the only entry point — see writer.addTask
    // resolution order). Default scheduled = unset; user adds ⏳ inline
    // via Quick Add tokens or schedules later via drag.
    // see USER_STORIES.md
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

  private renderSavedViewsToolbar(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "bt-saved-views" });
    wrap.dataset.savedViews = "true";

    this.renderSavedViewPicker(wrap);

    this.renderTagFilter(wrap);

    this.renderTimeFilter(wrap, PRIMARY_TIME_FIELD);

    this.renderMoreTimeFilters(wrap);

    this.renderStatusFilter(wrap);

    const save = wrap.createEl("button", { text: tr("savedViews.save"), cls: "bt-saved-view-save" });
    save.dataset.action = "save-current-view";
    const canSave = this.hasSaveableFilters();
    save.disabled = !canSave;
    if (!canSave) save.title = tr("savedViews.saveDisabled");
    save.addEventListener("click", async () => {
      if (!this.hasSaveableFilters()) return;
      const name = await this.askSavedViewName();
      if (!name || !name.trim()) return;
      await this.saveCurrentView(name.trim());
      this.render();
    });
  }

  private renderSavedViewPicker(parent: HTMLElement): void {
    const container = parent.createDiv({ cls: "bt-filter-popover-wrap" });
    const selected = this.plugin.settings.savedViews.find((view) => view.id === this.state.savedViewId);
    const trigger = container.createEl("button", {
      text: selected?.name ?? tr("savedViews.current"),
      cls: "bt-saved-view-select",
    });
    trigger.dataset.savedViewSelect = "true";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === "view" ? "true" : "false");
    trigger.addEventListener("click", () => {
      this.filterPopoverOpen = this.filterPopoverOpen === "view" ? null : "view";
      this.render();
    });
    if (this.filterPopoverOpen !== "view") return;

    const popover = container.createDiv({ cls: "bt-filter-popover bt-view-popover" });
    popover.setAttribute("role", "listbox");
    const current = popover.createEl("button", { text: tr("savedViews.current"), cls: "bt-menu-option" });
    current.dataset.savedViewOption = tr("savedViews.current");
    current.setAttribute("aria-selected", this.state.savedViewId ? "false" : "true");
    current.addEventListener("click", () => {
      this.clearSavedViewFilters();
      this.render();
    });
    if (this.plugin.settings.savedViews.length === 0) {
      popover.createDiv({ text: tr("savedViews.emptyHint"), cls: "bt-menu-empty" });
      return;
    }
    for (const view of this.plugin.settings.savedViews) {
      const option = popover.createEl("button", { text: view.name, cls: "bt-menu-option" });
      option.dataset.savedViewOption = view.name;
      option.setAttribute("aria-selected", view.id === this.state.savedViewId ? "true" : "false");
      option.addEventListener("click", () => {
        this.applySavedView(view);
        this.render();
      });
    }
  }

  private renderTimeFilter(parent: HTMLElement, field: SavedViewTimeField): void {
    const container = parent.createDiv({ cls: "bt-filter-popover-wrap" });
    const options = this.timeFilterOptions(field);
    const active = this.timeFilterValue(field);
    const label = this.timeFilterLabel(field, active);
    const popoverKey = this.timePopoverKey(field);
    const trigger = container.createEl("button", { text: label, cls: "bt-saved-view-filter bt-date-trigger" });
    trigger.title = label;
    trigger.dataset.savedViewFilter = `time-${field}`;
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === popoverKey ? "true" : "false");
    trigger.addEventListener("click", () => {
      const willOpen = this.filterPopoverOpen !== popoverKey;
      this.filterPopoverOpen = willOpen ? popoverKey : null;
      if (willOpen) {
        this.dateCalendarAnchorISO = this.dateCalendarAnchorForField(field);
        this.pendingDateRangeStart = null;
      }
      this.render();
    });
    if (this.filterPopoverOpen !== popoverKey) return;

    const popover = container.createDiv({ cls: "bt-filter-popover bt-date-popover" });
    popover.setAttribute("role", "listbox");
    this.renderTimeRangePopover(popover, field, options);
  }

  private renderTimeRangePopover(parent: HTMLElement, field: SavedViewTimeField, options = this.timeFilterOptions(field)): void {
    const presetPanel = parent.createDiv({ cls: "bt-date-presets" });
    presetPanel.createDiv({ text: tr("savedViews.timePreset", { field: this.timeFieldLabel(field) }), cls: "bt-date-section-title" });
    for (const [value, text] of options) {
      const option = presetPanel.createEl("button", { cls: "bt-date-preset" });
      option.createSpan({ text, cls: "bt-date-preset-label" });
      option.dataset.timeOption = `${field}:${value || "all"}`;
      option.setAttribute("aria-selected", (this.timeFilterValue(field) || "") === value ? "true" : "false");
      option.addEventListener("click", () => this.setTimeFilter(field, value));
    }

    this.renderDateCalendar(parent, field);
  }

  private renderMoreTimeFilters(parent: HTMLElement): void {
    const container = parent.createDiv({ cls: "bt-filter-popover-wrap" });
    const count = SECONDARY_TIME_FIELDS.filter((field) => this.timeFilterValue(field)).length;
    const text = count > 0 ? tr("savedViews.timeMoreActive", { count }) : tr("savedViews.timeMore");
    const trigger = container.createEl("button", { text, cls: "bt-saved-view-filter bt-time-more-trigger" });
    trigger.dataset.savedViewFilter = "time-more";
    trigger.setAttribute("aria-haspopup", "listbox");
    const openForSecondary = this.filterPopoverOpen?.startsWith("time:")
      && this.filterPopoverOpen !== this.timePopoverKey(PRIMARY_TIME_FIELD);
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === "time-more" || openForSecondary ? "true" : "false");
    trigger.addEventListener("click", () => {
      this.filterPopoverOpen = this.filterPopoverOpen === "time-more" ? null : "time-more";
      this.pendingDateRangeStart = null;
      this.render();
    });

    if (!(this.filterPopoverOpen === "time-more" || openForSecondary)) return;

    const popover = container.createDiv({ cls: "bt-filter-popover bt-time-more-popover" });
    popover.setAttribute("role", "listbox");
    const activeField = this.timeFieldFromPopover(this.filterPopoverOpen);
    if (activeField && activeField !== PRIMARY_TIME_FIELD) {
      popover.addClass("bt-date-popover");
      const back = popover.createEl("button", { text: tr("savedViews.timeBack"), cls: "bt-time-back" });
      back.addEventListener("click", () => {
        this.filterPopoverOpen = "time-more";
        this.pendingDateRangeStart = null;
        this.render();
      });
      this.renderTimeRangePopover(popover, activeField);
      return;
    }

    for (const field of SECONDARY_TIME_FIELDS) {
      const value = this.timeFilterValue(field);
      const row = popover.createDiv({ cls: "bt-time-more-row" });
      row.createSpan({ text: this.timeFieldLabel(field), cls: "bt-time-more-label" });
      const pick = row.createEl("button", {
        text: this.timeFilterLabel(field, value),
        cls: "bt-time-more-pick",
      });
      pick.dataset.timeField = field;
      pick.addEventListener("click", () => {
        this.filterPopoverOpen = this.timePopoverKey(field);
        this.dateCalendarAnchorISO = this.dateCalendarAnchorForField(field);
        this.pendingDateRangeStart = null;
        this.render();
      });
      const clear = row.createEl("button", { text: "×", cls: "bt-time-more-clear" });
      clear.ariaLabel = tr("savedViews.clearTimeRange", { field: this.timeFieldLabel(field) });
      clear.disabled = !value;
      clear.addEventListener("click", () => this.setTimeFilter(field, ""));
    }
  }

  private timeFilterOptions(field: SavedViewTimeField): Array<readonly [string, string]> {
    const base: Array<readonly [string, string]> = [
      ["", tr("savedViews.timeAll", { field: this.timeFieldLabel(field) })],
    ];
    if (field === "deadline") {
      base.push(["overdue", tr("savedViews.dateOverdue")], ["next-7-days", tr("savedViews.dateNext7Days")]);
    }
    base.push(
      ["today", tr("savedViews.dateToday")],
      ["tomorrow", tr("savedViews.dateTomorrow")],
      ["week", tr("savedViews.dateWeek")],
      ["next-week", tr("savedViews.dateNextWeek")],
      ["month", tr("savedViews.dateMonth")],
    );
    return base;
  }

  private timeFilterLabel(field: SavedViewTimeField, value: string): string {
    return formatDateFilterLabel(value, {
      emptyLabel: this.timeFieldLabel(field),
      openStartLabel: tr("savedViews.rangeOpenStart"),
      openEndLabel: tr("savedViews.rangeOpenEnd"),
      presets: new Map(this.timeFilterOptions(field)),
    });
  }

  private timeFieldLabel(field: SavedViewTimeField): string {
    if (field === "scheduled") return tr("savedViews.timeScheduled");
    if (field === "deadline") return tr("savedViews.timeDeadline");
    if (field === "completed") return tr("savedViews.timeCompleted");
    return tr("savedViews.timeCreated");
  }

  private timeFilterValue(field: SavedViewTimeField): string {
    return this.state.savedViewTime[field]?.trim() ?? "";
  }

  private timePopoverKey(field: SavedViewTimeField): FilterPopoverKey {
    return `time:${field}`;
  }

  private timeFieldFromPopover(key: FilterPopoverKey | null): SavedViewTimeField | null {
    if (!key?.startsWith("time:")) return null;
    const field = key.slice("time:".length) as SavedViewTimeField;
    return ["scheduled", "deadline", "completed", "created"].includes(field) ? field : null;
  }

  private parseDateFilterValue(value: string): { exact: string; from: string; to: string } {
    const token = value.trim();
    if (!token) return { exact: "", from: "", to: "" };
    if (token.includes("..")) {
      const [from, to] = token.split("..", 2);
      return { exact: "", from, to };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return { exact: token, from: "", to: "" };
    return { exact: "", from: "", to: "" };
  }

  private renderDateCalendar(parent: HTMLElement, field: SavedViewTimeField): void {
    const calendar = parent.createDiv({ cls: "bt-date-calendar" });
    const head = calendar.createDiv({ cls: "bt-date-calendar-head" });
    head.createSpan({ text: tr("savedViews.customTimeRange", { field: this.timeFieldLabel(field) }), cls: "bt-date-section-title" });
    const clear = head.createEl("button", { text: tr("savedViews.clearTimeRange", { field: this.timeFieldLabel(field) }), cls: "bt-date-clear" });
    clear.dataset.timeClear = field;
    clear.disabled = !this.timeFilterValue(field) && !this.pendingDateRangeStart;
    clear.addEventListener("click", () => this.setTimeFilter(field, ""));

    const nav = calendar.createDiv({ cls: "bt-date-calendar-nav" });
    const prev = nav.createEl("button", { text: "‹", cls: "bt-date-month-nav" });
    prev.ariaLabel = tr("savedViews.datePreviousMonth");
    prev.addEventListener("click", () => this.moveDateCalendarMonth(-1));
    nav.createSpan({ text: this.dateCalendarMonthLabel(), cls: "bt-date-month-label" });
    const next = nav.createEl("button", { text: "›", cls: "bt-date-month-nav" });
    next.ariaLabel = tr("savedViews.dateNextMonth");
    next.addEventListener("click", () => this.moveDateCalendarMonth(1));

    const weekdays = calendar.createDiv({ cls: "bt-date-calendar-weekdays" });
    const weekStart = this.plugin.settings.weekStartsOn;
    for (let i = 0; i < 7; i++) {
      const day = (weekStart + i) % 7;
      weekdays.createSpan({ text: tr(WEEKDAY_KEYS[day]), cls: "bt-date-calendar-weekday" });
    }

    const active = this.parseDateFilterValue(this.timeFilterValue(field));
    const rangeFrom = active.from || active.exact || "";
    const rangeTo = active.to || active.exact || "";
    const monthStart = startOfMonth(this.dateCalendarAnchorISO);
    const gridStart = startOfWeek(monthStart, weekStart);
    const today = todayISO();
    const days = calendar.createDiv({ cls: "bt-date-calendar-grid" });
    for (let i = 0; i < 42; i++) {
      const iso = addDays(gridStart, i);
      const day = fromISO(iso);
      const cell = days.createEl("button", { text: String(day.getDate()), cls: "bt-date-calendar-day" });
      cell.dataset.dateCalendarDay = iso;
      cell.setAttribute("aria-selected", active.exact === iso || iso === active.from || iso === active.to ? "true" : "false");
      if (!iso.startsWith(monthStart.slice(0, 7))) cell.addClass("other-month");
      if (iso === today) cell.addClass("today");
      if (this.pendingDateRangeStart === iso) cell.addClass("pending");
      if (rangeFrom && rangeTo && iso >= rangeFrom && iso <= rangeTo) cell.addClass("in-range");
      if (iso === active.from) cell.addClass("range-start");
      if (iso === active.to) cell.addClass("range-end");
      cell.addEventListener("click", () => this.handleDateCalendarDayClick(field, iso));
    }
  }

  private moveDateCalendarMonth(delta: number): void {
    this.dateCalendarAnchorISO = startOfMonth(shiftMonth(this.dateCalendarAnchorISO, delta));
    this.render();
  }

  private handleDateCalendarDayClick(field: SavedViewTimeField, iso: string): void {
    if (!this.pendingDateRangeStart) {
      this.pendingDateRangeStart = iso;
      this.filterPopoverOpen = this.timePopoverKey(field);
      this.render();
      return;
    }
    const from = this.pendingDateRangeStart <= iso ? this.pendingDateRangeStart : iso;
    const to = this.pendingDateRangeStart <= iso ? iso : this.pendingDateRangeStart;
    this.pendingDateRangeStart = null;
    this.setTimeFilter(field, `${from}..${to}`);
  }

  private dateCalendarAnchorForField(field: SavedViewTimeField): string {
    const parsed = this.parseDateFilterValue(this.timeFilterValue(field));
    return startOfMonth(parsed.exact || parsed.from || parsed.to || todayISO());
  }

  private dateCalendarMonthLabel(): string {
    const d = fromISO(this.dateCalendarAnchorISO);
    return new Intl.DateTimeFormat(getLocale(), { month: "long", year: "numeric" }).format(d);
  }

  private renderStatusFilter(parent: HTMLElement): void {
    const container = parent.createDiv({ cls: "bt-filter-popover-wrap" });
    const label = this.state.savedViewStatus === "all"
      ? tr("savedViews.statusAll")
      : this.statusFilterOptions().find((option) => option.value === this.state.savedViewStatus)?.label
        ?? tr("savedViews.statusAll");
    const trigger = container.createEl("button", {
      text: label,
      cls: "bt-saved-view-filter bt-status-trigger",
    });
    trigger.dataset.savedViewFilter = "status";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === "status" ? "true" : "false");
    trigger.addEventListener("click", () => {
      this.filterPopoverOpen = this.filterPopoverOpen === "status" ? null : "status";
      this.render();
    });
    if (this.filterPopoverOpen !== "status") return;

    const popover = container.createDiv({ cls: "bt-filter-popover bt-status-popover" });
    popover.setAttribute("role", "listbox");
    for (const option of this.statusFilterOptions()) {
      const item = popover.createEl("button", { cls: "bt-status-option" });
      item.dataset.statusOption = option.value;
      item.setAttribute("aria-selected", this.state.savedViewStatus === option.value ? "true" : "false");
      item.createSpan({ text: option.label, cls: "bt-status-option-label" });
      item.addEventListener("click", () => this.setStatusFilter(option.value));
    }
  }

  private statusFilterOptions(): Array<{ value: SavedViewStatus; label: string }> {
    return [
      { value: "all", label: tr("savedViews.statusAny") },
      { value: "todo", label: tr("savedViews.statusTodo") },
      { value: "done", label: tr("savedViews.statusDone") },
      { value: "dropped", label: tr("savedViews.statusDropped") },
    ];
  }

  private renderTagFilter(parent: HTMLElement): void {
    const selected = parseFilterTags(this.state.savedViewTag);
    const selectedSet = new Set(selected);
    const container = parent.createDiv({ cls: "bt-tag-filter" });
    const triggerText = this.tagFilterSummary(selected);
    const trigger = container.createEl("button", { text: triggerText, cls: "bt-tag-filter-trigger" });
    if (selected.length > 0) trigger.title = selected.join(", ");
    trigger.dataset.savedViewFilter = "tag";
    trigger.ariaLabel = tr("savedViews.tag");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", this.filterPopoverOpen === "tag" ? "true" : "false");
    trigger.addEventListener("click", () => {
      this.filterPopoverOpen = this.filterPopoverOpen === "tag" ? null : "tag";
      this.render();
    });

    if (this.filterPopoverOpen !== "tag") return;

    const popover = container.createDiv({ cls: "bt-tag-popover" });
    popover.setAttribute("role", "listbox");
    const search = popover.createEl("input", {
      type: "text",
      placeholder: tr("savedViews.tagSearch"),
      cls: "bt-tag-search",
    });
    const clear = popover.createEl("button", { text: tr("savedViews.clearTags"), cls: "bt-tag-clear" });
    clear.dataset.tagClear = "true";
    clear.addEventListener("click", () => this.setSelectedTags([]));

    const list = popover.createDiv({ cls: "bt-tag-options" });
    const rows: HTMLElement[] = [];
    for (const option of this.collectTagOptions()) {
      const row = list.createEl("button", { cls: "bt-tag-option" });
      row.dataset.tagOption = option.tag;
      row.title = option.tag;
      row.setAttribute("role", "checkbox");
      row.setAttribute("aria-checked", selectedSet.has(option.tag.toLowerCase()) ? "true" : "false");
      row.createSpan({ text: selectedSet.has(option.tag.toLowerCase()) ? "✓" : "", cls: "bt-tag-check" });
      row.createSpan({ text: option.tag, cls: "bt-tag-option-label" });
      row.createSpan({ text: String(option.count), cls: "bt-tag-option-count" });
      row.addEventListener("click", () => {
        const isSelected = selectedSet.has(option.tag.toLowerCase());
        const next = !isSelected
          ? [...selected, option.tag]
          : selected.filter((tag) => tag !== option.tag.toLowerCase());
        this.setSelectedTags(next);
      });
      rows.push(row);
    }
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      for (const row of rows) {
        const value = row.dataset.tagOption?.toLowerCase() ?? "";
        row.style.display = !q || value.includes(q) ? "" : "none";
      }
    });
    search.focus();
  }

  private tagFilterSummary(selected: string[]): string {
    if (selected.length === 0) return tr("savedViews.tag");
    const first = selected[0];
    if (selected.length === 1) return first;
    return `${first} +${selected.length - 1}`;
  }

  private hasSaveableFilters(): boolean {
    return hasSavedViewFilters({
      search: this.state.filter,
      tag: this.state.savedViewTag,
      time: this.state.savedViewTime,
      status: this.state.savedViewStatus,
    });
  }

  private hasActiveFilters(): boolean {
    return this.hasSaveableFilters();
  }

  private renderFilterEmptyState(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: "bt-filter-empty" });
    empty.createSpan({ text: tr("filters.empty"), cls: "bt-filter-empty-text" });
    const clear = empty.createEl("button", { text: tr("filters.clear"), cls: "bt-filter-empty-clear" });
    clear.dataset.action = "clear-filters";
    clear.addEventListener("click", () => {
      this.clearSavedViewFilters();
      this.render();
    });
  }

  private setTimeFilter(field: SavedViewTimeField, value: string): void {
    const next = { ...this.state.savedViewTime };
    const trimmed = value === "all" ? "" : value.trim();
    if (trimmed) next[field] = trimmed;
    else delete next[field];
    this.state.savedViewTime = next;
    this.state.savedViewId = null;
    this.filterPopoverOpen = null;
    this.pendingDateRangeStart = null;
    this.render();
  }

  private setStatusFilter(value: SavedViewStatus): void {
    this.state.savedViewStatus = value;
    this.state.savedViewId = null;
    this.filterPopoverOpen = null;
    this.render();
  }

  private openMobileFilterSheet(): void {
    const sheet = new BottomSheet(this.app, {
      title: tr("savedViews.mobileTitle"),
      populate: (el) => {
        const body = el.createDiv({ cls: "bt-mobile-filter-sheet" });
        this.renderSavedViewsToolbar(body);
      },
    });
    sheet.open();
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

  // US-101: 7-day Mon–Sun (or Sun–Sat per settings) week view, today
  // highlighted, prev/next-week navigation. Each day column is a
  // makeDropZone target so cards dragged across columns rewrite ⏳
  // (US-121). On mobile this delegates to a vertical collapsible list
  // (US-503), see expandedDays state above.
  // see USER_STORIES.md
  private renderWeek(parent: HTMLElement) {
    const today = todayISO();
    const weekStart = startOfWeek(this.state.anchorISO, this.plugin.settings.weekStartsOn);
    const days: string[] = [];
    for (let i = 0; i < 7; i++) days.push(addDays(weekStart, i));

    const filter = this.getTextFilter();
    if (this.hasActiveFilters()) {
      const unfilteredCount = days.reduce(
        (sum, day) => sum + this.hideChildrenOfVisibleParents(
          this.tasks.filter((t) => taskDateColumn(t) === day),
        ).length,
        0,
      );
      const filteredCount = days.reduce(
        (sum, day) => sum + this.hideChildrenOfVisibleParents(
          this.tasks.filter((t) => taskDateColumn(t) === day).filter(filter),
        ).length,
        0,
      );
      if (unfilteredCount > 0 && filteredCount === 0) this.renderFilterEmptyState(parent);
    }

    const wrapper = parent.createDiv({ cls: "bt-week" });

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
        .filter((t) => taskDateColumn(t) === day)
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
        this.renderCard(list, t, day);
      }
    }
  }

  // US-116: per-column header line `N tasks · XhYm` — task count plus
  // summed `[estimate::]` minutes. Lets the user see at a glance whether
  // a day is overbooked before they drop a new card on it. Sum collapses
  // to plain count when no card on the day carries an estimate.
  // see USER_STORIES.md
  private columnStats(tasks: ParsedTask[]): string {
    const sum = tasks.reduce((s, t) => s + (t.estimate ?? 0), 0);
    if (sum === 0) return `${tasks.length}`;
    return `${tasks.length} · ${formatMinutes(sum)}`;
  }

  /**
   * If a task's parent is also in the visible set, hide the child at the top
   * level — it will still render inside the parent's children block.
   *
   * US-143: parent-visible cards never duplicate the same child as a
   *  standalone top-level card; the child rides inside the parent's
   *  children block. This is the implementation of "child not duplicated
   *  as top-level when parent is visible".
   * US-148 carve-out: a child that has its OWN `⏳` different from the
   * parent's must NOT be hidden by the "parent has scheduled" branch — it
   * needs to surface in its own day column as a top-level card. Only hide
   * children that lack an independent schedule (so they ride with the
   * parent) or that share the parent's day (already represented by the
   * parent card).
   * see USER_STORIES.md
   */
  private hideChildrenOfVisibleParents(visible: ParsedTask[]): ParsedTask[] {
    const ids = new Set(visible.map((t) => t.id));
    return visible.filter((t) => {
      if (t.parentLine === null) return true;
      const parentId = `${t.path}:L${t.parentLine + 1}`;
      // Already in this list? Parent will render the child inline — but
      // only if the child rides with the parent (no independent ⏳ or
      // same day). Otherwise we want both: parent card without this
      // child, and the child as a top-level card on its own day.
      if (ids.has(parentId)) {
        const parent = this.findParentTask(t);
        return parent ? this.hasIndependentDateFromParent(t, parent) : true;
      }
      // Parent lives in another day column (has its own ⏳).
      const parent = this.tasks.find(
        (x) => x.path === t.path && x.line === t.parentLine,
      );
      if (parent && parent.scheduled) {
        // Only hide when the child rides with the parent — no independent
        // ⏳, or matching ⏳ (which is already covered by the parent card).
        if (!this.hasIndependentDateFromParent(t, parent)) return false;
      }
      return true;
    });
  }

  private hasIndependentDateFromParent(child: ParsedTask, parent: ParsedTask): boolean {
    const parentDate = parent.scheduled;
    if (child.scheduled && child.scheduled !== parentDate) return true;
    if (child.completed && child.completed !== parentDate) return true;
    if (child.cancelled && child.cancelled !== parentDate) return true;
    return false;
  }

  private findParentTask(t: ParsedTask): ParsedTask | undefined {
    if (t.parentLine === null) return undefined;
    return this.tasks.find(
      (x) => x.path === t.path && x.line === t.parentLine,
    );
  }

  // ---------- Month ----------

  // US-102: month calendar grid (6 weeks × 7 days, anchored to month-start
  // week). Prev / next-month navigation lives on the toolbar buttons in
  // `renderToolbar`. Each day cell renders up to 6 mini-cards plus a
  // `+N more` overflow chip; tapping the cell on mobile opens the day's
  // task list as a bottom sheet (US-504).
  // US-122: every cell is a `makeDropZone` target so dragging a card onto
  // a date in the month grid rewrites its ⏳ to that day — same write
  // semantics as the week-view day columns (US-121).
  // see USER_STORIES.md
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

    const filter = this.getTextFilter();
    if (this.hasActiveFilters()) {
      const unfilteredCount = gridDays.reduce(
        (sum, day) => sum + this.hideChildrenOfVisibleParents(
          this.tasks.filter((t) => taskDateColumn(t) === day),
        ).length,
        0,
      );
      const filteredCount = gridDays.reduce(
        (sum, day) => sum + this.hideChildrenOfVisibleParents(
          this.tasks.filter((t) => taskDateColumn(t) === day).filter(filter),
        ).length,
        0,
      );
      if (unfilteredCount > 0 && filteredCount === 0) this.renderFilterEmptyState(wrapper);
    }

    const grid = wrapper.createDiv({ cls: "bt-month-grid" });
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
        .filter((t) => taskDateColumn(t) === day)
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
      // US-504: mobile month tab is calendar-grid + per-day dot density;
      // tapping a day opens that day's task list as a bottom sheet (the
      // desktop path leaves the click as a no-op — chips inside handle
      // their own drag / select). Detection is "in mobile layout" — the
      // same predicate `applyMobileLayoutAttr` uses for the data-attr,
      // so viewport-narrow OR US-502 mobileForceLayout both qualify.
      // task #42 fixed the case where force-mobile was on but the
      // viewport was wide — the click previously silently no-op'd.
      // see USER_STORIES.md
      cell.addEventListener("click", (e) => {
        const narrow = window.innerWidth < 600;
        const force = !!this.plugin.settings.mobileForceLayout;
        if (!narrow && !force) return;
        // Don't fire when the click bubbled from a chip — that's a select
        // intent, not "open the day".
        if ((e.target as HTMLElement).closest(".bt-mini-card")) return;
        this.openDayTasksSheet(day, dayTasks);
      });
    }
  }

  /**
   * Mobile-only: long-press a card → bottom sheet with task actions.
   * Mirrors the desktop right-click menu (UX-mobile.md §5.1 / US-506)
   * into a single thumb-reachable surface. Buttons call the same `api.*`
   * methods as the desktop UI; rendered as a flat list of large tap targets.
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
        // Source location — quick orientation only. Editing source context
        // now goes through the US-168 single-click source edit shell.
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

        // task #43: route every label in the long-press action sheet
        // through tr() so a Chinese session sees "完成 / 取消完成 / 放弃"
        // etc. instead of the raw EN literals. The two
        // ⏳ <date> entries keep the date verbatim — the i18n template
        // wraps it without reformatting (locale-stable per US-411).
        btn(
          t.status === "done" ? tr("sheet.markUndone") : tr("sheet.done"),
          () => (t.status === "done" ? this.api.undone(t.id) : this.api.done(t.id)),
        );
        btn(tr("sheet.scheduleAt", { date: today }), () => this.api.schedule(t.id, today));
        btn(tr("sheet.scheduleAt", { date: tomorrow }), () => this.api.schedule(t.id, tomorrow));
        btn(tr("sheet.scheduleClear"), () => this.api.schedule(t.id, null));
        btn(tr("sheet.drop"), () => this.api.drop(t.id));
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
    const completedAll = this.tasks.filter((t) => t.status === "done" && t.completed);
    const completed = completedAll
      .filter(filter)
      .sort((a, b) => (b.completed! < a.completed! ? -1 : 1));

    const wrap = parent.createDiv({ cls: "bt-completed" });
    if (completed.length === 0 && completedAll.length > 0 && this.hasActiveFilters()) {
      this.renderFilterEmptyState(wrap);
      return;
    }

    // US-303: 7-day estimate-accuracy headline + top-tag minutes preset.
    // Mirrors the CLI `stats days=7` summary so the GUI user gets the same
    // calibration signal an AI agent would. Implementation lives in
    // `computeStats` (cli.ts) — view just renders the StatsResult.
    // see USER_STORIES.md
    const stats = computeStats(this.tasks, { days: 7 });
    if (stats.doneCount > 0) {
      const header = wrap.createDiv({ cls: "bt-stats-header" });
      const left = header.createDiv({ cls: "bt-stats-left" });
      // task #43 (PM HOLD msg cbf0489c): Completed-tab stats header
      // through tr() so a CN session reads "近 7 日 · 完成 N 条 / 准确率…"
      // instead of the EN literals.
      left.createSpan({
        text: tr("stats.sevenDayDone", { n: stats.doneCount }),
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
          text: tr("stats.ratio", { ratio: stats.ratio.toFixed(2), sign, delta }),
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
      // US-304: history weeks default-collapsed, current week expanded —
      // keeps the past from pushing this week below the fold. The user's
      // explicit expand / collapse choice lives in collapsedWeeks (with an
      // `EXPANDED:` marker for the inverse) and overrides the default.
      // see USER_STORIES.md
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
          row.addEventListener("click", () => {
            void this.openSourceEditShell(t);
          });
        }
      }
    }
  }

  // ---------- Unscheduled ----------

  // US-104: unscheduled pool sorted "what should I pick next" — deadline
  // ascending first (nearest 📅 wins), tasks with no deadline fall to the
  // end, and ties are broken by created date desc (newest on top). Same
  // sort runs in `renderUnscheduledBig` below; if you change one, change
  // both — they're the two surfaces that show the pool.
  // see USER_STORIES.md
  private renderUnscheduledPool(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const unscheduledBase = this.tasks.filter((t) => !t.scheduled && t.status === "todo" && !t.inheritsTerminal);
    const unscheduledAll = unscheduledBase.filter(filter);
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

  // US-123: bottom abandon target — dragging a card here marks it
  // `[-] ❌ today` (abandoned), and by US-124 cascades to its `todo`
  // descendants while preserving already-done children as history.
  // `data-drop-zone="abandon"` is the selector contract; the visible UI
  // intentionally avoids trash/delete wording.
  // see USER_STORIES.md
  private renderTrashZone(parent: HTMLElement) {
    const trash = parent.createDiv({ cls: "bt-trash" });
    // e2e drop-zone selector: `[data-drop-zone="abandon"]`. Stable across the
    // visible icon / label / theme. (The mobile action bar carries the
    // same data attribute on a different element; styles.css hides one
    // or the other based on viewport width — see UX-mobile.md §2 / §13.)
    trash.dataset.dropZone = "abandon";
    trash.createDiv({ cls: "bt-trash-icon", text: "⏹" });
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
   * abandon drop target. Drop = `api.drop(id)` (mark `[-] ❌`). Used by both
   * the desktop pool abandon zone (UX.md §6) and the mobile sticky action
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

  // US-720 (task #63): today execution view.
  //
  // Single question this view answers: "what should I do today?". Three
  // capped groups — overdue, scheduled-for-today, and one recommendation
  // pulled from the inbox/unscheduled. Each card carries the three minimal
  // inline actions (done / reschedule-to-tomorrow / drop); clicking the
  // card opens the US-168 source edit shell. The
  // view intentionally does NOT mirror the full board: per-group cap is 3
  // so the first screen stays scannable.
  //
  // DOM contract (frozen as test fixtures in test/e2e/specs/today-view.e2e.ts):
  //   [data-view="today"]                    container
  //   [data-today-group="overdue"]            section
  //   [data-today-group="today"]              section
  //   [data-today-group="unscheduled-rec"]    section
  //   [data-today-empty]                      empty-state element
  //   [data-action="reschedule-tomorrow"]     per-card primary action
  // see USER_STORIES.md
  private renderToday(parent: HTMLElement) {
    const wrap = parent.createDiv({ cls: "bt-today" });
    wrap.dataset.view = "today";

    const today = todayISO();
    const tomorrow = addDays(today, 1);
    const activeTodos = this.tasks.filter(
      (t) => t.status === "todo" && !t.inheritsTerminal && t.title.trim() !== "",
    );

    // Overdue: anything with a deadline in the past, regardless of schedule.
    // Sort earliest-deadline first so the most-overdue rises to the top.
    const overdue = activeTodos
      .filter((t) => t.deadline && t.deadline < today)
      .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""));

    // Today: scheduled to land on today. Cards already in the overdue group
    // are skipped to avoid double-listing.
    const overdueIds = new Set(overdue.map((t) => t.id));
    const todayList = activeTodos
      .filter((t) => t.scheduled === today && !overdueIds.has(t.id));

    // Unscheduled recommendation: just the one freshest unscheduled todo.
    // The full backlog lives on the Unscheduled tab — this slot is a single
    // nudge so the user doesn't sit on an empty Today screen when they have
    // inbox items waiting.
    const unscheduledRec = activeTodos
      .filter((t) => !t.scheduled && !t.deadline)
      .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
      .slice(0, 1);

    const PER_GROUP_CAP = 3;

    const isAllEmpty =
      overdue.length === 0 && todayList.length === 0 && unscheduledRec.length === 0;
    if (isAllEmpty) {
      const empty = wrap.createDiv({ cls: "bt-today-empty" });
      empty.dataset.todayEmpty = "true";
      empty.setText(tr("today.empty"));
      return;
    }

    this.renderTodayGroup(wrap, "overdue", tr("today.groupOverdue"), overdue.slice(0, PER_GROUP_CAP), tomorrow);
    this.renderTodayGroup(wrap, "today", tr("today.groupToday"), todayList.slice(0, PER_GROUP_CAP), tomorrow);
    this.renderTodayGroup(wrap, "unscheduled-rec", tr("today.groupRec"), unscheduledRec, tomorrow);
  }

  private renderTodayGroup(
    parent: HTMLElement,
    key: "overdue" | "today" | "unscheduled-rec",
    label: string,
    list: ParsedTask[],
    tomorrow: string,
  ) {
    const section = parent.createDiv({ cls: `bt-today-group bt-today-group-${key}` });
    section.dataset.todayGroup = key;
    const head = section.createDiv({ cls: "bt-today-group-head" });
    head.createSpan({ text: label, cls: "bt-today-group-label" });
    if (list.length > 0) {
      head.createSpan({ text: String(list.length), cls: "bt-today-group-count" });
    }
    if (list.length === 0) {
      section.createDiv({ cls: "bt-today-group-empty", text: tr("today.groupEmpty") });
      return;
    }
    for (const t of list) this.renderTodayCard(section, t, tomorrow);
  }

  private renderTodayCard(parent: HTMLElement, t: ParsedTask, tomorrow: string) {
    const card = parent.createDiv({ cls: "bt-today-card" });
    card.dataset.taskId = t.id;
    if (this.state.selectedTaskId === t.id) card.addClass("selected");

    const main = card.createDiv({ cls: "bt-today-card-main" });
    main.createDiv({ cls: "bt-today-card-title", text: t.title });
    this.renderTaskTags(main, t.tags, "bt-today-card-tags");
    const meta = main.createDiv({ cls: "bt-today-card-meta" });
    const metaParts: string[] = [];
    metaParts.push(t.path);
    if (t.scheduled) metaParts.push(`⏳ ${t.scheduled}`);
    if (t.deadline) metaParts.push(`📅 ${t.deadline}`);
    if (typeof t.estimate === "number") metaParts.push(`⏱ ${formatMinutes(t.estimate)}`);
    meta.setText(metaParts.join(" · "));

    const actions = card.createDiv({ cls: "bt-today-card-actions" });
    const mkBtn = (
      text: string,
      action: "done" | "reschedule-tomorrow" | "drop",
      handler: () => void | Promise<void>,
    ) => {
      const btn = actions.createEl("button", { text, cls: `bt-today-action bt-today-action-${action}` });
      btn.dataset.action = action;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        Promise.resolve(handler()).catch((err) =>
          console.warn("[task-center US-720] action failed:", err),
        );
      });
      return btn;
    };

    mkBtn(tr("today.actionDone"), "done", async () => {
      await this.api.done(t.id);
      await this.refreshAfterAction();
    });
    mkBtn(tr("today.actionReschedule"), "reschedule-tomorrow", async () => {
      await this.api.schedule(t.id, tomorrow);
      await this.refreshAfterAction();
    });
    mkBtn(tr("today.actionDrop"), "drop", async () => {
      await this.api.drop(t.id);
      await this.refreshAfterAction();
    });

    card.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openSourceEditShell(t);
    });
  }

  private async refreshAfterAction(): Promise<void> {
    await this.plugin.cache.forFlush();
    await this.reloadTasks();
    this.render();
  }

  private renderUnscheduledBig(parent: HTMLElement) {
    const filter = this.getTextFilter();
    const unscheduledBase = this.tasks.filter((t) => !t.scheduled && t.status === "todo" && !t.inheritsTerminal);
    const unscheduledAll = unscheduledBase.filter(filter);
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

    const grid = wrap.createDiv({ cls: "bt-unscheduled-grid" });
    const col = grid.createDiv({ cls: "bt-unscheduled-col" });
    if (unscheduled.length === 0 && unscheduledBase.length > 0 && this.hasActiveFilters()) {
      this.renderFilterEmptyState(col);
    } else {
      for (const t of unscheduled) this.renderCard(col, t);
    }

    this.renderTrashZone(wrap);
  }

  // ---------- Card ----------

  /**
   * Render a top-level task card.
   *
   * `contextDate` (US-150): if the card is being rendered inside a column
   * whose day already represents the task's `⏳`, the meta-row `⏳ {date}`
   * badge is suppressed — it'd just repeat what the column header says.
   * Pass the column's ISO date for week / month tabs; pass `null` (the
   * default) for unscheduled / completed views, where the date isn't
   * implied by position and the badge is useful.
   */
  private renderCard(
    parent: HTMLElement,
    t: ParsedTask,
    contextDate: string | null = null,
  ) {
    const card = parent.createDiv({ cls: "bt-card" });
    card.dataset.taskId = t.id;
    card.draggable = true;
    if (this.state.selectedTaskId === t.id) card.addClass("selected");

    const quad = this.quadrantClass(t.tags);
    if (quad) card.addClass(quad);

    // US-115: deadline 已过 → red (`bt-overdue`); 3 days or fewer → yellow
    // (`bt-near-deadline`). Both a CSS hook AND a data attribute so e2e
    // selectors can read `[data-overdue]` / `[data-near-deadline]` per
    // ARCHITECTURE.md §8.6 (CSS class names are not part of the contract).
    // see USER_STORIES.md
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
    if (t.status === "done") card.addClass("done");

    this.renderTaskTags(card, t.tags, "bt-card-tags");

    // Meta row
    const meta = card.createDiv({ cls: "bt-card-meta" });
    // task #43: route est/act labels through tr() so a CN session reads
    // "预估 30m / 实际 25m" instead of the raw English literals.
    if (t.estimate) meta.createSpan({ text: tr("meta.est", { dur: formatMinutes(t.estimate) }), cls: "bt-meta-est" });
    if (t.deadline) meta.createSpan({ text: `📅${t.deadline}`, cls: "bt-meta-deadline" });
    if (t.actual) meta.createSpan({ text: tr("meta.act", { dur: formatMinutes(t.actual) }), cls: "bt-meta-actual" });
    // US-150: hide the `⏳ {date}` badge when the card is rendered in a
    // column whose day already implies it. Otherwise (unscheduled pool /
    // completed view / etc.) the badge stays — date isn't implied by
    // position there, and the user needs to see when it was scheduled.
    if (t.scheduled && t.scheduled !== contextDate) {
      meta.createSpan({ text: `⏳${t.scheduled}`, cls: "bt-meta-sched" });
    }
    const path = meta.createSpan({ text: compactPath(t.path), cls: "bt-meta-path" });
    path.title = t.path;

    // Children expansion (recursive — renders grandchildren and deeper).
    //
    // US-148: a child with its own `⏳` ≠ the parent's belongs in *that* day's
    // column as a standalone card, NOT nested here. `hideChildrenOfVisibleParents`
    // surfaces it there; we just need to skip it on the parent side so it
    // doesn't double-render. Children without an independent schedule (or
    // matching the parent's) still render inline — they ride with the parent.
    const childLines = t.childrenLines;
    if (childLines.length > 0) {
      const expander = card.createDiv({ cls: "bt-card-children" });
      const resolved = childLines
        .map((l) => this.tasks.find((x) => x.path === t.path && x.line === l))
        .filter((x): x is ParsedTask => !!x);
      const children = resolved
        .filter((c) => !this.hasIndependentDateFromParent(c, t));
      // US-125 task #33 observability — the "subtask missing from parent
      // card" repro is hard to capture in synthetic e2e (Engineer scanned 6
      // axes, none reproduced). When a user trips the bug, ask them to
      // run `localStorage.setItem("task-center-debug","1")` then reload;
      // the next render dumps which children were resolved vs filtered
      // and why. Strip this once the bug is closed.
      if (childLines.length !== children.length && this.isDebugLogging()) {
        const dropped = childLines
          .map((l) => {
            const r = resolved.find((x) => x.line === l);
            if (!r) return { line: l, reason: "not_found_in_tasks" };
            if (r.scheduled && r.scheduled !== t.scheduled) {
              return {
                line: l,
                title: r.title,
                scheduled: r.scheduled,
                reason: "cross_day_filter",
              };
            }
            return null;
          })
          .filter((x) => x !== null);
        console.log(
          "[task-center US-125] renderCard children diff",
          { parent: t.id, childLines, resolvedCount: resolved.length, kept: children.length, dropped },
        );
      }
      for (const c of children) this.renderSubcard(expander, c, t.scheduled ?? null);
    }

    this.wireCardEvents(card, t);
    // Mobile gestures still need the pointer controller; source/context
    // editing is now the single-click source shell on every platform.
    if (isMobileMode()) {
      // Unified mobile gesture controller (UX-mobile §13 #6: long-press +
      // drag + swipe must share one state machine).
      //   US-506: hold N ms still → openCardActionSheet (action menu)
      //   US-507: hold 250ms then move → pointer-drag (with 800ms cross-
      //           tab dwell + 60px auto-scroll, see view/drag-mobile.ts)
      //   US-508: swipe ≥ 30% left → done; ≥ 30% right → drop; both with
      //           1s undo toast (settings.mobileSwipeEnabled gates).
      //   US-510: swipe is opt-out via settings (platform-conditional UI).
      // see USER_STORIES.md
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
            label: tr("trash.dropped"),
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
      new Notice(kind === "done" ? "✓ Done" : tr("trash.dropped"), 1000);
    } catch (err) {
      new Notice(tr("notice.error", { msg: (err as Error).message }), 4000);
    }
    this.scheduleRefresh();
  }

  // Renders a subcard + its own children recursively. The nested
  // `.bt-card-children` block is a sibling of the subcard so each level
  // inherits the 22px margin-left from CSS, producing a staircase indent.
  //
  // No `parent` parameter: cross-day subtasks are surfaced as top-level
  // cards on their own day (US-148), so by the time we reach this
  // function the subtask either rides with its parent's `⏳` or has none
  // — no `parent` comparison needed.
  //
  // US-142: subcards render recursively (this fn calls itself for each
  // grandchild that's still in scope), so nested subtasks display all
  // levels under their visible parent on desktop.
  // US-149: subtask `⏳` badge rules — child sharing parent's date never
  // shows a badge here (parent's column already implies it); cross-day
  // children are filtered out before reaching this function (US-148).
  // US-505: on mobile, deeper-than-1-level subtrees collapse to a `+N`
  // chip that opens a bottom sheet (see Platform.isMobile branch below)
  // rather than rendering inline — keeps card height bounded on phones.
  //
  // Task #36: `effectiveScheduled` is the date inherited from the
  // visible card chain — top card's `⏳` for direct children, propagated
  // through subcards that don't carry their own `⏳`. The recursive
  // grandchild filter compares against this inherited value, so a
  // grandchild whose `⏳` matches the TOP card still renders even if
  // the middle subcard has no `⏳` of its own.
  // see USER_STORIES.md
  private renderSubcard(
    container: HTMLElement,
    c: ParsedTask,
    effectiveScheduled: string | null,
  ) {
    const subCard = container.createDiv({ cls: "bt-subcard" });
    subCard.dataset.taskId = c.id;
    subCard.draggable = true;
    if (this.state.selectedTaskId === c.id) subCard.addClass("selected");

    const check = subCard.createEl("button", { cls: "bt-sub-check", text: statusIcon(c.status) });
    check.type = "button";
    check.dataset.cardAction = "done";
    check.title = c.status === "done" ? tr("ctx.markTodo") : tr("ctx.markDone");
    check.setAttr("aria-label", check.title);
    check.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.runWithRemoveAnim(c.id, async () => {
        if (c.status === "done") await this.api.undone(c.id);
        else await this.api.done(c.id);
      });
    });

    const title = subCard.createDiv({ cls: "bt-subcard-title", text: c.title });
    title.dataset.cardAction = "open";
    title.title = c.title;

    // (Previous `bt-sub-sched` badge for cross-day subtasks removed —
    //  US-148 now surfaces such subtasks as standalone top-level cards
    //  on their own day, so the inline badge can never trigger. Subcards
    //  reaching this branch always share their parent's `⏳` or have
    //  none of their own; no badge needed in either case.)
    if (c.estimate) subCard.createDiv({ cls: "bt-sub-est", text: formatMinutes(c.estimate) });
    if (c.status === "done") subCard.addClass("done");
    // task #37: subcards are drag SOURCES but not nest drop targets. The
    // browser's hit-test lands on the deepest DOM node under the cursor, so
    // a drop visually aimed at the parent card's body would otherwise nest
    // under the subcard the cursor happened to be over. Letting the drop
    // event bubble up to the enclosing `.bt-card` makes the drop land where
    // the user expects (the parent). To explicitly nest under a subcard the
    // user can still drop onto its top-level card rendering on its own day
    // when it has its own ⏳.
    this.wireCardEvents(subCard, c, { acceptNestDrop: false });

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
        // US-148 (recursive): a grandchild with its own ⏳ different from the
        // **effective inherited** day should render independently in its
        // own day, not nested here. Same rule as the top-level card /
        // first-level subtask filter — but we compare against the
        // inherited chain (top card → … → c), not just c's raw
        // `scheduled`, so a grandchild matching top survives even when
        // middle subcards have no `⏳` of their own (task #36).
        const inheritedDown = c.scheduled ?? effectiveScheduled;
        const sub = container.createDiv({ cls: "bt-card-children" });
        const grand = grandLines
          .map((l) => this.tasks.find((x) => x.path === c.path && x.line === l))
          .filter((x): x is ParsedTask => !!x)
          .filter((g) => !(g.scheduled && g.scheduled !== inheritedDown));
        for (const g of grand) this.renderSubcard(sub, g, inheritedDown);
      }
    }
  }

  private renderTaskTags(parent: HTMLElement, tags: string[], extraClass: string) {
    const displayTags = taskDisplayTags(tags);
    if (displayTags.length === 0) return;

    const row = parent.createDiv({ cls: `bt-task-tags ${extraClass}` });
    for (const tag of displayTags) {
      row.createSpan({ cls: "bt-task-tag", text: tag });
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

  private wireCardEvents(
    el: HTMLElement,
    t: ParsedTask,
    opts: { acceptNestDrop?: boolean } = {},
  ) {
    const acceptNestDrop = opts.acceptNestDrop ?? true;
    // Drag source
    el.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.stopPropagation();
      e.dataTransfer.setData("text/task-id", t.id);
      e.dataTransfer.effectAllowed = "move";
      el.addClass("dragging");
      // View-wide "a drag is in progress" marker so drop zones (esp. the
      // abandon target can attract attention without waiting for direct hover.
      this.contentEl.addClass("dragging-active");
    });
    el.addEventListener("dragend", (e) => {
      e.stopPropagation();
      el.removeClass("dragging");
      this.contentEl.removeClass("dragging-active");
    });

    // Drop target: dropping another card onto this one nests it as a subtask
    // (works cross-file). stopPropagation prevents the underlying day column
    // from also receiving the drop and just rescheduling.
    //
    // Skipped for subcards (task #37): subcards live inside a parent card's
    // visible area, so registering them as drop targets would steal drops
    // aimed at the parent. Letting the event bubble up to the enclosing
    // `.bt-card` matches the user's visual intent (they see the parent card,
    // not the inner sub-row, as the drop target).
    if (acceptNestDrop) {
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
    }

    // Click → source edit shell. US-168 replaces hover previews and
    // double-click source jumps with one primary card action.
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openSourceEditShell(t);
    });

    // Right-click context menu
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openContextMenu(e as MouseEvent, t);
    });
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
    const tags = parseFilterTags(this.state.savedViewTag);
    const time = this.state.savedViewTime;
    const status = this.state.savedViewStatus;
    if (!q && tags.length === 0 && !this.hasTimeFilters(time) && status === "all") return () => true;
    return (t) => {
      if (q && !taskMatchesText(t, q)) return false;
      for (const tag of tags) {
        if (!taskHasTag(t, tag)) return false;
      }
      if (!this.taskMatchesTimeFilters(t, time)) return false;
      if (status !== "all" && t.status !== status) return false;
      return true;
    };
  }

  private hasTimeFilters(time: SavedViewTimeFilters): boolean {
    return Object.values(time).some((value) => !!value?.trim());
  }

  private taskMatchesTimeFilters(task: ParsedTask, time: SavedViewTimeFilters): boolean {
    for (const field of ["scheduled", "deadline", "completed", "created"] as SavedViewTimeField[]) {
      const token = time[field]?.trim();
      if (token && !taskMatchesTimeFilter(task, field, token, this.plugin.settings.weekStartsOn)) return false;
    }
    return true;
  }

  private quadrantClass(_tags: string[]): string | null {
    return null;
  }

  private collectTagOptions(): Array<{ tag: string; count: number }> {
    const options = new Map<string, { tag: string; count: number }>();
    const selected = new Set(parseFilterTags(this.state.savedViewTag));
    const add = (raw: string, count = 0) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const tag = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
      const key = tag.toLowerCase();
      const existing = options.get(key);
      if (existing) {
        existing.count += count;
      } else {
        options.set(key, { tag, count });
      }
    };
    const q = this.state.filter.trim().toLowerCase();
    const time = this.state.savedViewTime;
    const status = this.state.savedViewStatus;
    for (const task of this.tasks) {
      if (q && !taskMatchesText(task, q)) continue;
      if (!this.taskMatchesTimeFilters(task, time)) continue;
      if (status !== "all" && task.status !== status) continue;
      for (const tag of task.tags) add(tag, 1);
    }
    for (const view of this.plugin.settings.savedViews) {
      for (const tag of parseFilterTags(view.tag)) add(tag);
    }
    for (const tag of selected) add(tag);
    return Array.from(options.values()).sort((a, b) => {
      const aSelected = selected.has(a.tag.toLowerCase());
      const bSelected = selected.has(b.tag.toLowerCase());
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      if (a.count !== b.count) return b.count - a.count;
      return a.tag.localeCompare(b.tag);
    });
  }

  private collectKnownTags(): string[] {
    return this.collectTagOptions().map((option) => option.tag);
  }

  private setSelectedTags(tags: string[]): void {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
      const tag = normalizeFilterTag(raw);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
    this.state.savedViewTag = out.join(",");
    this.state.savedViewId = null;
    this.filterPopoverOpen = "tag";
    this.render();
  }

  private clearSavedViewFilters(): void {
    const filters = emptySavedViewFilters();
    this.state.savedViewId = filters.savedViewId;
    this.state.filter = filters.search;
    this.state.savedViewTag = filters.tag;
    this.state.savedViewTime = filters.time;
    this.state.savedViewStatus = filters.status;
    this.filterPopoverOpen = null;
  }

  private applySavedView(view: SavedTaskView): void {
    const filters = applySavedViewFilters(view);
    this.state.savedViewId = filters.savedViewId;
    this.state.filter = filters.search;
    this.state.savedViewTag = filters.tag;
    this.state.savedViewTime = filters.time;
    this.state.savedViewStatus = filters.status;
    this.filterPopoverOpen = null;
  }

  private suggestSavedViewName(): string {
    return suggestSavedViewNameForFilters(
      { tag: this.state.savedViewTag, status: this.state.savedViewStatus },
      tr("savedViews.defaultName"),
    );
  }

  private askSavedViewName(): Promise<string | null> {
    return new Promise((resolve) => {
      new SavedViewNameModal(this.app, this.suggestSavedViewName(), resolve).open();
    });
  }

  private async saveCurrentView(name: string): Promise<void> {
    const view = createSavedView(name, {
      search: this.state.filter,
      tag: this.state.savedViewTag,
      time: this.state.savedViewTime,
      status: this.state.savedViewStatus,
    });
    this.plugin.settings.savedViews = upsertSavedView(this.plugin.settings.savedViews, view);
    this.applySavedView(view);
    await this.plugin.saveSettings();
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

  // US-166 / UX.md §6.8: global desktop hotkeys live here — Ctrl+1~5
  // switch tabs, `/` focuses the search input, Ctrl/Cmd+Z pops the undo
  // stack. Card-level shortcuts were removed with the old README residue.
  // US-501: desktop-only features silently no-op on Obsidian Mobile —
  // returning early here means the board never claims to handle a key
  // the user can't produce. CLI / hover popovers do the same at their
  // respective sites. Layout switching is screen-width based (CSS
  // @media); *capability* gating like this is a Platform check, allowed
  // at the UI layer per UX-mobile §13 #7.
  // see USER_STORIES.md
  async handleKey(e: KeyboardEvent) {
    if (Platform.isMobile) return;

    // Global tab switching
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      // US-720: today tab takes ⌃1, others shift one slot down.
      const map: Record<string, TabKey> = { "1": "today", "2": "week", "3": "month", "4": "completed", "5": "unscheduled" };
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

  }

  // Undo stack push / pop now live on `this.undoStack` (UndoStack instance).
  // Kept callsites use `this.undoStack.push(entry)` and
  // `this.undoStack.pop()` — see `./view/undo` for the implementation.

  private getSelectedTask(): ParsedTask | null {
    if (!this.state.selectedTaskId) return null;
    return this.tasks.find((t) => t.id === this.state.selectedTaskId) ?? null;
  }

  // ---------- Context menu / source ----------

  // US-164: right-click a card to get secondary task actions — toggle
  // done, schedule today / tomorrow / clear, drop.
  // Source/context editing is now the US-168 single-click source shell.
  // Wired from `wireCardEvents`'s `contextmenu` listener.
  // see USER_STORIES.md
  openContextMenu(e: MouseEvent, task: ParsedTask) {
    const m = new Menu();
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
    m.addItem((i) =>
      i.setTitle(tr("ctx.drop")).onClick(async () => {
        await this.runWithRemoveAnim(task.id, () => this.api.drop(task.id));
      }),
    );
    m.showAtMouseEvent(e);
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
    new QuickAddModal(
      this.app,
      this.api,
      () => this.scheduleRefresh(),
      this.plugin.settings,
      this.collectKnownTags(),
    ).open();
  }

}

function statusIcon(s: string): string {
  if (s === "done") return "✔";
  if (s === "dropped") return "✕";
  if (s === "in_progress") return "◐";
  return "○";
}

class SavedViewNameModal extends Modal {
  private value: string;
  private resolved = false;
  private resolve: (name: string | null) => void;

  constructor(app: App, initialValue: string, resolve: (name: string | null) => void) {
    super(app);
    this.value = initialValue;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("task-center-saved-view-name-modal");
    contentEl.createEl("h3", { text: tr("savedViews.promptName") });

    const input = new TextComponent(contentEl);
    input.inputEl.dataset.savedViewNameInput = "true";
    input.inputEl.style.width = "100%";
    input.setValue(this.value);
    input.onChange((value) => (this.value = value));
    input.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !(event.isComposing || event.keyCode === 229)) {
        event.preventDefault();
        this.commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });

    const actions = contentEl.createDiv({ cls: "task-center-saved-view-name-actions" });
    const cancel = actions.createEl("button", { text: tr("savedViews.cancel") });
    cancel.dataset.action = "cancel-saved-view-name";
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: tr("savedViews.confirmSave"), cls: "mod-cta" });
    save.dataset.action = "confirm-saved-view-name";
    save.addEventListener("click", () => this.commit());

    window.setTimeout(() => {
      input.inputEl.focus();
      input.inputEl.select();
    }, 10);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }

  private commit(): void {
    const name = this.value.trim();
    if (!name) return;
    this.resolved = true;
    this.resolve(name);
    this.close();
  }
}

function compactPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}
