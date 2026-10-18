# Task Center Query DSL 参考

[English](en.md) · **中文**

Task Center 里每一个 Tab 都是一份 **Query DSL**（一个 `QueryPreset` 对象）。同一份 DSL 同时驱动：图形过滤、视图布局、CLI 查询。在 Tab 上点「编辑 Query」就能看到并直接编辑这份 JSON。

> 本文是 DSL 的 **SSOT（唯一权威来源）**。其它地方（README、skill、AI 提示）若与本文冲突，以本文为准；改 DSL 行为时先改这里。
>
> Markdown 是唯一事实源。DSL 只决定「怎么筛、怎么排、怎么摆」，任务数据本身永远在 vault 的 Markdown 行里。视图、过滤都是从 Markdown 派生出来的结果。
>
> 需要逐字段的 TypeScript 类型定义，见 [`ARCHITECTURE.md` §1.3](../../ARCHITECTURE.md#13-querypreset)；运行时形状以 `src/types.ts` 的 `QueryPreset` 为准。

---

## 1. 一份 Preset 的结构

```jsonc
{
  "id": "preset-today",
  "name": "Today",
  "builtin": true,
  "hidden": false,
  "view": { "layout": { /* 布局树：怎么摆、每块各自筛什么 */ } }
}
```

| 字段 | 作用 |
| --- | --- |
| `id` | 稳定 id，定位用它，别用显示名。可省略（自动生成）。CLI `query-create` 总会分配新 id，`query-update` 总保留原 id，DSL 里写的 `id` 在这两条路径上都不生效。 |
| `name` | 显示名，**必填**（`query-update` 时省略则沿用原名）。 |
| `builtin` / `hidden` | 是否内置 / 是否在 Tab 栏隐藏。可省略，默认 `false`。 |
| `view.layout` | **布局树**：决定页面上摆哪些组件、怎么嵌套，以及**每个组件各自筛什么**。省略 `view` 时默认是一个不过滤的 `list`。 |

整份 DSL 也可以包一层 `{ "query": { … } }`，效果相同。

> ⚠️ 一个 Preset **只有身份 + 一棵 `view.layout`**。**没有** tab 级 `filters`，**没有** `summary`，**没有**「视图类型」枚举——这些在 1.0 已移除（US-109z2）。
>
> 通过「编辑 Query」或 CLI（`query-create` / `query-update`）提交下列 1.0 前的旧写法会被**直接拒绝**（CLI 报 `invalid_query`，提示更新 skill 并改用 `view.layout` + area `when`，US-217a）：
> - 顶层出现 `filters` 或 `summary`（哪怕是空对象 `{}`）；
> - 顶层扁平的 `search` / `tag` / `time` / `status`；
> - `view` 里带 `type` / `preset` / `sections` / `tray` / `matrix`。
>
> 只有 `data.json` 里**已存的**旧数据会在插件加载时经升级闸门自动迁移成 `{ layout }` 树（US-414 / US-415），手写输入不会。

一个视图长什么样，**完全由 `view.layout` 这棵布局树决定**。

---

## 2. 过滤：每个 area 自己的 `when`

没有「整个 Tab 的基础集合」。每个 list / grid / week / month area 都带**自己的 `when`**，它就是这块区域的全部过滤。GUI 的过滤面板编辑的就是这个 `when`，与你在 JSON 里手写完全等价。

```jsonc
"when": {
  "search": "周报",                                // 标题或任一标签包含这段文字（大小写不敏感）
  "tags": { "expr": "#工作 and not #someday" },     // 标签布尔表达式，见下
  "status": ["todo"],                              // 见下；省略 = 全部
  "time": {
    "scheduled": "today",                          // ⏳ 排期
    "deadline":  "next-7-days",                    // 📅 截止
    "completed": "week",                           // ✅ 完成时间
    "created":   "2026-01-01..2026-06-30"          // ➕ 创建时间
  }
}
```

各条件之间是 **AND**：任务要进入这块区域，必须同时满足 `when` 里每一项。省略的条件不参与过滤。

> `when` 的字段、类型、状态、日期和标签表达式会在归一化前严格校验（US-219）。错误拒绝整份 DSL，CLI 返回 `invalid_query`，文案跟随 Obsidian 语言，并包含完整区域路径，例如 `view.layout.children[0].when.time.scheduled`。

### search

字符串，去首尾空格后做大小写不敏感的子串匹配：任务**标题**或**任一标签**包含它即命中。

### status

可选值：

| 值 | 对应的 checkbox |
| --- | --- |
| `todo` | `- [ ]` |
| `done` | `- [x]` |
| `dropped` | `- [-]` |
| `in_progress` | `- [/]` |
| `cancelled` | `- [>]` |
| `custom` | 其它任意字符 |

写法：数组（多选，命中任一即可）、单个字符串，或 `"all"`；省略 = 全部。匹配的是终态继承后的 `effectiveStatus`（父任务已完成 / 放弃时，子任务按父任务的终态算）。GUI 状态面板只提供 全部 / TODO / 完成 / 放弃 四项。

> 不认识的状态会报错，不会退化成 `all`。归一化后的 `when` 显式带 `status: "all"` 或状态数组。

### tags —— 标签表达式

标签过滤是一个**布尔表达式**，标准写法是 `{ "expr": "…" }`（US-109d4）。

- 语法：标签、`and`、`or`、`not`、括号 `( )`。
- 优先级 `not` > `and` > `or`，用括号改变结合顺序。
- 关键字大小写不敏感；只有**不带 `#`** 的 `and` / `or` / `not` 才是关键字，`#and` 是一个名叫 and 的标签。
- 标签前的 `#` 可省略；标签大小写不敏感；按**完整标签**精确匹配（`#a` 不会命中 `#a/b`，反之亦然）。
- 必须显式写运算符：`#a #b` 是语法错误，不会当成 AND。
- 标签名里不能含空格或括号（它们是分隔符）。

例：`"tags": { "expr": "(#a or #b) and not #c" }` —— 含 a 或 b、且不含 c。

语法错误时拒绝保存；GUI 就地标红并显示“第 N 个字符附近…”，保留已保存的过滤条件。

**旧写法**仍可输入，归一化时会自动改写成等价的 `{ expr }`，`query-show` 看到的总是表达式：

| 旧写法 | 等价表达式 |
| --- | --- |
| `["#a", "#b"]` 或 `"a, b"` | `#a and #b` |
| `{ "values": ["#a", "#b"], "mode": "or" }` | `#a or #b` |
| `{ "values": ["#a"], "exclude": ["#c"] }` | `#a and not #c` |

`tags` 写成数字、混合类型数组或非法对象时返回 `invalid_query`。表达式与旧 `values/mode/exclude` 字段不能混写。

GUI 的标签 popover 有实时校验的表达式输入框与标签列表。追加标签时保留原表达式优先级：`#a or #b` 追加 `#c` → `(#a or #b) and #c`；末尾为 `and/or/not` 时只补标签。

### time —— 时间字段与日期词汇

`time` 是一个对象，支持 5 个字段：

| 字段 | 取值来源 |
| --- | --- |
| `scheduled` | ⏳ 排期（含从父任务继承的排期） |
| `deadline` | 📅 截止（含从父任务继承的截止） |
| `completed` | ✅ 完成日期（任务自己那行） |
| `created` | ➕ 创建日期（缺失时取继承值） |
| `dropped` | ❌ 放弃日期（任务自己那行） |

每个字段取一个日期 token：

| Token | 含义 |
| --- | --- |
| `all` | 不限制 |
| `today` / `tomorrow` | 今天 / 明天 |
| `week` / `next-week` | 本周 / 下周（周起始日优先使用区域 firstDayOfWeek，否则跟随插件设置） |
| `month` | 本月 |
| `unscheduled` | **该字段为空**（如「没有排期」＝ `scheduled: "unscheduled"`，「没有截止」＝ `deadline: "unscheduled"`） |
| `overdue` | 早于今天（**仅 `deadline`**） |
| `not-overdue` | 无截止日期或不早于今天（**仅 `deadline`**，US-720b） |
| `next-7-days` | 今天到 7 天后，含两端（**仅 `deadline`**） |
| `2026-06-23` | 某一天（`YYYY-MM-DD`） |
| `2026-06-01..2026-06-30` | 闭区间（`起..止`，任一端可空，如 `2026-06-01..`） |

- 除 `all`、`unscheduled` 和 `not-overdue` 外，字段为空的任务一律不匹配。
- 相对 token 的「今天」：list / grid 用真实的今天；week / month 用当前导航到的锚点日期（CLI 里是 `anchor=`）。
- `overdue` / `not-overdue` / `next-7-days` 只允许用于 `deadline`，用在其它字段会报错。
- **没有 `yesterday` / `next-month`**。未知 token、无效日历日期、倒置范围会报错；范围至少有一端日期。
- 未知时间字段会报错。

---

## 3. view.layout：SwiftUI 式布局树

布局树由两种节点组成：

- **容器节点 Stack**：`row`（≈ HStack，横排）或 `col`（≈ VStack，竖排），用 `children` 嵌套子节点，可选 `weight` 控制伸缩比例。
- **叶子节点 Area**：真正渲染内容的组件（`list` / `grid` / `week` / `month` / `drop`）。

```jsonc
"layout": {
  "dir": "col",                      // col = 竖排；row = 横排
  "children": [
    { "type": "week" },              // 叶子：周网格
    { "type": "list", "weight": 1 }  // 叶子：列表，占 1 份伸缩
  ]
}
```

结构校验（不通过则整份 DSL 被拒绝）：

| 规则 | 错误码 |
| --- | --- |
| 节点必须是对象 | `invalid_layout` |
| 带 `dir` 或 `children` 的节点视为 Stack，`dir` 必须是 `"row"` / `"col"` | `invalid_stack_dir` |
| Stack 的 `children` 必须是非空数组 | `invalid_stack_children` |
| area 的 `type` 必须是字符串（省略 = `list`） | `invalid_area_type` |
| `drop` area 必须带 `onDrop` 对象 | `drop_requires_on_drop` |

`weight` 必须是正数，否则报错。

根节点既可以是 Stack，也可以**直接是一个 area**（不必包壳）。例如 TODO 视图的根就是单个 `list`：

```jsonc
"layout": { "type": "list", "when": { "status": ["todo"] } }
```

一个视图不是「一种类型」，而是自由组合多个 area：周视图 = `col[ 周网格, row[未排期, 放弃区] ]`，未排期 = `col[ 列表 ]`，你也可以 `row[ 工作列表, 个人列表 ]` 并排自定义。

---

## 4. Area 类型逐个看

每个 area 的公共可选字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定标识。内置 id `overdue` / `today` / `unscheduled-rec` / `unscheduled-tray` 的标题会按界面语言本地化显示，覆盖 `title`。 |
| `title` | 区域标题。省略时，第一个内容区借用 Tab 名，其余显示 area 类型名。 |
| `weight` | 伸缩比例（正数）。 |
| `onDrop` | 拖入时的写操作，见 §5.2。 |

### 4.1 list —— 任务列表

最常用的组件：用 `when` 筛出一列任务卡。父任务和子任务同时命中时，子任务嵌在父卡片里，不重复出现。

![list 视图](../assets/dsl/todo.png)

```jsonc
{
  "type": "list",
  "when": { "tags": { "expr": "#工作" } },
  "orderBy": ["deadline_risk", "created_desc"],
  "limit": 50
}
```

| 字段 | 说明 |
| --- | --- |
| `when` | 这块区域的过滤（见 §2）。图形过滤入口编辑的就是这个 `when`。 |
| `orderBy` | 排序，见 [§5.3](#53-orderby-排序)。省略时保持 vault 里的原始顺序。 |
| `limit` | 最多显示多少条（正整数；其它值报错）。 |
| `emptyText` | list/grid 的自定义空状态文案（包括空托盘）；省略或空白则使用内置文案。 |

#### 多段列表 —— 用 col 叠多个 list

`list` 没有内部分组。要像「今日」那样把列表分成逾期 / 今天 / 未排期三段，就用 `col` 容器叠 3 个 `list` area，每个 area 自带完整 `when`、各自过滤（见 §6「今日」）。共享的条件直接在每块的 `when` 里各写一遍。

### 4.2 grid —— 卡片网格

和 `list` 同字段、同过滤与排序，只是卡片以**响应式多列网格**排列。二维分类（四象限）用 `row` / `col` 嵌套多个带 `title` + `when` 的 grid 表达，**没有专门的 matrix 类型**：

![四象限 = row/col 嵌套 grid](../assets/dsl/quadrant.png)

```jsonc
"layout": {
  "dir": "col",
  "children": [
    { "dir": "row", "children": [
      { "type": "grid", "title": "重要 & 紧急",   "when": { "tags": { "expr": "#重要 and #紧急" } } },
      { "type": "grid", "title": "重要 & 不紧急", "when": { "tags": { "expr": "#重要 and not #紧急" } } }
    ] },
    { "dir": "row", "children": [
      { "type": "grid", "title": "不重要 & 紧急",   "when": { "tags": { "expr": "not #重要 and #紧急" } } },
      { "type": "grid", "title": "不重要 & 不紧急", "when": { "tags": { "expr": "not #重要 and not #紧急" } } }
    ] }
  ]
}
```

### 4.3 week —— 周网格

按周展示的日期网格，带 `◀ 周 ▶` 导航。任务按 ⏳ 排期（含继承）落进对应的日格，没有排期的任务不会出现在这里。每个日格都是拖放目标：把卡片拖进某一天即写入该天的 ⏳。`when` 决定这张周网格里显示哪些任务。

![周视图 = col[ week, 未排期, 放弃区 ]](../assets/dsl/week.png)

```jsonc
{ "type": "week", "when": { "status": ["todo"] } }
```

- `firstDayOfWeek`（`monday` / `sunday`）覆盖全局周起始日，同时作用于本区域的日历与周日期过滤；省略时跟随全局设置。
- week/month 不接受显式 `onDrop`；日格始终是“改排期到当日”。

> 上图的完整布局见 [§6 周视图](#周视图)：周网格下面横排着「未排期」收纳格和「放弃区」。

### 4.4 month —— 月网格

按月展示的日期网格，用法同 `week`，带月份导航。

![月视图](../assets/dsl/month.png)

```jsonc
{ "type": "month", "when": { "status": ["todo"] } }
```

`firstDayOfWeek` 的覆盖规则同 week。`density` 已从 DSL 删除：新输入报错，读取旧存储时忽略；移动端仍使用日历格和圆点。

### 4.5 drop —— 放弃区

没有 query、不显示任务的落区，`onDrop` 必填（缺了报 `drop_requires_on_drop`）。

```jsonc
{ "type": "drop", "onDrop": { "setStatus": "dropped" } }
```

> drop 是放弃区（US-100 / US-123），只接受 `{ "setStatus": "dropped" }`，且只能有这个键。空对象、done、改期、清排期或多键都返回 `invalid_query`，不会静默变成放弃。放弃会级联仍为 todo 的子任务。drop 的 `title` 不显示。

### 4.6 unknown —— 兜底

不被支持的 area `type`（笔误，或已删除的旧类型如 `matrix`）**不是错误**：会被归一化成 `unknown`，保留原始 JSON，视图层渲染「未知类型 + JSON」，不会让整份配置加载失败。所以 `type` 拼错不会报错，只会渲染成一块没用的未知区。

---

## 5. 机制

### 5.1 过滤只属于 area

每个 list / grid / week / month area 的过滤，就是它**自己的 `when`**，互不影响。

- 没有作用于整个 Tab 的「基础集合 / 全局过滤」。要让整个 Tab 都只看 `todo`，就在每个 area 的 `when` 里各写一遍 `"status": ["todo"]`（内置视图就是这么做的）。
- 图形过滤入口直接编辑该 area 的 `when`，与 DSL 直编是同一份数据。

### 5.2 onDrop：拖拽写操作

卡片被拖进某个 area 时执行的写操作。每个 area 只写**一个**键：

| 写法 | 效果 | 在哪些 area 生效 |
| --- | --- | --- |
| `{ "setStatus": "dropped" }` | 放弃任务（含 todo 子任务级联） | `drop` / `list` / `grid` |
| `{ "setStatus": "done" }` | 完成任务（含 todo 子任务级联） | `list` / `grid` |
| `{ "clearScheduled": true }` | 清空被拖任务自己那行的 ⏳（未排期收纳格用） | `list` / `grid` |
| `{ "setScheduled": "2026-06-23" }` | 把 ⏳ 改到这一天 | `list` / `grid` |

- `setScheduled` 接受有效 ISO 日期或 `today` / `tomorrow` / `next-week`，在拖入时按真实今天解析为 ISO 后写回；`next-week` 指七天后。范围 token（如 `week`）不支持。
- `week` / `month` 拒绝显式 `onDrop`；日格本身是改排期目标。
- 排期继承自父任务（自己那行没有 ⏳）的卡片拖进 `clearScheduled` 区时，不会改写，只弹提示。
- `onDrop` 必须且只能有一个有效操作键；非法值、未知键及组合操作均在保存前报错。

### 5.3 orderBy 排序

`orderBy` 接受一个 token 数组，按顺序作为多级排序键：

| Token | 含义 |
| --- | --- |
| `deadline_asc` / `deadline_desc` | 按截止日期升 / 降（无截止的排最后） |
| `scheduled_asc` / `scheduled_desc` | 按排期升 / 降（无排期的排最后） |
| `created_desc` | 按创建时间倒序 |
| `completed_desc` | 按完成时间倒序 |
| `deadline_risk` | 按截止风险：已逾期 → 3 天内到期 → 更晚 → 无截止，同档再按截止日期升序 |
| `priority_desc` | 按优先级从高到低（🔺 ⏫ 🔼 🔽 ⏬，无优先级最后） |
| `title_asc` / `title_desc` | 按标题字母序 |

表里没列的排序 token（如 `created_asc`）会报错，不会保存一个无效排序。

---

## 6. 内置视图：完整范例

下面是 7 个内置视图的**真实出厂 DSL**（取自 `src/builtin-views/*.json`，此处省略 `id` / `name` 等身份字段），可直接当模板改。它们都没有 tab 级过滤，状态等条件一律落在各 area 的 `when` 上。

### TODO

一个不分组的 `list`：

```jsonc
{ "view": { "layout": { "type": "list", "when": { "status": ["todo"] } } } }
```

### 今日

`col` 叠 3 个 list（逾期 / 今天 / 未排期推荐），每个 list 自带 `when`：

```jsonc
{ "view": { "layout": {
  "dir": "col",
  "children": [
    { "type": "list", "id": "overdue", "title": "Overdue",
      "when": { "status": ["todo"], "time": { "deadline": "overdue" } },
      "orderBy": ["deadline_asc"], "limit": 3 },
    { "type": "list", "id": "today", "title": "Today",
      "when": { "status": ["todo"], "time": { "scheduled": "today" } }, "limit": 3 },
    { "type": "list", "id": "unscheduled-rec", "title": "Unscheduled",
      "when": { "status": ["todo"], "time": { "scheduled": "unscheduled", "deadline": "not-overdue" } },
      "orderBy": ["deadline_asc", "created_desc"], "limit": 3 }
  ]
} } }
```

### 未排期

`col[ list ]`，list 的 `when` 取「没有排期且 todo」：

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "list",
    "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
    "orderBy": ["deadline_risk", "created_desc"] }
] } } }
```

### 周视图

`col[ week, row[ grid(未排期收纳), drop(放弃) ] ]`：

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "week", "when": { "status": ["todo"] } },
  { "dir": "row", "children": [
    { "type": "grid", "id": "unscheduled-tray", "title": "Unscheduled",
      "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
      "onDrop": { "clearScheduled": true } },
    { "type": "drop", "title": "Drop",
      "onDrop": { "setStatus": "dropped" } }
  ] }
] } } }
```

