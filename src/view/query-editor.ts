// US-109p10 / US-109p11: the Query editor panel, extracted out of the (large)
// view.ts so parallel work doesn't keep colliding on one file. This owns the
// editor's transient UI state (scope / area index / sub-tab) and all of its
// rendering; it reaches back into the host TaskCenterView for shared helpers
// (draft snapshot, area `when` read/write, action controls, etc.).
//
// Behaviour is unchanged from when these lived on TaskCenterView — this is a
// pure structural move.

import { Menu, setIcon } from "obsidian";
import { t as tr, getLocale } from "../i18n";
import {
  collectAreas,
  normalizeQueryPreset,
  parseQueryDsl,
  stringifyQueryPreset,
} from "../saved-views";
import {
  setAreaType as layoutSetAreaType,
  appendArea as layoutAppendArea,
  insertNode as layoutInsertNode,
  removeNode as layoutRemoveNode,
  wrapInStack as layoutWrapInStack,
  setStackDir as layoutSetStackDir,
  reorderChild as layoutReorderChild,
  type LayoutPath,
} from "../layout-ops";
import { isStackNode } from "../types";
import type { AreaType, LayoutNode } from "../types";
import { areaHandler, SELECTABLE_AREA_TYPES } from "../areas";
import { BottomSheet } from "./bottom-sheet";
import { renderAreaFilterControls } from "./area-filter-controls";
import type { TaskCenterView } from "../view";

type Rerender = () => void;

// Two scopes, opened by different entries: "tab" (toolbar / tab menu) edits
// tab-level objects; "area" (an area head's 编辑) edits one area.
export type QueryEditorScope = "tab" | "area";
// Area-panel sub-tabs: 本区过滤 / 外观.
export type QueryEditorAreaTab = "filter" | "appearance";

export class QueryEditorView {
  private scope: QueryEditorScope = "tab";
  private areaIndex: number | null = null;
  private areaTab: QueryEditorAreaTab = "filter";

  constructor(private readonly v: TaskCenterView) {}

  // US-109p10: open the Query editor sheet in one of two scopes.
  open(opts: { scope?: QueryEditorScope; areaIndex?: number | null; areaTab?: QueryEditorAreaTab; focusSearch?: boolean } = {}): void {
    const scope = opts.scope ?? (opts.areaIndex != null ? "area" : "tab");
    this.scope = scope;
    this.areaIndex = scope === "area" ? (opts.areaIndex ?? null) : null;
    this.areaTab = opts.areaTab ?? "filter";
    let body: HTMLElement;
    const mobileLayout = this.v.contentEl.dataset.mobileLayout === "true";
    const bodyClass = mobileLayout ? "bt-mobile-query-sheet" : "bt-query-controls-sheet";
    const rerender: Rerender = () => {
      this.v.render();
      if (!body) return;
      // Preserve scroll across the in-place rerender. Without this, toggling the
      // tag select (or any filter change) rebuilds the body and snaps the sheet
      // back to the top, so a popover opened near the bottom looked like nothing
      // happened ("can't click").
      const scroller = body.closest<HTMLElement>(".modal-content, .bt-editor-page-body");
      const top = scroller?.scrollTop ?? 0;
      body.empty();
      this.renderSheet(body, rerender);
      if (scroller) scroller.scrollTop = top;
    };
    const sheet = new BottomSheet(this.v.app, {
      title: tr(scope === "area" ? "savedViews.editAreaTitle" : "savedViews.editViewTitle"),
      sheetClass: mobileLayout ? "task-center-query-sheet" : undefined,
      populate: (el) => {
        body = el.createDiv({ cls: bodyClass });
        this.renderSheet(body, rerender);
      },
    });
    sheet.open();
    if (opts.focusSearch) {
      const search = body!.querySelector<HTMLInputElement>(".bt-area-search");
      search?.focus();
      search?.select();
    }
  }

