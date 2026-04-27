# ARCHITECTURE

> 这份文档讲**数据怎么存、模块怎么拆、性能怎么扛**。
>
> - 想知道**谁要什么 / 为什么** → [USER_STORIES.md](./USER_STORIES.md)（SSOT）
> - 想知道**界面长啥样、交互怎么走** → [UX.md](./UX.md)
> - 当前已知 bug 与 root cause → [BUG.md](./BUG.md)
>
> 每条架构决策都尽量回引 `US-xxx` 或 UX/BUG 锚点，方便双向追溯。设计结束之后，凡是新功能改动都按这份文档审。

---

## 0. 设计原则（与 UX 对齐）

1. **markdown 是 Truth**。所有可观察状态都来自 vault 里的字节；内存只允许有一份**派生缓存**，永远可以从文件全量重建。重启不丢任何业务状态。（US-401 / US-407）
2. **单一数据源**给状态栏 / 看板 / CLI 共用——不允许任何代码路径绕开缓存自己跑 `parseVaultTasks`。（UX §16-1，BUG.md #1/#2/#4）
3. **事件增量优先，全量重扫为禁忌**。任何依赖 `metadataCache.on("resolved")` 的全量路径都视为 P0 缺陷。增量路径只在被改的那个 `TFile` 上重新解析。（BUG.md #3/#4）
4. **写永远是字节级 + 原子**。不读了改、改了写，统一走 `app.vault.process(file, mutate)`，让 Obsidian 自己保证原子性；不写半个文件。（US-403 / UX §6.7）
5. **未识别 token 字节级保留**。任何 mutate 的输入是文件原始那一行，输出仍是同一行的最小修改版；emoji / inline field / block anchor / 优先级符号都按字节顺序保留。（US-407 / UX §6.5）
6. **CLI 与 GUI 走同一份业务逻辑**。CLI = thin wrapper over `TaskCenterApi`；GUI 也只调 `TaskCenterApi`。两边的"列表"、"渲染子任务"等都是同一个函数。（UX §16-6）

---

## 1. 数据模型

### 1.1 `ParsedTask` —— 一行任务的全部派生信息

```ts
type TaskStatus = "todo" | "done" | "dropped" | "in_progress" | "cancelled" | "custom";

interface ParsedTask {
  // —— 标识 ——
  id: string;          // "path:L42" — 唯一稳定 id（行号失效时回退 hash）
  path: string;        // 文件路径
  line: number;        // 0-based 行号
  hash: string;        // 12-char short hash of `${path}::${cleanTitle}`，行号失效时找回（US-208/214）

  // —— 字节级原文 ——
  rawLine: string;     // 文件里那一整行（含 indent、checkbox、所有 token）
  rawTitle: string;    // 去掉 indent/checkbox 后的内容部分
  indent: string;      // leading 空白 + callout (`> ` 链)
  marker: string;      // `-` `+` `*`
  checkbox: string;    // ` ` / `x` / `-` / `/` / `>` / 自定义

  // —— 派生展示字段 ——
  status: TaskStatus;  // 由 checkbox 推
  title: string;       // 去掉所有 emoji/tag/inline-field 之后的"干净标题"
  tags: string[];      // 字面带 `#`，按出现顺序

  // —— 时间 ——
  scheduled: string | null; // ⏳ YYYY-MM-DD
  deadline:  string | null; // 📅 YYYY-MM-DD
  start:     string | null; // 🛫 YYYY-MM-DD
  completed: string | null; // ✅ YYYY-MM-DD
  cancelled: string | null; // ❌ YYYY-MM-DD
  created:   string | null; // ➕ YYYY-MM-DD

  // —— 时长 ——
  estimate: number | null;  // 分钟数
  actual:   number | null;  // 分钟数

  // —— 关系（仅同文件，跨文件用 nestRef，见 1.3） ——
  parentLine:    number | null;
  parentIndex:   number | null;     // listItems[].parent 的原值
  childrenLines: number[];

  // —— 继承 ——
  inheritsTerminal: boolean; // 任一祖先是 [x]/[-] 或 #dropped → 在活动 tab 隐藏

  // —— 缓存元数据 ——
  mtime: number; // file.stat.mtime；undo 时用来做 drift 检测（UX §16-3）
}
```

**为什么把 `rawLine` 也保留**：写路径要靠它做 drift detection（"我读到的那一行还是不是你认为我要改的那一行"），undo 要用它生成"前一版字节"。让派生字段方便消费、让原文方便回写。

### 1.2 `TaskRef` —— CLI / 拖拽 / undo 通用的引用

```ts
type TaskRef =
  | { kind: "line";  path: string; line0: number }   // path:Lnnn（用户给的是 1-based，内部用 0-based）
  | { kind: "hash";  hash: string }                  // 12 hex chars，行号失效时回退
  | { kind: "task";  task: ParsedTask };             // 已解析好的对象（避免再解析）
```

`resolveRef(ref): ParsedTask | error` 是单入口。错误集合：

| 错误 | 何时 |
| --- | --- |
| `not_found` | path/line 都不在缓存 + hash 也不在 |
| `ambiguous_slug` | hash 撞多条 → 返回候选列表，**绝不猜**（US-208 / US-214） |
| `out_of_date` | path:Lnnn 在文件里不再是 task 行，但 hash 找到 → 走 hash 命中（warn 一行） |

### 1.3 `Cache<path, {mtime, tasks: ParsedTask[]}>` —— 一份共享缓存

```ts
interface FileEntry {
  mtime: number;
  tasks: ParsedTask[];   // 同文件按 line 升序
  hasTaskListItem: boolean; // 缓存 metadataCache 的快速判断结果
}

class TaskCache {
  // 关键：只解析有任务的文件，没有任务的文件 hasTaskListItem=false 直接跳（BUG.md #1）
  private byPath: Map<string, FileEntry> = new Map();
  private byHash: Map<string, ParsedTask[]> = new Map(); // hash 不唯一时一对多

