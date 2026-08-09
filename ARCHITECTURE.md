# ARCHITECTURE

> 本文只描述 Task Center 如何支撑 [USER_STORIES.md](./USER_STORIES.md) 与 [UX.md](./UX.md)：数据模型、模块边界、读写路径、缓存、性能、测试与发布约束。
>
> 需求不在本文新增；实现不应绕过本文定义的对象模型。

## 0. 架构原则

1. **Markdown 是唯一事实源**：任务数据只存在于 vault 的 Markdown 行中；内存缓存、Query、summary、view 都是派生结果。（US-401）
2. **字节级写回**：改名、移动、嵌套、改期、完成、放弃都必须最小化改动目标行 / 目标块，保留未知 emoji、inline field、tag、block id、wikilink anchor 与用户原文。（US-407 / US-409）
3. **一份 Query DSL**：view（area 布局树）、tab preset、GUI 可视化编辑、GUI DSL 直编、CLI query 管理共用同一份 schema 与校验。（US-109t / US-219）
4. **Tab 是持久 Query**：不存在独立持久化的“current query”。运行时只有 tab saved query、tab draft、effective query。（US-109u）
5. **View 不拥有业务集合**：list / grid / week / month 只消费 Query 结果并提供对应操作；TODO、今日、未排期、已完成等都是 QueryPreset。（US-100 / US-109k）
5a. **过滤归属 area，不是全局 live state**：没有一份作用于整个 tab 的全局过滤运行时状态。每个 `list`/`grid` area 的过滤就是它自己的 `when`；图形过滤入口直接编辑该 area 的 `when`（落进 tab draft），与 DSL 直编同一份数据。**没有** tab 级 `filters` / 全局基础集——要整个 tab 都只看某状态，就在每个 area 的 `when` 里各写一遍。（US-109w / US-109x / US-109y / US-109z / US-109z2）
6. **GUI 与 CLI 共用业务层**：解析、筛选、summary、写回、嵌套、QueryPreset CRUD 都必须通过同一服务层，不允许 CLI 和 GUI 各自实现。（US-201~219）
7. **缓存是唯一读入口**：状态栏、看板、CLI 不直接扫 vault；所有任务读取经 TaskCache。（US-404）
8. **事件增量优先**：文件变更只重解析该文件；打开看板 / list / stats / hash disambiguation 才允许显式全量 ensure。（US-404）
9. **移动端不是降级桌面**：业务语义共用，交互适配层分离；移动端没有拖拽、dwell、hover、快捷键。（US-501 / US-507）
10. **可测试纯逻辑优先**：解析、Query、继承、summary、writer plan、CLI formatter 都应是无 DOM 纯逻辑。

## 1. 核心数据模型

### 1.1 ParsedTask

`ParsedTask` 表示 Markdown 中一行任务及其派生信息。

```ts
type TaskStatus = "todo" | "done" | "dropped" | "in_progress" | "cancelled" | "custom";

interface ParsedTask {
  id: string;              // stable id: "path:L42"，展示使用 1-based line
  path: string;
  line: number;            // 0-based
  hash: string;            // 标题 + 路径派生的短 hash，用于行号漂移找回

  rawLine: string;         // 原始整行
  rawTitle: string;        // checkbox 后完整内容
  indent: string;          // 空白 + callout prefix
  marker: "-" | "+" | "*";
  checkbox: string;

  status: TaskStatus;
  title: string;           // 去掉 Obsidian Tasks token / tag / inline field 后的标题
  tags: string[];          // 合法 hashtag，字面保留，含 #

  scheduled: string | null; // ⏳ 或 [scheduled:: YYYY-MM-DD]；两者都有时 ⏳ 优先
  deadline: string | null;  // 📅
  start: string | null;     // 🛫
  completed: string | null; // ✅
  dropped: string | null;   // ❌
  created: string | null;   // ➕
  recurrence: string | null;// 🔁 原样片段
  priority: string | null;  // 🔺⏫🔼🔽⏬ 原样片段

  inlineFields: Record<string, string[]>;
  durationFields: Record<string, number>; // 可解析为分钟的 inline field

  parentLine: number | null;
  childrenLines: number[];
  calloutDepth: number;

  mtime: number;
}
```

解析器必须忽略空标题任务，例如只有 `- [ ]` 的行不进入 Task Center。（US-107）

### 1.2 EffectiveTask

继承、终态、独立日期子任务属于派生层，不写入 `ParsedTask` 本身。

```ts
interface EffectiveTask extends ParsedTask {
  effectiveStatus: TaskStatus;
  effectiveScheduled: string | null;
  effectiveDeadline: string | null;
  effectiveCreated: string | null;
  terminalInheritedFrom: string | null; // ancestor id
  renderParentId: string | null;        // 当前 view 上是否嵌在父卡里
  isTopLevelInQuery: boolean;
}
```

`deriveEffectiveTasks(tasks)` 负责：

- 子任务继承父级未定义属性。（US-144）
- 父终态使未完成子任务继承完成 / 放弃状态。（US-145 / US-144a）
- 父可见时隐藏重复顶层子任务。（US-143）
- 子任务有不同 `⏳` 时拆成对应日期上下文的独立顶层卡。（US-148 / US-149）

### 1.3 QueryPreset

> 本节是 DSL 的 TypeScript 规格（架构事实源）。面向使用者、带配图与可运行示例的「怎么写」参考在 [`docs/dsl/zh.md`](docs/dsl/zh.md) / [`docs/dsl/en.md`](docs/dsl/en.md)；应用内「编辑 Query」的「DSL 文档」链接按 locale 指向对应语言页。

```ts
type TaskStateFilter = "todo" | "done" | "dropped"; // GUI 暴露这三个；解析器还接受 in_progress / cancelled / custom

type DateToken =
  | "all"
  | "today"
  | "tomorrow"
  | "week"
  | "next-week"
  | "month"
  | "unscheduled"
  | `${number}-${number}-${number}`
  | `${string}..${string}`;

interface QueryFilters {
  search?: string;
  tags?: string[] | string | { values: string[]; mode: "and" | "or"; exclude?: string[] } | { expr: string }; // 三态：values=包含组（数组/逗号串=AND，对象 mode 选与/或）+ exclude=排除组（US-109d3）；或 { expr } 自由布尔表达式（US-109d4）
  status?: TaskStateFilter[]; // undefined = 全部
  time?: {
    scheduled?: DateToken; // ⏳；unscheduled = is empty
    deadline?: DateToken | "overdue" | "next-7-days";
    completed?: DateToken;
    dropped?: DateToken; // 取消日期；DSL 归一化目前会剥除，预设里写了不生效
    created?: DateToken;
  };
}

// ── View = SwiftUI 式布局树：row / col 容器嵌套 area 叶子组件 ──
// 没有单一 view 类型，也没有 preset 判别字段。一个 view 是一棵布局树：
// 容器节点 row（≈ HStack）/ col（≈ VStack）排列子节点，叶子节点是 area
// 组件。旧的「view 类型」升级成「area 类型」：一个 view 不再只有一种类型，
// 而是可以自由组建多个 area（周视图 = col[ 网格, tray ]；未排期 =
// col[ 列表, 放弃 ]；用户也能 row[ 工作列表, 个人列表 ] 并排自定义）。
// 根节点可以直接是单个 area，不必包壳（今日 = 一个 list area）。渲染层
// 递归遍历布局树，逐个 area 派发到对应组件，不存在 today / completed /
// unscheduled 等专属渲染分支。（US-720 / US-109k / US-109f）

type LayoutNode = Stack | Area;

interface Stack {
  dir: "row" | "col"; // row ≈ HStack，col ≈ VStack
  children: LayoutNode[];
  weight?: number;    // 在父容器里占的伸缩比例，默认 1
}

type Area = ListArea | GridArea | WeekArea | MonthArea | DropArea | UnknownArea;
// grid：与 list 同字段同投影，卡片以响应式多列网格排列；二维分类（四象限）
// 用 row/col 嵌套多个带 title 的 grid 表达，没有专门的 matrix 类型。

// 卡片被拖入某个 area 时的写操作；三种语义互斥。
interface DropEffect {
  setStatus?: "dropped";      // 放弃区
  setScheduled?: DateToken;   // 写排期（week / month 日格隐式用当日）
  clearScheduled?: true;      // tray：清空被拖任务自己行的 ⏳
}

interface AreaBase {
  type: Area["type"];
  title?: string;
  weight?: number; // 在父容器里占的伸缩比例，默认 1
  onDrop?: DropEffect;
}

// list：用 when 筛出并渲染一列任务卡（无 tab 级 filters，过滤只在 area 自己的 when）。
// list 没有内部分组能力。「今日」那种「逾期 / 今日 / 未排期」三段，是用 col 容器
// 叠 3 个各自带 when 的 list area 表达（每个 area 自己 filter 自己），不是一个
// list 内部的 sections。TODO = 一个 list；今日 = col[ list, list, list ]；两者
// 用同一个组件，差异只在布局树。旧的 QuerySection / QueryTray 顶层概念已删，
// tray 也只是个 list area。
interface ListArea extends AreaBase {
  type: "list";
  when?: QueryFilters;
  orderBy?: string[];
  limit?: number;
  emptyText?: string;
}

// week / month：日期网格组件。日格内部自排布局，每个日格隐式
// onDrop:{ setScheduled: <当日> }。
interface WeekArea extends AreaBase {
  type: "week";
  firstDayOfWeek?: "monday" | "sunday";
}

interface MonthArea extends AreaBase {
  type: "month";
  firstDayOfWeek?: "monday" | "sunday";
  density?: "compact" | "cards";
}

// drop：纯动作落区，无 query；onDrop 必填。放弃区就是 drop area。
interface DropArea extends AreaBase {
  type: "drop";
  onDrop: DropEffect;
}

// unknown：归一化遇到不认识的 area.type（笔误，或已删除类型如旧 matrix）时
// 的兜底，保留原始类型与 JSON，视图层渲染「未知类型 + JSON」。
interface UnknownArea extends AreaBase {
  type: "unknown";
  rawType: string;
  raw: unknown;
}

interface QueryViewConfig {
  layout: LayoutNode; // 根节点：可以是 Stack，也可以直接是单个 area
}

interface QueryPreset {
  id: string;
  name: string;
  builtin: boolean;
  hidden: boolean;
  view: QueryViewConfig;     // 唯一分区：area 布局树。无 tab 级 filters、无 summary（US-109z2 移除）
}
```

Schema 约束：

- 一个 preset 只有 `view`（一棵 area 布局树）。**没有** tab 级 `filters`、**没有** `summary`（US-109z2 移除）：过滤只属于每个 list/grid/week/month area 自己的 `when`，写在顶层的 `filters` 会被静默忽略。
- 没有 view 类型枚举，也没有 `preset` 判别字段。view 行为完全由 `view.layout` 布局树决定，渲染层不得按 today / completed / unscheduled 等名字分支。（US-720 / US-109k）
- 内置 view 的布局（真实出厂见 `src/builtin-views/*.json`）：今日 = `col[ list(逾期), list(今日), list(未排期) ]`（每个 list 自带 `when`，与 TODO 同组件，差异只在布局树）；未排期 = `col[ list ]`；已完成 / 已放弃 = 单个 `list`；周 / 月 = `col[ week|month, row[ grid(tray), drop ] ]`；四象限 = `col[ row[grid,grid], row[grid,grid] ]`（带 title + when 的 grid，没有专门 matrix 类型）。状态等过滤都落在各 area 的 `when`，不是 tab 级。都是 area 组合，不是新 view 类型。（US-720 / US-103 / US-103a）
- 未排期 tray 是一个 `grid` area（卡片多列网格），数据来源是它自己的 `when`，不改变同一布局里 week / month area 的集合。（US-109j）
- 「改到明天」「清空排期」「放弃」是列表卡片与 drop area 的通用能力，不是某个 preset 的专属动作。（US-103 / US-123）
- `unscheduled` 属于 `time.scheduled is empty`，不是日期范围 token。（US-109e）
- View 配置不能硬编码业务分类；area 的 title 和 when 条件都来自 DSL。（US-109f / US-103a）
- 不被支持的 area `type` 不是错误：归一化成 `unknown` area（保留原始 JSON），视图层渲染「未知类型 + JSON」。（US-103c）

#### 1.3.1 布局树编辑算子（US-109p11）

`view.layout` 是用户可视化编辑的对象（Tab 面板「布局」小节 + 各 area head 的「编辑」）。所有结构改动做成**可测试的纯逻辑算子**，不在视图层手搓 `JSON.parse(JSON.stringify())` 改树。算子放在 `saved-views.ts`（或同层 `layout-ops.ts`），输入输出都是 `LayoutNode`，纯函数、不可变、不抛错（坏路径返回原树）：

- **定位**：`collectAreas(layout)` 已有，按 DFS 顺序枚举 area 叶子；视图层用 area 的 DFS 索引寻址（与 `setAreaWhen` / `setAreaTitle` 一致）。容器节点用从根出发的 `path: number[]`（children 下标序列）寻址。
- `updateAreaAt(layout, areaIndex, patch)`：改第 N 个 area 叶子的字段（`when` / `title` / `type` / `weight`）。**改 `type` 只换这一个叶子，保留 title / weight，不重建树**——修掉旧 `buildLayoutForAreaType` 重建整棵树的 bug。
- `insertArea(layout, path, index, area)` / `removeNode(layout, path)`：在某容器的指定位置插入 area，或删掉某节点；删到容器只剩 0 个孩子时容器一并塌掉，删到根为空时回退成单个默认 `list`。
- `wrapInStack(layout, path, dir)`：把某节点包进一层新 `row` / `col` 容器（搭四象限的原子操作）。
- `setStackDir(layout, path, dir)` / `moveNode(layout, fromPath, toPath, index)` / `setWeight(layout, path, weight)`：切排列方向、跨容器拖拽移动、调宽重。

