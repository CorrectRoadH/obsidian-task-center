# 数据结构与代码实现

> 这份讲"**数据长什么样 / 代码怎么切 / 怎么并行动工**"。用户视角 → [USER_STORIES.md](./USER_STORIES.md);界面交互 → [UX.md](./UX.md)。

## 目录

- [一句话总览](#一句话总览)
- [数据结构](#数据结构)
- [子任务如何继承父任务的属性](#子任务如何继承父任务的属性)
- [模块地图](#模块地图)
- [模块依赖规则](#模块依赖规则)
- [各模块的公开 API](#各模块的公开-api)
- [三个关键场景的代码路径](#三个关键场景的代码路径)
- [原子写 & 幂等](#原子写--幂等)
- [错误码](#错误码)
- [测试分层](#测试分层)
- [性能预算](#性能预算)
- [并行开发工作流](#并行开发工作流)
- [已决策的事](#已决策的事)

---

## 一句话总览

插件把 Obsidian Tasks 的 `- [ ] 任务` 那一行当数据库。
- **读**都走 `parser.ts`(从 Vault 里提取任务)。
- **写**都走 `writer.ts`(改那一行,通过 `Vault.process` 原子完成)。
- **CLI** 和 **View**(GUI)都不直接碰文件,只调用 parser / writer。

## 数据结构

### markdown 一行任务的语法

```
<缩进>["> "]*<项目符号> [<状态字符>] <标题和元数据>
```

例:

```
    > - [ ] 去营业厅问携号转网 #2象限 📅 2026-05-15 ⏳ 2026-04-24 ➕ 2026-04-23 [estimate:: 90m]
```

| 组件 | 含义 |
|---|---|
| `<缩进>` | 0 或 4 空格倍数;混用 tab 会报 `invalid_indent` |
| `> ` 前缀(可重复) | Obsidian callout 内的任务,和顶层一视同仁 |
| 项目符号 | `-` / `+` / `*` |
| 状态字符 | `" "` todo · `"x"` / `"X"` done · `"-"` dropped · `"/"` in_progress · `">"` cancelled · 其他单字符按 `custom` 处理 |
| 标题 | 第一个 emoji 元数据 / `[…::]` / `#tag` / `^blockref` **之前**的纯文本 |

元数据可以混在标题**后面任何位置**,解析不要求顺序:

| 编码 | 含义 |
|---|---|
| `⏳ YYYY-MM-DD` | 排期 = 打算哪天做 |
| `📅 YYYY-MM-DD` | deadline = 硬死期 |
| `🛫 YYYY-MM-DD` | 最早能开工的日期 |
| `➕ YYYY-MM-DD` | 创建日期 |
| `✅ YYYY-MM-DD` | 完成日期(状态为 `[x]` 时写入) |
| `❌ YYYY-MM-DD` | 放弃日期(状态为 `[-]` 时写入) |
| `🔁 <text>` | 重复规则(保留,当前不参与调度,见 US-901) |
| `🔺 / ⏫ / 🔼 / 🔽 / ⏬` | 优先级符号(保留,当前不参与排序,见 US-903) |
| `[estimate:: 90m]` | 估时分钟数 |
| `[actual:: 75m]` | 实际耗时分钟数 |
| `#1象限` … `#4象限` | Covey 四象限分组 |
| `#<其他>` | 普通 tag |
| `^<id>` | Obsidian block reference |

### `ParsedTask`(来自 `src/types.ts`)

parser 把一行 markdown 读成这么一个对象:

```ts
interface ParsedTask {
  id: string;              // "path:L<line>" — 稳定 id
  path: string;            // 所在 markdown 文件路径
  line: number;            // 文件里的行号(0-based)
  indent: string;          // 该行的缩进(原样保留)
  checkbox: string;        // 状态字符,例如 " " / "x" / "-"
  status: TaskStatus;      // "todo" | "done" | "dropped" | "in_progress" | "cancelled" | "custom"
  title: string;           // 去掉所有元数据后的标题
  rawTitle: string;        // 带元数据的原始标题段
  rawLine: string;         // 整行原文,writer 的 before/after 单位
  tags: string[];          // 扁平 tag 数组,含象限 tag
  scheduled: string | null;
  deadline: string | null;
  start: string | null;
  completed: string | null;
  cancelled: string | null;
  created: string | null;
  estimate: number | null; // 分钟
  actual: number | null;   // 分钟
  parentLine: number | null;   // 同文件里的父任务行号(顶层 = null)
  parentIndex: number | null;
  childrenLines: number[]; // 同文件里的直系子任务行号
  hash: string;            // 12 字符 title hash,id 回退用
  mtime: number;           // 读到时文件的 mtime,防误写
  inheritsTerminal: boolean; // 任一祖先是 [x]/[-]/#dropped 则 true
}
```

**不变量**:
- 同一个 vault 扫描里,`id` 唯一。
- 字段解析失败(非法日期 / 空 estimate)→ 该字段为 `null`,**不**抛错。
- `childrenLines` 只记**直系**,不记孙代——让 view 自己递归。

### 设置(`TaskCenterSettings`)

```ts
interface TaskCenterSettings {
  inboxPath: string;               // 快速添加的兜底写入位置
  dailyFolder: string;             // 找 daily note 的文件夹
  defaultView: "week" | "month" | "completed" | "unscheduled";
  openOnStartup: boolean;
  weekStartsOn: 0 | 1;             // 0 = 周日;1 = 周一
  stampCreated: boolean;           // 新任务自动打 ➕
  lastTab: "week" | "month" | "completed" | "unscheduled" | null;
}
```

---

## 子任务如何继承父任务的属性

这一节是 PR 里经常争的,单独拿出来明写:

| 属性 | 新建子任务时 | 父改动时 | 父终态(`[x]`/`[-]`/`#dropped`)时 |
|---|---|---|---|
| `⏳`(排期) | **继承父的值** | **不跟动**(子独立)。拖子到别的天 → 改子自己的 `⏳`(当前;见 US-902) | 不变(磁盘上),但活动视图里子消失 |
| `📅`(deadline) | 不继承 | 不跟动 | 同上 |
| `[estimate::]` | 不继承(子任务一般更小,应自己估) | 不跟动 | 同上 |
| `[actual::]` | 不继承 | 不跟动 | 同上 |
| `#象限` tag | 不继承(子可以在别的象限) | 不跟动 | 同上 |
| 其他 `#tag` | 不继承 | 不跟动 | 同上 |
| `➕`(创建) | **和父同天**时省略;不同天打 `➕ 今日` | 不跟动 | 同上 |
| **"可见性"** | — | — | **级联隐藏**:所有后代从 Week / Month / Unscheduled / `list status=todo` 消失;Completed tab 照常显示 |
| **放弃级联** | — | **拖父入垃圾桶**时:`[ ]` 子跟着 `[-] ❌`,`[x]` 子保留 | — |
| **完成级联** | — | **勾父为完成**时:子**不**被动完成,只是从活动视图消失(祖先终态传播) | — |

一句话总结:**新建时继承 `⏳` + `➕` 去重;其它字段独立;完成 / 放弃父 = 整条分支从"待办"消失**。

### 特殊规则:`#dropped` section

一个章节标题(`## 某某`)如果被打了 `#dropped` tag,下属所有 list item / task 都按终态对待——用来整块冻结过时的清单。

---

## 模块地图

源码在 `src/`,12 个 `.ts` 文件,对应 9 个逻辑模块:

```
                 ┌──────────────────────────────┐
                 │  main.ts (插件生命周期)      │
                 └──────────────────────────────┘
                          │            │
              ┌───────────┘            └───────────┐
              ▼                                    ▼
       ┌──────────────┐                    ┌──────────────┐
       │  view.ts     │                    │  cli.ts      │
       │  (看板 GUI)   │                    │  (动词)      │
       └──────┬───────┘                    └──────┬───────┘
              │                                   │
              │  quickadd / dateprompt / anim     │
              │                                   │
              └────────────┬──────────────────────┘
                           ▼
                  ┌───────────────────┐
                  │  writer.ts        │  ← 所有改动从这里走
                  │  (Vault.process)  │
                  └────────┬──────────┘
                           │
                  ┌────────▼──────────┐
                  │  parser.ts        │  ← 所有读从这里走
                  │  (MetadataCache)  │
                  └────────┬──────────┘
                           │
                  ┌────────▼──────────┐
                  │  types · dates    │
                  │  i18n · settings  │  (无状态工具)
                  └───────────────────┘
```

| 模块 | 文件 | 一句话职责 |
|---|---|---|
| **parser** | `src/parser.ts` | 把 vault 扫一遍,返回 ParsedTask 数组 |
| **writer** | `src/writer.ts` | 改源行;原子写;幂等;结构化错误 |
| **cli** | `src/cli.ts` | 把 verb 翻译成 parser / writer 调用;人类输出 + JSON 输出 |
| **view** | `src/view.ts` | 看板 GUI:渲染 / 拖拽 / 快捷键 / 内联编辑 / 撤销栈 |
| **quickadd** | `src/quickadd.ts` | 把一行快捷输入解析成 `add` 的参数 |
| **dateprompt** | `src/dateprompt.ts` | 代替 Electron 禁用的 `window.prompt` |
| **anim** | `src/anim.ts` | 淡出 / 折叠动画原语 |
| **dates** | `src/dates.ts` | ISO 校验 / `today` 等词 / 自然语言日期 |
| **i18n** | `src/i18n.ts` | key → zh/en 查询 |
| **settings** | `src/settings.ts` + types | 设置 schema + 读写 |
| **types** | `src/types.ts` | 共享类型,无运行时代码 |
| **main** | `src/main.ts` | 插件生命周期 / 注册 CLI / 状态栏 widget / ribbon |

---

## 模块依赖规则

强约束。违反这些规则的 PR 直接拒绝,不评审内部实现:

- `parser` **只读** vault。不 import writer / cli / view。
- `writer` 可以 import parser(解析 ref),**不** import cli / view / i18n。
- `cli` 可以 import parser / writer / dates,**不** import view / i18n(CLI 输出永远用英文)。
- `view` 读都走 parser,写都走 writer。**不**直接调 `vault.modify` / `vault.read`。
- 只有 `main` 负责插件生命周期的注册。

这些规则的用处:只要契约没变,一个模块内部怎么改都行——**并行开发的关键**。

---

## 各模块的公开 API

### parser

```ts
// 全量扫描 vault;fastSkip=true 时跳过无 list item 的文件
parseVaultTasks(app: App, opts?: { fastSkip?: boolean }): Promise<ParsedTask[]>;

// 单文件解析(cli.show / 测试用)
parseMarkdown(content: string, path: string, mtime: number): ParsedTask[];

// 纯函数
parseDurationToMinutes(input: string | null): number | null;
formatMinutes(minutes: number | null): string;    // 90 → "1h30m"
```

### writer

```ts
resolveTaskRef(app, ref: string, all?: ParsedTask[]): Promise<ParsedTask | null>;

setScheduled(app, task, date: string | null): Promise<WriteResult>;
setDeadline(app, task, date: string | null): Promise<WriteResult>;
setEstimate(app, task, minutes: number | null): Promise<WriteResult>;
setActual(app, task, minutes: number | null): Promise<WriteResult>;
addToActual(app, task, minutes: number): Promise<WriteResult>;   // 增量

markDone(app, task, at?: string): Promise<WriteResult>;
markUndone(app, task): Promise<WriteResult>;
markDropped(app, task): Promise<WriteResult>;   // 未打钩子任务级联;打钩的保留

addTag(app, task, tag: string): Promise<WriteResult>;
removeTag(app, task, tag: string): Promise<WriteResult>;
renameTask(app, task, newTitle: string): Promise<WriteResult>;
addTask(app, input: AddTaskInput): Promise<WriteResult>;

nestUnder(app, srcRef: string, dstRef: string): Promise<WriteResult>;
// 跨文件支持:先写 dst,再从 src 删;cycle / 自嵌套拒绝

interface WriteResult {
  ok: true;
  id: string;
  before: string;           // 原源行
  after: string;            // 新源行
  unchanged: boolean;       // 幂等路径:before === after
  cascade?: string[];       // drop / nest 级联影响到的 id
}

class TaskWriterError extends Error {
  code: "task_not_found" | "file_modified" | "ambiguous_slug"
      | "invalid_date" | "invalid_indent" | "cycle";
  candidates?: string[];    // ambiguous_slug 时候给候选 id
}
```

### cli

```ts
class TaskCenterApi {
  list(filters: ListFilters): Promise<ParsedTask[]>;
  show(id: string): Promise<ParsedTask>;
  stats(opts: StatsOpts): Promise<StatsResult>;
  // 下面这些直接对应 writer:
  schedule, deadline, estimate, actual, done, undone, drop,
  addTag, removeTag, rename, add, nest
}

formatListText(tasks: ParsedTask[]): string;    // 人类输出
formatListJson(tasks: ParsedTask[]): string;    // format=json 出口
formatWriteText(result: WriteResult): string;   // "ok\n    before …\n    after …"
formatError(err: TaskWriterError): string;      // 两行 "error <code>\n    <msg>"
```

CLI 输出契约:
- `list` / `stats` 的 `format=json` **唯一** stdout 内容,没有 banner / footer。
- 写 verb 幂等路径返回 `ok <id> … unchanged`,exit 0。
- 错误到 stderr,两行,exit != 0。

### view

- View type: `VIEW_TYPE_TASK_CENTER = "task-center-board"`,workspace 单例。
- 订阅 `app.metadataCache.on("resolved" | "changed")` 重渲染。
- 撤销栈存在 view 实例里,上限 20;跨文件 nest **不**入栈。
- DOM 事件全走 `this.registerDomEvent`,防泄漏。

### quickadd / dates / i18n / settings

见各自源文件的导出。所有都是**无状态纯函数**(除了 settings 的 load/save 有 I/O)。

---

## 三个关键场景的代码路径

### 拖拽改期(US-121)

```
用户拖 → view.onDrop(card, targetDay)
  1. view 启动消失动画(anim)
  2. view.undoStack.push({ id, before: card.rawLine })
  3. await writer.setScheduled(app, task, targetDay)
  4. 成功 → MetadataCache 触发 "changed" → view 重渲染源日 + 目标日
  5. 失败 → 动画回退,toast(i18n)
```

### CLI `done` 幂等(US-203)

```
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-23
  → cli.parseArgs
  → TaskCenterApi.done("Tasks/Inbox.md:L42", "2026-04-23")
    → writer.resolveTaskRef → ParsedTask
    → writer.markDone:
        if task.status === "done" && task.completed === at
          → 返回 { unchanged: true, before = after }
        else
          → Vault.process(file, transform) → { before, after }
  → cli.formatWriteText → stdout
  → exit 0
```

### 跨文件 nest(US-125 / US-228)

```
writer.nestUnder(srcRef, dstRef):
  1. 解析 src, dst
  2. 环检测:如果 dst 是 src 或 src 的后代 → throw cycle
  3. 重新缩进: newChildLine = reindent(src.rawLine, dst.indent + "    ")
  4. Vault.process(dst.file): 在 dst.line 之后插入 newChildLine
  5. Vault.process(src.file): 删掉 src.rawLine
  6. return { ok, before: src.raw, after: newChildLine, cascade: [dst.id] }

  若第 5 步失败,第 4 步已成功 → dst 多一行、src 没删。
  这种"跨文件半成功"是已知限制,让 US-929 的决策再补救。
```

---

## 原子写 & 幂等

- **原子写**:所有写都通过 `Vault.process(file, transform)`。transform 是一个同步纯函数 `string → string`,Obsidian 保证**整个文件的读-改-写**期间持有文件锁,进程崩了也不会留半拉文件。
- **幂等**:每个 writer verb 在入口处先算"要不要改"——目标状态等于当前状态就直接返回 `unchanged`。这样 AI agent 重复调不会产生级联效应。
- **跨文件不原子**:`nestUnder` 跨文件时是两次独立的 `Vault.process`。一旦第二次失败,第一次已经写入——文档化为"已知限制,用 git 恢复"(US-929)。

## 错误码

| code | 什么时候触发 | 怎么恢复 |
|---|---|---|
| `task_not_found` | ref 解析不到 | 重新 `list` 刷新 id |
| `file_modified` | 写前 mtime 和读时不一致(别人改过了) | 重新读,再试一次 |
| `ambiguous_slug` | hash 匹配到超过一个任务 | 从 `candidates` 里挑一个正式 id |
| `invalid_date` | 不是 ISO,也不是 `today / tomorrow / …` 词汇 | 转成 `YYYY-MM-DD` |
| `invalid_indent` | 缩进不是 4 空格倍数或混了 tab | 本地修好源行再试 |
| `cycle` | nest 形成环 / 自嵌套 | 换别的目标 |

CLI 出错时 stderr 两行:

```
error cycle
  cannot nest Tasks/A.md:L10 under itself
```

Exit codes:
- `task_not_found` / `ambiguous_slug` / `cycle` → exit 2
- `invalid_date` / `invalid_indent` → exit 3
- `file_modified` → exit 4

---

## 测试分层

| 层 | 工具 | 命令 | 覆盖 |
|---|---|---|---|
| unit | `node:test` (`.mjs`) | `npm test` | parser / writer / quickadd / dates |
| cli integration | `node:test` + Obsidian stub | `npm test` | cli verb 端到端(内存 vault) |
| e2e | WebdriverIO + Electron Obsidian | `npm run test:e2e` | view / 拖拽 / 快捷键 / 撤销 |

命名约定:
- 每条 `shipped` 故事至少对应 1 个测试用例。
- 测试文件注释写 `// US-121: 拖拽改期` 之类,PR 可追溯。
- 跨模块的故事,测试写在**下游**模块(例 US-121 主测试在 `writer.test.mjs`,view 层断言放 e2e)。

**Obsidian stub** 只模拟用到的 API(`Vault.{getAbstractFileByPath, read, process, modify, create}`、`MetadataCache.{listItems, on}`),内存 Map 代真实文件系统。新增对 Obsidian API 的依赖必须先补 mock。

---

## 性能预算

| 维度 | 预算 | 怎么度量 |
|---|---|---|
| 插件 onload | ≤ 50ms | `console.time` (dev) |
| 首帧(10k notes) | ≤ 500ms | benchmark fixture |
| 拖拽反馈 | ≤ 16ms(60fps) | 手测 + devtools |
| 单行写延迟 | ≤ 100ms | `performance.now()` 埋点 |
| 运行时依赖 | **零**(除 Obsidian / TS 外) | `package.json` |
| Node 构建版本 | ≥ 18 | `mise.toml` |
| Obsidian 最低版本 | 1.12.2(CLI handler API) | `manifest.json.minAppVersion` |

---

## 并行开发工作流

### 拆分原则

**一条并行流 = 一组故事 + 一个主模块 + 至多一个副模块**。
冲突的文件数 ≤ 2 个,rebase 代价可控。

### 当前等人认领的流

| 流 | 主模块 | 副模块 | 覆盖故事 | 阻塞 |
|---|---|---|---|---|
| A · 子任务按钮 | view | writer | US-141 | 无 |
| B · 移除动画打磨 | anim | view | US-127 | 无 |
| C · 跨文件 nest UI 提示 | view | i18n | US-129 | US-125 已合 |
| D · 循环任务决策 + 实现 | parser + writer | view | US-901 | 待决策 |
| E · 优先级排序 | view | parser | US-903 | 待决策 |
| F · 设置热更新 | view | settings | US-904 | 需要 view 拆 controller |
| G · 跨文件 nest 撤销 | view | writer | US-929 | 需要升级 view undo 栈 |
| H · mtime 冲突防护 | writer | cli | US-930 方案 A | 待决策 |
| I · 上架 Community Plugins 改名 | main | 所有 id 引用 | US-940 | 需迁移脚本 |

### 认领工作流的 checklist

PR / issue 描述里列齐:
1. 目标故事 ID(引 USER_STORIES)。
2. 主 + 副模块(动了第 3 个模块 → 拆 PR)。
3. 测试位置(哪个 `.mjs` / e2e)。
4. 契约有没有变(上面"各模块的公开 API"一节)。变了要先单独 PR 改契约,再跟实现。
5. 对其它流的影响(预期 rebase 冲突面)。

### 合流顺序

1. USER_STORIES / UX / ARCHITECTURE 改动先合。
2. 契约 PR 先于实现 PR。
3. CLI 输出格式 / 错误码改动同 PR 更新 `skills/obsidian-task-center/SKILL.md`。

---

## 已决策的事

留下来避免反复讨论:

| 日期 | 决策 | 背景 |
|---|---|---|
| 2026-04-23 | 放弃是一等状态 `[-] ❌`,不是删除 | P3 画像核心需求 |
| 2026-04-23 | CLI 走 `registerCliHandler`,**不**做 wrapper shell | US-201;依赖 Obsidian ≥ 1.12.2 |
| 2026-04-23 | 写操作全部 `Vault.process` | 对抗 mid-edit crash |
| 2026-04-23 | hash 歧义**不**猜,返回候选 | AI 可信度优先 |
| 2026-04-23 | Completed tab **不**应用终态传播过滤 | 用户要看历史 |
| 2026-04-23 | 跨文件 nest 不在撤销栈里 | 先上线,撤销留给 US-929 |
