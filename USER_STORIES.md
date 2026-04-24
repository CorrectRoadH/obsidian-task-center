# 用户故事

> 本文档是产品交付的**单一事实来源**(single source of truth)。不是 README 的倒推镜,也不是 CHANGELOG 的摘要——而是 SPEC.md 之下、实现之上的故事层。每条故事都有稳定 ID、验收标准、优先级、所属模块,供并行开发引用。

## 如何阅读 / 使用

- **ID 规则**:`US-<角色段><序号>`。1xx = P1 知识工作者,2xx = P2 AI 协作者,3xx = P3 精力管理,4xx = 横切关注点,9xx = 待决策。ID **永不复用**,废弃的故事标记 `[DROPPED]` 保留。
- **状态**:
  - `shipped` — 0.1.0 已发布并有验收路径
  - `unreleased` — 已实现,未发版(见 CHANGELOG "Unreleased")
  - `planned` — 在 SPEC 范围内,尚未实现
  - `decision-needed` — 故事方向未定,见 §待决策
- **优先级**:`P0` 影响核心体验 / 阻塞发布;`P1` 显著改善;`P2` 锦上添花。
- **模块**:见 [SPEC.md](./SPEC.md) §3。跨模块用 `+` 连接,表示该故事的验收需要多模块协作。
- **验收标准**:用 Given/When/Then 三段式。若已有 e2e / 单测覆盖,列出 `test:` 指针。

## 产品定位

在 Obsidian Tasks 语法(纯 markdown inline task)之上,加一层:
1. **GUI 看板** — 周/月/未排期/已完成,带拖拽改期、回收站、象限分组;
2. **原生 CLI** — 通过 `registerCliHandler`(Obsidian 1.12.2+)把 verb 暴露给 shell,供 AI agent 稳定调用。

数据始终是纯 markdown,和 Obsidian Tasks、Dataview、任何读纯文本的工具兼容。

## 用户画像

- **P1 · 知识工作者** — 常驻 Obsidian,已经在用 Tasks 插件,希望在 markdown 之上加一层看板 + 拖拽排期,不想离开当前工作流。
- **P2 · AI 协作者** — Claude Code 或同类 agent。代替用户从 shell 读写任务。在意稳定 id、幂等性、grep 友好输出。
- **P3 · 精力管理用户** — 用 Covey 四象限规划,用"估时 vs 实际耗时"对抗 planning fallacy,把"放弃"视为一等状态(不是删除)。

---

## P1 · 知识工作者

### 看板视图(view + parser)

#### US-101 · 本周看板 【shipped · P0 · view+parser】
**作为**用户,**我想要**本周看板(Mon–Sun,今日高亮),**以便**一眼看出哪天被塞满。
- **AC1**:GIVEN 当前为 2026-04-24(周五),WHEN 打开 Week tab,THEN 渲染 7 列,列头按 `weekStartsOn` 设置排列,今日列有高亮 class。
- **AC2**:GIVEN 某任务 `⏳ 2026-04-25`,THEN 卡片出现在"周六"列。
- **AC3**:GIVEN 任务无 `⏳`,THEN **不**出现在 Week tab。

#### US-102 · 月度日历看板 【shipped · P0 · view】
**作为**用户,**我想要**月度日历看板,**以便**往前规划更远。
- **AC1**:WHEN 打开 Month tab,THEN 渲染对应月历网格,空日期格显示为 drop zone。
- **AC2**:每一格显示该日任务列表,按 US-103 规则排序。

#### US-103 · 当日卡片按 deadline 排序 【shipped · P1 · view】
**作为**用户,**我希望**每一天内部的卡片按 deadline 排序,**以便**当天最紧急的项始终在列首。
- **AC1**:GIVEN 同日两任务 A(📅 2026-05-01) 和 B(📅 2026-04-28),THEN B 在 A 之上。
- **AC2**:GIVEN 无 deadline 的任务,THEN 排在有 deadline 的任务下方,按创建时间倒序。

#### US-104 · 未排期池排序 【shipped · P1 · view】
**作为**用户,**我希望**未排期池按紧急度排序(deadline 优先,其次按创建时间倒序),**以便**池顶永远是下一件该挑的事。
- **AC1**:同 US-103,但作用于 Unscheduled tab 整体。

#### US-105 · Tab 标题显示待办数量 badge 【shipped · P1 · view】
**作为**用户,**我希望**每个 tab 标题上显示待办数量 badge,**以便**不切换 tab 也能知道工作量分布。
- **AC1**:badge 实时随任务状态变化更新(完成 / 放弃 / 改期 / 增删)。
- **AC2**:badge 数字 = 该 tab 可见的 `[ ]` 任务数。