  // US-109p10: dispatch to one of the two scoped editors. Both project the same
  // tab draft; the scope just decides which objects are shown.
  private renderSheet(parent: HTMLElement, rerender?: Rerender): void {
    parent.dataset.savedViews = "true";
    parent.dataset.queryEditor = "true";
    parent.dataset.queryEditorScope = this.scope;
    const titleEl = parent.closest(".modal")?.querySelector<HTMLElement>(".modal-title");
    if (titleEl) {
      titleEl.setText(tr(this.scope === "area" ? "savedViews.editAreaTitle" : "savedViews.editViewTitle"));
    }
    if (this.scope === "area" && this.areaIndex !== null) {
      this.renderAreaEditor(parent, this.areaIndex, rerender);
    } else {
      this.renderTabEditor(parent, rerender);
    }
  }

  // US-109p10: Tab panel — name + layout tree + DSL; tab-level actions in a top
  // toolbar row. No single area's when / title / type (those are the Area panel).
  private renderTabEditor(parent: HTMLElement, rerender?: Rerender): void {
    const toolbar = parent.createDiv({ cls: "bt-query-editor-toolbar" });
    toolbar.dataset.queryEditorToolbar = "true";
    this.v.renderSavedViewsActionControls(toolbar, rerender, {
      includeSaveAs: true,
      includeDsl: false,
      includeManage: true,
    });

    const nameSection = parent.createDiv({ cls: "bt-query-editor-section" });
    nameSection.dataset.areaTitleSection = "true";
    nameSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.viewName") });
    const nameInput = nameSection.createEl("input", { type: "text", cls: "tc-full-width-input" });
    nameInput.dataset.viewNameInput = "true";
    nameInput.value = this.v.activeSavedView().name;
    nameInput.addEventListener("change", () => this.v.setActiveTabName(nameInput.value));

    const layoutSection = parent.createDiv({ cls: "bt-query-editor-section" });
    layoutSection.dataset.queryLayout = "true";
    const layout = this.v.currentQueryPresetViewConfig().layout;
    const areaCount = collectAreas(layout).length;
    const rootDir = isStackNode(layout)
      ? tr(layout.dir === "row" ? "savedViews.layoutRow" : "savedViews.layoutCol")
      : tr("savedViews.layoutCol");
    layoutSection.createDiv({
      cls: "bt-query-editor-section-title",
      text: `${tr("savedViews.layout")} · ${tr("savedViews.layoutSummary", { count: areaCount, dir: rootDir })}`,
    });
    const tree = layoutSection.createDiv({ cls: "bt-layout-tree" });
    // US-117g: 移动端不画布局（布局是桌面能力）。窄屏下布局小节退化为只读区域列表——
    // 列出各区域、整行可点进入该区域的 Area 面板改过滤；不渲染可编辑布局树与「＋添加区域」。
    const mobileLayout = this.v.contentEl.dataset.mobileLayout === "true";
    if (mobileLayout) {
      tree.addClass("bt-layout-area-list");
      collectAreas(layout).forEach((area, areaIndex) => {
        const row = tree.createDiv({ cls: "bt-layout-area bt-layout-area-readonly" });
        row.dataset.layoutArea = String(areaIndex);
        setIcon(row.createSpan({ cls: "bt-layout-area-icon" }), this.areaTypeIcon(area.type as AreaType));
        const main = row.createDiv({ cls: "bt-layout-area-main" });
        main.createSpan({
          cls: "bt-layout-area-title",
          text: this.v.localizeBuiltinTitle(area.id, area.title) || this.areaTypeLabel(area.type as AreaType),
        });
        const when = this.v.areaWhenByIndex(areaIndex);
        const summary = when ? this.v.areaFilterSummary(when) : "";
        if (summary) main.createSpan({ cls: "bt-layout-area-when", text: summary });
        setIcon(row.createSpan({ cls: "bt-layout-area-enter" }), "chevron-right");
        row.addEventListener("click", () => {
          const parentEl = tree.closest<HTMLElement>("[data-query-editor]");
          if (parentEl) {
            this.reRenderInPlace(parentEl, rerender, () => {
              this.scope = "area";
              this.areaIndex = areaIndex;
              this.areaTab = "filter";
            });
          } else {
            this.open({ scope: "area", areaIndex });
          }
        });
      });
    } else {
      this.renderLayoutTreeNode(tree, layout, [], { n: 0 }, rerender);
      const addArea = layoutSection.createEl("button", {
        cls: "bt-layout-add bt-layout-add--root",
        text: `＋ ${tr("savedViews.layoutAddArea")}`,
      });
      addArea.dataset.action = "add-area-root";
      addArea.addEventListener("click", (e) => this.openAddAreaMenu(e, [], rerender));
    }

    this.renderDslTab(parent, rerender);
  }