  // 操作
  invalidateFile(path: string): void;     // 单文件失效（事件驱动）
  ensureFile(path: string): Promise<FileEntry>; // 懒加载该文件
  ensureAll(): Promise<ParsedTask[]>;     // 全量返回（首次开看板用，懒加载所有有任务的文件）
  get(path: string): FileEntry | undefined;
  flatten(): ParsedTask[];                // 按 path 字典序展平，给 list/筛选用
  on(event: "changed", cb: (paths: Set<string>) => void): () => void;
}
```

**禁止**：暴露 `parseVaultTasks(app)` 直接给 `view` / `status-bar` / `cli` 调用——所有调用必须经 `TaskCache`。`parser` 模块只负责"给我一个文件的内容，吐 ParsedTask 数组"，**不**做 vault 遍历。

### 1.4 跨文件父子链

`ParsedTask.parentLine` 只表示**同文件内**的父任务行号。跨文件嵌套（US-125 / US-228）通过下面两件事一起表达：

1. **物理移动**：执行 `nest` 时把 child 的整个子树**真正搬到** parent 的文件里、parent 行的子级末尾，并按 parent indent + 4 空格重新缩进（writer 已实现 `planCrossFileNest`）。所以"嵌套之后" parent 和 child 在同一个文件里，`parentLine` 直接生效。
2. **不维护跨文件指针**：内存里**不存** "child 的虚拟父在另一个文件" 的关系；那种关系只在拖拽落定的瞬间存在，落定即物理化。这避免缓存里出现"父在 A 文件、子在 B 文件"的悬空引用。

> **实现要点**：跨文件 nest 必须先写 parent 文件、再写 child 文件。中途崩溃时 parent 多了一份，child 还在原处——比"child 没了 + parent 没收到"安全得多。失败时 toast 提示用户手动收尾（writer 已实现这个顺序）。

---

## 2. 模块拆分

```
src/
├── parser.ts        纯函数：line → ParsedTask；file content + listItems → ParsedTask[]
├── cache.ts         TaskCache（新模块，从 main.ts 抽出）
├── writer.ts        所有写动词：set*, mark*, addTask, nestUnder, applyUndoOps（已存在）
├── cli.ts           TaskCenterApi（业务层）+ formatList/formatShow/formatStats（输出层）
├── view/            看板视图（拆细，目前 view.ts 太大）
│   ├── view.ts          ItemView 主体 + 事件订阅
│   ├── tabs/
│   │   ├── week.ts
│   │   ├── month.ts
│   │   ├── completed.ts
│   │   └── unscheduled.ts
│   ├── card.ts          单卡渲染（含子任务递归）+ 状态机
│   ├── tree.ts          box-drawing 树渲染（CLI 与 GUI 复用，UX §16-6）
│   ├── dnd.ts           拖拽 controller（含 rAF dwell timer，UX §16-8）
│   ├── source-dialog.ts 源 Markdown 编辑 shell/controller（US-168）
│   └── undo.ts          UndoStack（深 20，drift 校验）
├── status-bar.ts    状态栏（订阅 cache，不再 rescan）
├── quickadd.ts      QuickAdd modal
├── settings.ts      设置面板
├── i18n.ts          字符串集（zh-CN / en）
├── dates.ts         日期工具
├── anim.ts          动画工具
├── types.ts         共享类型
└── main.ts          Plugin 主体：注册 view / commands / cli / status-bar / 事件路由
```

### 2.1 模块边界（强约束）

| 模块 | 允许调用 | 不允许调用 |
| --- | --- | --- |
| `parser` | 标准库、Obsidian 类型 | `cache` / `writer` / `view` / `cli` |
| `cache` | `parser`、Obsidian `App/TFile/metadataCache` | `writer` / `view` / `cli` |
| `writer` | `parser`、Obsidian `App/TFile/vault.process` | `cache`（写完触发事件，由事件驱动 cache 失效） |
| `cli` (TaskCenterApi) | `cache` / `writer` / `parser`（仅纯函数） | `view` / DOM |
| `view` | `cache` / `cli` / `writer` 通过 cli | 直接 `parseVaultTasks` |
| `status-bar` | `cache` | `parseVaultTasks`、`writer` |
| `main` | 所有模块 | — |

**关键反向约束**：
- `cache` **不**直接调 `writer`；写完后通过 `vault.modify` 事件回流到 `cache.invalidateFile`。
- `view` **不**自己订阅 `metadataCache.on("resolved")`（BUG.md #3）。订阅只在 `cache` 一处。
- `status-bar` **不**自己 `parseVaultTasks`。这是 BUG.md 的根本原因。

### 2.2 Source edit panel / shell（US-168）

点击卡片的查看/编辑路径统一为 source edit panel。旧的 hover popover、卡片双击打开源文件、右键菜单打开源文件都应删除，避免三套入口表达同一能力。#78 spike 的结论是：Obsidian public API 不能把原生 `MarkdownView` 安全嵌入 plugin `Modal`，所以这里的 "dialog" 是产品形态/控制器，不是纯 `Modal` 容器。

```
Task card click
  → TaskCenterView.openSourceDialog(task)
  → SourceEditDialog.open(task)
  → resolve TFile(task.path)
  → open a real WorkspaceLeaf + MarkdownView
  → editor.setCursor({ line: task.line, ch: 0 })
  → editor.scrollIntoView({ from/to: task.line }, true)
  → dialog-like shell controls close / reveal / refresh
  → on close / vault modify → cache invalidation → board refresh
```

**硬约束**：

- 编辑内容必须来自真实 `WorkspaceLeaf + MarkdownView`，不能用 `MarkdownRenderer` 只读渲染替代，也不能伪造 `WorkspaceLeaf` 或搬运 workspace leaf DOM 到 `Modal.contentEl`。
- 定位使用 Obsidian editor API：`MarkdownView.editor.setCursor()` + `editor.scrollIntoView(range, true)`。当前 `openAtSource()` 已在普通 leaf 路径里验证这组 API 可用；新对话框必须复用同一定位语义。
- 旧 `ContextPopoverController` / `view/popover.ts` 不再需要；实现任务必须删除 hover popover 代码、样式、测试和文档引用，而不是只在打开 dialog 前关闭它。
- 写回仍走 Obsidian editor / vault 原生保存语义；不要在 dialog 里另写一套 parser/writer。看板只通过既有 vault/cache 事件刷新。
- `openAtSource()` 普通 leaf 行为只能作为实现过渡工具存在；最终用户路径不再暴露右键"打开源文件"或卡片双击跳源文件。
- `docs/source-edit-dialog-spike.md` 是本架构决策的证据文件；后续实现如果偏离真实 leaf 路径，必须先更新 spike 证据并经 PM/Jerry 确认。

**模块边界**：

- `view/source-dialog.ts` 只处理 Obsidian UI 生命周期、真实 leaf 打开、光标定位、关闭和 refresh callback。
- 它可以依赖 `App` / `WorkspaceLeaf` / `MarkdownView` / `TFile` / `ParsedTask`，但不依赖 `TaskCenterApi` 写动词。
- `view.ts` 只负责把卡片 click 事件路由到 `openSourceDialog(task)`，并阻止按钮 / drag / contextmenu 冒泡误触发；不得继续给卡片绑定 `dblclick → openAtSource`。
- 测试以 e2e 为主：点击卡片后断言 source edit shell 出现、真实 Markdown editor 内容包含源文件上下文、当前任务行居中或至少 cursor line 正确、修改子任务后 vault 文件变更并刷新卡片。

---

## 3. 缓存与事件

### 3.1 事件订阅总图（唯一路径）

```
        ┌─────────────────────────────────────┐
        │       Obsidian VaultEvents          │
        │  modify / create / delete / rename  │
        └──────────────┬──────────────────────┘
                       │ (单一订阅源)
                       v
                  ┌────────────┐
                  │  cache.ts  │ invalidateFile(path)
                  └─────┬──────┘
                        │
           "changed" event {paths: Set<string>}
                        │
        ┌───────────────┼────────────────┐
        v               v                v
  status-bar.ts    view.ts         (其他订阅者)
  (debounced 500ms) (debounced 400ms)