#### US-106 · 状态栏摘要 【shipped · P1 · view+main】
**作为**用户,**我希望**状态栏显示 `📋 N today · ⚠ M overdue`,点击即打开看板。
- **AC1**:N = 今日 `⏳` 的 `[ ]` 任务数。
- **AC2**:M = `📅` 过期且仍为 `[ ]` 的任务数。
- **AC3**:点击 widget 等价于执行 `⌘/Ctrl+Shift+T`。

#### US-107 · callout 任务是一等公民 【shipped · P0 · parser】
**作为**用户,**我希望** callout 里的任务(`> - [ ]`)也被识别,**以便**不被忽略。
- **AC1**:GIVEN `> - [ ] 任务` 或 `>> - [ ]`,THEN parser 返回对应 ParsedTask。
- **AC2**:test: `test/parser.test.mjs`。

### 拖拽(view + writer + anim)

#### US-121 · 周列间拖拽改期 【shipped · P0 · view+writer】
**作为**用户,**我想**把卡片在本周列之间拖来改排期,**以便**不用手改 markdown。
- **AC1**:WHEN 卡片从"周三"拖到"周五",THEN 源行的 `⏳` 被改写为对应日期,文件保存后 Week tab 重渲染。
- **AC2**:改写通过 `Vault.process` 原子完成。

#### US-122 · 月视图格子为 drop zone 【shipped · P1 · view+writer】
同 US-121,作用域扩展到 Month tab 任意日期格。

#### US-123 · 垃圾桶放弃任务 【shipped · P0 · view+writer】
**作为**用户,**我想**把卡片拖进底部固定的垃圾桶,标记 `[-] ❌ today`——这是"放弃",不是从磁盘删除。
- **AC1**:WHEN 拖入垃圾桶,THEN 对应行从 `- [ ]` 改为 `- [-]`,追加 `❌ <today>`。
- **AC2**:文件、行号、其它元数据(tag, estimate, actual, deadline)保留。

#### US-124 · 放弃级联到未完成子任务 【shipped · P0 · view+writer+parser】
**作为**用户,**我希望**拖入垃圾桶时级联处理未完成子任务;**但已完成(`[x]`)的子任务必须保留**作为历史。
- **AC1**:GIVEN 父任务含 `[ ]` 子任务 S1 和 `[x]` 子任务 S2,WHEN 父拖入垃圾桶,THEN S1 也变 `[-] ❌ today`,S2 保持 `[x]`。
- **AC2**:test: `test/writer.test.mjs` drop 级联套件。

#### US-125 · 卡片拖成子任务(跨文件) 【unreleased · P0 · view+writer+parser】
**作为**用户,**我想**把一张卡拖到另一张卡上,让它成为子任务——**跨文件**也要支持,源行原子地从原文件删除、插入到目标文件。
- **AC1**:GIVEN A 在 FileA.md:L10,B 在 FileB.md:L20,WHEN A 拖到 B,THEN FileA.md 的 L10 行被移除,FileB.md 在 L20 之后插入 A 的行,缩进 = B.indent + "    "。
- **AC2**:两次写分别通过 `Vault.process`;若第二步失败,不回滚第一步(限制见 US-929)。
- **AC3**:CLI 对等命令 `task-center:nest ref=… under=…`(见 US-228)。

#### US-126 · 拒绝循环和自嵌套 【unreleased · P0 · writer】
- **AC1**:WHEN A 试图拖到 A 自己或 A 的后代上,THEN 拒绝操作,返回 `error cycle`,文件不变。
- **AC2**:test: `test/writer.test.mjs` nest cycle 套件。

#### US-127 · 卡片移除动画 【unreleased · P1 · view+anim】
**作为**用户,**我希望**所有卡片移除动作(拖去垃圾桶 / 别的天、完成、放弃、`←/→`、`Space`、`Delete`、日期弹窗)都淡出 + 折叠,**以便**邻居平滑上移;原地不动的操作跳过动画。
- **AC1**:移除动画时长 ≤ 200ms,用 Web Animations API。
- **AC2**:GIVEN 任务拖到当前日期(no-op),THEN 不播放动画。