  // US-109p10: Area panel — one area's own objects only.
  private renderAreaEditor(parent: HTMLElement, areaIndex: number, rerender?: Rerender): void {
    parent.dataset.queryEditorArea = String(areaIndex);
    const areaWhen = this.v.areaWhenByIndex(areaIndex);
    if (areaWhen === null) this.areaTab = "appearance";

    const crumb = parent.createDiv({ cls: "bt-query-editor-breadcrumb" });
    const back = crumb.createEl("button", { cls: "bt-query-editor-back" });
    back.dataset.action = "back-to-tab";
    back.setAttr("aria-label", tr("savedViews.backToTab"));
    setIcon(back.createSpan({ cls: "bt-query-editor-back-icon" }), "chevron-left");
    back.createSpan({ text: this.v.activeSavedView().name });
    back.addEventListener("click", () => {
      this.reRenderInPlace(parent, rerender, () => {
        this.scope = "tab";
        this.areaIndex = null;
      });
    });
    crumb.createSpan({ cls: "bt-query-editor-breadcrumb-sep", text: "/" });
    crumb.createSpan({ cls: "bt-query-editor-breadcrumb-area", text: this.areaCrumbLabel(areaIndex) });

    const subTabs: Array<{ key: QueryEditorAreaTab; label: string }> = [];
    if (areaWhen !== null) subTabs.push({ key: "filter", label: tr("savedViews.queryEditorAreaFilters") });
    subTabs.push({ key: "appearance", label: tr("savedViews.areaTabAppearance") });
    if (subTabs.length > 1) {
      const strip = parent.createDiv({ cls: "bt-query-editor-tabs" });
      strip.dataset.areaEditorTabs = "true";
      strip.setAttr("role", "tablist");
      for (const t of subTabs) {
        const active = this.areaTab === t.key;
        const btn = strip.createEl("button", { text: t.label, cls: "bt-query-editor-tab" + (active ? " active" : "") });
        btn.dataset.areaTab = t.key;
        btn.setAttr("role", "tab");
        btn.setAttr("aria-selected", active ? "true" : "false");
        btn.addEventListener("click", () => {
          if (this.areaTab === t.key) return;
          this.reRenderInPlace(parent, rerender, () => { this.areaTab = t.key; });
        });
      }
    }

    const panel = parent.createDiv({ cls: "bt-query-editor-panel" });
    panel.dataset.queryTabPanel = this.areaTab;
    if (this.areaTab === "filter" && areaWhen !== null) {
      const sec = panel.createDiv({ cls: "bt-query-editor-section" });
      sec.dataset.filterSection = "area";
      const controls = sec.createDiv({ cls: "bt-area-filter-popover bt-query-editor-area-filters" });
      renderAreaFilterControls(this.v, controls, areaIndex, areaWhen, rerender);
    } else {
      this.renderAreaAppearance(panel, areaIndex, rerender);
    }
  }