```

- **`cache` 是唯一**订阅 vault / metadata 事件的模块。
- `view` 与 `status-bar` 都订阅 `cache.on("changed")`，根据 `paths` 做局部 / 全量再渲染。
- **`metadataCache.on("resolved")` 完全不订阅**——这是 BUG.md #3 的根因，没有合法用途。所有 metadata 变化通过 `metadataCache.on("changed", file)` 单文件回调走 `invalidateFile(file.path)`。
  - 如果某个文件之前没被 metadata 索引到、刚刚索引到，会以 `changed` 事件单文件抵达，cache 自然在那时解析它——不需要任何 vault 级"全部重新审视一遍"的钩子。

### 3.2 缓存的生命周期

| 时机 | 行为 |
| --- | --- |
| `onload` | 创建空 `TaskCache`；不预热。 |
| 状态栏首次刷新 | **不**触发 `ensureAll()`。状态栏被动累积：cache 因 `metadataCache.changed` 单文件抵达而逐渐变大，状态栏数字也跟着变大。BUG.md #4 "启用就卡死" 必须从源头杜绝——没有任何"状态栏需要全量底数"的路径。 |
| 看板首次打开 | `cache.ensureAll()` 唯一触发点。仅遍历 `hasTaskListItem===true` 的文件，并发 32 限速。 |
| 文件 modify | `metadataCache.changed` → `cache.invalidateFile(path)` → **eager** 重解析这一个文件（不懒）→ 解析完成后 emit `cache.changed({paths: [path]})`。订阅者在 changed 回调里调 `flatten()` 拿到的是已经包含新解析结果的快照。 |
| 文件 rename | invalidate 旧 path + 新 path；逐 file 重映射所有缓存的 `ParsedTask.path`（不重新解析）。 |
| 文件 delete | `cache.byPath.delete(path)` + 从 `byHash` 中删除该 path 的 hash → `changed`。 |
| `onunload` | 清空 cache，取消订阅。 |

### 3.3 关键不变量

- **没有 full vault rescan 路径**。任何代码改动如果写出 `parseVaultTasks(app)` 直接调用 → CI 中通过 grep 拦截：`forbidden in main.ts/view.ts/status-bar.ts/cli.ts`。仅 `cache.ts` 内部的 `ensureAll()` 允许遍历，且**只解析 `hasTaskListItem===true` 的文件**。
- **没有"双订阅"**。BUG.md #3 的 root cause 是 `main.ts` 与 `view.ts` 同时订阅 `metadataCache.resolved`。新架构下只有 `cache` 订阅原始事件，所有其他模块订阅 `cache.changed`。
- **没有"未打开看板就跑全量"**。`status-bar` 的刷新逻辑只读 `cache.flatten()`；cache 还小（未打开过看板时）状态栏数字也小，被动累积，**绝不**为状态栏触发 `ensureAll`（UX §13 / BUG.md #4）。
  - **实现**：`status-bar` 仅监听 `cache.changed`；`cache` 在每个 `metadataCache.changed(file)` 单文件回调里**eager** 解析涉及的文件——**只解析这一个文件**，不预热全量。状态栏由"逐渐变多"而不是"一开始就全有"。这避免了"启用插件就卡死"。
  - **trade-off**：未打开看板时状态栏的 today/overdue 计数可能短期偏低（尚未访问的文件没解析到）。这是设计选择——优于卡死。打开看板一次后，cache 全量化，状态栏立刻准确。

### 3.4 cache.changed 与 flatten 的时序契约

为避免订阅者读到半成品状态，定义如下严格时序：

| 接口 | 同步 / 异步 | 时序保证 |
| --- | --- | --- |
| `invalidateFile(path)` | sync 入口 + 内部 async 重解析 | 调用立即返回；内部启动该 file 的 eager re-parse |
| `cache.changed({paths})` 事件 | async emit | **保证在 paths 中所有 file 的 re-parse 完成之后**才 emit。订阅者在回调里 `flatten()` 拿到的就是 post-reparse 状态 |
| `flatten(): ParsedTask[]` | sync | 返回**当前 byPath 的快照**。在 invalidateFile 与下一次 changed 之间调用，可能拿到旧或新——所以**禁止在 changed 之外的随机时机 flatten**，订阅者全部走 changed 触发 |
| `ensureFile(path): Promise<FileEntry>` | async | 强制等待该文件解析完成（如果在解析中则复用 in-flight Promise）。CLI 写动词的 ref 解析路径专用 |
| `ensureAll(): Promise<ParsedTask[]>` | async | 仅在打开看板时调用一次；并发解析所有 `hasTaskListItem` 文件后 emit 一次大 changed，view 在 await 后 render |

**实现细节**：
- `invalidateFile(path)` 内部维护一个 `pending: Map<path, Promise<FileEntry>>`。多次 invalidate 同一 path 在解析未完成时复用同一个 Promise（去抖）。
- 解析完成后**先**写回 `byPath` / `byHash`，**再** emit `changed`。顺序错了 → 订阅者读到旧数据。
- view / status-bar 收到 changed 后调 `flatten()` 是同步、安全的——cache 已经 post-reparse。

**反例**（禁止）：
```ts
// ❌ 错：可能拿到 invalidate 后、reparse 前的中间态
cache.invalidateFile(path);
const tasks = cache.flatten();
view.render(tasks);

