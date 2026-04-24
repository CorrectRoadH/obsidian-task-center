# Obsidian Task Center · 软件 SPEC

> 本文件和 [USER_STORIES.md](./USER_STORIES.md) 并列。故事层回答"**做什么,为谁**",SPEC 层回答"**怎么切、怎么连、怎么验**",从而让多个开发者 / agent 能并行推进而不互相踩脚。

## 1 · 北极星与非目标

### 北极星
把 Obsidian Tasks 语法(`- [ ] ⏳ 📅 [estimate::] …`)扩展出一个**能量感知 + AI 可操控**的任务中心:
- **人**通过 GUI 拖拽规划一周、放弃不做的事、复盘估时偏差;
- **AI**通过原生 CLI 稳定读写,不破坏 markdown、不造新数据库。

### 非目标
- **不**做自己的任务格式(inline markdown 即事实)。
- **不**和 Obsidian Tasks 插件竞争数据层,反而依赖它。
- **不**替代 Dataview / query block。Task Center 是看板 + 写入层,不是查询语言。
- **不**做多用户协同 / 服务端状态。数据永远是本地文件。
- **不**触达非 markdown 文件。

## 2 · 术语表(Ubiquitous Language)

| 术语 | 定义 |
|---|---|
| **任务 (task)** | 一行 `- [ ]` / `- [x]` / `- [-]`,带可选元数据。 |
| **任务状态** | `todo` (`[ ]`) · `done` (`[x]`) · `dropped` (`[-]`) · `in_progress` (`[/]`) · `cancelled` (`[>]`) · `custom` (其他单字符)。 |
| **终态 (terminal)** | `done` / `dropped` 或章节带 `#dropped` tag。 |
| **祖先终态传播 (ancestor terminal propagation)** | 任一祖先是 terminal 时,后代从活动视图消失。 |
| **活动视图 (active views)** | Week / Month / Unscheduled / todo 过滤下的 `list`。Completed 不属于活动视图。 |
| **排期 (scheduled)** | `⏳ YYYY-MM-DD`,用户计划做它的那天。 |
| **deadline** | `📅 YYYY-MM-DD`,外部硬死期。 |
| **放弃 (abandon / drop)** | `[-] ❌ YYYY-MM-DD`;**不是**从磁盘删除,是一等历史状态。 |
| **任务 id** | 主:`<path>:L<line>`。回退:12 字符 title hash。 |
| **源行 (raw line)** | 文件中代表该任务的完整一行(含 emoji / inline field / tag)。所有写 verb 的 diff 单位。 |
| **板 (board)** | Task Center view 本身,type = `task-center-board`。 |
| **verb** | CLI 动词,形如 `obsidian task-center:<verb>`。 |
| **idempotent** | 连跑两次结果与跑一次相同,第二次输出 `unchanged`,exit 0。 |

## 3 · 模块与边界

下图是源码文件到逻辑模块的映射。**模块是并行开发的边界**——只要契约(§4)不破,A 模块的内部重构不需要 B 模块评审。

```
                 ┌──────────────────────────────┐
                 │  main.ts (plugin lifecycle)  │
                 └──────────────────────────────┘
                          │          │
              ┌───────────┘          └───────────┐
              ▼                                  ▼
       ┌─────────────┐                    ┌─────────────┐
       │  view.ts    │                    │  cli.ts     │
       │  (GUI)      │                    │  (verbs)    │
       └─────┬───────┘                    └─────┬───────┘
             │                                  │
             │   anim / quickadd / dateprompt   │
             │                                  │
             └────────────┬─────────────────────┘
                          ▼
                 ┌───────────────────┐
                 │  writer.ts        │  ← 所有突变
                 │  (Vault.process)  │
                 └────────┬──────────┘
                          │
                 ┌────────▼──────────┐
                 │  parser.ts        │  ← 所有读
                 │  (MetadataCache)  │
                 └────────┬──────────┘
                          │
                 ┌────────▼──────────┐
                 │  types · dates    │
                 │  i18n · settings  │  (无状态工具)
                 └───────────────────┘
```

### 3.1 模块职责一览

