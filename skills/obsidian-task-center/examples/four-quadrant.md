# 例：四象限视图（Covey）

2×2 网格：外层 `dir:"col"` 套两个 `dir:"row"`，每个 row 放两个 `grid` 区域，按标签过滤。（US-103a / US-109v）下面的象限编码只是示例约定：1=紧急且重要，2=重要不紧急，3=紧急不重要，4=都不是；插件不内置这些含义。

标签过滤是布尔表达式（canonical 形态 `{ "expr": "…" }`，US-109d4）。下面用 `#N象限` 编码；你也可以**不打象限标签**，直接用 `#urgent` / `#important` 组合，例如 ① = `"#urgent and #important"`、② = `"#important and not #urgent"`。

布局（易读版）：

```json
{
  "name": "四象限",
  "view": { "layout": {
    "dir": "col",
    "children": [
      { "dir": "row", "children": [
        { "type": "grid", "title": "① 紧急且重要", "when": { "tags": { "expr": "#1象限" }, "status": ["todo"] } },
        { "type": "grid", "title": "② 重要不紧急", "when": { "tags": { "expr": "#2象限" }, "status": ["todo"] } }
      ]},
      { "dir": "row", "children": [
        { "type": "grid", "title": "③ 紧急不重要",  "when": { "tags": { "expr": "#3象限" }, "status": ["todo"] } },
        { "type": "grid", "title": "④ 都不是",      "when": { "tags": { "expr": "#4象限" }, "status": ["todo"] } }
      ]}
    ]
  }}
}
```

创建：

```bash
obsidian task-center:query-create dsl='{"name":"四象限","view":{"layout":{"dir":"col","children":[{"dir":"row","children":[{"type":"grid","title":"① 紧急且重要","when":{"tags":{"expr":"#1象限"},"status":["todo"]}},{"type":"grid","title":"② 重要不紧急","when":{"tags":{"expr":"#2象限"},"status":["todo"]}}]},{"dir":"row","children":[{"type":"grid","title":"③ 紧急不重要","when":{"tags":{"expr":"#3象限"},"status":["todo"]}},{"type":"grid","title":"④ 都不是","when":{"tags":{"expr":"#4象限"},"status":["todo"]}}]}]}}}'
```

要点：
- 二维网格靠**嵌套 stack**：外层 `col`，内层 `row`。
- 每格独立 `when`；标签过滤用布尔表达式（`and` / `or` / `not` / 括号）。旧写法 `"tags": ["#1象限"]` 仍可用，会自动迁移成 `{ "expr": "#1象限" }`。
- 区域类型不决定拖入后的业务动作。只有明确需要改期 / 清空排期 / 放弃时才配置对应 `onDrop`；拖进象限不会自动添加标签。