// ✅ 对：等 changed
cache.on("changed", () => view.render(cache.flatten()));
cache.invalidateFile(path);
```

---

## 4. 写路径

### 4.1 通用 mutate 模板

每个写动词都走同一个骨架（已在 `writer.ts/mutateLine` 实现）：

```ts
async function mutateLine(app, path, line, mutate: (raw: string) => string | null) {
  await app.vault.process(file, (data) => {
    const lines = data.split("\n");
    const original = lines[line];
    if (!parseTaskLine(original)) {
      throw new TaskWriterError("task_not_found", `${path}:L${line + 1} not a task line`);
    }
    const next = mutate(original);
    if (next === null || next === original) return data;  // 幂等：unchanged
    lines[line] = next;
    return lines.join("\n");
  });
  // 写完成功后：返回 {before, after}；事件订阅自动触发 cache.invalidateFile
}
```

**重要**：`vault.process` 回调内**永远 `throw new TaskWriterError(code, hint)`**，不要 `throw "string"`——后者破坏 `instanceof TaskWriterError` 判定，上游的 code/hint 路由会失效。

**幂等保证**（US-203）：`mutate` 返回 `null` ⇒ unchanged；`writer` 各动词在 mutate 里检测目标态相同，不写文件（例：`markDone` 先看是否已 `[x] ✅ 同日期`）。

### 4.2 跨文件原子性

`app.vault.process` 是单文件原子。跨文件 nest 不存在跨文件事务，做法（已在 `nestUnder` 实现）：

1. **快照检查**：读 child 当前内容，比对 `child.rawLine` 与 `child.line` 处实际内容。不匹配 → `task_not_found`（drift），中止。
2. **先写 parent**：`vault.process(parentFile, …)`；同样校验 parent 行未漂移。
3. **再写 child**：`vault.process(childFile, …)`；如果失败，parent 已经有了一份 child 子树。**不回滚 parent**，而是 throw 一个 `nest_partial` 带两个文件路径的错误，让 GUI toast / CLI stderr 把责任交给用户手动处理。

> **设计权衡**：宁愿"重复一份"也不愿"丢一份"。重复可见、丢失不可见。

#### 失败操作的 Undo 语义（UX §16-4 / §6.7）

UX 硬约束 #4 要求 "拖拽嵌套真的跨文件移动行，撤销必须能回退"。失败的 nest 也要进 Undo 栈，规则：

| 失败阶段 | 文件状态 | Undo 栈记录 | 撤销时做什么 |
| --- | --- | --- | --- |
| 步骤 1 快照失败 | child / parent 都未改 | **不入栈**（什么都没发生） | — |
| 步骤 2 parent 写失败 | child / parent 都未改 | **不入栈** | — |
| 步骤 3 child 写失败（"重复"状态） | parent 多了一份子树，child 原样 | **入栈**：`undoOps = [{ which: "parent", line: insertIndex, before: [], after: reindented }]` | 撤销时仅删除 parent 那份多余子树（`applyUndoOps` 倒序应用）；child 没动，不需要还原 |
| 步骤 3 成功（正常路径） | parent 有子树，child 行已删 | **入栈**：完整 `undoOps`（parent 插入 + child 删除两条 op） | 倒序：先把 child 删除的行恢复回去，再把 parent 多的行删掉 |

实现层面：`nestUnder` 的返回签名已经是 `{ before, after, unchanged, crossFile, undoOps: UndoOp[] }`——失败"重复"路径下返回**仅含 parent 插入那一条 op** 的 `undoOps`，由 view 入栈，toast 文案多加一行 "撤销可移除 parent 那份重复"。`UndoStack.pop()` 的内容比对（§6.2 修订）同样适用——只要 parent 文件中那段插入的内容仍在原处，撤销干净；如那几行被外部改了 → 内容 diverge → 拒绝撤销。

### 4.3 行号失稳（line drift）

任何写动作的 `mutate` 都会在 `vault.process` 内部重新读到最新文件内容，并校验：

- 目标行存在
- 目标行仍是 task 行（`parseTaskLine` 匹配）
- 跨文件场景下额外校验 `lines[child.line] === child.rawLine`

不满足任意一条 → `TaskWriterError("task_not_found", ...)`，UI 弹 toast：`⚠ 任务行已被外部修改，请刷新后重试`。

### 4.4 Callout 任务（US-406）字节级保留

Obsidian callout 里的任务行形如 `> - [ ] task` 或多层 `>>>  - [ ] task`。`parseTaskLine` 的正则已经 capture `indent = (\s*(?:>\s*)*)` 把 callout 链整体当作"前缀"。所有 mutate（`setEmojiDate` / `setInlineField` / `setCheckbox` / `addTagIfMissing` / `rebuildTaskLineWithNewTitle`）的实现都只对 indent 之后的部分操作，indent 字节原样保留。同样 `extractTaskBlock` 的 `indentLen()` 会把 callout 链长度算进缩进深度，跨文件 nest 时 callout 任务移到新文件后 callout 链按目标位置上下文重新算（如果目标在普通段落，callout 链丢——这是合理的"上下文跟着新位置"）。

**测试要求**：`writer.test.mjs` 必须有一个 `nested-callout-rewrite` case：
- 输入：`>> - [ ] task #foo ⏳ 2026-04-25`
- 操作：`setEmojiDate(line, "⏳", "2026-04-26")`
- 断言：输出 `>> - [ ] task #foo ⏳ 2026-04-26`（`>>` 前缀字节不变）
- 同测：rename / addTag / setActual 各一份，覆盖所有 mutate 函数。

### 4.5 写后回路（cache → view）

写完成→ Obsidian 触发 `vault.on("modify", file)` → `cache.invalidateFile(file.path)` → 异步重解析这一个文件 → `cache.changed({paths: [path]})` → view debounce 400ms 重渲染。

**为什么不用同步通知**：写动作可能由 CLI 触发（无 UI），由 view 订阅 cache 是天然的扇出，避免 writer 知道下游有谁。

---

## 5. CLI 调度

### 5.1 入口契约

```ts
this.registerCliHandler("task-center:<verb>", description, schema, (args) => this.cli<Verb>(args));
```

每个 verb 的实现走同一个骨架（已在 `main.ts:registerAllCliHandlers` 现成）：

```ts
private async cli<Verb>(args: CliArgs): Promise<string> {
  const ref = parseRef(args.ref);                  // 不接 allTasks
  const task = await this.cache.resolveRef(ref);   // 单文件 resolve
  const result = await writer.<verb>(this.app, task, …);
  // 写完异步刷新看板（不 await）：refreshOpenViews()
  return formatOk(task, result.before, result.after, result.unchanged, "<verb>");
}
```

**关键变化**（修 BUG.md #2）：**没有 verb 在入口跑 `allTasks()`**。

- `list` / `stats` 是只读且需要全集的，仍走 `cache.flatten()` —— 但 cache 已加载就秒回，未加载也只解析涉及的文件子集（`hasTaskListItem` 跳过非任务文件）。
- 写 verb（`schedule / done / drop / nest / …`）的 `ref` 解析改为：
  - `path:Lnnn` → 直接 `cache.ensureFile(path)`，单文件解析后查那一行 → ParsedTask。
  - `hash` → 看 `cache.byHash`；如果 cache 还没加载到包含该 hash 的文件，调一次 `ensureAll()`。一旦预热过，后续都走单文件路径。

> **澄清 vs §3.3 "没有 full vault rescan 路径"**：那条约束的精确语义是"写 verb 入口禁止直接 `parseVaultTasks` 或重复 `allTasks()`"（修 BUG.md #2 的全表反复扫）。`ensureAll()` 是 cache 的全 vault 一次性预热，仅扫 `hasTaskListItem===true` 的文件、整 session 只发生一次（hash 路径触发 / 打开看板触发）——这是预期成本，不是 BUG.md 反例。