视图层（拖拽 handler、按钮）只负责：取当前 tab draft 的 `layout` → 调算子得到新 `layout` → `tabDrafts.set(id, normalizeQueryPreset({...snapshot, view:{layout}}))` → 重渲染。这与 DSL 直编、area 过滤入口写的是**同一份 tab draft**，满足 US-109y（DSL 能改的 UI 也能改）。`normalizeQueryPreset` 在写回时把树校验 / 归一化一遍，保证非法结构不落库。

**两个编辑面板的数据流**（US-109p10）：编辑器面板抽到 `view/query-editor.ts` 的 `QueryEditorView` 类（不再堆在 view.ts）。`view.openQueryControlsSheet` 只是薄委托。按 scope 渲染——`scope:"tab"`（工具栏入口）渲染名称 / 布局树 / 管理 / DSL（顶部工具栏放保存与管理）；`scope:"area"`（area head 入口，带 `areaIndex`）渲染该 area 的过滤条件 / 外观。两个 scope 都只是同一份 tab draft 的不同投影，互不持有独立状态；DSL 只在 tab scope。**移动端**：同一套 `renderSheet`，shell 改成整页（`task-center-query-sheet` 用响应式 CSS 填满视口），不另写一套 UI（#10）。

#### 1.3.2 area 能力抽象（US-109z2）

area 的"能做什么"用 `areas.ts` 的 `AreaHandler` **类层级**统一描述，**不再**在 editor / projection / 渲染层散落 `if (type === "list" || type === "grid" ...)`（那种写法每加一个能力就漏掉 week/month）：

- `AreaHandler`（基类，默认最弱）→ `TaskAreaHandler`（list/grid/week/month 共享 `rendersTasks` / `filterable` / `editable`）→ `DateGridAreaHandler`（week/month，覆盖 `acceptsDrop`，每个日格隐式是改期落点）→ 各叶子类（`ListAreaHandler` 等）只覆盖 `icon` / `labelKey`；`DropAreaHandler` / `UnknownAreaHandler` 不渲染任务。
- `areaHandler(type)` 取处理器；`areaSupportsWhen(area)` = `areaHandler(area.type).filterable()`（唯一真源，narrow 到带 `when` 的 area 配置）。图标 / 文案 / 可编辑 / 可拖入 全部读 handler。
- **数据仍是纯 JSON**（`AreaConfig` 在 types.ts，DSL 可序列化）；行为在类里。**per-instance** 行为（同类型两个 area 不同的拖入语义，如未排期 tray = 拖入清空 ⏳）仍是 area 自己的 `onDrop` 数据，不进类。
- `week` / `month` 的 `AreaConfig` 也带可选 `when`（US-109z2），projection / GUI 渲染按 `when` 收窄；CLI `query-run` 与 view 覆盖也携带主 area 的 `when`。

### 1.4 TabState 与 Settings

```ts
interface RuntimeTabState {
  activeTabId: string;
  draftByTabId: Record<string, Partial<QueryPreset>>;
  viewCursorByTabId: Record<string, {
    weekStart?: string;
    month?: string;
    scrollTop?: number;
    expanded?: string[];
  }>;
}

interface PluginSettings {
  openBoardOnStartup: boolean;
  defaultTabId: string;
  firstDayOfWeek: "monday" | "sunday";
  forceMobileLayout: boolean;
  queryPresets: QueryPreset[];
  hiddenBuiltinTabIds: string[];
  lastActiveTabId?: string;
  stampCreatedByDefault: boolean;
  taskFormatFlavor: "tasks" | "dataview";
}
```

持久化设置必须兼容旧 `data.json` 字段；删除旧设置项时可忽略但不能导致启动失败。（US-118）

### 1.5 老数据迁移与升级闸门（US-414 / US-415）

新模型统一为 `QueryPreset`（只有 `view.layout` 布局树，过滤在各 area 的 `when`）。两类旧结构需要迁移：

- 扁平 `SavedTaskView`：无嵌套 `filters`，顶层有 `search/tag/time/status`。
- 旧 DSL 的 `QueryPreset`：`filters` 已嵌套，但 `view` 仍是旧写法 `{type, preset, sections, tray, matrix}`、没有 `layout`。

实现：

- 检测：`isLegacyQueryPresetShape(obj)` —— 命中 `isLegacySavedTaskView(obj)`，或 `view` 是非空旧 DSL 形状（无 `layout` 且含 `type/preset/sections/tray/matrix` 任一）即判定为旧结构。
- 迁移：`migrateLegacySavedTaskView(obj) → QueryPreset`（纯函数）把扁平字段收进 `filters`；旧 DSL view 由下游 `ensureBuiltinQueryPresets → normalizeQueryPreset → normalizeQueryPresetView` 的 `migrateLegacyViewToLayout` 迁成 `layout`。坏字段按默认值降级，不抛错、不中断加载。
- 内置视图：迁移后的旧内置项（`preset-*` id）进入 `ensureBuiltinQueryPresets`——保留用户的 name/hidden/排序，view 布局刷新成最新出厂 JSON。自定义项（`sv-*`）整体迁移并追加在内置之后。
- 闸门与时机：`loadSettings` 在内存里完成迁移并把检测计数记到 `plugin.migratedLegacyCount`，但**不**自动写回。只要该计数 > 0，`TaskCenterView.render()` 早退渲染全屏升级闸门页，不渲染看板——确保看板渲染路径只面对一种数据结构。用户点击闸门确认后调用 `plugin.completeMigration()`：`saveSettings()` 持久化、清零计数、刷新所有打开的看板进入新版 UI。
- 幂等：确认写回后，下次加载检测不到旧结构、计数为 0、闸门不再出现。用户不确认就退出则不写回，下次仍展示闸门。
- 边界：迁移只改本地 `data.json`，不触碰任务 Markdown（US-403）。

## 2. 模块边界

建议结构：

```text
src/
├─ parser.ts              # Markdown / Obsidian Tasks 行解析，纯函数
├─ task-tree.ts           # 父子关系、继承、独立日期子任务，纯函数
├─ query/
│  ├─ schema.ts           # QueryPreset 类型、默认预设、版本迁移
│  ├─ validate.ts         # GUI / CLI 共用校验
│  ├─ normalize.ts        # DSL 规范化、默认值填充
│  ├─ filter.ts           # filterTasks
│  ├─ summary.ts          # computeSummary
│  └─ presets.ts          # builtin preset factory
├─ cache.ts               # TaskCache，唯一 vault 读缓存
├─ writer.ts              # 单行 / 块级写回与 undo op plan
├─ api.ts                 # TaskCenterApi，GUI / CLI 共用业务入口
├─ cli.ts                 # CLI 参数解析与输出格式化
├─ view/
│  ├─ task-center-view.ts # ItemView 外壳
│  ├─ tabs.ts             # tab strip / menus
│  ├─ query-editor.ts     # 可视化 + DSL 编辑
│  ├─ filters.ts          # filter popovers
│  ├─ summary.ts          # summary render
│  ├─ views/list.ts
│  ├─ views/week.ts
│  ├─ views/month.ts
│  ├─ card.ts
│  ├─ source-dialog.ts
│  ├─ dnd.ts
│  ├─ mobile-actions.ts
│  └─ undo.ts
├─ quickadd.ts
├─ status-bar.ts
├─ settings.ts
├─ deps.ts                # Daily Notes / task-format companion 依赖健康
├─ dates.ts
├─ i18n.ts
├─ styles.ts?             # 若需要 TS class 常量，不放颜色
└─ main.ts
```

### 2.1 依赖规则

| 模块 | 可以依赖 | 禁止依赖 |
| --- | --- | --- |
| parser | 标准库、Obsidian 类型定义 | App、DOM、cache、writer |
| task-tree | ParsedTask、日期工具 | DOM、App |
| query | ParsedTask / EffectiveTask、日期工具 | DOM、writer、view |
| cache | parser、Obsidian App/Vault/MetadataCache | view、writer、cli |
| writer | parser、dates、Obsidian Vault process | view、cache |
| api | cache、writer、query、task-tree、settings store | DOM |
| cli | api、formatter、i18n | view、DOM |
| view | api、i18n、Obsidian UI | parser 直接扫 vault |
| status-bar | api/cache readonly、deps、i18n | writer、view |
| settings | settings store、query presets、deps | task writer |

任何模块若需要“所有任务”，必须通过 `TaskCenterApi.list()` 或 `TaskCache.ensureAll()` 间接获得，不能自行 `app.vault.getMarkdownFiles()`。

## 3. 读取与缓存

### 3.1 TaskCache 职责

```ts
interface FileEntry {
  path: string;
  mtime: number;
  hasTaskListItem: boolean;
  tasks: ParsedTask[];
}

class TaskCache {
  ensureFile(path: string): Promise<FileEntry>;
  ensureAll(options?: { signal?: AbortSignal }): Promise<ParsedTask[]>;
  flatten(): ParsedTask[];
  invalidateFile(path: string): void;
  removeFile(path: string): void;
  renameFile(oldPath: string, newPath: string): void;
  resolveRef(ref: TaskRef): Promise<ParsedTask>;
  onChanged(cb: (change: CacheChange) => void): () => void;
}
```

缓存维护：

- `byPath: Map<string, FileEntry>`。
- `byHash: Map<string, ParsedTask[]>`。
- `flattenCache: ParsedTask[] | null`，文件变更后标脏。
- `pendingParseByPath` 防止同一文件并发重复解析。

### 3.2 事件路径

```text
Obsidian vault/metadata event
  → TaskCache.invalidateFile(path)
  → 单文件解析完成
  → 更新 byPath / byHash / flattenCache
  → emit cache.changed(paths)
  → status-bar / open views / tests 订阅刷新
```

只有 `cache.ts` 订阅原始 vault / metadata 事件。view、status-bar、CLI 不订阅 `metadataCache.on("resolved")`，也不直接重扫。（US-404）

事件策略：

| 事件 | 处理 |
| --- | --- |
| modify | eager 重解析该文件 |
| create | 如果是 markdown，解析该文件 |
| delete | 移除该 path 的缓存与 hash 索引 |
| rename | 更新 path；必要时重解析新文件 |
| metadata changed | 只 invalidate 对应文件 |

### 3.3 全量 ensure 的边界

允许触发 `ensureAll()` 的路径：

- 用户打开看板且当前 query 需要全集。
- CLI `list` / `stats`。
- hash ref 解析且当前 hash 索引无法证明唯一。
- Query 编辑器需要候选 tag / field 统计。

不允许触发 `ensureAll()` 的路径：

- 插件 onload。
- 状态栏首次渲染。
- 单个写命令的 `path:Lnnn` ref。
- 每次 metadata resolved。

大 vault 启动时状态栏可以在缓存未全量化前显示部分计数；打开看板后全量化并变准确。这是避免“启用插件即卡住”的设计取舍。（US-404）

### 3.4 文件筛选与并发

`ensureAll()` 遍历 markdown 文件时，先看 `metadataCache.getFileCache(file)`：

- 已索引且明确没有 task list item：跳过。
- 未索引或未知：解析文件，不能当作无任务。
- 有 task list item：解析文件。

解析并发限制为固定池（默认 16 或 32，可根据测试调整）。单文件解析失败只记录 warning 和 stats，不让整个 vault 空白。

## 4. Query 执行管线

### 4.1 主流程

```text
TaskCache.flatten()
  → parse-level ParsedTask[]
  → deriveEffectiveTasks()
  → applyViewProjection(view)                // 每个 task-rendering area 用自己的 when 收窄
  → render surface / CLI format
```

过滤只有一层且归属于 area：在 `applyViewProjection` 里，每个 `list`/`grid`/`week`/`month` area 用自己的 `when` 从有效任务全集投影。area head 的编辑入口写的就是这份 `when`，进入 tab draft，与 DSL 直编同源。不存在 tab 级 `preset.filters` 或第三层全局 live filter；空状态由各 area 自己按 `when` 归因。（US-109w / US-109z2 / US-109b1）

### 4.2 Filter 语义

`applyQueryFilters` 必须按用户故事实现：

- `search`：标题关键字匹配。
- `tags`：合法 hashtag。包含组（`values`）默认 AND、可切 OR；对象形态可带 `exclude` 排除组。匹配 = （包含组为空，或按 `mode` 命中）且（`exclude` 一个都不命中）。归一化：纯 AND 且无 `exclude` → 收敛成裸数组 `string[]`，否则用 `{values, mode, exclude?}` 对象形态。（US-109d2 / US-109d3）
- `tags` 的第三形态 `{ expr: "…" }`：自由布尔表达式（`#tag` / `and` / `or` / `not` / 括号；关键字大小写不敏感；优先级 `not`>`and`>`or`；`#` 可省略）。`src/query/tag-expr.ts` 的 `parseTagExpr` 把字符串解析成 AST（纯逻辑、可单测）；`normalizeQueryFilters` 解析**一次**存进 `NormalizedQueryFilters.tagExpr`，再对每个 task 用 `evalTagExpr(ast, task.tags)` 求值——不每条任务重解析。解析失败（语法错误 / 空）→ 该 area **不做标签过滤**（fail-open），GUI 就地标红，不静默丢任务。三态与 `{expr}` 互斥，是同一份 `when.tags` 的两种形态。（US-109d4）
- `status`：todo / done / dropped 多选；undefined 表示全部。
- `time.scheduled`：只看有效 `⏳`；`unscheduled` 表示有效排期为空。
- `time.deadline`：只看 `📅`；`overdue` 属于 deadline。
- `time.completed`：只看 `✅`。
- `time.dropped`：只看 `❌`。
- `time.created`：只看 `➕`。

所有日期比较都使用 ISO `YYYY-MM-DD` 规范化；显示层再按 locale 格式化。（US-411）