### 月视图

同周视图，把顶部换成 `month`：

```jsonc
{ "view": { "layout": { "dir": "col", "children": [
  { "type": "month", "when": { "status": ["todo"] } },
  { "dir": "row", "children": [
    { "type": "grid", "id": "unscheduled-tray", "title": "Unscheduled",
      "when": { "time": { "scheduled": "unscheduled" }, "status": ["todo"] },
      "onDrop": { "clearScheduled": true } },
    { "type": "drop", "title": "Drop", "onDrop": { "setStatus": "dropped" } }
  ] }
] } } }
```

### 已完成

`list`，按完成时间倒序：

```jsonc
{ "view": { "layout": {
  "type": "list",
  "when": { "status": ["done"] },
  "orderBy": ["completed_desc"]
} } }
```

### 已放弃

`list`，过滤 `dropped`：

```jsonc
{ "view": { "layout": { "type": "list", "when": { "status": ["dropped"] } } } }
```

---

## 7. 图形编辑 ↔ DSL ↔ CLI（同一份 schema）

图形过滤入口、「编辑 Query」直编 JSON、CLI 查询管理，三者共用同一份解析与校验（US-219）：在界面上点过滤器改的就是某个 area 的 `when`，和你在这份 JSON 里手写完全等价。

CLI 命令（`obsidian task-center:<命令>`，目标一律用稳定 id）：

