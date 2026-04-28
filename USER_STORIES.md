# 用户故事

> 只讲**谁想要什么、为什么**。想知道界面长啥样 / 交互细节 → 去 [UX.md](./UX.md);想知道数据结构 / 代码怎么组织 → 去 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 我们在做什么

在 Obsidian 的 `- [ ] 任务` 这个最朴素的写法之上,加两样东西:

1. 一个**看板**。通过 周、月 View + Task 池来管理所有在Task的任务
2. 一套**命令行动词**,让 Claude Code 这类 AI agent 能稳定地读写任务,不用解析人眼看的花哨输出。

数据永远是那行 markdown。不造新格式、不建数据库,Dataview 和 Obsidian Tasks 插件照常用。

## 扩展
我们需要兼容 Obsidian Tasks Plugin。它扩展了一些 todo 用法，我们一样来兼容（解析、显示、即使本插件 UI 不展示也不能在改名/移动/嵌套时吃掉，详见 US-407）。

```
- [ ] Task A ➕ 2026-04-24 ⏳ 2026-04-24
    - [x] Task C ✅ 2026-04-24
    - [ ] Task B
```

➕ 创建于
⏳ 安排到
✅ 完成于
❌ 放弃于
📅 截至于
🛫 开始于
🔁 循环任务
🔺⏫🔼🔽⏬ 优先级
`[字段名:: 值]` 内联字段(如 `[estimate:: 90m]` `[actual:: 75m]` `[id::]` `[priority::]` `[recurrence::]`)

## 我们在为谁做

- **P1 · 常驻 Obsidian 的人**
  已经在用 Tasks 插件,想在 markdown 上加一层看板 + 拖拽排期,不愿切出当前工作流。
- **P2 · AI agent**
  Claude Code 或类似 agent,代替用户从 shell 读写任务。对"输出能被 grep"、"重复跑不炸"、"错误能解释"这些事很敏感。
- **P3 · 做精力管理的人**
  用 Covey 四象限,用"估了多久 vs. 真花了多久"对抗自己的乐观。关心"放弃"这个动作,不想只能"完成或删除"。


## 用户场景

- 小黄，苦于想做的太多，总是把任务做不完，安排太多了任务。想在obsidian快速添加很多 task(然后breakdown或者汇集)。然后让AI帮助把任务安排。并且每天复盘今天做的多了还是少了。是安排、估事不合理还是怎么样。

---

## P1 · 常驻 Obsidian 的人想要的

每条带一个稳定编号,方便 PR / commit 引用。这是 baseline,描述最终状态;。

### 看板 & 视图

- `US-101` 一眼看到**本周 7 天**谁塞满了,今日高亮。切到上一周、下一周。桌面 / 大屏 week 是 7 个日期列；移动端 week 是 7 个日期 row（见 US-503）。两者只是布局不同,**日期归属、任务计数、估时合计、拖拽改期语义必须完全一致**。周视图主区域不能塌得太矮：桌面与移动端的 week 主体最小高度至少占当前 Task Center 可视高度的一半,否则 PM 认为视觉上不成立。
- `US-102` 月度日历，可以在切到上一个月、下一个月
- `US-104` 未排期池顶永远是"该挑下一件的那件"——先按 deadline,再按新加入时间。
- `US-105` 每个 tab 自带"待办数"小圆点：badge 数 = **该 tab 切过去后实际渲染的顶层卡数**（与 `hideChildrenOfVisibleParents` 等所有显隐规则一致；父可见时被 inline 进父卡的子任务**不**单独计入；US-148 跨日子任务在自己 ⏳ 的 tab 里计入）。**badge 数与切过去能数到的卡数必须一致**——不允许 badge 上显 15、切过去只有 1 这种误差。
- `US-106` 状态栏一直显示 `📋 N today · ⚠ M overdue`,点一下就打开看板。
- `US-107` 如果 - [ ] 这样名字为空白的任务就被忽略掉。 
- `US-108` 可以通过`[字段名:: 值]`比如`[estimate:: 90m]`来扩展meta。还可以给任务加上`#内容`来标记内容。应用不对于这块有特别的限制，只是一种`约定大于配置`，用户可以自定义，后续的用户场景的四象限、复盘估时都是基于这种可以自定义的配置的一种实现。**应用层不允许硬编码任何 tag / 字段名字面**——所有过滤、快捷键、菜单项都从用户配置或 markdown 现状派生。`#1象限`、`[estimate::]` 等只是文档示例里的字面量，不是应用知识。应用识别的是 Markdown / Obsidian 语义上的 hashtag，而不是任何 `#` 后面的文本：`#^block-id`、wikilink 内部 anchor（如 `[[Note#Heading]]` / `[[Note#^id]]`）、inline code 里的 `#片段`、被标点或句子粘住的伪 tag 不能进入 tag 候选；这些字节仍必须按 US-407 / US-409 原样保留。
- `US-109` **筛选要解决的问题**：任务太多时，用户要把全库任务临时缩小成“现在能处理 / 今天要看 / 本周复盘”的集合，而不是面对一排含义不明的控件。筛选只改变当前可见集合与汇总，不改 markdown、不创建任务、不改变任务状态。
  - 搜索 = 按任务标题关键字缩小集合。
  - tag = 普通用户数据；筛选栏用当前视图候选任务里实际存在的合法 `#tag` 做标签选择器，可同时选择多个 tag。
  - 日期 = 日期条件控件，不是裸 `YYYY-MM-DD` 输入框；按有效排期日期筛选，常用预设放一级，自定义范围进入 date picker（同 US-207）。
  - 状态 = 在待办 / 已完成 / 已放弃 / 全部之间切换；默认是待办。
  - 汇总 = 对当前筛选后的集合计算任务数、估时、实际耗时、字段 sum / ratio 等复盘值。