### 5.2 输出形态

`formatList` / `formatShow` / `formatStats` / `formatOk` / `formatAdd` / `formatError` 已在 `cli.ts` 实现并满足 UX §14：

- 第一列恒为稳定 id（US-202 / UX §14.2-1）
- 不输出 JSON / YAML（US-205 / UX §14.2-2）—— `format=json` 仍存在但**仅供调试用**，文档不推荐
- 多行块用 `├ └` box-drawing（UX §14.2-4 / §16-6）
- 写动词输出 `ok / before / after`（US-204）
- 幂等 unchanged 仍返回 `ok` 不是 `error`（US-203）

### 5.3 错误形态

错误统一走 `formatError(code, message)`，code 集合（UX §14.3）：

```ts
type ErrorCode =
  | "not_found"
  | "ambiguous_slug"
  | "out_of_date"
  | "invalid_date"
  | "write_conflict"
  | "read_only"
  | "invalid_nest";
```

`TaskWriterError` 的 `code` / `hint` 直接映射成两行输出。绝不猜（US-214）：`ambiguous_slug` 一定列候选。

### 5.4 树渲染共享

`view/tree.ts` 导出一个纯函数 `renderTaskTree(roots: ParsedTask[], all: ParsedTask[]): TreeNode[]`，TreeNode 是中性结构（`{depth, label, meta}[]`）。CLI 把它转 box-drawing 文本；GUI 把它转 DOM。**两边走同一份 traversal + 排序规则**（UX §16-6）——但**渲染层各自适配**：CLI 用 `├ └ │` 字符；GUI 用原生 DOM 嵌套（卡内层级缩进 16px）。

> **2026-04-25 决策**：`view/tree.ts` 在 task #9 view 拆分时**未抽出**——理由是当前 GUI 不渲染"树形态"（卡内子任务用原生 DOM 嵌套，不是 box-drawing），CLI 是 tree 渲染的唯一消费者，没有第二客户拉抽象。日后若 GUI 真要渲染树形（如 outline view）再抽。Hard 约束（共享 traversal/sort）仍有效，目前 CLI 内部封装即可。

---

## 6. Undo 栈

### 6.1 边界

- **范围**：仅 view 内发起的字节级写动作（拖拽 / 改期 / 改名 / 完成 / 放弃 / 嵌套 / quick-add）。CLI 写**不**入栈。（UX §6.7）
- **深度**：20。超出从底部丢弃。
- **持久化**：内存。关闭 leaf / 重启 Obsidian 即清空。栈是 UI 状态，不是文件级（UX §16-3）。

### 6.2 数据结构

```ts
interface UndoOp {
  path: string;
  line: number;        // 操作起点
  before: string[];    // 操作前那一段 lines
  after: string[];     // 操作后那一段 lines
}

interface UndoEntry {
  label: string;       // toast 用
  ops: UndoOp[];       // 多 op，按写入顺序；undo 时倒序应用
}
```

> **2026-04-25 修订**：原稿额外存 `capturedMtime: Map<string, number>` 做 mtime 比对；实际实现（`view/undo.ts`）走的是**内容比对**，更精确。下面段落已更新。

`UndoStack.pop()`（`view/undo.ts`）反向应用 ops：对每个 op 调 `vault.process(file, mutate)`，**写入前逐行内容比对** `lines[op.line + j] === op.after[j]`——如果当前文件里"我们写过的那几行"和栈里记录的 `after` 不一致，throw 一个 divergence 异常，catch 里 notify 用户 + 不再 push 回栈，撤销整体中止；toast：`⚠ cannot undo: content diverged at <path>:L<n> — skipping undo`（UX §6.7）。

**为什么内容比对优于 mtime 比对**（决策 2026-04-25）：mtime 会因 Obsidian 自身的 backlink / metadata 写入、或文件别处的非冲突编辑而被动跳变，把"安全的撤销"误挡掉。内容比对精确到 `op.line ~ op.line + op.after.length` 那几行，**只在实际被外部改写时**才拒绝。符合用户期望"我没动你写的，撤回去就行"。

### 6.3 与写路径协作

- `setScheduled` / `markDone` / `nestUnder` / `addTask` / `markDropped` / `renameTask` 都返回 `{ before, after, … , undoOps?: UndoOp[] }` 或可由调用方组装出 undoOps。
- 跨文件 nest 已经返回 `undoOps`，标注两个文件。

### 6.4 与 Obsidian 编辑器 undo 的边界

`Ctrl+Z` 在 Obsidian 里**已经**是编辑器的撤销键。我们的看板 UndoStack 与编辑器 undo 必须明确分轨，否则用户在另一个 leaf 编辑笔记时按 `Ctrl+Z` 会被插件吃掉，灾难。

**判定规则**（plugin 注册命令时）：

```ts
this.addCommand({
  id: "undo-board-action",
  name: tr("cmd.undo"),
  hotkeys: [{ modifiers: ["Mod"], key: "z" }],
  checkCallback: (checking) => {
    // 仅当焦点在 task-center view 且 UndoStack 非空时拦截
    const active = this.app.workspace.activeLeaf;
    const isOurView = active?.view instanceof TaskCenterView;
    const hasEntry = isOurView && (active.view as TaskCenterView).undoStack.size > 0;
    if (checking) return hasEntry;
    if (hasEntry) (active.view as TaskCenterView).undo();
    return true;
  },
});
```

`checkCallback` 返回 `false` 时 Obsidian 会让 `Ctrl+Z` 走默认路径（编辑器 undo / no-op）。要点：

- **看板 leaf 焦点 + UndoStack 非空** → 我们处理
- **任何其他 leaf 焦点（编辑器、daily note、…）** → Obsidian 自己处理
- **看板焦点但栈空** → 不拦截，让 Obsidian 看是否有它的 undo 路径（一般没有，no-op）
- **不绑定 `Ctrl+Shift+Z`**（重做）——v1 不做重做，避免栈语义与编辑器 redo 打架

> 反例：v1 一上线必有用户报"Ctrl+Z 把我笔记改坏了"，根因往往是命令注册时 `callback` 直接拦截而没用 `checkCallback`。

### 6.5 重做（v1 不做）

UX 没列重做需求，v1 不实现，避免栈语义与 Obsidian 自身 undo 冲突。`Ctrl+Shift+Z` 不绑定。

---

## 7. 性能预算