| 模块 | 文件 | 职责 | 不做 |
|---|---|---|---|
| **parser** | `src/parser.ts` | 从 vault 全量抽取 ParsedTask;识别 callout、inline field、tag、祖先终态。 | 不写文件,不处理 i18n,不知道 GUI。 |
| **writer** | `src/writer.ts` | 所有源行突变;通过 `Vault.process` 保证原子;idempotent;结构化错误。 | 不渲染,不发通知,不直接面向 GUI。 |
| **cli** | `src/cli.ts` | verb → parser/writer 调用;人类 + JSON 出口;错误码契约。 | 不解析自然语言日期(委托 dates)。 |
| **view** | `src/view.ts` | 看板渲染、拖拽、快捷键、内联编辑、撤销栈;订阅 `MetadataCache` 变更重绘。 | 不直接改文件,写全部走 writer;不解析 markdown,读全部走 parser。 |
| **quickadd** | `src/quickadd.ts` | 单行输入解析 → `add` 参数。 | 不打开文件、不写入。 |
| **dateprompt** | `src/dateprompt.ts` | 在 view 里替代 `window.prompt`(Electron 禁用)。 | |
| **anim** | `src/anim.ts` | Web Animations API fade-collapse 原语。 | 不知道业务。 |
| **dates** | `src/dates.ts` | ISO 验证、`today / tomorrow / week / …` 词汇表、自然语言日期解析。 | 不知道任务。 |
| **i18n** | `src/i18n.ts` | key → zh/en 查询,missing-key fallback。 | 不持久化。 |
| **settings** | `src/settings.ts` + types | `TaskCenterSettings` 默认值、保存 / 读取。 | 不知道 view。 |
| **types** | `src/types.ts` | 共享类型。无运行时代码。 | |
| **main** | `src/main.ts` | 插件生命周期、registerCliHandler、状态栏 widget、ribbon icon、`open-board` 命令。 | 不写业务逻辑,全部委托。 |
| **skills** | `skills/obsidian-task-center/SKILL.md` | AI agent 接入合同。 | |

### 3.2 依赖规则(强约束)

- `parser` **只读** vault。**禁止** import writer / cli / view。
- `writer` 可以 import parser(为 id 解析),**禁止** import cli / view / i18n。
- `cli` 可以 import parser / writer / dates。**禁止** import view / i18n。CLI 输出永远用 en(机器可解析)。
- `view` 可以 import 任何下层。**不得**直接用 `vault.modify` / `vault.read`——一律走 parser/writer。
- `main` 是唯一允许注册全局生命周期 hook 的模块。

违反依赖规则的 PR 直接拒绝,不评审内部实现。

## 4 · 模块契约(public API)

### 4.1 parser

```ts
// 全量解析。fastSkip=true 时跳过无任务的文件。
parseVaultTasks(app: App, opts?: { fastSkip?: boolean }): Promise<ParsedTask[]>;

// 供测试 / cli.show 的单文件解析
parseMarkdown(content: string, path: string, mtime: number): ParsedTask[];

// 时长格式化(纯函数,测试 golden)
parseDurationToMinutes(input: string | null): number | null;
formatMinutes(minutes: number | null): string;   // 90 → "1h30m"
```

**不变量**:
- 返回的 ParsedTask `id = path + ":L" + line` 唯一。
- `inheritsTerminal` 对 "章节标题带 `#dropped`" 也生效。
- 空字符串 / 非法 emoji 日期 → 字段为 `null`,**不**抛错。

### 4.2 writer

```ts
resolveTaskRef(app, ref: string, all?: ParsedTask[]): Promise<ParsedTask | null>;
setScheduled(app, task, date: string | null): Promise<WriteResult>;
setDeadline(app, task, date: string | null): Promise<WriteResult>;
setEstimate(app, task, minutes: number | null): Promise<WriteResult>;
setActual(app, task, minutes: number | null): Promise<WriteResult>;
addToActual(app, task, minutes: number): Promise<WriteResult>;
markDone(app, task, at?: string): Promise<WriteResult>;
markUndone(app, task): Promise<WriteResult>;
markDropped(app, task): Promise<WriteResult>;   // cascades to children
addTag(app, task, tag: string): Promise<WriteResult>;
removeTag(app, task, tag: string): Promise<WriteResult>;
renameTask(app, task, newTitle: string): Promise<WriteResult>;
addTask(app, input: AddTaskInput): Promise<WriteResult>;
nestUnder(app, srcRef: string, dstRef: string): Promise<WriteResult>;

interface WriteResult {
  ok: true;
  id: string;
  before: string;   // 源行
  after: string;    // 新行
  unchanged: boolean;
  cascade?: string[];   // 级联受影响的 id(drop / nest)
}

class TaskWriterError extends Error {
  code: "task_not_found" | "file_modified" | "ambiguous_slug"
      | "invalid_date" | "invalid_indent" | "cycle";
  candidates?: string[];   // ambiguous_slug 时
}
```

