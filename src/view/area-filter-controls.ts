// US-109p9 / US-109z2: the area-`when` filter controls (search / status /
// scheduled+date / tags), rendered inside the Query editor's Filters tab
// "本视图过滤" section. All edits go through `v.setAreaWhen` so they land in the
// tab draft and rerender, same as DSL editing. Extracted from the TaskCenterView
// god class as functions over a `v: TaskCenterView` (REFACTOR.md Phase 2 — the
// first DOM-cluster extraction); the view owns the draft + control state, this
// module owns the markup.

import { setIcon } from "obsidian";
import type { TaskCenterView } from "../view";
import type { QueryPresetFilters, QueryTimeField } from "../types";
import { t as tr } from "../i18n";
import { normalizeQueryStatus } from "../query/schema";
import {
  PRIMARY_TIME_FIELD,
  SECONDARY_TIME_FIELDS,
  statusFilterOptions,
  timeFieldLabel,
  timeFilterOptions,
  toggledStatus,
} from "./area-filter-model";
import { appendTagToExpr, parseTagExpr } from "../query/tag-expr";

type Rerender = () => void;

export function renderAreaFilterControls(
  v: TaskCenterView,
  parent: HTMLElement,
  areaIndex: number,
  when: QueryPresetFilters,
  rerenderControls?: Rerender,
): void {
  const status = normalizeQueryStatus(when.status);
  const scheduled = when.time?.scheduled?.trim() ?? "";

  // Search — matches task title text. Placeholder reads as "task text
  // contains …" so it's clear it's a substring match, not a command.
  const search = parent.createEl("input", {
    type: "text",
    cls: "bt-area-search",
    placeholder: tr("savedViews.searchContains"),
  });
  search.value = when.search ?? "";
  search.addEventListener("change", () => {
    const val = search.value.trim();
    v.setAreaWhen(areaIndex, { ...when, search: val || undefined }, rerenderControls);
  });

  // Status
  const statusSec = parent.createDiv({ cls: "bt-area-filter-sec" });
  statusSec.createDiv({ cls: "bt-area-filter-sec-label", text: tr("savedViews.statusAll") });
  const statusRow = statusSec.createDiv({ cls: "bt-area-filter-chips" });
  for (const opt of statusFilterOptions()) {
    const checked = opt.value === "all"
      ? status === "all"
      : status !== "all" && status.includes(opt.value);
    const chip = statusRow.createEl("button", {
      text: opt.label,
      cls: "bt-area-filter-chip" + (checked ? " active" : ""),
    });
    chip.dataset.areaStatus = opt.value;
    chip.addEventListener("click", () => {
      const next = toggledStatus(status, opt.value);
      v.setAreaWhen(areaIndex, { ...when, status: next }, rerenderControls);
    });
  }

  // US-109z2: time fields are progressive. Scheduled (the primary one) always
  // shows; deadline / completed / created only show once they have a value or
  // the user adds them via "添加日期筛选" — keeps the common panel short.
  void scheduled;
  renderAreaTimeField(v, parent, areaIndex, when, PRIMARY_TIME_FIELD, rerenderControls);
  const shownSecondary = SECONDARY_TIME_FIELDS.filter(
    (f) => (when.time?.[f]?.trim()) || v.areaFilterExtraFields.has(f),
  );
  for (const field of shownSecondary) {
    renderAreaTimeField(v, parent, areaIndex, when, field, rerenderControls);
  }
  // Show the addable date fields directly as inline chips (not a dropdown) so
  // the user can see what's available at a glance.
  const addable = SECONDARY_TIME_FIELDS.filter((f) => !shownSecondary.includes(f));
  if (addable.length > 0) {
    const addRow = parent.createDiv({ cls: "bt-area-add-field-row" });
    addRow.createSpan({ cls: "bt-area-add-field-label", text: tr("savedViews.addTimeField") });
    for (const f of addable) {
      const chip = addRow.createEl("button", {
        cls: "bt-area-add-field",
        text: `＋ ${timeFieldLabel(f)}`,
      });
      chip.dataset.action = "add-time-field";
      chip.dataset.timeField = f;
      chip.addEventListener("click", () => {
        v.areaFilterExtraFields.add(f);
        v.refreshFilterControls(rerenderControls);
      });
    }
  }

  // Tags — a searchable, scrollable list (scales to thousands of tags).
  renderAreaTagList(v, parent, areaIndex, when, rerenderControls);
}