- `US-109a` **筛选栏不是一个“筛选”下拉**。桌面筛选栏的每个控件必须说清自己筛什么：搜索框 placeholder 是“搜索任务”，tag 控件是“标签”按钮 + popover，日期控件是“日期”条件 popover，状态控件是“状态”按钮 + popover。如果某一维没有可选项，该控件隐藏或 disabled 并说明原因，不能显示一个点开后仍只有“筛选”的 option。
- `US-109b` **组合筛选必须可解释**。筛选栏要能显示当前条件摘要，例如 `tag:#alpha,#beta · 日期:本周 · 状态:待办`；用户能一键清空临时筛选。空结果时说明是筛选导致的，并提供“清空筛选”动作。
- `US-109c` **保存过滤视图**：用户可以把常用 tag / date / status / search / summary 组合命名保存成固定视图，比如“Q1”“工作”“本周复盘”，之后一键切换。按钮文案必须是“保存过滤视图”（英文 Save filter view），点击后要求用户命名；保存视图只是 UI preset，不改 markdown、不创建新数据模型；保存的是条件集合与汇总配置，不保存当时的任务列表快照。没有保存视图时，“无过滤”菜单要提示可以先设置条件并新建视图。
- `US-109d` **tag 选择器的选项来源与形态**。tag 选项按“当前 tab / 保存视图 / 日期 / 状态等非 tag 条件”筛出的候选集合计算，并显示每个 tag 的命中数；已选 tag 即使命中数变成 0 也要留在列表里直到用户手动取消或清空筛选。选中多个 tag 默认是 AND 语义：任务必须同时包含这些 tag 才显示。控件形态为“标签”按钮 + popover：未选时按钮显示“标签”，选 1 个时按钮直接显示该 tag，选多个时显示“第一个 tag +N”；不要在按钮旁边再铺一排外部 tag chip。popover 顶部有搜索框，下面是自绘 checkbox 行；长 tag 单行截断但可看完整 title；排序为已选优先、命中数降序、locale 排序。不得使用原生 `<select multiple>` 展示 tag 列表，也不得依赖原生 checkbox/label 的点击行为；点击整行必须稳定切换选中态并立刻更新按钮摘要 / visible set。
- `US-109e` **时间范围选择器形态**。日期控件默认展示“日期”，点开后是自绘 popover，不用原生 select，也不把自定义路径做成手输日期表单。popover 左侧/上方是快捷范围：全部、逾期、今天、明天、本周、下周、本月、未排期；右侧/下方是日历视图：月份前后切换、星期列按 US-112 一周起始设置排列、日期格可点击。日历视图固定表达“开始日期 → 结束日期”的范围选择：第一次点击日期只标记开始，第二次点击日期写入闭区间 `FROM..TO`；若第二次早于第一次，自动交换开始 / 结束。快捷范围不能渲染成一串占满宽度的大主按钮；选中态只做轻量高亮，避免压过工具栏。用户看到的日期按 locale 显示，保存视图和 CLI 表达仍用稳定 token：`all / overdue / today / tomorrow / week / next-week / month / unscheduled / YYYY-MM-DD / FROM..TO`；其中 `YYYY-MM-DD` 作为 legacy / CLI 精确日期表达可读可显示，但日历 UI 默认产出范围 token。
- `US-109f` **不提供独立“分组”筛选控件**。保存视图只保存 search / tags / date / status / summary 等条件集合；`#计划`、`#安全`、`#1象限`、`#now` 都通过“标签”筛选 + 保存视图表达。未来如果要“按 tag 分组渲染”，必须另开新故事定义它如何改变列表结构，不能把单 tag 过滤伪装成“分组”。
- `US-109g` **保存视图切换控件不用原生 select**。桌面和移动端都使用“无过滤 / <视图名>”按钮 + popover。popover 第一项是“无过滤”（清空保存视图和临时筛选），其后是用户保存的过滤视图；没有保存视图时显示轻提示“设置过滤条件后可保存为视图”。切换视图后仍允许继续临时改筛选；一旦临时改动，保存视图选中态清空。
- `US-109h` **状态筛选不用原生 select**。状态控件是轻量按钮 + popover，选项固定为：状态（全部）、待办、完成、放弃；点击选项立即过滤并关闭 popover。选中态只做轻量高亮，视觉层级低于保存过滤视图按钮，不出现系统原生菜单。
- `US-110` 设置「启动时自动开看板」开关，默认关。
- `US-111` 设置「默认 tab」(周/月/已完成/未排期)，决定首次打开停在哪。
- `US-112` 设置「周一/周日为一周第一天」，影响周视图列序与本周边界。
- `US-113` vault 一条任务都没有时，看板显示空状态引导(「没有任务，按 + 添加」)，不是空白看板。
- `US-114` 拖拽过程中悬停在另一个 tab 上一会儿，自动切到那个 tab，松手即可跨视图改期。
- `US-115` deadline 已过的卡显红色 (overdue)、3 天内显黄色 (near-deadline)，眼睛能扫到。
- `US-116` 周视图每天显示「N tasks · XhYm」(任务数 + 估时合计)，看一眼就知道当天满不满。桌面显示在每个日期列顶部；移动端显示在每个日期 row header。两端的 N / XhYm 必须按同一套任务集合计算。
- `US-117` 筛选栏与保存视图栏要能承载长期使用：默认视图、保存视图、临时筛选三者分清。用户切换保存视图后可以继续临时改筛选；只有点“保存/更新视图”才写入设置。移动端不能把桌面完整筛选栏塞进首屏,只能保留一个“筛选”入口；这个入口打开 bottom sheet，里面仍按 US-109a 展示搜索 / 标签 / 日期 / 状态等明确控件，标签选择同样使用搜索 + 自绘 checkbox 列表，不使用原生多选 select。
- `US-118` 设置页只保留仍有用户故事支撑的项；无故事支撑、已经被删除功能依赖的设置必须移除或隐藏。删除设置项时不能破坏旧 `data.json` 读取：旧字段可以被忽略,但不能让插件启动失败。