#### US-128 · 20 步撤销 【shipped · P0 · view+writer】
**作为**用户,**我希望** `Ctrl/Cmd+Z` 能撤销最近 20 步拖拽 / 方向键改期 / 重命名,**以便**手滑一下不至于要翻 git。
- **AC1**:撤销栈仅在当前 board 实例内有效,关闭 view 后清空。
- **AC2**:撤销仅恢复"源行文本",不回滚其它副作用(例如:级联子任务的改动)。

#### US-129 · 跨文件 nest 不可撤销的 UI 提示 【planned · P1 · view】
**作为**用户,**我知道**"跨文件 nest"不可撤销,**我希望**这个限制在 UI 里提示,而不是悄悄吞掉。
- **AC1**:WHEN 跨文件 nest 发生,THEN 显示一次性 notice:"跨文件移动不可撤销,如需回退请用 git"。
- **AC2**:notice 有 dismiss-and-remember 选项(保存到 localStorage)。

### 多级任务 · 父/子(view + writer + parser)

#### US-141 · `+ 子任务` 按钮 【unreleased · P1 · view+writer】
**作为**用户,**我想**通过卡片上的 `+ 子任务` 按钮直接加子任务,**以便**不用记快捷键;新子任务继承父级的 `⏳`。
- **AC1**:按钮点击后弹出单行输入框,Enter 提交,Escape 取消。
- **AC2**:新子任务写入父所在文件的父行后,缩进 = parent.indent + "    ",继承 `⏳`。

#### US-142 · 嵌套子任务递归渲染 【shipped · P0 · view+parser】
**作为**用户,**我希望**嵌套子任务在卡片里递归渲染,每一层的 checkbox 和标题编辑都要能用。
- **AC1**:GIVEN 3 层嵌套,THEN 第 2、3 层都在父卡内部可见。
- **AC2**:每层的 checkbox 切换独立作用,不串扰。

#### US-143 · 父可见时子不作顶层 【shipped · P0 · view】
**作为**用户,**我希望**父级可见时,它的子任务在视图里不再作为独立顶层卡片出现。
- **AC1**:GIVEN 父 P(`⏳ today`)和子 C(`⏳ today`),THEN C 仅作为 P 的嵌套卡片出现,不是顶层 C。
- **AC2**:GIVEN 父 P(无 `⏳`)和子 C(`⏳ today`),THEN C 作为顶层卡片出现在 Week tab 今日列(因父不可见)。

#### US-144 · 子任务 `⏳` badge 只在不同时显示 【shipped · P1 · view】
- **AC1**:子 `⏳` == 父 `⏳`:不显示 badge。
- **AC2**:子 `⏳` != 父 `⏳`:显示 `⏳ YYYY-MM-DD` badge。

#### US-145 · 祖先终态传播 【shipped · P0 · parser+view】
**作为**用户,**我希望**任意祖先(任务 / bullet / `#dropped` 章节标题)一旦是 `[x]` / `[-]` / `#dropped`,它所有后代自动从活动视图(todo / week / month / unscheduled)消失。
- **AC1**:`parser` 在 ParsedTask 上标记 `inheritsTerminal: true`;view 层按此字段过滤活动视图。
- **AC2**:Completed tab **不**过滤 — 用户需要看到历史。
- **AC3**:test: `test/parser.test.mjs` ancestor-propagation 套件。

#### US-146 · 同日创建子任务不重复 ➕ 戳 【shipped · P1 · writer】
**作为**用户,**我希望**子任务如果和父级是同一天创建,就不重复打 `➕` 时间戳,**以便**避免新项目里满屏冗余时间。
- **AC1**:GIVEN `stamp-created=true` 且父的 `➕` == today,THEN 新子任务省略 `➕`。
- **AC2**:GIVEN 父无 `➕` 或父 `➕` != today,THEN 新子任务写 `➕ today`。

#### US-147 · 父改动不丢子元数据 【shipped · P0 · writer】
**作为**用户,**我希望**父级的 重命名 / 改期 / 拖拽 操作**不会**丢子任务的元数据。
- **AC1**:WHEN 父执行任意写操作,THEN 子任务原文件行(tag / estimate / actual / emoji / blockref)字节级不变。
- **AC2**:test: `test/writer.test.mjs` preserve-children 套件。