// US-109z2: one time field's area controls — quick tokens + a date-range
// picker (two native date inputs writing a `START..END` range token).
function renderAreaTimeField(
  v: TaskCenterView,
  parent: HTMLElement,
  areaIndex: number,
  when: QueryPresetFilters,
  field: QueryTimeField,
  rerenderControls?: Rerender,
): void {
  const token = when.time?.[field]?.trim() ?? "";
  const isRange = token.includes("..");
  const sec = parent.createDiv({ cls: "bt-area-filter-sec" });
  sec.dataset.areaTimeField = field;
  sec.createDiv({ cls: "bt-area-filter-sec-label", text: timeFieldLabel(field) });

  const setToken = (next: string | undefined) => {
    const nextTime = { ...(when.time ?? {}) };
    if (next) nextTime[field] = next;
    else delete nextTime[field];
    v.setAreaWhen(areaIndex, { ...when, time: nextTime }, rerenderControls);
  };

  const chips = sec.createDiv({ cls: "bt-area-filter-chips" });
  const opts: Array<readonly [string, string]> = field === "scheduled"
    ? [...timeFilterOptions("scheduled"), ["unscheduled", tr("pool.unscheduled")]]
    : timeFilterOptions(field);
  for (const [t, label] of opts) {
    const checked = !isRange && token === t;
    const chip = chips.createEl("button", {
      text: label,
      cls: "bt-area-filter-chip" + (checked ? " active" : ""),
    });
    if (field === "scheduled") chip.dataset.areaScheduled = t || "all";
    chip.addEventListener("click", () => setToken(t || undefined));
  }

  // US-109z2: two distinct semantics for one field — the chips above are
  // RELATIVE (今天 / 本周 / 未来7天 …, resolved against "now"); the inputs below
  // are an ABSOLUTE date range. They're mutually exclusive (picking one clears
  // the other); the "或自定义范围" separator makes that explicit, and the active
  // chip highlights only when no range is set (isRange gates `checked` above).
  const sep = sec.createDiv({ cls: "bt-area-date-or" });
  sep.setText(tr("savedViews.dateOrRange"));
  // Custom date range (a real date picker via native inputs).
  const range = sec.createDiv({ cls: "bt-area-date-range" });
  const [from, to] = isRange ? token.split("..", 2) : ["", ""];
  const fromIn = range.createEl("input", { type: "date", cls: "bt-area-date-input" });
  fromIn.value = from ?? "";
  range.createSpan({ cls: "bt-area-date-sep", text: tr("savedViews.dateRangeTo") });
  const toIn = range.createEl("input", { type: "date", cls: "bt-area-date-input" });
  toIn.value = to ?? "";
  const applyRange = () => {
    const f = fromIn.value.trim();
    const t = toIn.value.trim();
    if (!f && !t) { setToken(undefined); return; }
    setToken(`${f || t}..${t || f}`);
  };
  fromIn.addEventListener("change", applyRange);
  toIn.addEventListener("change", applyRange);
}