#### 4.2.1 刚完成任务的 status 过滤豁免（US-153）

为支撑"点 ✔ 后卡片原地停留、重进 view 才消失"，`applyQueryFilters` 接受一个可选的纯参数 `exemptStatusIds: ReadonlySet<string>`：

- 语义：若 `task.id ∈ exemptStatusIds`，该任务**跳过 status 过滤**（其它过滤——search / tags / time——照常生效）。这让一条 `done` 任务能临时留在一个 `status: todo` 的集合里，而不破坏其它筛选条件。
- 纯函数：豁免集合作为入参传入，`applyQueryFilters` / `projectListArea` 不持有任何会话状态；不传时退化为原行为，CLI / summary / badge 计数一律不传，因此完全不受影响。
- 会话状态归属 view 层：`TaskCenterView` 维护 `justCompletedIds: Set<string>`（仅当前 view 会话），投影每个 area 的 `when` 时传给 `applyQueryFilters` / `projectListArea`。内置今日 / TODO / 已完成的状态条件同样都在各自 area 的 `when` 中。
- 加入时机：用户在卡片上点 ✔ **切换任意方向的状态**（todo → done 或 done → todo）时，把它的 id 加入集合，并走"原地变切换后状态"的局部重渲（不播放 animateOut、不移除卡片）。两个方向都加入、都不移除，因此对称——无论变 done 还是变 todo，卡片都跳过该次过滤而停留（一条刚 undone 的 `todo` 任务也能临时留在 `status: done` 的"已完成"集合里）。
- 清空时机（= "重新进入 view"）：`onOpen`（整页加载）、`applySavedView`（切 tab / 激活 saved view）、`scheduleRefresh`（cache changed 触发的整表刷新）三处清空 `justCompletedIds`。**注意**：完成切换自身触发的局部重渲不清空集合，否则刚完成的卡又会立即被过滤掉。

### 4.3 View Projection

View projection 不再筛选业务集合，只把 query 结果投影成渲染模型。它递归遍历 `view.layout`：容器节点（row / col）投影成 `StackModel`，叶子 area 各自投影成对应的 area model。

```ts
type LayoutModel = StackModel | AreaModel;

interface StackModel { kind: "stack"; dir: "row" | "col"; weight: number; children: LayoutModel[]; }

type AreaModel =
  | { kind: "area"; type: "list"; weight: number; tasks: EffectiveTask[]; onDrop?: DropEffect }
  | { kind: "area"; type: "week"; weight: number; days: DayColumnModel[]; onDrop?: DropEffect }
  | { kind: "area"; type: "month"; weight: number; cells: MonthCellModel[]; onDrop?: DropEffect }
  | { kind: "area"; type: "drop"; weight: number; onDrop: DropEffect }
  | { kind: "area"; type: "unknown"; weight: number; rawType: string; raw: unknown };
```

- 容器：row / col 决定子节点横向 / 纵向排列，`weight` 决定伸缩比。
- List：用 area `when` 从有效任务全集收窄，投影成一列扁平任务（无内部分组）。今日与 TODO 走同一条 list 投影，差异只在 DSL——今日是 col 叠 3 个各自带 `when` 的 list。
- Week：按有效 `scheduled` 落入 7 天；无有效 scheduled 不进日期区。移动端折叠状态只影响 day row body 可见性，不改变 day model。
- Month：按有效 `scheduled` 落入月历日期格；移动端只改变渲染密度，并把当前选中日期的任务列表作为月历下方内联 panel 渲染。
- Grid：与 List 同投影，只是渲染成响应式多列网格；四象限由 row/col 嵌套多个带 title + when 的 grid 组成。
- Drop：纯落区，无数据投影，只携带 `onDrop`。
- Unknown：不被支持的 area 类型，渲染「未知类型 + 原始 JSON」，不参与任务投影。

### 4.4 Summary

`computeSummary(tasks, metrics)` 对过滤后的集合计算：

- count。
- sum(field)：读取 `durationFields[field]` 或可解析的 inline field。
- ratio(numerator, denominator)。
- top-n(by)：tag 或用户字段。
- group-by(by)。

字段名是用户配置，不允许视图层硬编码 `estimate` / `actual` 分支；默认 preset 可以使用这些字段名作为配置值。（US-302 / US-303）

### 4.5 移动端布局适配层

View 层负责把同一份 Query / ViewModel 投射成桌面或移动端 DOM，不允许通过移动端分支改变任务集合、Query DSL 或写回语义。（US-109k / US-117）

**移动端 area 单开手风琴（US-511 / US-511a）**：`renderLayoutNode` 在移动布局下把 layout 树里的每个内容 area 包成可折叠节，复用既有 `renderAreaHead`（标题 + 计数 / 导航 + 编辑入口）当 head，点 head 展开 area body 并收起其它（exclusive）。它是**纯渲染 / DOM 适配层**：不改 `view.layout`、不改任务投影、不写 tab draft——只决定哪个 area 的 body 可见。展开态键（哪个 area 打开）是会话态（§7.1 `expandedAreaByTab`），不持久化；默认首个内容 area。area 内部既有折叠（week 7 日行 `expandedDays`、month `selectedMonthDay`）不受影响。容器（row/col）在移动端退化为竖排手风琴；`drop` 等桌面专属 area 在移动端本就不渲染。手风琴容器贴合页面可用宽度，展开 body 左右各留 8px 层级槽（CSS 在 `mobile.css`，`[data-mobile-layout="true"]`）。桌面端不进此分支，多 area 同时铺开。

**桌面 pane 自适应（US-514 / US-515）**：视图外壳通过 `ResizeObserver` 读取 `contentEl` 自己的宽度并映射为 presentation width band；不得用 `window.innerWidth` 代替 pane 宽度。只有跨 band 时才调度重渲，普通像素抖动只更新 CSS metrics。紧凑 pointer pane 不复用 `data-mobile-layout="true"`，否则会错误关闭 draggable / tab 排序 / 快捷键并把卡片点击改成移动 sheet。

- `wide`：week 7 列、month 格内 mini-card、row 布局与方形 drop area。
- `compact`：week 日期键 + 选中日 outline；month 负载月历 + 选中日 outline；row 视觉纵排；drop area 紧凑横条。日期键 / 月格仍调用同一 `makeDropZone`，保留 pointer 改期。
- `narrow`：沿用移动端手风琴与触控排版；是否启用 swipe / long-press 仍只看 `modality`。

calendar 的 `selectedDay` 是 view 会话态：week 与 month 都记住当前选中日期，跨 `wide ↔ compact` 不修改 Query DSL、不丢 tab / anchor；选中日期离开当前范围时回退到 today（若在范围内）或范围第一天。

**移动端首屏精简（US-512）**：移动布局下渲染调度根**不调用** `renderFooter`（底部统计行）与 `renderMobileActionBar`（未排期 / + 新建 条）。未排期 tray 仍是 layout 里的一个 area，由手风琴呈现；新建任务入口收敛为顶部 toolbar 的一个「+」→ 打开 Quick Add bottom sheet（US-509 / US-169）。桌面端 Footer 不受影响。

移动端布局状态分两层：

- `data-pane-layout="wide|compact|narrow"`：只描述 `contentEl` 可用宽度，驱动 calendar / row / drop / tabs 的排版，不改变输入能力。
- `data-mobile-layout="true"`：真实移动设备或用户强制移动布局，用于移动端手风琴、触控工具栏与 sheet 排版；窄桌面 pane 不设置该值。
- `data-obsidian-mobile="true"`：真实 Obsidian Mobile 环境，用于额外预留 Obsidian 底部工具栏避让空间。窄屏桌面不能自动套用这层底部避让。

`BottomSheet` 是移动端复杂操作的共享 shell，但调用方可以传入语义 class，使 Query 编辑、父任务选择、日期选择、任务动作 sheet 使用不同高度和 footer 策略。sheet 只能承载视图适配和交互编排；筛选、summary、嵌套、写回仍调用既有 query / writer / api 路径。

**Query 编辑器是两个独立面板（US-109p10）**：`openQueryControlsSheet({ scope, areaIndex?, initialTab? })` 在 `BottomSheet` 里按 scope 渲染（桌面、移动同一套 DOM，只是外层 sheet class 不同）。两个 scope 投影同一份 tab draft，互不持有独立状态：

- **Tab 面板**（`scope:"tab"`，工具栏 / tab 菜单 / 摘要入口，`areaIndex=null`）：`renderTabEditor` 渲染 `data-query-editor-scope="tab"`，包含名称、布局树（`data-query-layout`，接 §1.3.1 算子）、保存与管理（`renderSavedViewsActionControls`）与 DSL（`data-query-dsl-input`）；不出现过滤控件。
- **Area 面板**（`scope:"area"`，area head 的 `bt-area-edit` 入口，带 `areaIndex`）：`renderAreaEditor` 渲染 `data-query-editor-scope="area"` + `data-query-editor-area=<idx>`，顶部面包屑（`data-action="back-to-tab"` 回 Tab 面板），下面 area 级两 tab（`data-area-tab="filter|appearance"`）——本区过滤（`renderAreaFilterControls` + `setAreaWhen`，`data-filter-section="area"`；drop 无 `when`，其余 task-rendering area 均支持）、外观（标题 `areaTitleByIndex`/`setAreaTitle` + 类型）。

`queryEditorScope` / `queryEditorAreaIndex` / `queryEditorTab`（或 area 子 tab `queryEditorAreaTab`）存在实例字段上，跨重渲染保留；切面板 / 切 tab 不重置 tab draft、不丢 DSL 校验错误位置。DSL 只在 Tab 面板（它编辑整份 preset）。

**统一 area head（US-109p9）**：所有内容 area（list / grid / week / month / 四象限 / 未排期 tray）共用一个 `renderAreaHead(parent, areaIndex, area, {title})`：渲染 `bt-area-head`（标题 + 右侧），并为每个可查询 area 渲染一个安静的 `bt-area-edit` 按钮（`data-area-edit=<idx>`、`data-action="edit-area"`、图标 `sliders-horizontal`）。按钮不因 `when` 高亮或挂摘要，避免把 area 自身的固有条件渲染成告警。点按钮 → `openQueryControlsSheet({ scope:"area", areaIndex, initialTab:"filter" })`。`renderWeek`/`renderMonth` 保留各自范围导航；纯 drop 区不显示编辑按钮。

**area head 入口打开 Area 面板（US-109p9 / US-109p10）**：`renderAreaHead` 的 `bt-area-edit` 按钮点击 → `openQueryControlsSheet({ scope:"area", areaIndex, initialTab:"filter" })`。Area 面板的本区过滤 tab 用 `areaWhenByIndex(areaIndex)` 取该 area 的 `when`（list/grid/week/month 均返回条件，drop 返回 null）；外观 tab 渲染标题输入框（`areaTitleByIndex` / `setAreaTitle`，空则清除回退内置本地化标题）+ 类型按钮（调 `updateAreaAt(layout, areaIndex, {type})`，**只换这一块**）。`type` 切换不再走重建整棵树的旧 `buildLayoutForAreaType`（删除）。

父任务选择的候选数据来自已缓存的 EffectiveTask 集合和当前 DOM 可见任务 id。排序、搜索、禁用当前任务及后代都在 view 层完成；真正嵌套写回仍通过 `api.nest(childId, parentId)`。

## 5. 写路径

### 5.1 Writer 不变量

所有写操作走 `app.vault.process(file, mutate)`，保证单文件原子写。（US-403）

`writer.ts` 提供纯规划函数和执行函数：

- `setEmojiDate` / `clearEmojiDate`。
- `setCheckbox`。
- `addTag` / `removeTag`。
- `setInlineField`。
- `renameTaskLine`（CLI/API 用；GUI 标题编辑走源 Markdown 编辑层）。
- `planSameFileNest`。
- `planCrossFileNest`。
- `appendTaskToDailyNote`。
- `applyUndoOps`。

Writer 只修改目标 token：

- 改期只替换 / 插入 / 删除该行自己的 `⏳`。
- 清空排期只清空该行自己的 `⏳`，不改继承来源。
- 完成写 `[x]` 和 `✅ YYYY-MM-DD`。
- 放弃写 `[-]` 和 `❌ YYYY-MM-DD`。
- 同父级同日创建的子任务不重复写 `➕`。（US-146）

### 5.2 幂等与 before/after

每个写动词返回：

```ts
interface WriteResult {
  ok: true;
  unchanged: boolean;
  before: string[];
  after: string[];
  undoOps: UndoOp[];
}
```

如果目标状态已满足，返回 `unchanged: true`，不写文件；CLI 格式化为 `ok … unchanged`。（US-203 / US-204）

### 5.3 行号漂移与 ref 解析

```ts
type TaskRef =
  | { kind: "line"; path: string; line0: number }
  | { kind: "hash"; hash: string };
```

`resolveRef` 规则：

- `path:Lnnn`：先解析该文件并检查行号。
- 若行号不再是同一任务，尝试用 hash 找回；找回则返回 warn `out_of_date`。
- hash 多候选返回 `ambiguous_slug` + 候选列表，绝不猜。（US-208 / US-214）
- 找不到返回 `not_found`。

Writer 在 `vault.process` 内再次校验目标 rawLine，防止读取后被外部修改。

### 5.4 嵌套

GUI 拖拽嵌套与 CLI `nest ref=A under=B` 共用同一函数。（US-125 / US-228）

语义：

1. 解析被移动任务整棵子树。
2. 拒绝移动到自己或后代。（US-126）
3. 把子树物理移动到目标父任务所在位置。
4. 重新缩进为目标父级子任务。
5. 清空被移动 root 自己行的 `⏳`。
6. 保留所有子孙任务自己的 `⏳` / emoji / inline fields / tag / 原文。