| 命令 | 作用 |
| --- | --- |
| `query-list [hidden=true] [format=json]` | 列出 preset |
| `query-show id=<id>` | 输出归一化后的完整 DSL |
| `query-run id=<id> [view=list\|week\|month] [anchor=YYYY-MM-DD] [format=json]` | 执行查询并展示结果 |
| `query-create dsl=<json>`（同 `query-save`） | 新建 preset，总是分配新 id |
| `query-update id=<id> dsl=<json>` | 整体替换 preset，保留 id 与 builtin |
| `query-rename` / `query-copy` / `query-hide` / `query-delete` / `query-set-default` | 重命名 / 复制 / 隐藏 / 删除 / 设默认 |

`query-run` 的当前行为：

- 只执行布局里**第一个内容 area**（深度优先、跳过 `drop`），其余 area 不参与。像「今日」这样的多段视图，CLI 只会输出第一段。
- `view=` 临时把布局换成单个 list / week / month，沿用第一个内容 area 的 `when`。
- `anchor=` 决定 week / month 显示哪一周 / 哪个月，也是它们相对 token 的「今天」。

DSL 无法解析或校验失败时，`query-create` / `query-update` 返回 `invalid_query`，已有 preset 保持不变。

> 🖼️ **配图 TODO** —— 并排展示「图形过滤弹窗」与对应的 `when` JSON 片段，标出二者一一对应。

---

## 8. 设计原则速记

1. **Markdown 是唯一事实源**，DSL 只是派生层。
2. **一个视图 = 一棵布局树**，没有视图类型枚举；渲染层不按 today / completed 等名字分支。
3. **过滤只属于 area**：每个 area 的 `when` 就是它的全部过滤，没有 tab 级基础集、没有全局过滤状态。
4. **动作是通用能力**：改排期 / 清排期 / 放弃由卡片和落区提供，不绑定某个视图。
5. **未知类型不报错**：归一化成 `unknown` 兜底。
6. **没有 `summary`**：顶部统计已移除；估时 / 复盘类统计走 `task-center:stats` / `review` CLI。

---

> 截图取自桌面端 Task Center；标签、分组标题等文案以各自 vault 的真实数据为准。