#### US-148 · 子任务改期表示法 【decision-needed · P1 · writer】
见 [US-902](#us-902-子任务跨日期拖拽的表示法)。

### 卡片编辑与快捷键(view)

#### US-161 · 就地重命名 【shipped · P0 · view+writer】
**作为**用户,**我想**点击标题就地重命名(Enter 提交、Escape 回退),**以便**不丢 emoji、tag、`[estimate::]`、`[actual::]`、`^blockrefs`、`🔁`、优先级符号。
- **AC1**:重命名后,非标题部分(tags, emoji metadata, inline fields)在源行中位置 / 顺序 / 字节完全保留。
- **AC2**:test: `test/writer.test.mjs` rename-preserves-meta 套件。

#### US-162 · 键盘优先的卡片操作 【shipped · P0 · view】
- `1–4` 换象限 · `←/→` 改天 · `Space` 完成 · `D` 日期弹窗 · `Delete/Backspace` 放弃
- `E/Enter` 打开源文件 · `Ctrl+Z` 撤销(20 深)· `/` 聚焦筛选框
- `Ctrl+1–4` 切 tab · `Ctrl+T` 快速添加 · `⌘/Ctrl+Shift+T` 打开看板
- **AC1**:快捷键不在 input/textarea focus 时生效。
- **AC2**:冲突时遵循上表优先级。

#### US-163 · 一行快速添加 【shipped · P0 · view+quickadd+writer】
**作为**用户,**我想**一行快速添加任务,支持自然语言日期(`今天 / tomorrow / 周六 / Mon`)。
- **AC1**:`Ctrl+T` 打开 QuickAdd 弹窗;输入解析 `#tag`、`⏳`、`[estimate::]`、自然语言日期。
- **AC2**:目标文件优先级:`to=` → 父文件(若指定 `parent=`)→ 当日 daily note → `settings.inboxPath`。
- **AC3**:test: `test/quickadd.test.mjs`。

---

## P2 · AI 协作者

#### US-201 · 原生 CLI verb,无 shell 转义 【shipped · P0 · cli+main】
**作为** agent,**我想**用 Obsidian 原生 CLI verb,**以便**不用 shell 转义或 eval。
- **AC1**:所有 verb 通过 `registerCliHandler` 注册(Obsidian ≥ 1.12.2)。
- **AC2**:参数以 `key=value` 传递,空格值用 `"…"` 引号。

#### US-202 · 稳定 id 为首列 【shipped · P0 · cli】
**作为** agent,**我想**每行 list 输出的首列都是稳定 id(`path:L42` 或 hash),**以便** `grep/awk/cut` 直接能用。
- **AC1**:list 每行首列 matches `^[^\s:]+:L\d+` 或 12-hex hash。
- **AC2**:列分隔符为 2 空格或 tab,不混用。

#### US-203 · 幂等写操作 【shipped · P0 · cli+writer】
**作为** agent,**我想**幂等的写操作,**以便**重跑不炸状态。
- **AC1**:对已完成任务再跑 `done` 返回 `ok … unchanged`,exit 0。
- **AC2**:所有写 verb 均满足此约束。
- **AC3**:test: `test/cli.test.mjs` idempotent 套件。

#### US-204 · before/after diff 【shipped · P0 · cli+writer】
**作为** agent,**我想**每次写都返回 `before/after` diff,**以便**验证刚才发生了什么。
- **AC1**:每个写 verb 的成功输出包含 `before <rawLine>` 和 `after <rawLine>` 两行。
- **AC2**:`unchanged` 路径返回 `before == after`。

#### US-205 · JSON 输出 【shipped · P0 · cli】
**作为** agent,**我想** `list` 和 `stats` 的 `format=json` 出口,**以便**不必刮人类友好输出。
- **AC1**:`format=json` 返回单个 JSON document 到 stdout,无其它文本。
- **AC2**:`list` 返回 array,每项含 ParsedTask 全字段;`stats` 返回 `{ratio, mean, stddev, within_band, per_tag: {...}}`。

#### US-206 · stats 暴露估时准确率 【shipped · P0 · cli】
**作为** agent,**我想** `stats days=N` 暴露"估时准确率 + 各 tag 分钟数",**以便**代替用户校准未来的估时。
- **AC1**:默认 `days=7`。
- **AC2**:`group=<前缀>` 把匹配的 tag 聚合成一节(例如 `group=象限`)。

#### US-207 · 统一的时间筛选词 【shipped · P0 · cli+dates】
**作为** agent,**我想**一套跟人说话方式一致的时间筛选词:
`today / tomorrow / yesterday / week / next-week / month / next-month / unscheduled / YYYY-MM-DD / FROM..TO`
- **AC1**:`scheduled=` 和 `done=` 共享同一词汇表(`unscheduled` 仅 `scheduled=` 语义有效)。
- **AC2**:非法词汇返回 `error invalid_date`。

#### US-208 · hash fallback id 解析 【shipped · P0 · writer】
**作为** agent,**我想** hash fallback 的 id 解析,**以便**当行号失效也能找到任务。
- **AC1**:GIVEN `path:L42` 但 L42 不是任务,THEN 尝试 title-hash 匹配同文件剩余任务。
- **AC2**:GIVEN 12-hex hash,THEN 全 vault 扫描匹配。
- **AC3**:hash 歧义(>1 候选)返回 `error ambiguous_slug`,列出所有候选 id,**不**猜测。

#### US-209 · 增量时间操作 【shipped · P0 · cli+writer】
**作为** agent,**我想**增量时间操作(`actual minutes=+30m`),**以便**记工时不必先读再写。
- **AC1**:`+Nm` 追加到现有 `[actual::]`;若原无,视为 0 + Nm。
- **AC2**:单位接受 `m` / `min` / `h` / `h30m` 等(parser.parseDurationToMinutes)。

#### US-210 · 明确推荐的工作流顺序 【shipped · P1 · docs】
**作为** agent,**我想** SKILL.md 里明确推荐的工作流顺序,**以便**不必反推 verb 的调用顺序。
- **AC1**:SKILL.md 含 "End-of-day wrap-up"、"Quick capture"、"Backfill completions" 三段。

#### US-211 · 错误码契约 【shipped · P0 · cli+writer】
- **AC1**:错误到 stderr,首行 `error <code>`,第二行人类消息(缩进 2 空格)。
- **AC2**:Codes: `task_not_found / file_modified / ambiguous_slug / invalid_date / invalid_indent / cycle`。
- **AC3**:文档化在 SKILL.md。

#### US-228 · CLI `nest` verb 【unreleased · P0 · cli+writer】
**作为** agent,**我想** `task-center:nest ref=A under=B`,**以便**跨文件把 A 设为 B 的子任务。
- **AC1**:语义和 US-125(GUI 拖拽)完全一致。
- **AC2**:循环 / 自嵌套返回 `error cycle`。

---

## P3 · 精力管理用户

#### US-301 · 象限 tag 【shipped · P0 · parser+view】
**作为**用户,**我想**给任务打象限 tag(`#1象限`–`#4象限`),未排期池按象限分组。
- **AC1**:Unscheduled tab 按 `#1/#2/#3/#4象限` 分组,无象限的归入"其它"。
- **AC2**:parser 识别 `#N象限`(N=1..4)为象限字段。

#### US-302 · 估时与实际耗时 【shipped · P0 · parser+writer+cli】
**作为**用户,**我想**记估时(`[estimate:: 90m]`)和实际耗时(`[actual:: 75m]`)。
- **AC1**:parser 提取两字段为 int minutes;非法值(负数 / 空)parsed 为 null。
- **AC2**:writer 以 `m` 为基准单位写回(不做 `1h30m` 美化)。

#### US-303 · 近 7 天准确率 【shipped · P0 · view+cli】
**作为**用户,**我想**在已完成 tab 看到近 7 天的准确率(`sum(actual)/sum(estimate)`),按周聚合,加 top-4 tag 分钟数。
- **AC1**:Completed tab 顶部显示 `sum actual / sum estimate` 比率和 top-4 tag 分钟数。
- **AC2**:`task-center:stats days=7` 输出相同统计。

#### US-304 · 历史周默认折叠 【shipped · P1 · view】
- **AC1**:Completed tab 按周分组;本周展开,历史周默认折叠。
- **AC2**:折叠状态 session 内保留,关闭 board 后重置为默认。

#### US-305 · `[-] ❌` 是一等状态 【shipped · P0 · parser+view+writer】
- **AC1**:`[-]` 状态独立于 `[x]` 显示,有专属样式(灰/斜体)。
- **AC2**:Completed tab 聚合时,`[-]` 进入 "abandoned" 分类,不计入"完成计数"。

---

## 横切关注点(cross-cutting)

#### US-401 · 纯 markdown,无自定义格式 【shipped · P0 · parser+writer】
- **AC1**:所有数据均存在于 `- [ ]` / `- [x]` / `- [-]` 行内,不使用 YAML front matter,不维护外部索引文件。
- **AC2**:对照产品:Obsidian Tasks plugin、Dataview 读相同文件行为一致(没被 Task Center 独占字段)。

#### US-402 · zh/en 自动检测 【shipped · P1 · i18n】
- **AC1**:`localStorage.language` 存在则用它;否则用 `navigator.language` 前缀。
- **AC2**:i18n key 丢失时 fallback 到英文,不抛错。

#### US-403 · 原子写 【shipped · P0 · writer】
- **AC1**:所有写操作通过 `Vault.process(file, transform)` 完成;mid-edit crash 不应损坏文件。
- **AC2**:跨文件 nest 的两次写各自原子,但两者之间不保证原子(见 US-929)。

#### US-404 · 快速跳过无任务文件 【shipped · P1 · parser】
- **AC1**:通过 `MetadataCache.listItems` 预筛,只加载有 list item 的文件。
- **AC2**:大 vault(>10k notes)打开看板首帧 ≤ 500ms(benchmark 目标,非硬约束)。

#### US-405 · 设置持久化 `lastTab` 【shipped · P1 · settings+view】
- **AC1**:关闭 board 时当前 tab 写入 `settings.lastTab`。
- **AC2**:下次打开 board 使用 `lastTab`;若为 null,用 `defaultView`。

---

## 待决策故事(decision-needed)

> 代码或 CHANGELOG 提过,但故事方向未定。每条给出"当前实现"+"候选方案"+"负责决策人"。决策后把故事拉回主节并更新 ID。

### US-901 · 循环任务(`🔁`)完成时的下一实例
- **现状**:parser 保留 `🔁` 字段;完成一个循环任务**不**生成下一实例。
- **候选 A**:完成时根据 `🔁 every week` 等表达式,在同文件 appeend 一条新 `- [ ]`,`⏳` = 下一周期日期。
- **候选 B**:继续不生成,只保留字段,让 Obsidian Tasks 插件自己处理。
- **候选 C**:配置项开关,默认 B。
- **决策待:**产品负责人。

### US-902 · 子任务跨日期拖拽的表示法
- **现状**:子任务拖到别的天是**原地改** `⏳`。
- **候选 A**(当前):原地改 `⏳`,结构不动。
- **候选 B**:目标日新建 `[[parent]] > child` wikilink 卡片,原子任务 `⏳` 不变。
- **候选 C**:按修饰键区分(Alt 拖 = 候选 B)。
- **决策待:**产品 + 交互。

### US-903 · 优先级符号(`🔺⏫🔼🔽⏬`)参与排序/筛选
- **现状**:GUI 保留但不参与排序、不响应快捷键。
- **候选 A**:未排期和本周按 `优先级 → deadline → created` 多级排序。
- **候选 B**:增加 `↑/↓` 快捷键改优先级。
- **决策待:**产品。

### US-904 · 设置热更新
- **现状**:设置改后需要关闭并重开 board 才生效。
- **候选**:board 订阅 settings 变更事件,diff 最小重渲染。
- **估工作量**:中(需要 view 拆 controller-renderer)。
- **决策待:**工程。

### US-929 · 跨文件 nest 的撤销
- **现状**:US-128 undo 栈不覆盖跨文件 nest;提示"用 git"。
- **候选 A**:session 级跨文件 undo 栈,记录 `(srcFile, srcLine, dstFile, dstLineBefore)`,undo 时逆向 `nest`。
- **候选 B**:保持现状,只完成 US-129(UI 提示)。
- **决策待:**工程。

### US-930 · 多设备同步冲突
- **现状**:Obsidian Sync / iCloud / git 三路抢同一行时行为未定义,可能覆盖。
- **候选 A**:写前 `mtime` 校验,冲突返回 `error file_modified`,让用户 / agent 决定重试。
- **候选 B**:最后写赢(当前行为),文档化。
- **决策待:**产品 + 工程。

### US-940 · Community Plugins 上架改名
- **现状**:plugin id 含 `obsidian` 子串,被官方目录拒收。
- **决策待:**产品决定是否改名;改名会破坏现有用户的 `<vault>/.obsidian/plugins/obsidian-task-center` 目录,需要迁移脚本或文档。

---

## 变更流程

1. 新故事:分配下一个可用 ID(同段内顺延),写入对应章节,设初始 `planned` 状态。
2. 故事改验收标准:保留 ID,更新 AC,追加 "__修订 YYYY-MM-DD__" 行说明原因。
3. 废弃故事:状态改 `[DROPPED]`,保留条目,追加 "__废弃 YYYY-MM-DD__" 行。
4. 从 `decision-needed` 转出:分配正式段 ID,删除 US-9xx 条目前加 "→ 见 US-XXX" 指针。
5. 所有引用:PR / commit message 用 `US-XXX` 前缀,以便双向追溯。