跨文件没有真正事务。策略：先写 parent 文件，再写 child 文件。若第二步失败，宁可产生可见重复也不丢任务；返回 `nest_partial` 并提供可撤销 parent 插入的 undo op。

### 5.5 Quick Add 写入

Quick Add / CLI add 的默认路径由 Daily Notes 依赖解析：

```text
Daily Notes enabled + folder configured
  → today daily note path
  → append `- [ ] title ➕ YYYY-MM-DD [tokens...]`
```

Daily Notes 不可用时，add 失败并保留输入；不写 fallback 文件。（US-163 / US-701）

任务格式读取固定兼容 Tasks emoji 与 Dataview bracket inline fields：日期字段映射为 `⏳`/`[scheduled::]`、`📅`/`[due::]`、`🛫`/`[start::]`、`➕`/`[created::]`、`✅`/`[completion::]`、`❌`/`[cancelled::]`，并读取 `🔁`/`[repeat::]` 与 priority emoji / `[priority::]`。若同一字段两种格式并存，Tasks emoji 是有效来源。写回由 `settings.taskFormatFlavor` 决定：`tasks` 写 emoji 字段，`dataview` 写 bracket inline fields。`setScheduled` / `setDeadline` / `markDone` / `markDropped` / `addTask` 是格式敏感写入入口；写入某一字段前必须清理该字段的另一种语法，清空排期则同时清理 `⏳` 与 `[scheduled::]`，避免读取优先级导致旧日期继续生效。（US-111 / US-407 / US-409）

`stamp-created=true|false` 由 CLI 单次参数覆盖全局默认。（US-213）

## 6. Undo

```ts
interface UndoOp {
  path: string;
  line: number;
  before: string[];
  after: string[];
}

interface UndoEntry {
  label: string;
  ops: UndoOp[];
}
```

Undo 栈：

- 只属于看板 UI；CLI 写不入栈。
- 深度 20。
- 关闭 leaf / 重启后清空。
- 应用撤销前对目标区域做内容比对：当前文件中的 `after` 必须仍在原位置；否则拒绝撤销并提示内容已外部修改。

`Ctrl/Cmd+Z` 只在当前 active leaf 是 TaskCenterView 且 undo 栈非空时拦截；其它情况下交给 Obsidian 编辑器处理，避免破坏笔记编辑撤销。（US-128）

## 7. GUI 架构

### 7.1 外壳职责收敛（TaskCenterView 拆解后保留什么）

`TaskCenterView`（`src/view.ts`）拆解后**只**保留三类不可外抽的职责，对应 REFACTOR.md shell-core 核验结论 `extractability: hard-keep-in-shell`——它就是外壳本身，不是某个可独立单测的纯逻辑簇，把它"搬出去"会把 ItemView 生命周期 / cache 订阅 / DOM 反向倒挂，是负收益。

**(1) per-tab cursor 状态的唯一持有与持久化。** 这些字段是外壳独占的状态真相源，外部子模块**绝不**直接读写，只能经 §7.6 的 Port 间接访问：

- `state: ViewState`（`view/state.ts:6`）：`tab / anchorISO / filter / savedViewId / savedViewTag / savedViewTime / savedViewStatus / expandedDays / selectedMonthDay / collapsedWeeks / showUnscheduledPool / selectedTaskId / expandedAreaByTab`。其中 `expandedAreaByTab`（`Record<tabId, areaIndex>`，US-511）记录移动端各 tab 当前展开哪个 area，会话态、不持久化；缺省回退首个内容 area。
- `tabDrafts: Map<string, QueryPreset>`（per-tab 草稿，§1.4 `draftByTabId` 的运行时实现）。
- `justCompletedIds: Set<string>` + `skipNextRefreshClear`（US-153 linger 状态机，§4.2.1）。
- `tasks / _effectiveTasks / _taskIndex`（数据基线与派生缓存）。

**(2) 生命周期与 cache 事件接线。** 强绑 `ItemView` / `contentEl` / `leaf`，外壳独占，无可抽的窄接口：

- `onOpen`（`view.ts:349`）：建占位 → `reloadTasks` → `bumpCacheVersion` → `render`；订阅 cache `'changed'` / keydown / pointerdown(capture) / `window.resize` / `ResizeObserver` / css-change；会话开始清 `justCompletedIds`。
- `onClose`（`view.ts:418`）：拆线（`refreshTimer` / `cacheUnsub` / `ResizeObserver` / `dwellTracker`）。
- `scheduleRefresh`（`view.ts:432`）：400ms 防抖全量刷新，cache `'changed'` 的唯一落点。
- `reloadTasks`（`view.ts:623`）/ `getEffectiveTasks`（`view.ts:647`）/ `waitForCacheUpdate` / `bumpCacheVersion` / `__forFlush`：数据-渲染-缓存闭环。

**(3) 组合根（Composition Root）。** 这是本次重构给外壳新增的核心定位：外壳**实现**各 Port（§7.6–§7.9），把 Port 实现**注入**各 view/ 子模块，并路由顶层事件。具体三件：

- **渲染调度根**：`render`（`view.ts:686`）→ 迁移门 gate → 建 `_taskIndex` → `applyMobileLayoutAttr` → `renderTabBar` / `renderMobileStatusRow` / `renderToolbar` / `renderViewLayout`（`view.ts:3024`）→ `renderLayoutNode`（`view.ts:3042`，layout 树 DFS 分派 area；移动端把 area 包成单开手风琴 §4.5）→ Footer / `renderMobileActionBar`（**移动端两者都不渲染**，§4.5 US-512）。这些**调用**各子模块，不被子模块调用，没有可抽的窄接口，按定义留外壳。
- **注入点**：渲染调度时把 `CalendarRenderPort` / `CardRenderPort` / `SavedViewMutationPort` / `TaskActionsPort` / `PresentationCtx`（§7.7）的实例传给对应子模块函数，取代现在传 `this`。
- **api / projectArea 调用**：所有 mutation 经 `this.api.*`（done/undone/schedule/drop/nest/tag），所有投影经 `query/projection.ts` 的 `projectArea`。外壳不直接解析 vault、不手写 writer mutation（§2.1）。

> **判据**：一个方法若"被各 area/card 子模块调用、且不绑 ItemView 生命周期"，它应收成 Port 成员暴露；若"调用子模块、或绑 contentEl/leaf/cache 订阅"，它留外壳。`render` / `onOpen` / `reloadTasks` 属后者；`getEffectiveTasks` 的**结果**经 Port 暴露但**所有权**留外壳。

### 7.2 Query Editor

Query Editor 操作 `draftByTabId[activeTabId]`：

```text
visual controls → update draft → validate → effective query → render preview
DSL editor     → parse/validate → update same draft → controls rehydrate
```

保存动作：

- `updateCurrentTab(tabId)`：覆盖 saved query。
- `saveAsNewTab(effectiveQuery, sourceTabId?)`：创建新 id；`sourceTabId` 只用于复制来源元数据或默认命名，不改变用户语义。
- `discardDraft(tabId)`：删除 draft。

**切 tab 的分支（US-109s / US-513）**：`activateSavedView` 在切换前看平台——桌面端保留旧行为（dirty 时弹「更新 / 另存为 / 丢弃」`SwitchTabConfirmModal`，否则 `persistCurrentDraft` 把 draft 留在原 tab）；移动端直接 `discardDraft(current.id)` 并 `applySavedView(target)`，不弹确认、不跨 tab 留 draft。

不实现单独的 `saveTab()` / `saveCurrentQuery()` 用户动作。无来源 query 的首次保存也调用 `saveAsNewTab`，因为用户结果同样是“创建一个新的 Query Tab”。所有动作走 `QueryPresetService`，CLI query 动词调用同一个 service。

### 7.3 Source Markdown 编辑层

点击卡片调用：

```text
TaskCenterView.openSourceEditor(taskId)
  → api.resolveTask(taskId)
  → SourceDialog.open(task.path, task.line)
  → 使用 Obsidian 编辑器能力定位任务行
  → 文件保存 / modify event
  → cache invalidate
  → view refresh 后保持原 tab / filter / scroll
```

SourceDialog 不实现自己的 Markdown parser/writer，不用 textarea 冒充完整编辑体验。若 Obsidian public API 无法安全嵌入原生 MarkdownView，必须记录降级边界并保留后续修复任务；不能把只读 preview 当完成。（US-168f）

桌面端 `SourceDialog` 可以通过临时 `WorkspaceLeaf` 承载真实 `MarkdownView`。移动端不复用该 overlay：`TaskCenterView.openSourceEditShell()` 在移动布局下调用 Obsidian 官方 `WorkspaceLeaf.openFile()` 打开源文件，并在 `MarkdownView.editor` 上设置 cursor / scrollIntoView 定位任务行。这样移动端的键盘、安全区、编辑滚动和返回行为都交给 Obsidian 原生编辑器处理。（US-168g / US-506）

桌面端 `SourceDialog` 的“打开（新标签页）”动作先保存并释放 overlay 内的临时 `MarkdownView`，再通过 `workspace.getLeaf("tab").openFile(file, { active: true, eState: { line } })` 打开 Obsidian 原生 Markdown 标签页，并复用同一套 cursor / scrollIntoView 定位逻辑。该动作不恢复 Task Center leaf 焦点，因为用户已明确选择离开浮层进入原文标签页。（US-168h）

移动端 tag 编辑是视图层的差异化输入面板：从 `EffectiveTask.tags` 和当前任务集合推导当前 / 候选 tag，保存时对比初始集合，依次调用 `TaskCenterApi.tag(id, tag)` 或 `TaskCenterApi.tag(id, tag, true)`。写回仍由 writer 做字节级最小修改，不在视图层解析整行 Markdown。（US-506b / US-409）

移动端父任务选择器是视图层的差异化选择面板：候选来自当前 `TaskCache` 派生出的任务集合，按当前视图、同文件和搜索结果分组展示。选择器只返回目标父任务 id，不直接改 Markdown；确认后仍调用 `TaskCenterApi.nest(childId, parentId)`，由 writer 共用桌面 / CLI 的嵌套 planner，保证跨文件移动、清空被移动 root 自己 `⏳`、保留子孙字段和 undo 操作一致。（US-507b / US-125 / US-228）

旧入口必须删除：hover popover、dblclick 打开源文件、右键打开源文件、卡片 inline title input。（US-168d / US-161）

### 7.4 DnD Controller

`view/dnd.ts` 只负责桌面拖拽状态机：

- drag start threshold。
- drop target hit test。
- tab dwell。
- 落点优先级。
- 调用 API 写动作。
- 入 undo 栈。
- 动画 class 编排。

移动端不加载拖拽行为；移动端动作由 `mobile-actions.ts` 调用同一 API。（US-501 / US-507）

### 7.5 DOM 选择器契约

E2E 和 UI 自动化依赖稳定 `data-*`，不依赖 CSS 类名或文案：

| 选择器 | 含义 |
| --- | --- |
| `[data-task-id="path:Lnnn"]` | 卡片或子任务行 |
| `[data-tab-id="<query-id>"]` | Query tab |
| `[data-date="YYYY-MM-DD"]` | week 列 / month 日期格 |
| `[data-view="list|grid|week|month|unknown"]` | view body |
| `[data-query-editor]` | Query 编辑器面板根 |
| `[data-query-tab="filter|summary|view|dsl"]` | Query 编辑器 Tab 按钮 |
| `[data-query-dsl-input]` | Query 编辑器 DSL 直编输入框 |
| `[data-drop-zone="abandon"]` | 桌面放弃目标区 |
| `[data-drop-zone="unscheduled-tray"]` | 未排期 tray |
| `[data-card-action="open|done|drop|menu|reschedule-tomorrow"]` | 卡片动作 |
| `[data-parent-picker]` | 移动端父任务选择器 |
| `[data-parent-candidate-id="path:Lnnn"]` | 父任务候选行 |
| `[data-parent-confirm]` | 父任务选择确认按钮 |
| `[data-dep-warning="task-format-companion-missing|task-format-companion-disabled"]` | Tasks / Dataview companion 依赖警告 |
| `[data-test-cache-version="n"]` | cache 刷新版本 |

变更这些契约必须同步改 e2e。

### 7.6 view/ 目标模块树与 Port 归属

剩余大簇按真实核验切分落点如下。**关键纠偏**（来自核验）：manage-tabs 表面依赖 ~20 个内部方法是"切错了边界"——那 20 个里大半是 saved-view CRUD **动词**，属另一个内聚簇；manage-tabs UI 本身只需 ~7 个窄成员。因此先抽 `saved-view-actions`，再抽 `manage-tabs` 让它依赖前者的 Port，避免被迫把 11 个动作临时改 public（= 把耦合挪到类外）。

