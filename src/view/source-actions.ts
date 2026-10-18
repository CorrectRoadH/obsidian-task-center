// 任务动作入口（presentation）：右键 context menu、Quick Add、打开源文件编辑，
// 从 TaskCenterView god class 抽出（ARCHITECTURE §7.10 TaskActionsPort /
// §7.14 step7 之二）。收 v: TaskCenterView——菜单/弹窗只负责「展示 + 把点击
// 派发到壳的变更引擎」（v.toggleDone / v.runWithRemoveAnim / v.scheduleRefresh /
// v.api …），引擎本身仍留壳。后续一步可把签名收窄为 TaskActionsPort。

import { Notice, Menu, TFile, MarkdownView } from "obsidian";
import type { TaskCenterView } from "../view";
import type { ParsedTask } from "../types";
import type { EffectiveTask } from "../task-tree";
import { t as tr } from "../i18n";
import { todayISO, addDays } from "../dates";
import { isMobileMode } from "../platform";
import { QuickAddModal } from "../quickadd";
import { openTaskSourceEditShell } from "./source-dialog";
import { markdownSourceOpenState } from "./source-open-state";

export async function openSourceEditShell(v: TaskCenterView, task: ParsedTask): Promise<void> {
  v.state.selectedTaskId = task.id;
  v.contentEl.focus();
  if (isMobileMode()) {
    await openNativeSourceEditor(v, task);
    return;
  }
  await openTaskSourceEditShell(v.app, v.leaf, task, {
    onSave: async () => {
      await v.waitForCacheUpdate([task.path], 2000);
      await v.reloadTasks();
      v.bumpCacheVersion();
      v.render();
    },
  });
}

async function openNativeSourceEditor(v: TaskCenterView, task: ParsedTask): Promise<void> {
  const file = v.app.vault.getAbstractFileByPath(task.path);
  if (!(file instanceof TFile)) {
    new Notice(tr("notice.fileNotFound", { path: task.path }));
    return;
  }
  try {
    const leaf = v.app.workspace.getLeaf("tab");
    await leaf.openFile(file, markdownSourceOpenState(task.line, true));
    if (typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      throw new Error("native MarkdownView editor missing");
    }
    const pos = { line: task.line, ch: 0 };
    view.editor.setCursor(pos);
    view.editor.scrollIntoView({ from: pos, to: pos }, true);
    view.editor.focus();
  } catch (err) {
    new Notice(tr("sourceEdit.nativeFailed"));
    console.error(err);
  }
}

// Wired from `wireCardEvents`'s `contextmenu` listener.
// see USER_STORIES.md
export function openContextMenu(v: TaskCenterView, e: MouseEvent, task: EffectiveTask): void {
  const m = new Menu();
  m.addItem((i) =>
    i.setTitle(task.effectiveStatus === "done" ? tr("ctx.markTodo") : tr("ctx.markDone")).onClick(async () => {
      // US-153: same linger-in-place behavior as the ✔ check.
      await v.toggleDone(task);
    }),
  );
  m.addItem((i) =>
    i.setTitle(tr("ctx.scheduleToday")).onClick(async () => {
      const target = todayISO();
      if ((task.scheduled ?? null) !== target) {
        await v.runWithRemoveAnim(task.id, async () => {
          const result = await v.api.schedule(task.id, target);
          v.recordUndoableWrite("schedule", task, result);
        });
      } else {
        v.scheduleRefresh();
      }
    }),
  );
  m.addItem((i) =>
    i.setTitle(tr("ctx.scheduleTomorrow")).onClick(async () => {
      const target = addDays(todayISO(), 1);
      if ((task.scheduled ?? null) !== target) {
        await v.runWithRemoveAnim(task.id, async () => {
          const result = await v.api.schedule(task.id, target);
          v.recordUndoableWrite("schedule", task, result);
        });
      } else {
        v.scheduleRefresh();
      }
    }),
  );
  m.addItem((i) =>
    i.setTitle(tr("ctx.clearSchedule")).onClick(async () => {
      if (task.scheduled) {
        await v.runWithRemoveAnim(task.id, async () => {
          const result = await v.api.schedule(task.id, null);
          v.recordUndoableWrite("clear schedule", task, result);
        });
      } else {
        v.scheduleRefresh();
      }
    }),
  );
  m.addItem((i) =>
    i.setTitle(tr("ctx.drop")).onClick(async () => {
      await v.runWithRemoveAnim(task.id, async () => {
        const result = await v.api.drop(task.id);
        v.recordUndoableWrite("drop", task, result);
      });
    }),
  );
  m.showAtMouseEvent(e);
}

export function openQuickAdd(v: TaskCenterView): void {
  new QuickAddModal(
    v.app,
    new Proxy(v.api, {
      get(target, key, receiver) {
        if (key !== "add") return Reflect.get(target, key, receiver) as unknown;
        return async (...args: Parameters<typeof target.add>) => {
          const result = await target.add(...args);
          v.undoStack.push({ label: "quick add", ops: [{
            path: result.path, line: result.line, before: [], after: [result.created],
          }] });
          return result;
        };
      },
    }),
    () => v.scheduleRefresh(),
    v.plugin.settings,
    v.collectKnownTags(),
  ).open();
}