| 指标 | 预算 | 实现方式 |
| --- | --- | --- |
| **打开看板首次** | ≤ 1.5s（≤ 1 万文件、≤ 5000 任务） | cache 懒加载，仅解析 `hasTaskListItem` 的文件；并行 `cachedRead`（`Promise.all` 限 32 并发） |
| **打开看板二次** | ≤ 200ms | cache 命中，直接 `flatten()` |
| **拖拽落定 → 渲染** | ≤ 100ms | 写文件 + 单文件 invalidate；view 在 `metadataCache.changed` 后立即 render（绕过 400ms debounce） |
| **状态栏更新** | ≤ 1s | cache 单文件失效后 500ms debounce；不阻塞主线程 |
| **未打开看板 (BUG.md 场景)** | "插件感觉不存在" | 不预热 + 不订阅 resolved 全量 + 状态栏只反应 `cache.changed` |
| **首次大 vault 索引完毕之前** | 状态栏可显示 `📋 …` | `cache.changed` 慢慢累计；状态栏不主动等 |

### 7.1 关键优化点

1. **`hasTaskListItem` 快速跳过**：

   ```ts
   const meta = app.metadataCache.getFileCache(f);
   if (meta !== null && !meta.listItems?.some(li => li.task !== undefined)) {
     continue;  // 已索引、确认无任务 → 跳过
   }
   // meta === null（metadata 还没索引到这个文件）→ 不能跳过，必须解析
   ```

   ⚠️ 关键：`getFileCache(f)` 在 metadataCache 还没索引该文件时返回 `null`，**不能**当作"无任务"短路，否则首启动期间未索引的 task 文件会被静默丢弃。`null` 必须当 "未知 → 解析"。已索引的文件如果 `listItems.some(task !== undefined) === false`，才安全跳过。比 `cachedRead + regex` 快 100x；6589 文件 vault 实测跳过 6000+。
2. **限并发**：`Promise.all` 一把全开会让 main thread 排队；用 32 并发的简单池（实现：手写一个 `mapLimit`，<30 行）。32 是经验初值——预期能跑通 BUG.md repro 的 6589-file vault；遇到全任务 vault（5000+ 解析）卡顿再下调到 16 / 8 评估。

   **错误隔离策略**：`mapLimit` 内部对单文件解析失败**只 `console.warn(file.path, err)`、不向上传播**，整批继续。原因：vault 级批处理一个文件挂掉就全空白对用户毫无价值，已知失败的几个跳过、显示其余的远好。失败文件下次 `metadataCache.changed` 触发时还会再被尝试解析。`__stats.parseErrCount` 同时加 1 用于性能 / 健康监控。
3. **不预解析子任务关系**：`parentLine/childrenLines` 在 `parseFileTasks` 内部完成，不需要二次 pass。
4. **`renderTabBar` 缓存计数**：`cache.changed` 一次重算 4 个 tab 的计数，存到 view state，render 直接读（修 BUG.md #5）。
5. **`renderTree` 用 `DocumentFragment`**：构造完一次性 append，避免 reflow。

### 7.2 兜底：超 5s 的 vault

如果 cache 全量解析 > 5s（用 `performance.now()` 测）：

- view 主区显示 `⏳ 正在解析 vault... (N/M files)` 进度条 + 取消按钮（UX §8.4）。
- 取消 = 中止剩余文件解析；已解析的部分照常显示。
- 不阻塞状态栏；状态栏可能数字不准，但不卡。

---

## 8. 测试切面

> 与 @Rally 的 e2e 改造（task #1）对齐：架构层把"可测试切面"定清楚，让 e2e 不会被 race。

### 8.1 测试金字塔

```
       ┌────────────┐
       │  e2e (wdio)│   真 Obsidian + 真 vault → 整个流程
       └────┬───────┘
            │
       ┌────┴───────┐
       │ integration│   parser+cache+writer 联动（无 Obsidian DOM）
       └────┬───────┘
            │
       ┌────┴───────┐
       │   unit     │   parser 纯函数 / writer pure planner / cli formatter
       └────────────┘
```

### 8.2 单元（`node --test`，无 Obsidian）

| 模块 | 覆盖目标 |
| --- | --- |
| `parser.ts` | `parseTaskLine` / `parseTaskFromLine` / `cleanTitle` / `shortHash` / `parseDurationToMinutes` / `formatMinutes` |
| `writer.ts` | `setEmojiDate` / `setInlineField` / `setCheckbox` / `addTagIfMissing` / `rebuildTaskLineWithNewTitle` / `planSameFileNest` / `planCrossFileNest` / `applyUndoOps` |
| `cli.ts` | `filterTasks` / `computeStats` / `formatList` / `formatShow` / `formatStats` / `formatOkWrite` / `formatError` / `parseTaskId` |
| `dates.ts` | `resolveWhen` / `isoWeekNumber` / `daysBetween` / `addDays` / `startOfWeek` |
| `i18n.ts` | hashtag/emoji 字面不被翻译路径覆盖 |

> 现状：`parser.test.mjs` / `writer.test.mjs` / `cli.test.mjs` / `quickadd.test.mjs` 已存在；新加：`cache.test.mjs`（用 fake App 模拟 metadataCache + vault）、`tree.test.mjs`（box-drawing 渲染）。

### 8.3 集成（`node --test`，fake App）

`test/obsidian-stub.mjs` 已经造了一个最小 App。扩展用例：

1. **cache 增量失效**：mock 一个 6 文件 vault，调用 `cache.ensureAll()`，断言 5 个被 `hasTaskListItem` 跳过、1 个被解析；触发 `vault.modify(f1)`，断言只 f1 被重解析。
2. **跨文件 nest**：mock 两个文件，调 `nestUnder`，断言两个文件内容都对、`undoOps` 能成功 reverse。
3. **drift 检测**：撤销前外部改写"被撤销的那几行"，断言 `UndoStack.pop()` 抛"content diverged"并停止应用（内容比对，2026-04-25 修订；不再用 mtime）。
4. **CLI 入口不全扫**：mock cache 只有一个 hot path `ensureFile`，断言 `cli.schedule(ref="path:L42")` 只调用了一次 `ensureFile(path)`，**没有** `ensureAll()`。

### 8.4 e2e（wdio + Obsidian Sandbox）

按 UX §17 验收 checklist 一对一覆盖。重点 race-free 切面：

1. **拖拽落定后等待 cache changed**：e2e 不用 `sleep(N)`，等 `data-test-cache-version` 属性递增（view 在每次 `cache.changed` 后递增 dataset attr）。让 Rally 的 e2e 能 `expect(elem).attr("data-test-cache-version", v + 1)`。
2. **写动词 idempotent 测试**：连续两次 `task-center:done ref=…`，断言第二次 stdout 含 `unchanged`。
3. **大 vault 启用插件不卡**：性能 budget 测试，`enable plugin → wait for ready → expect time < 3s`。
4. **`prefers-reduced-motion` 启用时动画降级**：mock `matchMedia`，断言 transitions 时长 ≤ 50ms。

### 8.5 测试钩子（架构层暴露）