| 模块（落点） | 职责 | 依赖的 Port | 状态 | 主要符号（view.ts 行号） |
| --- | --- | --- | --- | --- |
| `view/render/calendar.ts` | week/month 时间轴渲染、范围导航、移动端选中日 panel | `CalendarRenderPort`（§7.7）+ `PresentationCtx` | 待抽 needs-port | `renderWeek` 2262 / `renderMonth` 2438 / `renderRangeNav` 1324 / `renderMobileMonthDayPanel` 2556 / `scopeTasksToArea` 2256 |
| `view/render/calendar-grid.ts` | **纯逻辑**：`buildWeekDays(anchorISO,weekStartsOn)` / `buildMonthGrid(...)` / `columnStats` | 无（纯函数，禁 DOM，§2.1） | 可立即抽 **clean** | `columnStats` 2367（已纯，仅 import `formatMinutes`）；网格计算现内联于 `renderWeek`/`renderMonth` |
| `view/render/card.ts` | 卡片/子卡 DOM 结构、父子展开、事件 wiring、移动手势接线 | `CardRenderPort`（§7.7）+ `PresentationCtx` | 待抽 needs-port | `renderCard` 3311 / `renderSubcard` 3499 / `wireCardEvents` 3661 / `renderTaskTags` 3573 |
| `view/saved-view-actions.ts` | saved-view CRUD 编排（创建/复制/重命名/删除/隐藏/默认/恢复/激活/重排/保存当前） | `SavedViewMutationPort`（§7.8）+ `SavedViewPromptsPort` | 待抽 needs-port | `copySavedView` 1902 / `setDefaultSavedView` 1913 / `reorderQueryTab` 1930 / `renameSavedView` 1936 / `toggleSavedViewHidden` 1960 / `deleteSavedViewWithConfirm` 2003 / `restoreBuiltinSavedView` 2127 / `saveCurrentView` 3990 |
| `view/manage-tabs.ts` | Manage Tabs 面板 UI（行渲染 + kebab 菜单 + 拖拽重排路由） | `SavedViewPanelPort`（§7.8，是 `SavedViewMutationPort` 的 UI 投影） | 待抽 needs-port（依赖前者先抽） | `renderManageTabsSheet` 1741 / `openManageTabRowMenu` 1864；容器 `openManageTabsSheet` 1718 留外壳 |
| `view/tabbar.ts` | tab 条 + tab 按钮渲染 + 溢出入口 | `TabBarPort`（§7.9） | 待抽 needs-port | `renderTabBar` 804 / `renderTabButton` 987 |
| `view/tab-overflow.ts` | **几乎自洽**：tab 溢出几何测量 | 无（持 4 个私有字段 + 纯函数 `fitTabCountFromWidths`） | 可优先抽 **clean** | `scheduleTabOverflowMeasure` 915 / `handleTabbarOverflowResize` 977 |
| `view/toolbar.ts` | 查询工具条 + saved-view 动作按钮组 | `SavedViewMutationPort`（与 manage-tabs 共享）+ `PresentationCtx` | 待抽 needs-port | `renderToolbar` 1363 / `renderSavedViewsActionControls` 1468；`renderMobileStatusRow` 746 / `renderMobileActionBar` 765（无状态展示，独立小函数） |
| `view/source-actions.ts` | 源编辑入口分流 + 移动动作派发 + context menu + date prompt | `TaskActionsPort`（§7.10） | 待抽 needs-port | `openSourceEditShell` 464 / `openContextMenu` 4313 / `openDatePrompt` 4358 / `nestFromMobile` 2679 / `applyTagEditResult` 2913 |
| `view/parent-picker.ts` | 移动端父任务选择器（防环/分组/搜索/resolve） | `TaskActionsPort` 的只读子集（`getEffectiveTasks`/`resolveTask`/`visibleTaskIds`）+ `PresentationCtx` | 待抽 **clean once port exists** | `openParentPickerForTask` 2722（~190 行，自包含 BottomSheet） |

**已抽出的子模块（一并列入，本次将其依赖从 `v: TaskCenterView` 改窄为对应 Port）**：

| 已抽模块 | 当前依赖 | 目标依赖（本次改窄） |
| --- | --- | --- |
| `view/area-filter-model.ts` | 纯助手，无 view 依赖 | 不变 |
| `view/area-filter-controls.ts` | `v: TaskCenterView`（`:27/107/170`） | `SavedViewMutationPort.setAreaWhen` 子集 |
| `view/query-editor.ts` | `import type { TaskCenterView }`（`:33`），`constructor(private v: TaskCenterView)`（`:48`） | `QueryEditorHostPort`（= `currentQuerySnapshot` + `setTabDraft` + `refresh`，§7.8 子集）——这是打断概念耦合的标志性一改 |
| `view/dnd.ts` | 桌面拖拽状态机 | `TaskActionsPort`（落点写经 `onNest`/`afterMutation`） |
| `view/touch.ts` | `attachCardGestures` / `attachLongPress` | 不变（已是参数化适配器，由 card 模块按 `PresentationCtx.modality` 装配） |
| `view/undo.ts` | UndoStack | 不变（经 `TaskActionsPort.pushUndo` 暴露） |
| `view/mobile-task-sheet.ts` | 已"刻意解耦 TaskCenterView"（`:10`），收显式回调 | 承接 `openMobileTaskDetailSheet`(2592)/`openSubtreeSheet`，靠 `TaskActionsPort` 驱动 |
| `view/source-dialog.ts` / `view/source-open-state.ts` | `openTaskSourceEditShell` | 外壳经 `TaskActionsPort.openSourceEditor` 反向提供 |
| `view/bottom-sheet.ts` / `view/filter-popover.ts` / `view/saved-view-name-modal.ts` / `view/query-dsl-modal.ts` / `view/migration-gate.ts` / `view/state.ts` | UI/类型基元 | 不变 |

---

### 7.7 渲染 Ports（calendar / card）

渲染 Port 的设计原则：**子模块只依赖它真正消费的几个只读数据 + 意图回调**，不依赖整个 `TaskCenterView`。核验显示这两簇本体都很薄，"显得耦合重"是因为内联调了三类不属于自己的东西——数据管线、共享外壳组件、提交编排——全部下沉为回调后 Port 即收敛。

#### CalendarRenderPort

calendar 簇真正属于自己的只有"把 anchor 摊成 7 天/42 格网格、按 today/expanded/selected 上 class、放 `data-date` 容器、算 `columnStats`"。其余（`scopeTasksToArea` 数据管线、`renderCard`/`renderMiniCard` 卡片、`renderAreaHead`/`makeDropZone` 共享组件）作回调注入。

```ts
// src/view/render/calendar.ts
import type { EffectiveTask } from "../../types";
import type { QueryPresetFilters, ParsedTask, Area } from "../../types";
import type { PresentationCtx } from "../presentation";

export interface CalendarRenderPort {
  // ── 只读数据（簇唯一消费的时间游标 + 设置快照）──
  readonly anchorISO: string;                 // week 算 7 天起点 / month 算 42 格 / 周号月号
  readonly weekStartsOn: 0 | 1;               // 网格对齐 + 喂 applyQueryFilters

  // ── 数据管线下沉（取代 scopeTasksToArea + getTextFilter + getEffectiveTasks）──
  scopedTasks(when: QueryPresetFilters | undefined): EffectiveTask[]; // 该 area 该显示的任务（含 justCompletedIds 豁免）
  textFilter(): (t: EffectiveTask) => boolean;                        // 全局文本/标签/时间/状态谓词

  // ── 共享外壳组件（list/grid/week/month 共用，不属日历簇）──
  renderAreaHead(parent: HTMLElement, areaIndex: number, area: Area,
                 opts: { title: string; renderNav?: (host: HTMLElement) => void }): void;
  renderCard(parent: HTMLElement, t: EffectiveTask, contextDate?: string): void;     // 卡片大簇容器
  renderMiniCard(parent: HTMLElement, t: EffectiveTask, day: string): void;          // month chip，与 renderCard 同源
  makeDropZone(el: HTMLElement, day: string | null): void;                           // dnd 簇落点

  // ── 语义化状态读写（取代直接写 state.* + this.render()）──
  setAnchor(iso: string): void;               // 取代 renderRangeNav 直写 state.anchorISO + render
  readonly weekExpanded: { has(day: string): boolean; toggle(day: string): void };   // week 移动端折叠（持久于 state.expandedDays）
  readonly monthSelection: { day: string | null; select(day: string): void };        // month 选中日（select 内清 selectedTaskId 并重渲）
}
```

**为什么这样切能真解耦**：簇内现直接读写 4 个 `state` 字段（`anchorISO`/`expandedDays`/`selectedMonthDay`/`selectedTaskId`）并直接 `this.render()`。换成 `setAnchor`/`weekExpanded.toggle`/`monthSelection.select` 语义回调后，外壳保留状态所有权与 `render` 节奏，**不必把 state 改 public**。`renderRangeNav`(1324) 与 `renderMobileMonthDayPanel`(2556) 作 calendar 模块**私有函数**，靠同一 Port 驱动，桌面经 areaHead、移动经 toolbar 两条注入路径由外壳装配（`renderRangeNav` 作 `opts.renderNav` 回调传入），使 week/month 不依赖装配顺序。

**先可抽的 clean 子集**：`columnStats`(2367) 已纯，连同新增 `buildWeekDays` / `buildMonthGrid` 一起进 `view/render/calendar-grid.ts`（纯逻辑禁 DOM，§2.1），让带 Port 的渲染壳变薄。

> **风险点（核验）**：`renderMiniCard` 现内联于 `renderMonth`(约 2519)，与 `renderCard` 不同源。抽取时必须让 month chip 走 card 模块的精简渲染器（`CardRenderPort.renderMiniCard` 由 card 模块提供），否则日历簇被迫直接 `import wireCardEvents`，等于把 card 事件耦合留在日历里。

#### CardRenderPort

card 簇本体是 DOM 结构构建 + 事件 wiring；其耦合面看似宽（13 方法/9 状态），但绝大多数是"提交类编排"（nest/swipe/toggle/subtree/contextmenu/primary）——这些**不搬**，收成少数几类**用户意图回调**。Port 因此收敛到 ~11 个成员：5 个只读数据 + 6 个意图回调。

```ts
// src/view/render/card.ts
import type { EffectiveTask, ParsedTask } from "../../types";
import type { PresentationCtx } from "../presentation";

export interface CardRenderPort {
  // ── 只读数据 ──
  effectiveTasks(): EffectiveTask[];          // 按 renderParentId 过滤 inline 子/孙卡，纯读
  selectedId(): string | null;               // selected class
  isJustCompleted(id: string): boolean;       // US-153 linger 标记（集合本身留外壳）
  gestureConfig(): { longPressMs: number; swipeEnabled: boolean }; // 取代 plugin.settings 直读

  // ── 意图回调（提交编排留外壳）──
  onPrimary(t: EffectiveTask): void;          // 移动→detail sheet / 桌面→source edit（收口两个内部方法）
  onToggleDone(t: EffectiveTask): void;       // 封装 toggleDone 的 justCompleted + linger 编排
  onContextMenu(e: MouseEvent, t: EffectiveTask): void;
  onNest(droppedId: string, targetId: string): Promise<void>; // api.nest + undoStack + runWithRemoveAnim 整段收外壳
  onSwipe(t: EffectiveTask, kind: "done" | "drop"): void;      // US-508
  onOpenSubtree(root: ParsedTask): void;      // 移动 +N chip：_taskIndex 遍历 + BottomSheet 留外壳
}
```

**为什么比 manage-tabs 窄得多**：card 簇的"动作"天然能归并成少数用户意图（主动作/完成/右键/嵌套/滑动/展开子树），而非 20 个散开的内部方法引用。

**先可抽的 clean 子集**：`renderTaskTags`(3573) 已是零 `this` 依赖的纯 DOM 函数，可立即无 Port 抽出。`countDescendants`(约 3583) 只依赖 `_taskIndex`，移入 `task-tree.ts` 作纯函数（传 index/tasks）。

> **风险点（核验）**：`toggleDone`(567) 的 linger 语义（US-153）与 `scheduleRefresh` 的 `skipNextRefreshClear` 强耦合，**绝不能**下放到簇——必须经 `onToggleDone` 单向回调，否则 linger 状态机泄漏到类外，重蹈"把耦合挪到类外"覆辙。`attachCardGestures` 的 `onSwipeProgress` 直写 `el.dataset.swipe*` 是纯 DOM 反馈，可随簇走。

---

### 7.8 saved-view Ports（共享 Mutation + 两个 UI 投影）

saved-view 相关有三个不同关注点，**必须分三个 Port**——这是核验最强的纠偏点。三者共享 `SavedViewMutationPort`（CRUD 编排底座），`SavedViewPanelPort`（manage-tabs UI）与 toolbar 动作组都是它的 UI 投影；交互对话框单列 `SavedViewPromptsPort`。

#### SavedViewMutationPort（共享底座）

去重后，14 个 CRUD 方法真正依赖只有"一个列表 + 一个草稿动作 + 三个标量 + 四个动作 + 一份 labels"。绝大多数方法是 `读 presets → 调 saved-views.ts 纯函数 → writePresets → dropDraft → apply → persist → refresh` 同一形状——这正是窄 Port 成立的证据。

```ts
// src/view/saved-view-actions.ts
import type { QueryPreset } from "../types";

export interface SavedViewMutationPort {
  // ── 数据（一个列表 + 写回 + 三标量）──
  presets(): QueryPreset[];
  writePresets(next: QueryPreset[]): void;                  // 所有 CRUD 的最终落点
  defaultId(): string | null;  setDefaultId(id: string | null): void;
  deletedBuiltinIds(): string[];  setDeletedBuiltinIds(ids: string[]): void; // US-109l tombstone
  activeViewId(): string;                                   // 判断被操作的是不是当前 active

  // ── 草稿 / 状态写口（簇不持有 tabDrafts，也不直接写 state）──
  dropDraft(id: string): void;                              // 取代 tabDrafts.delete(id)
  apply(view: QueryPreset): void;                           // = applySavedView，写 state 的唯一授权入口
  snapshotCurrent(existing?: QueryPreset | null, name?: string): QueryPreset; // 当前草稿态凝固成 preset

  // ── 收尾 ──
  refresh(): void;                                          // = render()，统一在编排末端调用
  persist(): Promise<void>;                                 // = plugin.saveSettings()
  labels(): Record<"today" | "week" | "month" | "completed" | "unscheduled", string>; // 仅 restoreBuiltin 需要
}
```

> **易错点（核验）**：`saveCurrentView`(3990) 自身**不**调 render（由调用方 render），其它 CRUD 自带 render。抽 Port 时统一由 `refresh()` 在编排末端调用、方法内部不各自 refresh，否则 `createSavedViewFromCurrent` 链路双重重绘。校验散点（`throw "至少保留一个可见 Tab"` / `"不能把已隐藏的 Tab 设为默认"`）建议下沉为 `saved-views.ts` 纯校验返回 `ok/err`，Port 只负责报错呈现。