### 拖拽

- `US-121` **周视图拖拽改期**：把卡从"周三"拖到"周五",这张卡的 `⏳` 就改成周五。更完整地说,任何任务卡落到 week 的某个**日期目标**上,就把该任务自己的 `⏳` 写成那个日期；原来没有 `⏳`（例如来自未排期池）就新增,原来已有 `⏳` 就替换。拖回原本同一天是 no-op：不写文件、不弹 toast、不进 undo 栈。只改被拖任务自己的 `⏳`,不改标题、tag、估时、完成状态、其它 Obsidian Tasks emoji / inline fields。
  - 桌面 week 的日期目标 = 某天列头、列体空白处、卡片之间的列内空隙。
  - 移动端 week 的日期目标 = 某天 row header、折叠 row、展开 row 的非卡片空白处。
  - **卡片本体不是日期目标**：如果落点在另一张卡的卡体上,走 US-125 嵌套,不走 US-121 改期。
- `US-122` 月视图每个日期格都可以当拖入目标。月视图日期格的改期语义与 US-121 相同：落到日期格背景 / 日期数字 / `+N more` 等日期表面时写入该日期；落到某张任务卡本体时仍按 US-125 嵌套。
- `US-123` 把卡拖进底部固定的**放弃目标区**,标成"放弃"(`[-] ❌`),不是从磁盘删。UI 不应使用“垃圾桶/删除”心智或 trash 图标；要表达“放弃/搁置/停止投入”,避免用户误以为会删除文件内容。
- `US-124` 放弃一个父任务时,还没打钩的子任务会自动继承放弃状态,**已经打钩的子任务不动**(作为历史保留)。
- `US-125` 把一张卡拖到**另一张卡**上,它就变成那张的子任务——两张卡在不同文件也行。然后弹一个toast说明，这个toast有一个undo按钮可以点击撤回
  - 这个是真的需要移动被drag的task从一个文件到另一个文件
  - GUI 拖到卡片 = **结构嵌套 + 合并进父任务的排期上下文**。因此如果被拖任务自己有 `⏳`,嵌套时必须清空被拖任务自己的 `⏳`,让它按 US-144 继承目标父级的有效 `⏳`（父级没有有效 `⏳` 时,它就随父级进入未排期上下文）。否则它会按 US-148/US-149 继续作为另一天的独立卡出现,用户看不到"变成父任务下面的子任务"这个结果。
  - 只清空被拖任务这一行自己的 `⏳`;被拖任务子树里其它子孙任务自己写明的 `⏳` / emoji / inline fields 继续按 US-147 / US-407 保留。
  - 如果被拖任务本来已经是该父任务的子任务,这次操作不再移动行,只清空它自己的 `⏳`,让它回到父任务的排期下。
- `US-126a` 拖拽落点优先级固定,避免 US-121 / US-122 / US-125 互相抢解释：非法目标（自己 / 后代）最高优先级 → 放弃目标区 → 任务卡本体（嵌套）→ 日期目标（改期）→ 其它位置无操作。也就是说,在某天列 / row / 月格里的卡片上松手时,永远是 US-125 嵌套；要改期必须松手在日期表面的非卡片区域。
- `US-126` 不能把 A 拖到 A 自己或 A 的后代上(不允许绕圈)。
- `US-127` 每次"卡片从当前位置消失"都应该是**淡出 + 邻居平滑上移**,不该是闪一下就没了。原地不动的操作不放动画。
- `US-128` `Ctrl/Cmd+Z` 能撤销最近 20 步拖拽 / 改期 / 重命名,手滑不至于翻 git。

### 父子任务