// US-109d4: tag filtering is a single boolean expression. The popover has an
// expression input at the top (live-validated, with an example) plus a
// searchable tag list whose rows APPEND `#tag` to the expression — so users can
// both type their own and click to insert. There is no separate three-state /
// AND-OR UI; those are just shapes of the same expression.
function renderAreaTagList(
  v: TaskCenterView,
  parent: HTMLElement,
  areaIndex: number,
  when: QueryPresetFilters,
  rerenderControls?: Rerender,
): void {
  const currentExpr = v.areaTagExpr(when);
  const hasExpr = currentExpr.trim().length > 0;
  const sec = parent.createDiv({ cls: "bt-area-filter-sec" });
  const head = sec.createDiv({ cls: "bt-area-filter-sec-head" });
  head.createSpan({ cls: "bt-area-filter-sec-label", text: tr("savedViews.tag") });
  const headRight = head.createDiv({ cls: "bt-area-tag-head-right" });
  if (hasExpr) {
    const clearTags = headRight.createEl("button", { text: tr("savedViews.clearTags"), cls: "bt-area-filter-clear-tags" });
    clearTags.addEventListener("click", () => v.setAreaWhen(areaIndex, { ...when, tags: [] }, rerenderControls));
  }

  // US-109d4: the expression input is ALWAYS visible (the expression is the tag
  // filter — no click-to-reveal, no "search tags" placeholder). Live-validate on
  // keystroke (inline error, no rerender — keeps focus); commit on change / Enter.
  const exprInput = sec.createEl("input", {
    type: "text",
    cls: "bt-area-tag-expr",
    placeholder: "#a and (#b or #c) and not #d",
  });
  exprInput.dataset.areaTagExpr = "";
  exprInput.value = currentExpr;
  const errEl = sec.createDiv({ cls: "bt-area-tag-expr-error" });
  sec.createDiv({ cls: "bt-area-tag-expr-example", text: tr("savedViews.tagExprExample") });
  const validate = (text: string): boolean => {
    const t = text.trim();
    if (!t) { errEl.toggleClass("is-visible", false); return true; }
    const { error, position } = parseTagExpr(text);
    if (error) {
      errEl.setText(tr("savedViews.tagExprError", { n: position ?? 1 }));
      errEl.toggleClass("is-visible", true);
      return false;
    }
    errEl.toggleClass("is-visible", false);
    return true;
  };
  const commit = () => {
    const text = exprInput.value.trim();
    if (!text) {
      if (hasExpr) v.setAreaWhen(areaIndex, { ...when, tags: [] }, rerenderControls);
      return;
    }
    if (!validate(exprInput.value)) return; // invalid → don't write, keep last saved value
    if (text !== currentExpr) v.setAreaWhen(areaIndex, { ...when, tags: { expr: text } }, rerenderControls);
  };
  exprInput.addEventListener("input", () => validate(exprInput.value));
  exprInput.addEventListener("change", commit);
  exprInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });

  // "Insert a tag" — a collapsed trigger that expands a searchable tag list;
  // clicking a tag appends `#tag` to the expression. Just an input aid; the
  // expression input above is the source of truth. Open state persists.
  const trigger = sec.createEl("button", { cls: "bt-area-tag-trigger" });
  trigger.dataset.action = "tag-select";
  trigger.createSpan({ cls: "bt-area-tag-trigger-summary", text: tr("savedViews.tagInsert") });
  setIcon(trigger.createSpan({ cls: "bt-area-tag-caret" }), v.areaTagPopoverOpen ? "chevron-up" : "chevron-down");
  trigger.addEventListener("click", () => {
    v.areaTagPopoverOpen = !v.areaTagPopoverOpen;
    v.refreshFilterControls(rerenderControls);
  });

  if (!v.areaTagPopoverOpen) return;

  // Float the popover (position:fixed anchored to the trigger) so opening it
  // doesn't grow the sheet / push other controls — it overlays instead.
  const popover = sec.createDiv({ cls: "bt-area-tag-popover bt-area-tag-popover--float" });
  const placeFloat = () => {
    const r = trigger.getBoundingClientRect();
    popover.style.left = `${Math.round(r.left)}px`;
    popover.style.width = `${Math.round(r.width)}px`;
    const popH = popover.offsetHeight || 280;
    const below = window.innerHeight - r.bottom;
    if (below < popH + 8 && r.top > popH + 8) popover.style.top = `${Math.round(r.top - popH - 4)}px`;
    else popover.style.top = `${Math.round(r.bottom + 4)}px`;
  };
  window.requestAnimationFrame(placeFloat);
  const scroller = trigger.closest<HTMLElement>(".modal-content, .bt-editor-page-body");
  const reposition = () => placeFloat();
  scroller?.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition, { passive: true });
  const cleanup = () => {
    scroller?.removeEventListener("scroll", reposition);
    window.removeEventListener("resize", reposition);
  };
  new MutationObserver((_m, obs) => {
    if (!popover.isConnected) { cleanup(); obs.disconnect(); }
  }).observe(sec, { childList: true, subtree: true });

  // Searchable tag list — clicking a row APPENDS `#tag` to the expression above.
  const searchInput = popover.createEl("input", { type: "text", cls: "bt-area-tag-search", placeholder: tr("savedViews.tagSearch") });
  const list = popover.createDiv({ cls: "bt-area-tag-list" });
  const options = v.collectTagOptions([]);
  const CAP = 100;
  const renderRows = (query: string) => {
    list.empty();
    const q = query.trim().toLowerCase();
    const filtered = q ? options.filter((o) => o.tag.toLowerCase().includes(q)) : options;
    if (filtered.length === 0) {
      list.createDiv({ cls: "bt-area-filter-empty", text: tr("savedViews.tagEmpty") });
      return;
    }
    for (const opt of filtered.slice(0, CAP)) {
      const row = list.createEl("button", { cls: "bt-area-tag-row" });
      row.dataset.areaTag = opt.tag;
      setIcon(row.createSpan({ cls: "bt-area-tag-check" }), "plus");
      row.createSpan({ text: opt.tag, cls: "bt-area-tag-row-label" });
      if (opt.count > 0) row.createSpan({ text: String(opt.count), cls: "bt-area-tag-row-count" });
      row.addEventListener("click", () => {
        const next = appendTagToExpr(exprInput.value, opt.tag);
        exprInput.value = next;
        if (validate(next)) v.setAreaWhen(areaIndex, { ...when, tags: { expr: next } }, rerenderControls);
      });
    }
    if (filtered.length > CAP) {
      list.createDiv({ cls: "bt-area-tag-more", text: tr("savedViews.tagMore", { n: filtered.length - CAP }) });
    }
  };
  searchInput.addEventListener("input", () => renderRows(searchInput.value));
  renderRows("");
}