#### SavedViewPromptsPort（交互对话框，单列）

```ts
export interface SavedViewPromptsPort {
  promptName(defaultName: string): Promise<string | null>; // = askSavedViewName（包 SavedViewNameModal）
  confirmDelete(view: QueryPreset): Promise<boolean>;       // delete 的 BottomSheet 确认
  switchTabConfirm(): Promise<"save" | "discard" | "cancel">; // activateSavedView 的脏检查弹窗
}
```

UI 留视图层；`activateSavedView`(约 1621) 的 `SwitchTabConfirmModal` 编排跨"草稿脏态"与"CRUD"两簇，是外壳的视图切换路由，宜留外壳，仅复用 `SavedViewMutationPort.apply`。

#### SavedViewPanelPort（manage-tabs UI 投影）

manage-tabs 真正职责只有两件：(1) BottomSheet 容器生命周期（`openManageTabsSheet` 1718 留外壳，把 `rerender`/`closeSheet` 闭包传入）；(2) 把 preset 列表渲染成行 + 路由用户意图到动作集合。因此它依赖的不是整个 `TaskCenterView`，而是这个 ~6 成员 + 一个 7 项 `rowActions` 表的窄 Port，全部是 `SavedViewMutationPort` 已有动作的引用，无需把任何状态改 public。

```ts
// src/view/manage-tabs.ts
import type { QueryPreset } from "../types";

export interface SavedViewPanelPort {
  listPresets(): QueryPreset[];               // 已归一化，UI 只消费
  isActive(view: QueryPreset): boolean;       // 行高亮，封掉 state.savedViewId
  activate(view: QueryPreset): void;          // 点击行/菜单 open（含脏 tab 确认）
  reorder(draggedId: string, insertAt: number): Promise<void>; // insertAt 由 UI 用 listPresets() 下标算
  createFromCurrent(): Promise<void>;
  restoreAllBuiltins(): Promise<void>;
  // 7 项行级动作打包成动作表（菜单 = title/icon → 调某 action 的装配）
  rowActions: {
    editDsl(v: QueryPreset): void;            // = activate + openQueryControlsSheet，外壳组合
    rename(v: QueryPreset): Promise<void>;
    copy(v: QueryPreset): Promise<void>;
    setDefault(v: QueryPreset): Promise<void>;
    toggleHidden(v: QueryPreset, hidden: boolean): Promise<void>;
    restoreBuiltin(v: QueryPreset): Promise<void>;
    deleteWithConfirm(v: QueryPreset): Promise<void>;
  };
}
```

**动作表 vs 散开回调**：把 7 个行级动作收进 `rowActions` 对象而非 7 个顶层成员，让 Port 表面"少而精"，与菜单项集合一一对应，未来增删菜单项只改一处。

> **两步走（核验强制次序）**：先抽 `saved-view-actions`（CRUD 动词聚成模块，实现 `SavedViewMutationPort`），再抽 `manage-tabs` UI 依赖 `SavedViewPanelPort`。反过来先抽 UI 会被迫把 11 个动作临时变 public，正是要避免的"把耦合挪到类外"。`setActiveTabName`(1949) 严格说不属 manage-tabs（是 tab 条 toolbar 的 inline rename），归 `toolbar.ts`。

#### QueryEditorHostPort（query-editor.ts 改窄）

`query-editor.ts:33 import type { TaskCenterView }` + `:48 constructor(private v: TaskCenterView)` 是报告点名的概念耦合。它实际只需草稿态三件：

```ts
// src/view/query-editor.ts
export interface QueryEditorHostPort {
  currentQuerySnapshot(existing?: QueryPreset | null, name?: string): QueryPreset; // 与 state 唯一合法接触面
  setTabDraft(presetId: string, draft: QueryPreset | null): void;  // null = 删（setAreaWhen/setAreaTitle 底座）
  refresh(rerenderControls?: () => void): void;                    // = refreshFilterControls(4164)
}
```

`setAreaWhen`(3200，**已 public**) / `setAreaTitle` 改为基于 `currentQuerySnapshot` + `setTabDraft` 实现，不再要外壳开 `collectAreas` 级别的口。

---

### 7.9 TabBarPort（tab 条）与 TabOverflowMeasure（几何）

原"tab 条 + toolbar"被切成三个关注点，强行整簇外迁会逼出 ~20 回调（= 现状直接耦合面）。正确切法按子关注点拆，难度递增：

#### TabOverflowMeasure（clean，优先抽）

溢出几何几乎自洽：只读 DOM `offsetWidth` + 4 个私有状态，核心算法 `fitTabCountFromWidths` 已是模块级纯函数。把 4 个状态搬进独立实例，`renderTabBar` 只问"现在该显示几个"。**零回调进 view**，view 只在结果变化时 `render()`。

```ts
// src/view/tab-overflow.ts
import type { QueryPreset } from "../types";

export interface TabOverflowMeasure {
  measure(bar: HTMLElement, tabs: QueryPreset[]): number | null; // widthChanged 才重算；返回 fittedVisibleTabCount
  reset(): void;
}
// 内部持 fittedVisibleTabCount / lastTabbarMeasureWidth / tabWidthCache / moreChipWidth
// 纯部分 fitTabCountFromWidths 已隔离且无 DOM（§2.1 满足）；DOM 量宽属视图层，不破坏"纯逻辑禁 DOM"
```

#### TabBarPort（needs-port）

耦合压成 ~7 个窄成员。**关键技巧**：用单一 `meta(v)` 回调把 `isSavedViewDirty + savedViewBadges + countForSavedView + legacyTabForSavedView + defaultSavedViewId` 这 5 个领域读折叠成一个"展示元数据"结果——这些计算依赖 effectiveTasks/drafts/settings，属外壳领域逻辑，视图只需结果。

```ts
// src/view/tabbar.ts
import type { QueryPreset } from "../types";
import type { TabKey } from "./state";

export interface TabBarPort {
  tabs(): QueryPreset[];                       // = visibleQueryTabs()
  activeId(): string | undefined;              // = state.savedViewId（dwellTracker 源 tab）
  meta(v: QueryPreset): {                      // 5 个领域读折成一个展示元数据
    dirty: boolean; badges: string[]; count: number; isDefault: boolean; legacyTab: TabKey | null;
  };
  renderOverflow(host: HTMLElement, overflowTabs: QueryPreset[], close: () => void,
                 opts: { mobile: boolean }): void; // 「更多」dropdown/sheet，黑盒回调注入
  // 交互意图路由（背后是 saved-view CRUD，留外壳）
  onActivate(v: QueryPreset): void;
  onRename(v: QueryPreset): void;
  onReorder(id: string, insertAt: number): Promise<void>;
  onContextMenu(e: MouseEvent, v: QueryPreset): void;
  onManage(): void;
  onSettings(): void;
}
```

`dwellTracker`（跨 tab 拖卡片落点）**不进 Port**——属 dnd 簇，由已抽的 `view/dnd.ts` 或 `onTabDragHover` 承接，`renderTabButton`(987) 只触发。

#### toolbar / saved-view 动作（不进 TabBarPort）

`renderToolbar`(1363) / `renderSavedViewsActionControls`(1468) 本质是 saved-view CRUD 编排，与 tab 条只共享"saved-view"名词、不共享渲染上下文。它们复用 **§7.8 的 `SavedViewMutationPort`**（`snapshotCurrent`/`apply`/`refresh` + `SavedViewPromptsPort.promptName`）。`renderMobileStatusRow`(746) / `renderMobileActionBar`(765) 是无状态展示，各自一个 clean 小函数，收 `{ effectiveTasks }` / `{ onUnscheduled, onQuickAdd }` 即可。

---

### 7.10 TaskActionsPort（源编辑 + 移动动作 + 父选择器）

这一簇是"窄 Port 范例"：动作全部经 `api.*` 单一出口，刷新全部经一个 `afterMutation` 语义收敛。**关键洞察**：把 `runWithRemoveAnim`(525) / `toggleDone`(567) 尾部 / `refreshAfterAction`(约 3293) 三种刷新统一成 `afterMutation(opts)` 后，簇对 view 内部状态（`refreshTimer`/`justCompletedIds`/`findCardEl`/`bumpCacheVersion`/`waitForCacheUpdate`）的耦合从 ~7 个降到 0——这是切对边界的标志。

```ts
// src/view/source-actions.ts
import type { EffectiveTask, ParsedTask, TaskCenterApi, UndoOp } from "../types";
import type { PresentationCtx } from "./presentation";

export interface TaskActionsPort {
  api: TaskCenterApi;                          // 所有 mutation 唯一出口（已窄，直接透传，不逐动词包回调）

  // ── 统一刷新契约（写进 §7.1 外壳"路由事件→维护 cursor→渲染"）──
  afterMutation(opts?: {                       // 收敛 runWithRemoveAnim + toggleDone 尾部 + refreshAfterAction
    animateOutId?: string;                     // 淡出某卡
    awaitCachePaths?: string[];                // 等缓存路径（跨文件 nest 用）
    lingerId?: string;                         // US-153 linger（justCompletedIds + skipNextRefreshClear）
  }): Promise<void>;
  scheduleRefresh(): void;                     // no-op/错误回退的去抖刷新（带 400ms 去抖 + linger 清理）

  // ── 状态窄接口（不暴露 state / _taskIndex / contentEl）──
  select(taskId: string): void;               // 取代写 state.selectedTaskId + contentEl.focus
  getEffectiveTasks(): EffectiveTask[];        // 父选择器枚举 / tag 建议
  resolveTask(id: string): ParsedTask | undefined; // 取代 _taskIndex.get / tasks.find（含 childrenLines）
  visibleTaskIds(): string[];                  // 封装 contentEl.querySelectorAll[data-task-id]，DOM 留外壳

  // ── undo（不交给簇持有 UndoStack 实例）──
  pushUndo(entry: { label: string; ops: UndoOp[] }): void;
  showUndoableNotice(message: string): void;   // 封装 Notice + undoStack.pop

  // ── 外壳反向提供的能力 ──
  openSourceEditor(task: ParsedTask): Promise<void>; // 桌面 shell / 移动 native 分流 + onSave 刷新（持 leaf/app/缓存）
  ctx: PresentationCtx;                        // isMobile / weekStartsOn 等适配轴
}
```

**切分建议（避免一锅端）**：

1. `TaskActionsPort` 覆盖 `toggleDone`/`openContextMenu`(4313)/`openDatePrompt`(4358)/`nestFromMobile`(2679)/`applyTagEditResult`(2913)/卡片 drop 处理器——纯动作派发，**clean once port exists**。
2. 父选择器 `openParentPickerForTask`(2722，~190 行) 单独成 `view/parent-picker.ts`：自包含 BottomSheet，只依赖 `getEffectiveTasks`/`resolveTask`/`visibleTaskIds` 三个只读 + `ctx`，提交交回外壳 `nestFromMobile`。几乎不碰外壳可变状态，**clean**。
3. `openMobileTaskDetailSheet`(2592)/`openSubtreeSheet` 归 `view/mobile-task-sheet.ts`（已存在），靠 `TaskActionsPort` + `openSourceEditor` + `openParentPicker` 回调驱动。
4. `openSourceEditShell`(464)/`openNativeSourceEditor`(481) **不抽**——它们是外壳提供给簇的能力（`Port.openSourceEditor`），反向依赖。

> **依赖规则符合 §2.1**：Port 把所有 DOM（`contentEl` 查询、`findCardEl`）和缓存调度留在外壳，抽出的父选择器/动作派发只读 `EffectiveTask` 数据 + 调 `api`，不触 `metadataCache`、不直接操作 view 私有 DOM。

---

### 7.11 依赖倒置：为什么窄 Port 能真解耦

**问题（核验点名）**：现有"搬出去 + 收 `v: TaskCenterView`"模式（`area-filter-controls.ts:27`、`query-editor.ts:48`）只是把耦合**挪到类外**——子模块依赖具体类 `TaskCenterView`，编译期就钉死了对 god class 全部 public 表面的依赖；要抽 manage-tabs 就得把 ~20 个内部方法改 public，god class 反而更大。

**解法（依赖倒置 DIP）**：

1. **子模块依赖 Port 接口，不依赖具体类**。`renderCard(parent, t, ctx: CardRenderPort, contextDate?)` 只知道 `CardRenderPort` 这个**抽象**，不知道 `TaskCenterView` 存在。打断 `import type { TaskCenterView }` 那条概念耦合边——`view/render/card.ts` 的 import 图里不再有 `../view`。
2. **外壳实现 Port、注入实现**。`TaskCenterView` 在组合根（§7.1(3)）`implements` 各 Port（或现场用对象字面量构造 Port 实例传入），把 `this.renderCard` 改成 `renderCard(parent, t, this.cardPort, ...)`。每改一个子模块，对应的内部方法就能从 public 收回 private——耦合面**单调收缩**，与"收 `v`"模式的单调膨胀相反。
3. **Port 成员窄到"恰好够用"**。证据：manage-tabs 从"依赖 ~20 个内部方法"降到 `SavedViewPanelPort` 的 6 成员 + 1 个 7 项动作表；card 从 13 方法/9 状态降到 11 成员；source-mobile 把 ~7 个刷新耦合降到 0（统一 `afterMutation`）。窄 Port 让"哪 20 个依赖是哪个簇的"显形——它们大多根本不是同一个簇要的。
4. **共享能力抽成共享 Port**。`SavedViewMutationPort` 同时被 `saved-view-actions` / `manage-tabs`（经 `SavedViewPanelPort` 投影）/ `toolbar` 三处复用，CRUD 编排只实现一遍。

---

### 7.12 PresentationCtx 注入（复用 REFACTOR.md §5）