- `US-141` **卡片不再提供 `+ 子任务` / inline 子任务输入入口**。新增、删除、编辑子任务统一通过 US-168 源 Markdown 编辑层完成：用户点开卡片,在原文里直接缩进新增 `- [ ]` 行。新子任务不需要重复写父级的 `⏳` / 状态 / tag,按 US-144 的继承规则显示与统计。
- `US-142` 子任务在卡里**递归显示**所有层级,不止一层;每层的 checkbox 和标题都能用。这里的“卡”包含周 / 月 / 未排期 / 搜索结果 / Today 等所有 Task Center 里可点击的任务卡，除非某个具体视图的故事明确写了例外。
- `US-143` 父可见时,子任务**不**作为独立顶层卡重复出现(嵌在父里就够了)。
- `US-144` 子的所有属性如果没有定义的话继承于父任务。比如 状态(完成、放弃) ⏳、📅之类。所以不需要额外写。本文里“有效 `⏳`”指任务自己写了 `⏳` 就用自己的；自己没写就向父级递归继承；一路都没有才是未排期。
- `US-144a` 在已完成 / 已放弃父任务下面新增未完成子任务时,不能静默让用户误以为它是新的活动任务。由于 US-144 会继承父级终态,看板必须明确表现“该子任务继承父级完成/放弃状态”；如果用户想让它重新变成活动任务,应通过源 Markdown 编辑层先恢复父任务状态或把子任务移出终态父级。
- `US-145` **完成或放弃父级,等于自动完成 / 放弃整条分支**——不用一条条勾子任务。活动视图里直接消失,已完成 tab 里能看到历史。
- `US-146` 和父级同一天建的子任务,不重复打 `➕ 创建日期` 戳,避免满屏冗余时间。
- `US-147` 改父级的时候,子任务的 tag / 估时 / 实际耗时 / emoji 字节不变。
- `US-148` 任务卡的子树显示遵循“同一执行上下文一起显示,独立日期拆出去”的规则。父任务安排到 A 时,没有自己 `⏳` 或自己 `⏳` 也等于 A 的子任务,在父卡内递归显示；子任务如果自己有不同的 `⏳`,就不嵌在父卡里,而是在自己 `⏳` 对应的视图 / 日期上下文里作为独立顶层卡显示。周 / 月视图的一天、Today 视图的今日组、搜索结果里的可见父卡都按这条规则处理。
- `US-149` 子任务 `⏳` badge 显隐规则（修订 2026-04-25 锐化）：
  - 父子都有 `⏳` 且**相同** → 不显（冗余）
  - 父子都有 `⏳` 且**不同** → 子卡上显示 `⏳ MM-DD` 小 badge
  - 父无 `⏳` / 子有 `⏳` → 子按 US-148 移到独立顶层卡，**父卡内不再嵌入这张子任务**；该独立顶层卡的 ⏳ badge 显隐按 US-150 顶层规则
  - 子无 `⏳` / 父有 `⏳` → 子继承父的 `⏳`，不显 badge
- `US-151` 顶层 Task Card 必须在标题下方显示该任务 markdown 里写的 `#tag`。范围包含周 / 月 / 未排期 / 搜索结果 / Today 等顶层任务卡；嵌在父卡内的 subcard 为紧凑树节点,不强制显示 tag。tag 文案必须保留 markdown 原文（例如 `#alpha` / `#1象限`）,不翻译、不替换；同一任务重复写同一个 tag 时 UI 只显示一次。
- `US-150` 顶层卡的 `⏳` badge **仅在渲染上下文未隐含其 ⏳ 日**时显示——避免冗余信息：
  - 周视图日列里：卡渲染于自己 `⏳` 那天的列 → **隐藏** badge（列头已经告诉用户日期）
  - 月视图日格里：同上，卡所属日格 = 卡的 `⏳` 日 → **隐藏**
  - 未排期池：N/A（这些卡无 `⏳`，不存在 badge）
  - **已完成视图**：**显示** badge（用户复盘时要看具体计划日期）
  - 不影响 US-115 的 overdue / near-deadline 视觉，也不影响 US-149 子卡 badge 规则

### 编辑卡片 & 快捷键