| 钩子 | 用途 |
| --- | --- |
| `view.contentEl.dataset.testCacheVersion` | e2e 等待 cache 重建 |
| `cache.__stats: { ensureCount, parseCount, skipCount }` | 性能回归测试 |
| `plugin.__forFlush()` | 测试时主动等所有 debounced timer 完成 |

> **不**暴露 `NEXT_PUBLIC_E2E` 之类的 production 路径分支。这些钩子永远存在、不消耗性能、不改变行为。

### 8.6 DOM 选择器契约（与 @Rally e2e 对齐）

为让 e2e 用语义选择器、不耦合 CSS 实现细节，view 必须提供下列稳定的 `data-*` 属性。重构 view 时这些属性是合同的一部分，**改名 / 删除 = breaking change，必须同步改 e2e**。

| 选择器 | 元素 | 含义 |
| --- | --- | --- |
| `[data-task-id="<path:Lnnn>"]` | 卡片根元素 | 唯一定位一张任务卡（包括子任务） |
| `[data-date="YYYY-MM-DD"]` | 周视图列体、月视图日期格 | 拖拽 drop target；e2e 用它定位某天 |
| `[data-tab="week|month|completed|unscheduled"]` | tab 头 | 切 tab |
| `[data-drop-zone="trash"]` | 底部垃圾桶 | 拖拽 drop target；**移动端 + 桌面同时存在两个 DOM 节点**（`.bt-trash` 桌面池 + `.bt-mobile-trash` 底部 action bar），CSS 媒体查询保证同一时刻只有一个可见。e2e 默认拿到的是桌面那个（DOM 顺序在前）；若需明确移动端 trash 用 `.bt-mobile-trash[data-drop-zone="trash"]` 区分 |
| `[data-drop-zone="card:<path:Lnnn>"]` | 卡片体（拖到另一卡 = 嵌套） | 拖拽 drop target |
| `[data-card-action="open\|done\|drop\|menu\|add-child"]` | 卡片上的按钮 / 控件 | 点击触发动作；right-click 由原生菜单处理 |
| `[data-test-cache-version="<n>"]` | view contentEl | 每次 `cache.changed` 后 +1，e2e `waitUntil` 用 |

**反例（禁止 e2e 依赖）**：CSS 类名（`.bt-task-card-...`）、文本内容（"完成" / "Done"——会因 i18n 变）、DOM 结构层级（`.children[0].children[1]`）。

**a11y 配套**：每张卡同时有 `role="article"` + `aria-label`（"任务: <title>, 状态 <X>, 日期 <Y>"），盲读 / 键盘用户可达；e2e 在断言"是哪张卡"时优先用 `data-task-id`，但要验"这张卡上有什么文字"时用 aria-label 比 textContent 更稳。

---

## 9. i18n（与硬约束 #5 对齐 / 拟引 US-408~412）

```
i18n/
├── zh-CN.ts    UI 文案
├── en.ts       UI 文案
└── index.ts    getLocale() + t(key, args?) + 切语言事件
```

### 9.1 翻译边界

| 类别 | 翻译？ | 来源 |
| --- | --- | --- |
| UI 文案（tab 名、按钮、设置项 label/description、空状态、toast） | ✅ | `i18n/<locale>.ts` |
| 错误"一句人话"部分（`error <code>  <一句人话>` 后半截） | ✅ | `i18n/<locale>.ts`，按 `<code>` 取 |
| 错误 `<code>` 本身（`not_found` / `ambiguous_slug` / …） | ❌ 恒英文 | hardcoded（AI / 脚本依赖稳定标识，不能因语言变） |
| 自然语言日期解析词（`today/今天/明天/Mon`） | 多语全识别 | `dates.ts` 解析表（中英两套永远都识别，不分 locale） |
| 日期显示（"周三 4 月 24 日"） | ✅ | locale 格式化 |
| 日期写回文件 | ❌ 恒 ISO `YYYY-MM-DD` | `dates.ts` 格式化（US-411 数据兼容硬约束） |
| **markdown 里的字面**（hashtag / inline field 字段名 / Obsidian Tasks emoji 标记） | ❌ 永远字节级保留 | parser/writer 不识别也不动它 |

### 9.2 禁止翻译的字符集合（i18n 字符串 build-time 校验）

> **2026-04-25 修订**：原稿把 emoji 字段标记列入 ban-list 是过紧的约束——`⏳ 📅 ✅ ❌` 是产品视觉语言，UI 文案里要用（"📋 N today · ⚠ M overdue"、"⏳ tap to schedule" 等）。把它们 ban 掉等于强迫所有 UI 字符串避开产品的字面表达，反而推动重构成更脆的代码。

`i18n/<locale>.ts` 里的每条 `value` 过校验：**不得包含**

- inline field 字段名（任何 `[xxx::` 形式）—— 这是数据语法，翻译者改了会 break parser
- 任何 `#` 开头的 hashtag 字符串 —— 同上，hashtag 是数据

包含 ⇒ 编译 fail。

**emoji 字段标记**（`⏳ 📅 🛫 ✅ ❌ ➕ 🔁 🔺 ⏫ 🔼 🔽 ⏬`）**允许出现在 i18n 字符串里**——它们是产品视觉语言。替代防误改的机制：
1. PR review 阶段对比 `i18n/zh-CN.ts` 与 `i18n/en.ts`，断言每对 key 的 value 包含的 emoji 集合相同（locale 间 emoji 一致性 lint，build-time 自动跑）。
2. 翻译指南文档明确写 "emoji 不要替换 / 删除"，新增 locale 时贴这条 review notice。

（默认配置里出现的 hashtag 字面，例如默认"分组 tag 集" `#1象限~#4象限`，**写在 settings 默认值，不在 i18n 字符串里**。）

### 9.3 切语言

监听 Obsidian 自身的 locale 变化（`workspace.on("css-change")` 是粗粒度可用入口；或定期对比 `getLocale()`）。变化时**不复用 `cache.changed`**——cache.changed 的语义是"vault 文件解析结果变了"，切语言时文件没动，复用会让 status-bar / 后续断言误判数据底数变化。

**正确做法**：plugin 内部维护一个独立的 `i18n` EventEmitter，触发 `i18n.emit("locale-changed", newLocale)`：

- view 订阅 `i18n.locale-changed` → 整体 re-render（不重读 cache）
- status-bar 订阅 `i18n.locale-changed` → 重渲染文字（不重读 cache）
- `t(key)` 即时返回新 locale 字符串

**绝不**为切语言重扫 vault（缓存里 ParsedTask 不依赖 locale）。

### 9.4 应用层不硬编码 tag / 字段名（拟引 US-108 锐化 / US-301 锐化）