各渲染 Port 都收一个 `PresentationCtx`，取代散落 ~30 处的 `contentEl.dataset.mobileLayout === "true"` 字符串比对与裸 `Platform.isMobile`（绕过测试钩子 `__testForceMobile`，导致 e2e force-mobile 测不到）。两条**正交轴**收成一个注入对象：

```ts
// src/view/presentation.ts
export interface PresentationCtx {
  modality: "touch" | "pointer"; // 输入模态：取代 isMobileMode()/裸 Platform.isMobile，单一来源（底层走 __testForceMobile）
  width: "narrow" | "compact" | "wide"; // contentEl 宽度 band，与输入模态正交
}
```

- **外壳算一次、注入给渲染器**。`render` 起点由 `contentEl` 的 ResizeObserver width band + `isMobileMode()` 算出 `PresentationCtx`，传给 `CalendarRenderPort` / `CardRenderPort` / `TaskActionsPort.ctx`。渲染器不再读 dataset 字符串。
- **calendar 收 `ctx.width`**：week wide 7 列、compact 日期键 + outline、narrow 日期行；month wide 格内 mini-card、compact/narrow 负载月历 + inline day outline。mini-card draggable、card click 与手势装配不看 width，统一读 `ctx.modality`。
- **card 收 `ctx.modality`**：draggable / click 路由 / 子树折叠 +N 按 `ctx.modality`；手势适配器 `attachCardGestures`（`touch.ts`）由 card 模块在 `modality === "touch"` 时装配，取代每个 `renderCard` 里 `if (Platform.isMobile)`。
- **交互能力按模态门控**：拖拽/dwell/hover/快捷键 ∈ `pointer`；long-press/swipe/bottom-sheet ∈ `touch`（正是 §0 原则 9 清单）。做成 `PointerInteractions`/`TouchInteractions` 适配器，外壳按 `ctx.modality` 装一个。
- **sheet vs popover**：`query-editor.ts` 已按 `mobileLayout` 选 class（对的雏形），推广成统一收 `ctx.width`。
- 顺带修裸 `Platform.isMobile` 的测试盲区：全部收口 `ctx.modality`。

---

### 7.13 与 AreaSpec / AreaView 的关系（复用 REFACTOR.md §4）

> **落地实况（截至本轮，覆盖本节后续的设计草案）**：本节是 §4 的早期设计草案，**部分已落地、其余按 §7.14 与 REFACTOR §4.7 评审判定不做**：
> - **纯核心两半已落地、且是分开两表**，不是合一的 `AREA_SPECS`：能力侧 = `src/areas.ts` 的 `AreaHandler` 层次 + `HANDLERS: Record<AreaType|"unknown", AreaHandler>`；投影侧 = `src/query/projection.ts` 的 `AREA_PROJECTORS: Record<AreaType|"unknown", AreaProjector>`（投影 switch 已消除，`today` 显式注入）。两表都带 exhaustive 编译检查。
> - **渲染侧已落地为 `AREA_RENDERERS: Record<AreaType|"unknown", (v, el, area, idx)=>void>`**（`src/view.ts`，消除 `renderLayoutNode` 的最后一处 `switch(node.type)`），值是 step8/9 抽出的**收-v 函数**（`renderListArea` / `calendar.ts:renderWeek|renderMonth` / `renderTrashZone` / `renderUnknownArea`）。
> - **下文的 `AreaView.mount` 生命周期对象 + 窄 `AreaViewPorts` + `AREA_VIEWS` 表不采纳**：按 §7.14 第 11 步「窄 Port/DIP 对单宿主插件是过度设计、收 v 是正确终态」，以及 REFACTOR §4.7 的多维度+对抗式评审结论——渲染函数无跨渲染实例状态（`expandedDays`/`selectedMonthDay` 都在 `v.state`、整树重渲染），AreaView 是为不存在的生命周期造容器；§4.7 的 `AreaKind` 合一对象 / `AreaSettingsSpec` DSL（旗舰示例 `firstDayOfWeek`/`density` 实为未接线死字段）一并不采纳。
> - 因此「area 渲染走注册表而非 switch」这个**目标已达成**（三张同构注册表：能力/投影/渲染），只是落地形态是收-v 函数表，而非下文的 `AreaSpec`/`AreaView` 双对象。下文保留作设计沿革。

area 渲染走**注册表**而非 `switch(area.type)`（现 `view.ts:renderLayoutNode`(3042) / `query/projection.ts` 的 `switch`，`default→list` 会把新 type 静默当 list）。分两组 strategy + 全量注册表：

- **纯核心** `src/query/areas/`：`AreaSpec` = `{ type, capabilities: AreaHandler, projector: AreaProjector, validate }`，`AREA_SPECS: Record<AreaType|"unknown", AreaSpec>`。CLI `query-run` 与 GUI 共用，`projector.project(area, tasks, ctx)` 只吃 `EffectiveTask[] + AreaProjectionCtx`（`today` 显式注入），可单测、无 DOM。
- **视图层** `src/view/render/areas/`：`AreaView.mount(host, vm, area, ctx: PresentationCtx, ports: AreaViewPorts)`，`AREA_VIEWS: Record<AreaType|"unknown", AreaView>`。

**`AreaViewPorts` 是本节渲染 Port 的统一上层**——area 渲染器需要的窄回调，不是整个 `TaskCenterView`：

```ts
// src/view/render/areas/ports.ts
export interface AreaViewPorts {
  onCardAction(taskId: string, action: CardAction): void;          // 卡片动作
  onEditWhen(areaIndex: number, when: QueryPresetFilters): void;   // → setAreaWhen(3200)
  openSource(taskId: string): void;
}
```

`list`/`grid` 的 `AreaView` 内部组合 `CardRenderPort`（§7.7）；`week`/`month` 的 `AreaView` 内部组合 `CalendarRenderPort`（§7.7）。外壳壳循环零 switch（REFACTOR §4.4）：

```ts
for (const [i, area] of collectAreas(layout).entries()) {
  const spec = AREA_SPECS[area.type];
  const tasks = spec.capabilities.filterable()
    ? applyQueryFilters(all, (area as FilterableAreaConfig).when, ctx) // capability 门控，过滤统一于此
    : all;
  const vm = spec.projector.project(area, tasks, ctx);
  AREA_VIEWS[area.type].mount(host, vm, area, presentation, ports);
}
```

`drop` 的 `onDrop` 是**实例级**数据（tray 清 ⏳ vs 放弃区 setStatus），留 data 不进类：**type 级行为进 strategy，实例级差异留 data**。

---

### 7.14 增量落地次序（风险/收益排序）

总原则（核验一致）：**先定 Port 接口（本文档 §7.6–§7.10）→ 外壳实现 Port → 一簇一簇迁移 → 子模块改依赖 Port 而非 `TaskCenterView`**。每步：补 characterization 测试 → 搬一组逻辑/改 import → 测试仍绿 = 一次独立小 commit。禁用 reset/rebase/amend/checkout/restore/stash/clean；只 `git add` 自己改的文件。

| 步 | 抽取项 | 风险/收益 | 兜底测试 | 可独立提交 |
| --- | --- | --- | --- | --- |
| 1 | `view/render/calendar-grid.ts`（`columnStats` + `buildWeekDays` + `buildMonthGrid`，纯逻辑） | **最低风险/立竿见影**：零 DOM、零 state、无 Port | 新增 `calendar-grid.test.mjs`（网格边界/周月号/columnStats 求和） | ✅ |
| 2 | `view/tab-overflow.ts`（`TabOverflowMeasure`，几何 clean） | 低风险：核心 `fitTabCountFromWidths` 已纯，零回调进 view | 既有几何单测 + e2e tab 溢出 | ✅ |
| 3 | `renderTaskTags` / `countDescendants`（card 纯子集） | 低风险：零 `this`（前者）/ 仅 `_taskIndex`（后者，移 `task-tree.ts`） | parser/task-tree 单测 | ✅ |
| 4 | **定义全部 Port 接口 + 外壳 `implements`**（§7.6–§7.10） | 无行为变更，纯类型 + 适配方法 | typecheck 绿 | ✅ |
| 5 | `view/saved-view-actions.ts`（`SavedViewMutationPort` + `SavedViewPromptsPort`） | 中风险：CRUD 编排，先于 manage-tabs（次序强制） | `saved-views.test.mjs`(2041 行) + e2e saved-views CRUD/隐藏/恢复/默认 | ✅ |
| 6 | `view/manage-tabs.ts`（依赖 `SavedViewPanelPort`） | 中：依赖第 5 步，收回 11 个 public→private | e2e manage-tabs（行点击切换/高亮/kebab 重命名/拖拽重排，§7.9 UX 不变量） | ✅ |
| 7 | `view/source-actions.ts` + `view/parent-picker.ts`（`TaskActionsPort`） | 中：父选择器 clean，动作派发 clean once port | e2e 父选择器/移动详情 sheet/swipe/context menu/嵌套/undo | ✅（两个 commit） |
| 8 | `view/render/card.ts`（`CardRenderPort` + `PresentationCtx`） | 中高：linger/手势/拖拽，必须经回调不下放 state | e2e 卡片完成 linger(US-153)/拖拽嵌套/移动 swipe + 新增 cardViewModel 纯单测 | ✅（先 projector 纯单测） |
| 9 | `view/render/calendar.ts`（`CalendarRenderPort` + `PresentationCtx`） | 中高：week/month 桌面/移动分叉收进文件 | e2e week row/month inline panel/改期/清空 tray | ✅ |
| 10 | `view/tabbar.ts` + `view/toolbar.ts`（`TabBarPort`，toolbar 复用 `SavedViewMutationPort`） | 中：`meta()` 折叠 5 个领域读 | e2e tab CRUD/更多/隐藏/默认 + i18n 热切换 | ✅ |
| 11 | `query-editor.ts` / `area-filter-controls.ts` 改窄签名 `(host: QueryEditorHostPort)` | 收尾：打断最后的 `import type { TaskCenterView }` | e2e Query 编辑器可视化/DSL 往返 + area when live 刷新 | ✅ |
| 12 | 外壳改名 `view/task-center-view.ts`（动文件名风险最高，放最后且确认无人在途） | 高：文件名 | 全量 e2e | ✅（最后） |

落地伴随 REFACTOR §4 的 `AreaSpec`/`AreaView` 注册表（消两处 `switch(area.type)`）与 §5 `PresentationCtx`（收 ~30 处分叉），与第 8/9 步同批——它们是同一内聚单元（REFACTOR §6 "最小一起改集合"）。

#### 落地实况（截至本轮）

第 1–10 步**已全部落地并合并**，`src/view.ts` 由 5066 行降到约 2118 行（较 Brooks-Lint 标记的 5060 行 god class −58%），抽出 8 个聚焦模块：`view/saved-view-actions.ts`、`view/manage-tabs.ts`、`view/parent-picker.ts`（+`view/paths.ts`）、`view/source-actions.ts`、`view/render/card.ts`、`view/render/calendar.ts`、`view/tabbar.ts`、`view/toolbar.ts`。CI e2e 白名单（board-basics / saved-views / mobile-filter-ui / source-edit-dialog / dataview-format）+ 527 单测全绿。顺手删了死代码 `openDatePrompt` / `renderSavedViewsCompactBar`。

**与原计划的偏差（重要）**：第 5–10 步采用务实的「收 v」抽法——子模块以 `(v: TaskCenterView)` 收外壳、把动作派发回壳的引擎，而**不是**先定义窄 Port（§7.6–§7.10）再依赖 Port。代价是这 8 个模块都 `import type { TaskCenterView }`，外壳为此把若干私有成员临时改成 public（每个 commit 已注明「step11 收窄为 XxxPort」）。因此：

- **第 11 步的字面目标「打断最后的 `import type { TaskCenterView }`」已不可达**：要名副其实，需把全部 8 个模块一起改成依赖窄 Port，是一个比本表预估更大的纯类型重构阶段（零行为变更，typecheck 兜底）。只收窄 `query-editor` / `area-filter-controls`（各用 17 / 6 个 `v.*` 成员）则与其余模块不一致，且接近「把公有面照抄一遍」的 header 接口，DIP 收益有限。
- **第 12 步**（外壳改名 `view/task-center-view.ts`）是纯文件名 churn，需改全部 `./view` / `../view` 导入点（8 模块 + `main.ts` / `settings.ts` / 测试），本表自标「风险最高、放最后」。

**决策（基于取舍）**：

- **第 11 步：判定为过度设计，不做。** 窄 Port / DIP 的价值在于「同一接口多实现」或「模块脱离具体宿主单测（对 mock host）」。本插件只有**一个** `TaskCenterView`，渲染/动作模块永远不会有第二个宿主；为它们造 8 个「照抄公有面」的 header 接口，只会新增必须跟随类 API 漂移的维护负担，换不到任何可替换性收益。「收 v」（模块以 `(v: TaskCenterView)` 收外壳）对单宿主插件就是**正确的终态**，不是临时态。若将来真出现第二个宿主或要对渲染做隔离单测，再按需为该模块单独定义窄 Port 即可。
- **第 12 步：技术上可做，但当前被「无人在途」前置条件挡住，暂缓。** `view.ts` 是全仓被 import 最多的文件；改名要改动 8 个子模块 + `main.ts` / `settings.ts` / 测试的全部导入点。本仓多 agent 同时在 `main` 上工作，改名期间别的 agent 在途的 `view.ts` 改动会被大面积冲突/冲掉（CLAUDE.md 头号禁忌）。须在确认无人在途的窗口、由单一 agent 一次性完成，不可与他人并行。

综上：第 1–10 步的 god class 拆解目标已达成且经 e2e 验证（`view.ts` 5066→~2118，−58%）；第 11 步按取舍判定不做，第 12 步待无人在途的窗口再单独执行。