  // Re-render the open sheet body in place after mutating editor state.
  private reRenderInPlace(parent: HTMLElement, rerender: Rerender | undefined, mutate: () => void): void {
    mutate();
    parent.empty();
    this.renderSheet(parent, rerender);
  }

  private areaCrumbLabel(areaIndex: number): string {
    const area = collectAreas(this.v.currentQueryPresetViewConfig().layout)[areaIndex];
    if (!area) return "";
    const title = this.v.localizeBuiltinTitle(area.id, area.title);
    if (title) return title;
    return this.areaTypeLabel(area.type as AreaType);
  }

  // US-109p10/p11: Area appearance — title + type (area-level, only this leaf).
  private renderAreaAppearance(parent: HTMLElement, areaIndex: number, rerender?: Rerender): void {
    const area = collectAreas(this.v.currentQueryPresetViewConfig().layout)[areaIndex];
    const titleSection = parent.createDiv({ cls: "bt-query-editor-section" });
    titleSection.dataset.areaTitleSection = "true";
    titleSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.queryEditorAreaTitle") });
    const input = titleSection.createEl("input", { type: "text", cls: "tc-full-width-input" });
    input.dataset.areaTitleInput = "true";
    input.placeholder = this.v.effectiveSavedView().name;
    input.value = this.v.areaTitleByIndex(areaIndex);
    input.addEventListener("change", () => this.v.setAreaTitle(areaIndex, input.value, rerender));

    const typeSection = parent.createDiv({ cls: "bt-query-editor-section" });
    typeSection.createDiv({ cls: "bt-query-editor-section-title", text: tr("savedViews.queryEditorViewType") });
    const typeRow = typeSection.createDiv({ cls: "bt-query-editor-view-row" });
    const currentType = area?.type === "unknown" ? "list" : (area?.type ?? "list");
    for (const value of SELECTABLE_AREA_TYPES) {
      const btn = typeRow.createEl("button", {
        text: this.areaTypeLabel(value),
        cls: "bt-query-editor-view-btn" + (currentType === value ? " active" : ""),
      });
      btn.dataset.areaType = value;
      btn.addEventListener("click", () => this.setAreaTypeForIndex(areaIndex, value, rerender));
    }
  }

  // US-109p11: recursively render the layout tree.
  private renderLayoutTreeNode(
    host: HTMLElement,
    node: LayoutNode,
    path: LayoutPath,
    counter: { n: number },
    rerender?: Rerender,
  ): void {
    if (isStackNode(node)) {
      const frame = host.createDiv({ cls: `bt-layout-stack bt-layout-stack-${node.dir}` });
      frame.dataset.layoutStack = path.join(".") || "root";
      const head = frame.createDiv({ cls: "bt-layout-stack-head" });
      head.createSpan({
        cls: "bt-layout-stack-label",
        text: tr(node.dir === "row" ? "savedViews.layoutRow" : "savedViews.layoutCol"),
      });
      const dirBtn = head.createEl("button", { cls: "bt-layout-stack-dir" });
      dirBtn.setAttr("aria-label", tr("savedViews.layoutToggleDir"));
      setIcon(dirBtn.createSpan(), node.dir === "row" ? "rows-3" : "columns-3");
      dirBtn.addEventListener("click", () =>
        this.commitDraftLayout(layoutSetStackDir(this.draftLayout(), path, node.dir === "row" ? "col" : "row"), rerender));
      const children = frame.createDiv({ cls: "bt-layout-stack-children" });
      node.children.forEach((child, i) =>
        this.renderLayoutTreeNode(children, child, [...path, i], counter, rerender));
      if (path.length > 0) {
        const addBtn = frame.createEl("button", { cls: "bt-layout-add", text: `＋ ${tr("savedViews.layoutAddArea")}` });
        addBtn.addEventListener("click", (e) => this.openAddAreaMenu(e, path, rerender));
      }
      return;
    }
    const areaIndex = counter.n++;
    const row = host.createDiv({ cls: "bt-layout-area" });
    row.dataset.layoutArea = String(areaIndex);
    setIcon(row.createSpan({ cls: "bt-layout-area-icon" }), this.areaTypeIcon(node.type as AreaType));
    const main = row.createDiv({ cls: "bt-layout-area-main" });
    main.createSpan({
      cls: "bt-layout-area-title",
      text: this.v.localizeBuiltinTitle(node.id, node.title) || this.areaTypeLabel(node.type as AreaType),
    });
    const when = this.v.areaWhenByIndex(areaIndex);
    const summary = when ? this.v.areaFilterSummary(when) : "";
    if (summary) main.createSpan({ cls: "bt-layout-area-when", text: summary });
    const actions = row.createDiv({ cls: "bt-layout-area-actions" });
    const edit = actions.createEl("button", { cls: "bt-layout-area-edit" });
    edit.setAttr("aria-label", tr("savedViews.editArea"));
    setIcon(edit.createSpan(), "sliders-horizontal");
    edit.addEventListener("click", () => {
      const parentEl = host.closest<HTMLElement>("[data-query-editor]");
      if (parentEl) {
        this.reRenderInPlace(parentEl, rerender, () => {
          this.scope = "area";
          this.areaIndex = areaIndex;
          this.areaTab = "filter";
        });
      } else {
        this.open({ scope: "area", areaIndex });
      }
    });
    const more = actions.createEl("button", { cls: "bt-layout-area-more" });
    more.setAttr("aria-label", tr("savedViews.layoutDelete"));
    setIcon(more.createSpan(), "more-vertical");
    more.addEventListener("click", (e) => this.openLayoutAreaMenu(e, path, rerender));
  }