- "分组"概念走配置 `settings.groupTags: string[]`，默认值 `["#1象限","#2象限","#3象限","#4象限"]`，用户可改。
- 卡片数字快捷键 `1/2/3/4/…` 不是"切象限"，是"应用 `groupTags[N-1]`"；超出长度无操作（UX §6.8）。
- 右键菜单"分组"子项从 `groupTags` 动态生成；选某项时把同组互斥项的 tag 移除（`groupTags` 内部互斥），不在组内的其他 tag 不动。
- 未排期视图按 `groupTags` 分组，未命中任意一项的进 "其他" / "Other"。
- "时长"字段名同理：`settings.estimateField` 默认 `"estimate"`、`settings.actualField` 默认 `"actual"`，summary / 卡片 meta 行从这两个名字读。

> 实现细节都在 settings + filterTasks/computeStats，没有任何 `if (tag === "#1象限")` 的特判路径。CI 加 grep 拦截：`grep -E '"#[1-4]象限"|estimate|actual' src/{view,cli,status-bar}.*` 命中 → 提醒人工 review（写在默认配置 / 测试 fixture 里允许，写在视图 / 业务路径里禁止）。

---

## 10. 视觉变量（与硬约束 #7 对齐）

`styles.css` 内**禁止常量颜色**。CI lint：`grep -E '#[0-9a-fA-F]{3,8}' styles.css` → 命中 fail（除非在白名单：黑/白/transparent）。

允许的来源：

- `--background-primary / --background-secondary / --background-secondary-alt`
- `--background-modifier-border / --background-modifier-hover`
- `--interactive-accent`
- `--color-red / --color-yellow / --color-green`
- `--text-normal / --text-muted / --text-faint`
- `--shadow-s / --shadow-l`

TS 内**禁止**写 `style.color = "#xxx"` 等 inline style 颜色。同 lint 规则。

**动画时长**统一通过 CSS custom property 定义（`--tc-anim-fast: 80ms`、`--tc-anim-card-fade: 100ms` 等），并在 `@media (prefers-reduced-motion: reduce)` 块内整体覆盖到 ≤ 50ms（UX §11.2）。**保留状态变化**——只缩短过渡时长，不取消视觉反馈。所有需要动画的 CSS class 都引用这些 var，**不**在 inline style / TS 里写 `transition: ...`。

---

## 11. 拖拽 dwell（与硬约束 #8 对齐）

`view/dnd.ts`：

```ts
class TabDwellTracker {
  private rafId: number | null = null;
  private startTs: number | null = null;
  private targetTab: TabKey | null = null;

  update(hoveredTabHead: TabKey | null) {
    if (hoveredTabHead !== this.targetTab) this.reset();
    this.targetTab = hoveredTabHead;
    if (hoveredTabHead && this.startTs === null) {
      this.startTs = performance.now();
      this.tick();
    }
  }
  private tick = () => {
    if (this.startTs === null || this.targetTab === null) return;
    const elapsed = performance.now() - this.startTs;
    this.renderProgress(elapsed / 600);
    if (elapsed >= 600) { this.commitTabSwitch(this.targetTab); this.reset(); return; }
    this.rafId = requestAnimationFrame(this.tick);
  };
  reset() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null; this.startTs = null;
  }
}
```

**禁止**用 `setTimeout(fn, 600)`。`setTimeout` 在 main thread 卡顿时漂移，`performance.now()` 在 rAF 里测才准（UX §6.1 / §16-8）。

---

## 12. 实施顺序（建议）

按"先解 BUG.md，再补 UX，再加新功能"的顺序：

### Phase 1：解 BUG.md（必须先做）

1. 抽出 `cache.ts`，把 `parseVaultTasks` 从 `cli.ts/TaskCenterApi.allTasks` 后移到 cache。
2. `main.ts` 删 `metadataCache.on("resolved")` → 改 `metadataCache.on("changed", file)`。
3. `view.ts` 删自己的 `metadataCache.resolved` 订阅，改订阅 `cache.changed`。
4. 全量改写 `TaskCenterApi`：`allTasks` 内部走 cache；写 verb 改为 `cache.ensureFile + 单文件 resolveRef`。
5. `cli.ts` 顶部加 lint 注释 `// REMINDER: do not call parseVaultTasks here`。
6. 跑 BUG.md repro：`enable plugin in 6589-file vault → no freeze`。e2e 加 case。

### Phase 2：补 UX 缺口

7. 拆 `view.ts` → `view/{view, tabs/*, card, tree, dnd, popover, undo}`。
8. 实现 box-drawing 树渲染（`view/tree.ts`），CLI/GUI 共用。
9. dwell tracker 改 rAF。
10. styles.css / TS 颜色 lint 规则上 CI。
11. i18n 翻译白名单 build-time check。

### Phase 3：稳定 + 测试覆盖

12. e2e 钩子：`data-test-cache-version`、`__stats`、`__forFlush`。
13. drift detection 测试用例。
14. 跨文件 nest 失败的 toast 路径。
15. 性能回归测试（vault 6589 文件 fixture）。

每个 Phase 落地一个 PR；所有 PR 走 @Rally review；BUG.md 反向验收（"启用插件不卡"）必须在 Phase 1 PR 合并前手动验证。

---

## 13. 不变量速查（给改代码的 agent 用）

复刻这 11 条到每个 PR 的 description 里，逐条 check：

- [ ] `parseVaultTasks(app)` 与 `app.vault.getMarkdownFiles()` 仅允许在 `cache.ts` 内部出现；其他模块禁止。
- [ ] 没有新代码订阅 `metadataCache.on("resolved")`。
- [ ] 写动词的入口没有 `await this.allTasks()` 调用。
- [ ] 未识别 emoji / inline field / 优先级符号 / block anchor 在 mutate 后字节级保留（diff 测试覆盖）。
- [ ] CLI 错误统一两行：`error <code>\n    <message>`，code 在固定集合内、恒英文；message 跟随 locale。
- [ ] 当 GUI 与 CLI 同时渲染任务树时（目前仅 CLI 渲），traversal/sort 走 `view/tree.ts` 共享纯函数；渲染层（box-drawing 文本 vs DOM 嵌套）按 surface 各自适配。
- [ ] 颜色仅来自 Obsidian CSS 变量，不出现 `#xxx` / `rgb(...)`。
- [ ] 拖拽 dwell 用 rAF + `performance.now()`，不用 `setTimeout(600)`。
- [ ] Undo 应用前对**被撤销的那几行**做内容比对，发现外部改写则中止撤销并 notify（2026-04-25 修订：不再用 mtime 校验，详 §6.2）。
- [ ] 视图 / 业务路径里**没有**硬编码的 tag / inline-field 字面（`#1象限`、`estimate` 等只在 settings 默认值 / 测试 fixture / parser 字段名常量里出现）。
- [ ] 日期写回文件恒 ISO `YYYY-MM-DD`；显示走 locale 格式化。