**不变量**:
- 所有写走 `Vault.process(file, transform)`;transform 是同步纯函数。
- `unchanged === true` 时 `before === after`,仍返回 `ok: true`。
- `markDropped` 级联:未完成 `[ ]` 子任务也变 `[-]`;`[x]` 保留。
- `nestUnder` 先**检测** cycle,**再**写;检测失败抛 `cycle`。
- 跨文件 `nestUnder`:先写 dst,后写 src;dst 写完若 src 失败,不回滚——文档化为已知限制(US-929)。

### 4.3 cli

```ts
TaskCenterApi {
  list(filters: ListFilters): Promise<ParsedTask[]>;
  show(id: string): Promise<ParsedTask>;
  stats(opts: StatsOpts): Promise<StatsResult>;
  schedule / deadline / estimate / actual / done / undone / drop /
  addTag / removeTag / rename / add / nest   // 对应 writer 方法
}

// 人类友好输出(stdout) vs format=json
formatListText(tasks: ParsedTask[]): string;
formatListJson(tasks: ParsedTask[]): string;
formatWriteText(result: WriteResult): string;
formatError(err: TaskWriterError): string;   // 两行:code + message
```

**不变量**:
- `list` / `stats` 对 `format=json` 是**唯一** stdout 内容(无 banner、无 footer)。
- 写 verb 对 idempotent 路径返回 `unchanged`,exit 0。
- 错误 exit 非零;stderr 两行,第一行 `error <code>`。

### 4.4 view

- View type: `VIEW_TYPE_TASK_CENTER = "task-center-board"`。
- 注册 workspace leaf,单例。
- 订阅 `app.metadataCache.on("resolved" | "changed")` 重渲染。
- 撤销栈:`board.undoStack: UndoEntry[]` 上限 20;跨文件 nest **不**入栈。
- 所有 DOM 事件绑定放 `this.registerDomEvent`,避免泄漏。
- **不得**直接 `setTimeout` > 500ms — 用 `Plugin.registerInterval`。

### 4.5 quickadd

```ts
interface QuickAddParse {
  title: string;
  tags: string[];
  scheduled: string | null;   // ISO
  estimate: number | null;    // minutes
  deadline: string | null;
}
parseQuickAdd(input: string, today: string, weekStartsOn: 0|1): QuickAddParse;
```

**不变量**:
- 同一 token 被 quoted(`"#notag"`)时不当作 tag。
- 未识别 token 聚合成 title 的一部分,顺序保留。

### 4.6 dates

```ts
todayISO(): string;
isValidISO(s: string): boolean;
resolveWhen(word: string, today: string, weekStartsOn: 0|1):
  { kind: "day"; date: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "unscheduled" }
  | { kind: "invalid" };

// QuickAdd / CLI 共用
resolveNaturalDate(word: string, today: string, weekStartsOn: 0|1, locale: "zh"|"en"): string | null;
```

### 4.7 i18n

```ts
t(key: string, vars?: Record<string, string|number>): string;
detectLocale(): "zh" | "en";
```

**不变量**:
- 缺 key 返回英文 key 本身(不抛错,不崩)。
- key 命名空间 `view.*` / `cli.*` / `err.*`。

### 4.8 settings

```ts
interface TaskCenterSettings {
  inboxPath: string;
  dailyFolder: string;
  defaultView: "week" | "month" | "completed" | "unscheduled";
  openOnStartup: boolean;
  weekStartsOn: 0 | 1;
  stampCreated: boolean;
  lastTab: "week" | "month" | "completed" | "unscheduled" | null;
}
loadSettings(plugin): Promise<TaskCenterSettings>;
saveSettings(plugin, s: TaskCenterSettings): Promise<void>;
```

## 5 · 数据模型

### 5.1 源行语法(正则级)

```
<indent> ["> "]* ("-" | "+" | "*") " [" <status-char> "] " <title-and-meta>
```

- `status-char`: `" "` todo · `"x"` done · `"X"` done(规范化)· `"-"` dropped · `"/"` in_progress · `">"` cancelled · 其他单字符 = custom。
- callout prefix `"> "` 允许嵌套任意层。
- `<title-and-meta>` 按该顺序 /**出现即有效,顺序不强制**/ 可混入:
  - `#tag`(`#1象限`–`#4象限` 保留为象限字段)
  - `🔺 / ⏫ / 🔼 / 🔽 / ⏬`(优先级,保留不做排序——见 US-903)
  - `🔁 <recurrence>`(保留,见 US-901)
  - `⏳ YYYY-MM-DD` `📅 YYYY-MM-DD` `🛫 YYYY-MM-DD` `➕ YYYY-MM-DD` `✅ YYYY-MM-DD` `❌ YYYY-MM-DD`
  - `[estimate:: 90m]` `[actual:: 75m]`
  - `^blockref`