---

### 7.15 不变量与边界

每个抽取必须守住：

1. **§2.1 依赖规则**：`view` 只依赖 `api` / `i18n` / `Obsidian UI`，不直接解析 vault、不手写 writer mutation。所有 mutation 经 `TaskActionsPort.api` / `SavedViewMutationPort.persist`，所有任务读取经 `getEffectiveTasks()`（外壳经 `TaskCache` 派生）。
2. **Port 不得泄漏 DOM 给纯逻辑层**：Port 成员只暴露 `api` 结果 / `QueryPreset` 数据 / `EffectiveTask[]` / settings 快照 / 意图回调，**不**暴露 DOM 节点（`contentEl` 不进任何 Port）。需要 DOM 真相的（`visibleTaskIds`、`makeDropZone`、溢出量宽）由外壳/视图层实现并经回调暴露结果；`calendar-grid.ts` / `cardViewModel` / `fitTabCountFromWidths` 纯部分禁 DOM（§0 原则 10）。
3. **状态所有权不外放**：`state` / `tabDrafts` / `justCompletedIds` / `skipNextRefreshClear` / `_taskIndex` / `undoStack` 字段留外壳，子模块只经 Port 谓词/回调访问。linger 状态机（US-153）只经 `onToggleDone`/`afterMutation({lingerId})` 单向回调，绝不下放。
4. **每个抽取可回溯到 US**：calendar（US-116 columnStats / US-149 独立日期子任务 / US-117 移动适配）；card（US-115 overdue / US-143–149 父子树 / US-153 linger / US-508 swipe / US-506 长按详情）；saved-view-actions（US-109l tombstone / US-216–219 CRUD）；manage-tabs（US-109q 溢出 / §2.3 UX 不变量）；tabbar（US-109q）；source-actions（US-125/228 嵌套 / US-168f-h 源编辑 / US-506b tag / US-507b 父选择器）。
5. **§7.5 DOM 选择器契约不变**：抽取是纯结构重构，不改变用户可见行为与 `data-*` 契约；改契约必须同步改 e2e。

## 8. CLI 架构

CLI 注册到 Obsidian CLI 命名空间，不提供独立二进制。（US-201）

根命令 `task-center` 只输出静态帮助文本，不读写 vault，不初始化额外状态。帮助文本必须覆盖任务动词、Query Tab 动词和 AI skill 安装命令。（US-201a / US-215）

### 8.1 Task 动词

Task 动词薄封装 `TaskCenterApi`：

- `list` / `stats`：显式 ensureAll。
- `done` / `drop` / `schedule` / `actual` / `nest`：按 ref 解析，单文件优先。
- `add`：走 Daily Notes append。
- `list parent=<id>`：resolve parent 后基于 task tree 输出子任务。（US-212）

输出格式由 `cli.ts` 统一处理，保证：

- 第一列稳定 id。
- 写操作 `ok / before / after`。
- 幂等 unchanged 仍为 ok。
- 错误 `error <code>` + 一句人话。

### 8.2 Query 动词

QueryPreset 动词调用 `QueryPresetService`：

- `query-list`：列出 id、name、builtin、hidden、default。
- `query-show id=<id>`：输出完整 DSL。
- `query-run id=<id> [view=list|week|month] [anchor=YYYY-MM-DD]`：执行 QueryPreset 的主内容 area `when`，并按 view projection 输出结果；`view` 把本次展示临时替换成「单个该类型 area」的布局，不写回 preset。
- `query-create`：读取 DSL 创建 tab。
- `query-update id=<id>`：校验后覆盖。
- `query-rename` / `query-copy` / `query-hide` / `query-delete` / `query-set-default`。

`query-create` / `query-update` 的 `parseQueryDsl` 是 CLI 与 GUI DSL 直编的共同入口。它必须在 normalize 前拒绝 1.0 前旧 DSL 输入：顶层 `search/tag/time/status`、顶层 `filters` / `summary`，以及旧 `view.type/preset/sections/tray/matrix`。拒绝时抛给 CLI `invalid_query`，消息固定包含 skill 更新指引 `npx skills add CorrectRoadH/obsidian-task-center`，避免旧 agent skill 继续生成会被 1.0 静默降级的 DSL。（US-217a / US-219）

删除自定义 tab 不删除任务；预设 tab 不允许永久删除，只允许隐藏 / 恢复。（US-216~219）

### 8.3 错误码

固定英文错误码至少包含：

```ts
type ErrorCode =
  | "not_found"
  | "ambiguous_slug"
  | "out_of_date"
  | "invalid_date"
  | "invalid_query"
  | "write_conflict"
  | "daily_notes_missing"
  | "daily_notes_folder_missing"
  | "invalid_nest"
  | "nest_partial";
```

错误码不翻译；后接人话跟随 Obsidian 语言。（US-211 / US-412）

## 9. 依赖健康

`deps.ts` 负责检测：

- Daily Notes 核心插件启用状态。
- Daily Notes folder 配置。
- task-format companion 安装 / 启用状态：Tasks 或 Dataview 任意一个启用即健康。

检测结果提供给：

- Header / 状态栏警告。
- Quick Add submit guard。
- CLI add guard。
- 设置页说明。

配置变化后，依赖状态自动刷新，不要求重启。（US-701c）

## 10. i18n 与日期

### 10.1 i18n

`i18n.ts` 提供：

```ts
t(key: string, vars?: Record<string, string | number>): string;
getLocale(): "zh-CN" | "en" | string;
onLocaleChanged(cb: () => void): () => void;
```

切换语言只触发 UI 重渲染，不重扫 vault；`ParsedTask` 不依赖 locale。（US-408）

禁止翻译：

- 用户 Markdown 字面。
- hashtag。
- inline field 字段名。
- Obsidian Tasks emoji 字段。
- CLI error code。

允许翻译：UI 文案、toast、设置项、错误人话、默认预设显示名。

### 10.2 日期

`dates.ts` 负责：

- ISO 写回：永远 `YYYY-MM-DD`。（US-411）
- locale 显示。
- 周一 / 周日起始日。
- token 解析：`today / tomorrow / yesterday / week / next-week / month / next-month / YYYY-MM-DD / FROM..TO`。
- 中文自然语言：今天、明天、昨天、周一至周日、本周、下周、本月、下月。（US-410）

无法识别日期时返回“无日期”，不猜测。

### 10.3 IME Guard

所有 Enter 提交输入框必须使用统一 helper：

```ts
function shouldSubmitEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.isComposing && e.keyCode !== 229;
}
```

适用：tab rename、Quick Add、DSL editor save、搜索 / filter 需要 Enter 的场景。（US-413）

## 11. 性能预算

| 场景 | 预算 | 策略 |
| --- | --- | --- |
| 插件 onload | 不触发全量扫描 | 创建空 cache，状态栏被动刷新 |
| 首次打开看板 | ≤ 1.5s 目标；超时显示 skeleton / 进度 | metadata 快速跳过 + 限并发解析 |
| 二次打开看板 | ≤ 200ms | flatten cache 命中 |
| 单文件修改后刷新 | ≤ 1s | 单文件 invalidate + debounce render |
| 桌面拖拽落定反馈 | ≤ 100ms 感知反馈 | 先视觉反馈，写入后 cache 刷新确认 |
| 移动端输入搜索 | debounce ≥100ms | 避免每键全量 render |

渲染约束：

- 父子查找使用 Map，不在 render 热路径中 `Array.find` 全表扫描。
- DataTransfer types 用 `.contains()`，不 `Array.from(...).includes()`。
- 移动端卡片设置 `touch-action: pan-y`。
- 移动端首屏不挂载桌面搜索输入和筛选控件；Query 编辑 bottom sheet 复用同一套 filter controls，避免双份状态。
- 移动端 toolbar、body、week row、card 的布局必须基于父容器宽度收缩，不依赖横向滚动承载主路径控件。
- 移动端 Query tab strip 是例外的横向 pan 区：设置横向 overflow、固定高度、隐藏纵向 overflow，并禁用 tab 拖拽 / dwell / 快捷键提示。
- “更多”溢出入口（US-109q）按平台分形态，但共用同一行渲染 `renderOverflowTabEntries`：桌面是锚在“更多”按钮的就地下拉浮层（`bt-overflow-tabs-menu`，`position: absolute` + `z-index`），开合状态记在 view 实例字段 `overflowTabsMenuOpen` 上，靠 `render()` 重渲染呈现；关闭复用 area 过滤同一套机制——全局 `pointerdown`（capture）经 `isClickInsideFilterControls` 判定外部点击、`Esc` keydown、选中行后、再次点按钮 toggle。`registerDomEvent` 注册的监听随 view 卸载自动清理，不留全局泄漏。移动端（`mobileLayout`）仍走 `BottomSheet`。窄下拉不承载拖拽重排，溢出 tab 的排序入口在「管理 Tabs」面板。下拉容器与每行保留一等 `data-tab-id` / `data-query-tab-id` / `data-query-tab-dirty` / `data-query-tab-default` 属性，与原 sheet 行契约一致，便于 e2e 断言。
- 列表容器设置 `overscroll-behavior: contain`。
- CSS 禁止 `transition: all`。
- reduced motion 下动画时长 ≤ 50ms 但保留状态变化。

## 12. 样式架构

`styles.css` 只使用 Obsidian CSS 变量和插件自定义语义变量；不写硬编码颜色。

允许来源：

- `--background-primary` / `--background-secondary` / `--background-secondary-alt`
- `--background-modifier-border` / `--background-modifier-hover`
- `--interactive-accent`
- `--color-red` / `--color-yellow` / `--color-green`
- `--text-normal` / `--text-muted` / `--text-faint`
- `--shadow-s` / `--shadow-l`

TS 不写 inline 常量颜色。动画时长通过 CSS custom properties 管理，统一响应 `prefers-reduced-motion`。

## 13. 测试策略

### 13.1 单元测试

必须覆盖纯逻辑：

- parser：Obsidian Tasks 字段、tag、inline field、callout、空标题任务忽略。
- writer：字节级保留、emoji date、checkbox、inline field、tag、嵌套 plan、undo ops。
- task-tree：继承、父终态、独立日期子任务、顶层去重。
- query：filter、date token、view projection、summary、布局归一化（含 unknown area）。
- dates：中英自然语言日期、周起始日、ISO 写回。
- cli formatter：ok / unchanged / before-after / error code。
- i18n：用户字面不翻译。

### 13.2 集成测试

使用 fake App / fake Vault 覆盖：

- cache ensureAll 跳过无任务文件。
- 单文件 invalidate 只重解析目标文件。
- 写动作后 cache changed 时序。
- Quick Add Daily Notes guard。
- QueryPresetService GUI / CLI 共用 CRUD。
- 跨文件 nest 部分失败和 undo。
- path ref 不触发 ensureAll；hash disambiguation 可触发 ensureAll。

### 13.3 E2E

E2E 覆盖 UX 主路径：

- Query Tab CRUD、更多、隐藏、恢复、默认 tab。
- Query 编辑器可视化 / DSL 往返。
- 今日三组、改到明天、空状态。
- Week / Month 未排期 tray 改期与清空。
- List / Grid 配置渲染。
- 源 Markdown 编辑层定位、编辑、保存、刷新。
- Quick Add 成功 / Daily Notes 失败保留输入。
- 桌面拖拽改期、放弃、嵌套、非法目标、跨 tab dwell、undo。
- 移动端 week row、month inline day panel、swipe、任务详情 sheet、长按 action sheet、点选式日期 sheet、父任务选择器。
- CLI task 与 query 动词。
- i18n 热切换。

E2E 等待 cache 刷新时使用 `data-test-cache-version`，不使用固定 sleep。

## 14. 发布与 CI

发版要求来自 US-601~605：

- 严格 semver tag，不带 `v`，不带 pre-release。
- pre-flight gate：typecheck、lint、unit test、e2e。
- 每次发版更新 `versions.json`。
- Release body 从 PR / issue 标题按 conventional 前缀分组生成，可手动覆写。
- Release asset 挂 `main.js`、`manifest.json`、`styles.css`；禁止 build 产物 commit 回 main。
- Release job 在上传 asset 前为 `main.js`、`manifest.json`、`styles.css` 生成 GitHub artifact attestation；workflow 需要 `id-token: write` 与 `attestations: write` 权限。

CI 额外建议检查：

- 非 cache 模块不直接 `getMarkdownFiles()` 全量扫。
- 无 `metadataCache.on("resolved")` 新订阅。
- 视图 / 业务路径无硬编码示例 tag 或方法论字面。
- CSS 无硬编码颜色、无 `transition: all`。
- i18n 字符串不包含示例 hashtag / inline field 语法。

## 15. 实现不变量清单

每次实现或重构至少检查：

- [ ] Markdown 任务格式兼容 Obsidian Tasks 字段。
- [ ] 空标题任务不进入 Task Center。
- [ ] 未识别 token 字节级保留。
- [ ] Query filters / view / summary 共用同一 DSL。
- [ ] GUI Query 编辑器与 CLI Query 动词共用 schema 与校验。
- [ ] 没有独立持久化 current query。
- [ ] View 没有硬编码 TODO / 今日 / 未排期等业务分支；这些来自 QueryPreset。
- [ ] 未排期是 `time.scheduled is empty`，不是任务池。
- [ ] Week / Month tray 是 view 附加区，不污染主日期区集合。
- [ ] GUI / CLI 嵌套语义一致。
- [ ] 移动端不暴露拖拽 / hover / 快捷键。
- [ ] Daily Notes 不可用时不写 fallback。
- [ ] CLI error code 恒英文。
- [ ] 日期写回恒 ISO。
- [ ] Enter 提交守卫 IME composition。
- [ ] 所有写路径走 `vault.process`。
- [ ] 读路径走 TaskCache，不直接扫 vault。