- `US-161` **标题改名不再走卡片 inline input**。点击卡片/标题统一进入 US-168 源 Markdown 编辑层,用户在原文里改标题;emoji / tag / `[estimate::]` / `[actual::]` / block 锚点 / 优先级符号自然保留。CLI/API `rename` 仍作为 agent 与自动化入口保留。
- `US-163` 新建任务只能写入当天 Daily Note 文件尾(只允许这个文件入口)：`- [ ] 任务名 ➕ 创建日期`。默认是未安排截止日期的状态。没有可用 Daily Note 目标时，新建失败并提示用户去启用 / 配置 Obsidian Daily Notes；**不允许写入 inbox / fallback 文件，也不允许提供 inbox 设置**。
- `US-162` **合并进 US-141 / US-168**：GUI 不再有 Task Card 内 `+ 子任务` 或子子任务 inline 创建器。用户需要加子任务 / 子子任务时,点开源 Markdown 编辑层,按 Obsidian 原文层级直接写；CLI/API 可继续保留 parent 写入能力给 agent/自动化使用,但不作为卡片 UI 主路径。
- `US-164` 右键卡片弹菜单(切完成 / 安排到今天/明天 / 清空日期 / 编辑 tag / 放弃)，鼠标用户不用记快捷键。打开源文件不再作为右键菜单主动作；源文件查看与编辑统一走 US-168。
- `US-166` 全局快捷键：`Ctrl+1~4` 切 tab、`/` 聚焦筛选输入框。
- `US-167` Quick Add 是 **Spotlight 风格的紧凑命令面板**（v2，2026-04-25 重设计）——
  - 单行 input + 右侧 inline parse hint（暗显 `→ ⏳ 04-26 (Sat)`）
  - 一行可点 quick chips（`Today / Tomorrow / 周六 / 下周 / 最近使用 tag`，点击 prefill）
  - 单行 footer：`↵ <实际写入路径>` 左 + `Esc` 右（不写"取消"/"确认" 动词）
  - 删除：`<h3>` 标题、X 关闭按钮、散文 hint
  - 容器：540×~240px 桌面 / bottom sheet 移动；圆角 14px；linear-gradient 背景；Spotlight 浮起阴影
  - 视觉心智线：Linear Cmd+K + Things 3 add-task。视觉品质细节详 [UX.md §6.6](./UX.md#66-quick-add-新建任务)。
- `US-169` 重构添加任务体验：新增任务的主路径只有 Quick Add / 移动端 bottom sheet,不再散落多个小入口。添加体验必须支持快速连续输入、自然语言日期、tag chip、写入路径预览、失败时不丢失输入；提交成功后输入框保持可继续添加下一条,移动端软键盘不应被无谓收起。
- `US-168` **点击 Task Card 在当前页打开源 Markdown 编辑对话框**。作为常驻 Obsidian 的人，我点一下卡片，就能在 Task Center 当前视图上方看到该任务所在文件的原始 markdown，并且任务所在行自动滚动到视窗中间、光标落在该行；我可以直接编辑该任务、它的子任务和上下文。这个旅程取代旧的 hover 上下文预览、双击跳源文件、右键打开源文件，不再保留三套查看/编辑入口。点击卡片后不能裸切到新的 Markdown leaf/页面；必须保留 Task Center 作为背景并显示前景 editor shell。体验目标是 Obsidian 自己的 Live Preview / 所见即所得 Markdown 编辑器能力（主题、光标、选择、列表缩进、checkbox 编辑、快捷键尽量一致）。由于 Obsidian public API 不能把 `MarkdownView` 安全嵌入 plugin `Modal`（见 #78 spike），实现可以使用 dialog-like shell / floating workspace / popover leaf 等方式承载真实 `WorkspaceLeaf + MarkdownView`，但不能让用户感知为离开 Task Center。`textarea` / 自制 preview / 只读 `MarkdownRenderer` 只能作为明确标注的临时 fallback，不算 US-168 100% 完成。
  - `US-168a` 点击普通卡片 / Today 卡片 / 搜索过滤后的卡片都走同一入口，打开对话框并定位到 `task.path:task.line`。
  - `US-168b` 对话框内编辑 markdown 并保存后，vault 文件落盘；看板随后刷新，卡片标题、子任务、日期、tag 与状态反映最新 markdown。
  - `US-168c` 卡片单击不再只是选中；需要选中态时只能作为视觉反馈，不能阻断打开编辑对话框。
  - `US-168d` 旧 hover popover、卡片双击打开源文件、右键菜单打开源文件对应实现必须删除；同一能力统一由点击 source edit panel/dialog-like shell 承担。
  - `US-168e` Esc、右上关闭、点击遮罩均能关闭编辑层；关闭后仍回到原 Task Center tab / filter / scroll 状态。
  - `US-168f` 视觉验收必须提供桌面与移动证据，证明它不是整屏 textarea / preview markdown 的开发者工具感，而是可用的 Obsidian-style 编辑体验。
  - `US-168g` 移动端点击卡片打开的源 Markdown 编辑层必须限制尺寸：默认不遮蔽整个任务中心超过必要范围,内容区可滚动,高度有上限并避让软键盘；不能出现“预览框大到像整页跳走”的体验。
  - `US-168h` 源编辑层内提供“在原文中打开/定位”的明确入口,用于需要完整 Obsidian 文件上下文时跳到原文件对应行；这个入口是用户主动选择,不能取代默认的当前页编辑层。

---

## AI agent 想要的

- `US-201` 注册命令到 obsidina cli，不是自己写额外的cli
- `US-202` list 的每一行**第一列都是稳定 id**(`path:L42` 或 hash),`grep/awk/cut` 能直接用。
- `US-203` 写操作**重复跑结果相同**。对已完成任务再跑 `done` → `ok … unchanged`,不报错。
- `US-204` 每次写都返回 `before / after` 两行 diff,方便我校验刚才到底改了啥。
- `US-205` `list` 和 `stats` 都是 human reable 的格式输出，不允许使用 json 之类，同时对人类与 AI 友好。
- `US-206` `stats days=N` 告诉我"估了多久 vs. 真花了多久"的比率和 top tag 分钟数,让我帮用户校准未来的估时。
- `US-207` 时间筛选词和人说话一致:`today / tomorrow / week / next-week / month / YYYY-MM-DD / FROM..TO / unscheduled`。
- `US-208` 行号失效时能**按标题 hash 找回任务**;hash 撞了给候选列表,**不要猜**。
- `US-209` 增量改时间:`actual minutes=+30m`,不用先读再写。
- `US-210` 文档里直接给出"典型一天收尾 / 快速捕捉 / 补记完成"三种工作流,我不用反推调用顺序。
- `US-211` 报错两行:`error <code>` + 一句人话;code 是短而固定的集合。
- `US-228` 有 `nest ref=A under=B` 动词,能跨文件把 A 变成 B 的子任务(GUI 拖拽的同胞)。语义必须与 US-125 一致：嵌套时清空 A 自己这一行的 `⏳`,让它继承 B 的有效 `⏳` / 未排期上下文；其它 Obsidian Tasks emoji / inline fields 字节级保留。
- `US-212` `list parent=<id>` 能筛出某父任务的所有子任务，方便 agent 走层级。
- `US-213` `add` 接受 `stamp-created=true|false`，覆盖全局的「自动打 ➕」设置——agent 批量回填历史任务时不污染时间戳。
- `US-214` 当 hash 撞到多条任务，返回 `ambiguous_slug` + 候选列表，**绝不猜**(扩展 US-208 的错误码与 payload 形态)。
- `US-215` 设置页提供 AI skill 安装指引：展示可复制的 `npx skill add ...` 命令,让用户把 Task Center 的 CLI / 工作流能力安装给 AI agent 使用。该指引只是设置页帮助入口,不在移动端制造不可用的 CLI 功能。

---

## 做精力管理的人想要的

精力管理本质就是「这周我打算花多久 vs. 真的花了多久」+「最重要的事先做」。这些都通过 US-108(自定义 field/tag)和 US-109(filter + summary)落地，**应用层不为这些字段做硬编码特性**——下面只列**默认约定**和能做的事。

- `US-301` 我想按 Covey 4 象限管理优先级。约定：用户在 markdown 里用普通 tag，例如 `#1象限`~`#4象限`；然后把对应 tag / 日期 / 状态筛选组合保存成视图（如“Q1”“Q2”“本周 Q1”）。换成 `#now / #next / #later / #waiting` 等自定义 tag 也一样工作。应用层不区别对待 `#1象限` 与 `#now`，也不提供额外分类设置；象限相关能力只能来自用户 markdown tag + 保存视图。
- `US-302` 我想记估时与实际耗时。约定：`[estimate:: 90m]` `[actual:: 75m]`(支持 `Nh / NhMm / Nm`)。summary 能对带分钟单位的字段做 sum / 比率(US-109 的应用)。换 `[planned::]` `[spent::]` 也行，只要在 summary 里指定字段名。
- `US-303` 我想一眼看到「最近 7 天估得准不准」：每周一行，显示 `sum(actual)/sum(estimate)` 比率、命中 ±25% 带的条数 / 总条数、按 tag 拆分时长 top N。这是 US-109 summary 的固定 preset，不用每周自己写查询。
- `US-304` 历史周默认折叠，本周展开，别让过去的数据把当周挤出屏幕。
- `US-305` `[-] ❌` 是「**放弃**」，和「完成」分开统计——回头复盘才知道自己**放弃过什么**，不是混在完成计数里。这是 checkbox 状态语义的事，不是 field/tag。

---

## 跨角色的共同期望

- `US-401` **只用 markdown**,没自定义格式、没数据库。Obsidian Tasks / Dataview / 任何读纯文本的工具都还能读。
- `US-402` 中英**自动切换**(跟 Obsidian 语言),不用手动配。
- `US-403` 写操作是**原子的**,写一半崩了不会把文件写坏。
- `US-404` 读操作**跳过没有任务的文件**,大 vault 开看板不卡。
- `US-405` 关看板时记住当前 tab,**下次开在同一个**。
- `US-406` Obsidian callout 里的任务 (`> - [ ] ...`，含多层 `>>`) 视同一等公民，照样解析、渲染、写回。
- `US-407` 即使本插件 UI 不渲染某些扩展（如 `🛫` 开始日、`🔁` 循环、`🔺⏫🔼🔽⏬` 优先级、`[id::]` 等内联字段），改名 / 移动 / 嵌套时也必须**字节级保留**，不能吃掉。
- `US-408` UI 字符串（tab 名、按钮、设置项 label / description、空状态、toast、错误信息"一句人话"部分）跟随 Obsidian 当前语言自动切换；切语言时已打开看板**实时**重渲染，不要求重启或重开看板。
- `US-409` 用户写在 markdown 里的字面**绝不翻译 / 替换 / 规范化**：hashtag（任何合法 `#xxx`）、inline field 字段名（`[xxx::]` 中的 `xxx`）、Obsidian Tasks emoji 字段标记（`⏳ 📅 ✅ ❌ ➕ 🛫 🔁 🔺⏫🔼🔽⏬`）。改名 / 移动 / 嵌套 / 写回时全部字节级保留。未被识别为合法 hashtag 的 `#...` 片段也不能被删除或改写，只是不进入 tag 筛选候选。
- `US-410` Quick Add / CLI 的自然语言日期至少同时支持中英两套：`今天 / 明天 / 昨天 / 周一~周日 / 本周 / 下周 / 本月 / 下月` 与 `today / tomorrow / yesterday / Mon~Sun / week / next-week / month / next-month`。无法识别**绝不假设日期**——任务落入未排期。
- `US-411` 日期显示跟随 Obsidian / 系统 locale（月份、星期、月日顺序），但**写回文件的日期永远是 ISO `YYYY-MM-DD`**——数据兼容硬约束（呼应 US-401 / US-407）。
- `US-412` CLI 错误形态 `error <code>  <一句人话>` 中：`<code>` 部分恒为英文短码（稳定标识符，AI / 脚本依赖，不能因语言而变）；后接的"一句人话"部分跟随当前语言（呼应 US-211）。
- `US-413` **输入法（IME）composition 守卫——所有支持 Enter 提交的输入框统一规则**。中文 / 日文 / 韩文等 IME 在拼音 / 假名选字过程中按 Enter 是"选词"，不是"提交"——所有 keydown 处理 Enter 的 input 必须**先判 composition 状态**：`e.isComposing === true` 或 `e.keyCode === 229` 时**忽略 Enter，不触发提交动作**（不调 submit、不关闭 modal、不写文件）。覆盖范围（穷举且**面向未来**——任何新增带 Enter 提交的 input 自动落入此规则）：
  - Quick Add input（US-167，桌面 + 移动）
  - 源 Markdown 编辑层内由 Obsidian 编辑器自己处理的输入不再由 Task Center 自定义 Enter 提交；Task Center 不额外拦截 IME Enter。
  - 日期 prompt input（DatePromptModal，按 `d/D` 唤起的快速排期）
  - 任何设置项里要按 Enter 提交的输入
  - 未来新增的所有 text input / textarea
  反例：用户输入"周六" 拼音过程中按 Enter 选字，被当成 submit 触发——**这是 bug 不是 feature**。Esc 不在此规则内（IME 期间 Esc 是"取消候选词"还是"关 modal"由浏览器 / Electron 决定，不强制覆盖）。**不需要守卫的 Enter 处理**：focusable div 的卡片 hotkey（已 skip text-input focus 路径）、按钮 keydown 触发（chip / role=button 等，不是 text input，IME composition 不会发生）。

### 移动端独有（Obsidian Mobile / iOS / iPadOS / Android）

详细 UX 设计与硬约束见 [UX-mobile.md](./UX-mobile.md)。下列故事是**移动端的额外语义**，桌面端的 US-101 ~ US-412 在移动端继续成立。

- `US-501` 移动端不支持的桌面功能（CLI、键盘快捷键等）静默 no-op，不弹错误 / 警告——用户在移动端看不到这些功能存在的痕迹。hover popover 已被 US-168 删除,不再作为任何端的功能存在。
- `US-502` 横竖屏适配：屏幕 ≥ 600px CSS 媒体查询走桌面布局，< 600px 走移动布局；用户可在设置里强制保持移动布局。移动端 tab / 底部操作栏 / 主要按钮必须满足触控尺寸,高度不低于 44px,不能像桌面 tab 一样压扁。
- `US-503` 周视图在移动端默认垂直 list（7 行折叠面板）；当前日默认展开，其余折叠；row header 显 `星期 MM-DD · N tasks · XhYm`。移动端 week 是桌面 7 列 week 的同语义改排版：日期顺序、周边界、任务归属、计数、估时、拖拽改期都按 US-101 / US-112 / US-116 / US-121 执行。折叠 row header 和展开 row 的非卡片空白处都是日期目标；row 里的任务卡本体仍是 US-125 嵌套目标。移动端 week 主体也必须遵守 US-101 的半屏最小高度,避免只露出一条很矮的列表。
- `US-504` 月视图在移动端简化为"日历 + 数字 + 任务数圆点"，点格弹该日 list bottom sheet；不在格内画卡片。
- `US-505` 移动端卡片紧凑模式——meta 行合并、子任务默认显 1 层（>1 显 `+N`，点开弹 bottom sheet 显全树）、拖动加 `scale 1.04`。移动端未排期区域与其中卡片宽度应直接占满可用宽度（接近 100%,只保留安全边距和设计间距）,不能沿用桌面 masonry 窄列。
- `US-506` 长按卡片 ≥ 500ms（且未移动）弹移动端操作 sheet（完成 / 放弃 / 改期 / 编辑 tag 等卡片动作）。源文件查看与编辑不在 long-press sheet 里重复出现,统一由单击卡片打开 US-168 源 Markdown 编辑层。按压周期内若移动 ≥ 4px（最早 250ms 后生效）→ 改走拖拽（详 US-507），long-press menu 取消；两者由同一手势 controller 仲裁，**互斥不并发**。
- `US-507` 移动端拖拽 long-press 250ms 进入 drag mode；跨 tab dwell 800ms（vs 桌面 600ms，手指比鼠标抖）；自动滚动边缘 60px（vs 桌面 40px）；状态栏小部件不存在，`📋 N today · ⚠ M overdue` 嵌进 board header。移动端只改变拖拽启动方式和布局,不改变落点语义：日期 row / 月格按 US-121 / US-122 改期,卡片本体按 US-125 嵌套,放弃目标区按 US-123 放弃,非法目标按 US-126 拒绝。
- `US-508` 左滑卡 = 标完成、右滑卡 = 放弃；阈值 30% 卡宽，触发后 1 秒 toast 内 undo 可撤销。
- `US-509` Quick Add 在移动端是 bottom sheet，软键盘弹出时自动避让，sheet 上移到键盘上方 + 8px。
- `US-510` UI 文案中桌面特定的快捷键 / 鼠标操作描述要平台条件分支；不在 i18n 字符串里翻译 `Ctrl+T` 这类描述——移动端写 `点 ➕ 按钮`。

### 发版与分发（GitHub Release / Obsidian Plugin Store）

插件需要被装、被更新。下面这些故事讲"插件作者 / 维护者 / 用户" 想从发版机制里得到什么——不讲 yaml 语法 / pnpm 命令 / GitHub Action runner 细节（那些是实现，留给 `.github/workflows/release.yml` + ARCHITECTURE）。参考样板使用公开 Obsidian 插件 release workflow（MVP 形态 + 含 release-notes 自动生成形态）。

- `US-601` **作为插件维护者，我打 semver tag 就自动出版本**。`git tag 1.5.0 && git push --tags` 触发 GitHub Action 跑构建 + 创建对应 GitHub Release，**不再手动 build / 手动上传 main.js**。tag 必须严格匹配 `[0-9]+\.[0-9]+\.[0-9]+`（不允许 `v` 前缀、不允许 pre-release 后缀进 stable channel——Obsidian community plugin store 只认严格 semver）。半自动而非全自动：版本号由我手动 `pnpm version patch/minor/major` 决定，**不接 release-please 之类靠 commit message 自动 bump 的工具**——每次发版的语义边界由 PM 判断，不交给工具。
- `US-602` **作为维护者，发版前我希望工程纪律自动兜底**。tag 触发后必须先跑完 pre-flight gate：`pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:e2e` 全过才进入 build + release 步骤；任何一项失败 → fail fast，**不发**、tag 留着但 GitHub Release 不创建。"build 通过" 不等于 "可发版"——这是今晚（2026-04-25）刚立的工程纪律在发版环节的延伸（呼应 §AGENTS.md TDD / multi-angle review）。
- `US-603` **作为 Obsidian 用户（P1），我升级插件时不希望踩兼容性炸弹**。每次发版必须同步更新 `versions.json`（key = 插件版本，value = 该版本所需的 Obsidian min version，例 `"1.5.0": "1.4.0"`）。Obsidian community plugin store 用这个文件决定要不要把新版本推给用户——如果用户的 Obsidian 比 min version 老，store 会留旧插件版本而不是强升后崩溃。**这不是可选项**，是 Obsidian plugin 标准（参 [Obsidian docs - Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)）。
- `US-604` **作为用户，我点开 Release 页能一眼看到这个版本变了什么**。Release body 自动从"上次 tag 到这次 tag" 之间的 PR 标题 + 已 closed issue 标题生成，按 conventional commit 前缀分组（feat / fix / chore / refactor）。不要求人工写 changelog——但维护者保留**手动覆写** Release body 的余地（GitHub Release UI 改即可，不影响下次发版）。手动覆写是例外不是常态。
- `US-605` **作为用户，我装插件 / 自动更新拿到的 zip 必须是 Obsidian 标准三件套**。每个 GitHub Release 必须挂 `main.js` + `manifest.json` + `styles.css` 三个 asset（不是打包进 zip，是三个独立文件）——这是 Obsidian community plugin store 拉取约定。**禁止把 build 产物 commit 回 main**（dynamic-views 那条样板**反例**——main.js 进 main 会污染 PR diff、和工程纪律冲突，artifact 上 GitHub Release 一处即可，store 自己拉）。

### 插件依赖健康检查（US-701）

插件写入路径依赖 Obsidian 内置的 **Daily Notes** 插件（读取 folder/format 配置决定每日文件路径）。新建任务只能写入当天 Daily Note；Daily Notes 未启用或未配置时必须阻止新建并给出可操作提示，不允许默默写入 inbox / fallback 文件。

- `US-701a` **Daily Notes 未启用时必须展示可操作提示**。当 Obsidian 内置 Daily Notes 插件处于禁用状态，插件启动及用户打开看板时，**状态栏**（或持久 Notice）必须展示形如 "Daily Notes 插件未启用，无法新建任务" 的提示，并提供一个跳转到 Obsidian 插件设置页的入口。Quick Add / add 命令必须失败并保留输入，不写任何 fallback 文件。
- `US-701b` **Daily Notes 未配置时（folder 为空）必须展示可操作提示**。当 Daily Notes 启用但未设置日记文件夹，插件应在状态栏展示 "Daily Notes 未设置文件夹，无法新建任务" 提示，并附设置入口。逻辑与 US-701a 对称。
- `US-701c` **警告状态必须在配置修复后自动消失**。用户在 Obsidian 设置中启用 Daily Notes 或补齐配置后，警告应随下一次 workspace 事件（layout-change / settings-change）自动清除，无需重启 Obsidian。
- `US-701d` **Tasks 社区插件未安装时必须展示可操作提示**。当 Obsidian 社区插件列表中不存在 `obsidian-tasks` 插件（`app.plugins.manifests["obsidian-tasks"]` 为空），插件启动及用户打开看板时，状态栏必须展示 `data-dep-warning="tasks-missing"` 提示，告知用户依赖未安装。不允许静默跳过。
- `US-701e` **Tasks 社区插件已安装但禁用时必须展示可操作提示**。当 `app.plugins.manifests["obsidian-tasks"]` 存在但未加载（`app.plugins.plugins["obsidian-tasks"]` 为空），状态栏必须展示 `data-dep-warning="tasks-disabled"` 提示，区别于未安装的 tasks-missing。
- `US-701f` **Tasks 插件正常启用时不显示任何 tasks 相关警告**。当 `app.plugins.plugins["obsidian-tasks"]` 已加载，状态栏不得出现任何 `data-dep-warning` 值包含 `"tasks-"` 的元素。

### 今日执行视图（US-720）

用户每天打开插件最常见的问题是"今天先做什么"——需要在逾期、今日、未排期推荐三堆信息里快速找到行动项。现有"周视图"不直接回答这个问题，展示量大、操作链路长。US-720 增加一个**今日执行视图**，第一屏聚合三组关键任务并提供最核心的快捷操作。

- `US-720a` **今日视图入口**。看板有一个"今日"入口（`data-tab="today"` 的 tab 按钮或等价入口）。点击后出现今日容器（`data-view="today"`）。
- `US-720b` **三组任务列表**。今日容器内有三个分组：`data-today-group="overdue"`（逾期）、`data-today-group="today"`（今日安排）、`data-today-group="unscheduled-rec"`（未排期推荐，每组最多展示 3 个顶层 root task）。任务卡包含标题、来源路径提示和日期信息；每张 Today 卡仍是 Task Card,必须遵守 US-142 / US-143 / US-144 / US-148 / US-149：父任务可见时,卡内递归显示属于同一今日执行上下文的完整子任务树；有独立 `⏳` 且不属于今日执行上下文的子任务不嵌入父卡,按自己的日期在对应视图作为独立顶层卡出现。
- `US-720c` **"改到明天"快捷动作**。今日视图每张卡上有 `data-action="reschedule-tomorrow"` 按钮，点击后向对应任务文件写入 `⏳ <tomorrow>`，任务从今日组移走。动作须走现有 writer 路径（TDD 覆盖文件写入结果）。
- `US-720d` **空状态**。三组均无任务时，今日容器展示 `data-today-empty` 空状态提示（文案如"今天没有可执行任务"），而不是空白页面。
- `US-720e` **今日面板视觉居中**。今日视图首屏内容要在可视区域中有稳定的视觉中心：空状态必须居中；有任务时三组列表不能贴顶堆在第一行,应保留合理上边距并让第一屏重点落在“今天先做什么”上。

## 故事变更怎么走

1. 新故事:取下一个空编号,写进对应章节,默认 ⬜。
2. 改验收预期: 直接改掉就行
3. 作废: 删掉就行
5. commit 用 `US-XXX:` 开头,双向追溯。