### 5.2 持久化目标

| 来源 | 写入位置 | 决定规则 |
|---|---|---|
| `add` (无 `to=`,无 `parent=`) | 今日 daily note 若存在 → `settings.inboxPath` | main 启动时计算 daily folder 路径 |
| `add parent=X` | 父任务所在文件 | parent 下一行,缩进 = parent.indent + `"    "` |
| `add to=<path>` | `to=` 文件尾 | 若文件不存在,创建之 |
| 所有 schedule / deadline / estimate / actual / done / drop / rename | 该任务源文件 | 就地改写源行 |
| `nest`(跨文件) | src 文件移除 + dst 文件插入 | 先 dst,后 src |

### 5.3 不变量摘要

- **唯一性**:vault 内某文件的某行要么是零任务、要么是一任务。
- **幂等性**:所有 writer verb 对同入参连跑两次,第二次 `unchanged`。
- **保留性**:任何 writer 操作都不得改动与该 verb 无关的字段字节。
- **原子性**:单文件写 atomically;多文件(nest)不跨文件原子。
- **终态传播**:活动视图按 `inheritsTerminal` 过滤;Completed 视图不过滤。

## 6 · 控制流:典型场景

### 6.1 GUI 拖拽改期(US-121)

```
[user drag] → view.onDrop(card, targetDay)
  1. view stages anim(card)  (US-127)
  2. view.undoStack.push({id, before: card.raw})
  3. await writer.setScheduled(app, task, targetDay)
  4. on ok → MetadataCache resolves → view re-render that day + source day
  5. on error → revert anim, toast via i18n
```

### 6.2 CLI `done`(US-203 幂等)

```
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-23
  → cli.parseArgs
  → TaskCenterApi.done("Tasks/Inbox.md:L42", "2026-04-23")
    → writer.resolveTaskRef → ParsedTask
    → writer.markDone
       - if task.status === "done" && task.completed === at → return { unchanged: true, before = after }
       - else → Vault.process → new raw → { before, after }
  → cli.formatWriteText → stdout "ok …"
  → exit 0
```

### 6.3 跨文件 nest(US-125 / US-228)

```
writer.nestUnder(app, srcRef, dstRef):
  1. resolve src, dst
  2. detect cycle: if dst.inheritsFrom(src) → throw cycle
  3. serialize newChildLine = re-indent(src.rawLine, dst.indent + "    ")
  4. Vault.process(dst.file): insert newChildLine at dst.line+1
  5. Vault.process(src.file): remove src.rawLine
  6. return { ok, before: src.raw, after: newChildLine, cascade: [dst.id] }
  // 若 (5) 失败,(4) 已成功,dst 文件多一行,src 未删——由 US-929 决定是否补救
```

## 7 · 错误契约

| code | 触发 | 恢复建议 |
|---|---|---|
| `task_not_found` | ref 解析不到 | 调 `list` 刷新 id 后重试 |
| `file_modified` | 写前 mtime 变化 | 重新 resolve,再试 |
| `ambiguous_slug` | hash 匹配到 >1 | 从候选里挑一个 id |
| `invalid_date` | 非 ISO / 非词汇表词 | 转成 `YYYY-MM-DD` |
| `invalid_indent` | 缩进不是 4 空格倍数 / 混 tab | 本地修复源行后重试 |
| `cycle` | nest 构成环 / 自嵌套 | 选别的目标 |

**契约**:
- 错误 stderr 两行:`error <code>` + 缩进 2 空格的人类消息。
- exit code: `task_not_found / ambiguous_slug / cycle = 2`;`invalid_*` = 3;`file_modified = 4`。

## 8 · 测试策略

### 8.1 分层

| 层 | 工具 | 跑法 | 覆盖对象 |
|---|---|---|---|
| **unit** | `node:test`(`.mjs`) | `npm test` | parser / writer / quickadd / dates |
| **cli integration** | `node:test` + Obsidian stub | `npm test` | cli verbs 端到端(stub vault) |
| **e2e** | WebdriverIO + Obsidian(electron) | `npm run test:e2e` | view / 拖拽 / 快捷键 / 撤销 |

### 8.2 命名约定