  // ⋮ menu for a layout area row.
  private openLayoutAreaMenu(e: MouseEvent, path: LayoutPath, rerender?: Rerender): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(tr("savedViews.layoutWrapRow")).setIcon("rows-3").onClick(() =>
      this.commitDraftLayout(layoutWrapInStack(this.draftLayout(), path, "row"), rerender)));
    menu.addItem((i) => i.setTitle(tr("savedViews.layoutWrapCol")).setIcon("columns-3").onClick(() =>
      this.commitDraftLayout(layoutWrapInStack(this.draftLayout(), path, "col"), rerender)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(tr("savedViews.layoutMoveUp")).setIcon("arrow-up").onClick(() =>
      this.moveLayoutSibling(path, -1, rerender)));
    menu.addItem((i) => i.setTitle(tr("savedViews.layoutMoveDown")).setIcon("arrow-down").onClick(() =>
      this.moveLayoutSibling(path, 1, rerender)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(tr("savedViews.layoutDelete")).setIcon("trash-2").onClick(() =>
      this.commitDraftLayout(layoutRemoveNode(this.draftLayout(), path), rerender)));
    menu.showAtMouseEvent(e);
  }

  private moveLayoutSibling(path: LayoutPath, delta: -1 | 1, rerender?: Rerender): void {
    if (path.length === 0) return;
    const parentPath = path.slice(0, -1);
    const idx = path[path.length - 1];
    this.commitDraftLayout(layoutReorderChild(this.draftLayout(), parentPath, idx, idx + delta), rerender);
  }

  // US-109p11: "＋ 添加区域" dropdown — choose which area type to append.
  private openAddAreaMenu(e: MouseEvent, path: LayoutPath, rerender?: Rerender): void {
    const menu = new Menu();
    for (const type of SELECTABLE_AREA_TYPES) {
      menu.addItem((i) => i.setTitle(this.areaTypeLabel(type)).setIcon(this.areaTypeIcon(type)).onClick(() =>
        this.commitDraftLayout(this.insertAreaInto(this.draftLayout(), path, type), rerender)));
    }
    menu.showAtMouseEvent(e);
  }

  private insertAreaInto(layout: LayoutNode, path: LayoutPath, type: AreaType = "list"): LayoutNode {
    const node = this.newAreaOfType(type);
    if (path.length === 0) return layoutAppendArea(layout, node);
    return layoutInsertNode(layout, path, Number.MAX_SAFE_INTEGER, node);
  }

  private newAreaOfType(type: AreaType): LayoutNode {
    if (type === "drop") return { type: "drop", onDrop: { setStatus: "dropped" } };
    return { type };
  }

  private draftLayout(): LayoutNode {
    return this.v.currentQueryPresetViewConfig().layout;
  }

  // US-109p11: write a new layout into the tab draft and re-derive view state.
  private commitDraftLayout(layout: LayoutNode, rerender?: Rerender): void {
    const active = this.v.activeSavedView();
    const snapshot = this.v.currentQuerySnapshot(active);
    const next = normalizeQueryPreset({ ...snapshot, view: { layout } });
    this.v.tabDrafts.set(active.id, next);
    this.v.applySavedView(active);
    this.v.refreshFilterControls(rerender);
  }

  // US-109z2: label / icon come from the central area capability table, not a
  // local switch — so a new area type is described in one place.
  private areaTypeLabel(type: AreaType): string {
    return tr(areaHandler(type).labelKey as Parameters<typeof tr>[0]);
  }

  private areaTypeIcon(type: AreaType): string {
    return areaHandler(type).icon;
  }

  // US-109p11: change one area's type without rebuilding the tree.
  private setAreaTypeForIndex(areaIndex: number, type: AreaType, rerender?: Rerender): void {
    this.commitDraftLayout(layoutSetAreaType(this.draftLayout(), areaIndex, type), rerender);
  }

  // User-facing Query DSL reference, one page per language.
  private dslDocsUrl(): string {
    const byLocale: Record<string, string> = {
      zh: "https://github.com/CorrectRoadH/obsidian-task-center/blob/main/docs/dsl/zh.md",
      en: "https://github.com/CorrectRoadH/obsidian-task-center/blob/main/docs/dsl/en.md",
    };
    return byLocale[getLocale()] ?? byLocale.en;
  }

  // US-109p6: DSL tab — full Query DSL direct editing.
  private renderDslTab(parent: HTMLElement, rerender?: Rerender): void {
    const dslSection = parent.createDiv({ cls: "bt-query-editor-section" });
    const dslHead = dslSection.createDiv({ cls: "bt-query-editor-dsl-head" });
    dslHead.createSpan({ cls: "bt-query-editor-section-title", text: tr("savedViews.dslTitle") });
    const docs = dslHead.createEl("a", {
      text: tr("savedViews.dslDocs"),
      cls: "bt-query-editor-dsl-docs",
      href: this.dslDocsUrl(),
    });
    docs.setAttr("target", "_blank");
    docs.setAttr("rel", "noopener");
    const active = this.v.activeSavedView();
    const snapshot = this.v.currentQuerySnapshot(active);
    const dslText = stringifyQueryPreset(snapshot);
    const dslArea = dslSection.createEl("textarea", { cls: "tc-full-width-input" });
    dslArea.rows = 8;
    dslArea.value = dslText;
    dslArea.dataset.queryDslInput = "true";
    const dslError = dslSection.createDiv({ cls: "bt-query-editor-dsl-error" });
    dslError.hide();

    const dslApply = dslSection.createEl("button", {
      text: tr("savedViews.apply"),
      cls: "bt-query-editor-dsl-apply",
    });
    dslApply.addEventListener("click", () => {
      try {
        const parsed = parseQueryDsl(dslArea.value, { id: active.id, name: active.name, builtin: active.builtin, hidden: active.hidden });
        this.v.tabDrafts.set(active.id, parsed);
        this.v.applySavedView(parsed);
        dslError.hide();
        dslError.setText("");
        this.v.refreshFilterControls(rerender);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dslError.setText(msg);
        dslError.show();
      }
    });
  }
}
