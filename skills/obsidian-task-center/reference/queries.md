# Query Tabs / Preset DSL — 完整参考

> 产品需求唯一来源是 `USER_STORIES.md`；`docs/dsl/zh.md`（英文 `docs/dsl/en.md`）是语法参考。本文件是 skill 自带的速查。旧语法示例与当前故事不一致时，应报告差异，不能照旧例生成已被拒绝的 DSL。

> 决定要**建/改视图**、或要精确解释 `query-run` 输出时再读本文件。成品布局直接看同级 `../examples/`。
> 写 DSL 前的保命做法：先 `obsidian task-center:query-show id=preset-week`（周+托盘+drop）或 `id=preset-today`（分区列表），**照它返回的结构改，别凭记忆猜**。

视图 / Tab 是保存的 QueryPreset，与“编辑视图 / 编辑区域”共用存储、schema 和校验。布局在 `view.layout`，过滤条件只在各区域的 `when`；没有 Tab 级过滤或汇总，GUI 统计在区域头。（US-109t / US-109z2 / US-303）始终用稳定 `id` 定位，不要用显示名。

## 读取动词

```
obsidian task-center:query-list [hidden=true] [format=json]
obsidian task-center:query-show id=preset-week
obsidian task-center:query-run  id=preset-today [view=list|week|month] [anchor=YYYY-MM-DD] [format=json]
```

- `query-list` 文本输出含 `id` / `name` / `builtin|custom` / `default` / `hidden|visible`。JSON 包含 id、name、builtin、hidden、default 字段。`hidden=true` 才包含隐藏视图，`false` 或省略时不包含。（US-216 / US-413a）
- `query-run` 按布局顺序逐区域输出标题与结果，跳过放弃区；list / grid 按任务树，week 按 7 天，month 按日期，JSON 包含每块区域结果。（US-220）
- `view=list|week|month` 临时覆盖每块显示任务区域的类型，保留各自 `when` 和区域顺序，不回写、不合并为单区域。`anchor=` 是周 / 月日期游标，默认今天，支持 `明天` / `周六` / `next-week` 等自然语言；无法识别或不存在的日期报 `invalid_date`。（US-410a）
- 周输出全部 7 天带计数；月文本只列有任务的日期格，JSON 含全部月格。
- 所有任务行带稳定 id（`Tasks/Inbox.md:L42`），可继续 pipe 给 `show` / `schedule` / `done` / `abandon`。

## DSL 形状（1.0+，是一棵 area 布局树）

预设 = `{ name, view: { layout: <node> } }`。

> ⚠️ **过滤只能写在每个 area 的 `when` 上。**
> - 顶层 `filters` / `summary`、旧扁平 `search` / `tag` / `time` / `status`、旧 `view:{type,preset,sections,tray,matrix}` 输入全部返回 `invalid_query`，提示更新 AI skill 并使用 `view.layout` + 区域 `when`。（US-217a）
> - CLI 新输入不自动迁移、不静默忽略旧字段。US-414 / US-415 的一次性迁移仅用于已有旧插件配置，由用户确认升级后保存。
> - 区域的状态、日期、标签表达式、`onDrop` 等字段非法时返回 `invalid_query`，指出区域与字段，不改成默认值后保存。（US-219）

`<node>` 是 **stack** 或 **area leaf**：

- **stack** — `{ "dir": "row" | "col", "children": [<node>, …], "weight"?: number }`。`col` ≈ VStack，`row` ≈ HStack；嵌套做二维布局（如四象限网格）。`children` 必须非空。
- **area leaf** 之一（公共可选字段：`id` / `title` / `weight` / `onDrop`）：
  - `{ "type":"list", "when"?:Filters, "orderBy"?:[string], "limit"?:number, "emptyText"?:string }`（无内部分组；多段列表用 `col` 叠多个 list）
  - `{ "type":"grid", …同 list… }` — 配置与投影同 `list`，卡片改为响应式多列网格（未排期托盘用）
  - `{ "type":"week" | "month", "when"?:Filters, "firstDayOfWeek"?:"monday"|"sunday" }`；week/month 的每个日期格本身就是改期放置目标
  - `{ "type":"drop", "onDrop":DropEffect, "title"?:string }` — 纯动作放弃区，无任务、无 `when`；必须有合法 `onDrop`，否则 CLI 报 `invalid_query` 并定位该字段。

> 已加载配置中的未知区域类型保留原始 JSON，并显示“未知区域类型”，不静默丢掉或换成其它类型（US-103c）。不要主动生成未知类型；US-219 的新 DSL 严格校验与未知类型展示的导入边界尚需澄清，不能据此承诺 CLI 会接受拼错的 `type`。

列表 / 网格的 `limit` 只限制顶层卡片，GUI 超出时显示“还有 M 条”并可在本区域展开。展开仅限本区域、本次看板会话。区域头任务数 / 估时 / 实际合计仍统计过滤后的全部匹配任务；只有存在 done 才显示实际与比例，比例只用 estimate 和 actual 都有的任务求和相除，分母为 0 不显示百分比。（US-103 / US-720b）

