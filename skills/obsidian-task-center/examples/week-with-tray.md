# 例：周视图 + 未排期区 + 放弃区

`dir:"col"` 顶部一个 `week` area，底部一行放 `grid` 未排期区（未排期任务）+ `drop` 放弃区。拖动可改排期 / 放弃。

布局（易读版）：

```json
{
  "name": "工作周",
  "view": { "layout": {
    "dir": "col",
    "children": [
      { "type": "week", "when": { "tags": ["#work"], "status": ["todo"] } },
      { "dir": "row", "children": [
        { "type": "grid", "id": "unscheduled-tray", "title": "未排期",
          "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
          "onDrop": { "clearScheduled": true } },
        { "type": "drop", "title": "放弃", "onDrop": { "setStatus": "dropped" } }
      ]}
    ]
  }}
}
```

更新到已有 tab：

```bash
obsidian task-center:query-update id=sv-alpha dsl='{"name":"工作周","view":{"layout":{"dir":"col","children":[{"type":"week","when":{"tags":["#work"],"status":["todo"]}},{"dir":"row","children":[{"type":"grid","id":"unscheduled-tray","title":"未排期","when":{"time":{"scheduled":"unscheduled"},"status":["todo"]},"onDrop":{"clearScheduled":true}},{"type":"drop","title":"放弃","onDrop":{"setStatus":"dropped"}}]}]}}}'
```

要点：
- 周历日期范围与区域过滤保持一致；未覆盖 `firstDayOfWeek` 时跟随全局周首日设置。（US-112）
- 未排期区用 `grid`（多列卡片）过滤 `scheduled:"unscheduled"`；`onDrop:{clearScheduled:true}` 表示拖进未排期区即清掉任务自己的排期；有效排期来自父级时不能修改父任务，应提示先移出父级或编辑原文（US-122a）。
- `drop` 是纯动作区，无查询；`onDrop:{setStatus:"dropped"}` 把拖入任务标为放弃。
- 放弃区使用 `setStatus:"dropped"`；未排期区使用 `clearScheduled:true`；日期格隐式写入目标日期。不同动作不混写。