- 每条故事至少 1 个 AC 对应 1 个测试用例。
- 测试文件注释 `// US-121: drag to change schedule`;便于 PR 追溯。
- 新增 `test/<module>.test.mjs` 时,若故事跨模块,优先放下游模块(例如 US-121 主测试在 `writer.test.mjs`,view 层断言放 e2e)。

### 8.3 Obsidian stub 约束

- 只模拟 Task Center 实际调用的 API:`App.vault.{getAbstractFileByPath, read, process, modify, create}`、`MetadataCache.{listItems, on, getFirstLinkpathDest}`。
- stub 不模拟真实文件系统 — 用内存 Map。
- 任何新增 Obsidian API 依赖必须先在 stub 里补 mock,否则单测跑不起来。

## 9 · 非功能约束

| 维度 | 预算 | 度量 |
|---|---|---|
| 启动 | 插件 onload ≤ 50ms | `console.time` (dev) |
| 大 vault 首帧 | ≤ 500ms for 10k notes | benchmark fixture |
| 拖拽延迟 | ≤ 16ms visual feedback(60fps) | 手测 + devtools |
| 写延迟 | ≤ 100ms for 单行改写 | `performance.now()` 埋点 |
| 依赖体积 | 零运行时依赖 | `package.json`。Obsidian 和 TypeScript 之外不新增。 |
| Node 版本 | 构建 ≥ Node 18 | `mise.toml` |
| Obsidian 最低版本 | 1.12.2(CLI handler API) | `manifest.json.minAppVersion` |

## 10 · 并行开发工作流

### 10.1 工作流的拆分原则

**每条并行工作流 = 一组故事 + 恰好一个主模块 + 至多一个副模块**。这样两个并行 stream 冲突的文件数 ≤ 2 个,rebase 代价可控。

### 10.2 当前流(供认领)

| Stream | 主模块 | 副模块 | 故事集 | 阻塞依赖 |
|---|---|---|---|---|
| **A · subtask button** | view | writer | US-141 | 无 |
| **B · remove-anim polish** | anim | view | US-127 | 无 |
| **C · cross-file nest UI notice** | view | i18n | US-129 | US-125 已合并 |
| **D · recurrence decision + impl** | parser + writer | view | US-901 | 待决策 |
| **E · priority sort** | view | parser | US-903 | 待决策 |
| **F · settings hot reload** | view | settings | US-904 | 需 view 拆 controller |
| **G · cross-file nest undo** | view | writer | US-929 | 需 view undo 栈升级 |
| **H · mtime 冲突防护** | writer | cli | US-930 (候选 A) | 待决策 |
| **I · community plugins rename** | main | 所有 id 引用 | US-940 | 需要迁移脚本 |

### 10.3 启动并行流的 checklist

认领工作流时,在 issue / PR 描述里列:
1. 目标故事 ID(引用 USER_STORIES 条目)。
2. 触及的模块(只列主 + 副;动了第三个模块就拆 PR)。
3. 测试位置(哪个 `.mjs` / e2e)。
4. 契约有无变化(§4);变了要先单独 PR 改 SPEC,再跟实现。
5. 对其他 stream 的影响(rebase 冲突面)。

### 10.4 合流顺序

- SPEC / USER_STORIES 先于代码。
- 契约 PR 先于实现 PR。
- 错误码 / CLI 输出格式改动需要更新 SKILL.md(同 PR)。

## 11 · 决策日志(已决)

| 日期 | 决策 | 背景 |
|---|---|---|
| 2026-04-23 | 放弃 = 一等 `[-]` 状态,不是删除 | P3 画像核心需求 |
| 2026-04-23 | CLI 通过 `registerCliHandler`,**不**做 wrapper shell | US-201,依赖 Obsidian 1.12.2+ |
| 2026-04-23 | 写操作全部 `Vault.process` | 原子性,对抗 mid-edit crash |
| 2026-04-23 | hash 歧义**不**猜测,返回候选列表 | AI 可信度优先 |
| 2026-04-23 | Completed tab **不**应用终态传播过滤 | 用户需要看历史 |
| 2026-04-23 | 跨文件 nest 不在 undo 栈内 | 先上线,undo 留给后续(US-929) |

## 12 · 变更本文件

- SPEC 每次重大修订前先写 ADR(可在 `docs/adr/` 下;当前未创建,若需要再起)。
- 契约(§4)变化触发 minor 版本号升级;错误码 / 参数字段移除触发 major。
- 添加新模块需要:更新 §3.1 表、§3.2 依赖规则、§10.2 可能受影响的流、测试分层 §8.1。
- `USER_STORIES.md` 增删改,不必改 SPEC,除非牵扯契约或模块边界。