### Filters（`when`）

```jsonc
{
  "search": "示例",                 // 任务文本关键字
  "tags": { "expr": "(#work or #urgent) and not #done" },  // 布尔表达式：#tag / and / or / not / 括号；# 可省略；优先级 not>and>or。旧写法 ["#a","#b"]（=AND）、"a,b"、{values,mode,exclude} 仍可用，会自动迁移成 {expr}
  "status": ["todo"],               // 见下；或 "all"
  "time": { "scheduled": "today", "deadline": "overdue" }
}
```

- **`status`** 合法值：`todo` / `done` / `dropped` / `in_progress` / `cancelled` / `custom`（数组，或单个字符串，或 `"all"`）。匹配的是终态继承后的 `effectiveStatus`。
- **`time`** 日期字段：`scheduled` 排期、`deadline` 截止、`completed` 完成于、`dropped` 放弃于、`created` 创建于。放弃于可添加、保存和回显，不能静默剥除。（US-109i）
- **`time` token**：
  - 通用（任意字段）：`today` · `tomorrow` · `week` · `next-week` · `month` · `unscheduled`（该字段为空）· `YYYY-MM-DD`（精确）· `FROM..TO`（区间）· `all`
  - **仅 `deadline`**：`overdue`（早于今天）· `not-overdue`（无截止或截止不早于今天）· `next-7-days`
  - `when` 的 DSL token 与 CLI 日期参数分开：`list` 支持 `yesterday` / `next-month`，CLI 日期参数支持自然语言；不要把任意自然语言原词写入 DSL。非法 DSL 日期必须报 `invalid_query`，不能静默无匹配。（US-109e / US-219 / US-410a）

表达式编辑遵守 US-109d4：点选标签时，`#a or #b` 追加 `#c` 生成 `(#a or #b) and #c`；末尾已有 `and` / `or` / `not` 时只补标签。非法表达式要定位字符，不可当作“无标签过滤”。GUI 保留先前有效条件，CLI 返回 `invalid_query`。

今日出厂视图是竖排三个 list：未完成且截止逾期、未完成且排期今天、未完成且未排期且不逾期；每组上限 3。不要把单纯 `scheduled:unscheduled` 当成完整的未排期推荐条件。未排期推荐可用 `time:{scheduled:"unscheduled",deadline:"not-overdue"}`；按截止由近到远、无截止排后，再按创建时间。具体完整配置先用 `query-show` 核对，不按标题在客户端补过滤。（US-720b / US-109v）

`drop` 放弃区必填 `onDrop:{"setStatus":"dropped"}`。其它接收拖拽的任务区域可按语义使用互斥动作：`setStatus:"dropped"`、`setScheduled` 或 `clearScheduled:true`；未排期区用清空排期，周 / 月日期格隐式写入当日排期。

## 创建 / 修改

```bash
obsidian task-center:query-create dsl='…'      # 总是分配新 id，即使 DSL 里带 id（query-save 是其别名）
obsidian task-center:query-update id=… dsl='…' # 保留目标 id 与 builtin/custom 身份；校验失败则原预设不动
```

非法 DSL 报 `invalid_query` 并保持设置不变；成功后刷新已打开看板。保存的出厂 / 自建视图布局和混合排序在重载、重开仓库、升级后保留；只有显式恢复预设才重置出厂配置。（US-217 / US-109c2）成品 DSL 见 `../examples/`。

## 管理 / 规则

```
obsidian task-center:query-rename      id=sv-alpha name="深度工作"
obsidian task-center:query-copy        id=preset-week [name="我的本周"]   # 缺省名 = "<源名> Copy"
obsidian task-center:query-hide        id=preset-week hidden=true|false
obsidian task-center:query-delete      id=sv-alpha
obsidian task-center:query-set-default id=preset-week                     # 或 id=null 清默认
```

- 出厂 / 自建 Tab 都可删除；出厂 Tab 的删除会持久记录，重启不重新播种，GUI 可显式“恢复预设”找回。（US-109l / US-218）
- 删除任何 Tab 都只删保存视图，绝不删任务。
- 默认视图只能选择未隐藏的 Tab。（US-120）
- 目标 id 应先从 `query-list` 获取；US-211 未定义不存在的视图 id 对应哪一个固定错误码，不再宣称支持 `query_not_found`。

## CLI 错误与参数

错误严格两行，第二行跟随 Obsidian 语言：（US-211 / US-412）

```text
error <code>
<一句说明如何处理的人话>
```

固定集合：`not_found`、`ambiguous_slug`、`missing_arg`、`invalid_arg`、`invalid_date`、`invalid_query`、`daily_notes_missing`、`daily_notes_folder_missing`、`write_conflict`。含义与处理见 `../SKILL.md`，不自行增加旧错误码。`hidden=false` 按 false 处理；`limit` / `days` 不是正整数时返回 `invalid_arg`。（US-413a）
