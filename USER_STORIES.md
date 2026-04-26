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

- `US-101` 一眼看到**本周 7 天**谁塞满了,今日高亮。切到上一周、下一周
- `US-102` 月度日历，可以在切到上一个月、下一个月
- `US-104` 未排期池顶永远是"该挑下一件的那件"——先按 deadline,再按新加入时间。
- `US-105` 每个 tab 自带"待办数"小圆点：badge 数 = **该 tab 切过去后实际渲染的顶层卡数**（与 `hideChildrenOfVisibleParents` 等所有显隐规则一致；父可见时被 inline 进父卡的子任务**不**单独计入；US-148 跨日子任务在自己 ⏳ 的 tab 里计入）。**badge 数与切过去能数到的卡数必须一致**——不允许 badge 上显 15、切过去只有 1 这种误差。
- `US-106` 状态栏一直显示 `📋 N today · ⚠ M overdue`,点一下就打开看板。
- `US-107` 如果 - [ ] 这样名字为空白的任务就被忽略掉。 
- `US-108` 可以通过`[字段名:: 值]`比如`[estimate:: 90m]`来扩展meta。 还可以给任务加上`#内容`来标记内容。应用不对于这块有特别的限制，只是一种`约定大于配置`，用户可以自定义，后续的用户场景的四象限、复盘估时都是基于这种可以自定义的配置的一种实现。**应用层不允许硬编码任何 tag / 字段名字面**——所有分组、过滤、快捷键、菜单项都从用户配置或 markdown 现状派生。`#1象限`、`[estimate::]` 等只是默认配置 / 约定示例里的字面量，不是应用知识。
- `US-109` 筛选与复盘，用户可以通过搜索task名、筛tag、看各种值的汇总，这里需要什么图表看看吧。
- `US-110` 设置「启动时自动开看板」开关，默认关。
- `US-111` 设置「默认 tab」(周/月/已完成/未排期)，决定首次打开停在哪。
- `US-112` 设置「周一/周日为一周第一天」，影响周视图列序与本周边界。
- `US-113` vault 一条任务都没有时，看板显示空状态引导(「没有任务，按 + 添加」)，不是空白看板。
- `US-114` 拖拽过程中悬停在另一个 tab 上一会儿，自动切到那个 tab，松手即可跨视图改期。
- `US-115` deadline 已过的卡显红色 (overdue)、3 天内显黄色 (near-deadline)，眼睛能扫到。
- `US-116` 周视图每列顶部显示「N tasks · XhYm」(任务数 + 估时合计)，看一眼就知道当天满不满。

### 拖拽

- `US-121` 把卡从"周三"拖到"周五",这张卡的 `⏳` 就改成周五
- `US-122` 月视图每个日期格都可以当拖入目标。
- `US-123` 把卡拖进底部固定的**垃圾桶**,标成"放弃"(`[-] ❌`),不是从磁盘删。
- `US-124` 放弃一个父任务时,还没打钩的子任务(因为US-141，会自动继承放弃状态),**已经打钩的子任务不动**(作为历史保留)。
- `US-125` 把一张卡拖到**另一张卡**上,它就变成那张的子任务——两张卡在不同文件也行。然后弹一个toast说明，这个toast有一个undo按钮可以点击撤回
  - 这个是真的需要移动被drag的task从一个文件到另一个文件
- `US-126` 不能把 A 拖到 A 自己或 A 的后代上(不允许绕圈)。
- `US-127` 每次"卡片从当前位置消失"都应该是**淡出 + 邻居平滑上移**,不该是闪一下就没了。原地不动的操作不放动画。
- `US-128` `Ctrl/Cmd+Z` 能撤销最近 20 步拖拽 / 改期 / 重命名,手滑不至于翻 git。

### 父子任务

- `US-141` 卡片上有个 `+ 子任务` 小按钮,点一下就能加子任务,不用记快捷键。新子任务自动**继承父的 ⏳**。
- `US-142` 子任务在卡里**递归显示**所有层级,不止一层;每层的 checkbox 和标题都能用。
- `US-143` 父可见时,子任务**不**作为独立顶层卡重复出现(嵌在父里就够了)。
- `US-144` 子的所有属性如果没有定义的话继承于父任务。比如 状态(完成、放弃) ⏳、📅之类。所以不需要额外写
- `US-145` **完成或放弃父级,等于自动完成 / 放弃整条分支**——不用一条条勾子任务。活动视图里直接消失,已完成 tab 里能看到历史。 因为`US-141`
- `US-146` 和父级同一天建的子任务,不重复打 `➕ 创建日期` 戳,避免满屏冗余时间。 因为`US-141`
- `US-147` 改父级的时候,子任务的 tag / 估时 / 实际耗时 / emoji 字节不变。
- `US-148` 在周、月视图中一天的 Task Card，如果父任务安排到 A(下面有继承的a-1\a-2就一起显示)。 如果 A-3 有自己的⏳就单独显示在另一天。 因为`US-141`
- `US-149` 子任务 `⏳` badge 显隐规则（修订 2026-04-25 锐化）：
  - 父子都有 `⏳` 且**相同** → 不显（冗余）
  - 父子都有 `⏳` 且**不同** → 子卡上显示 `⏳ MM-DD` 小 badge
  - 父无 `⏳` / 子有 `⏳` → 子按 US-148 移到独立顶层卡，**父卡内不再嵌入这张子任务**；该独立顶层卡的 ⏳ badge 显隐按 US-150 顶层规则
  - 子无 `⏳` / 父有 `⏳` → 子继承父的 `⏳`，不显 badge
- `US-150` 顶层卡的 `⏳` badge **仅在渲染上下文未隐含其 ⏳ 日**时显示——避免冗余信息：
  - 周视图日列里：卡渲染于自己 `⏳` 那天的列 → **隐藏** badge（列头已经告诉用户日期）
  - 月视图日格里：同上，卡所属日格 = 卡的 `⏳` 日 → **隐藏**
  - 未排期池：N/A（这些卡无 `⏳`，不存在 badge）
  - **已完成视图**：**显示** badge（用户复盘时要看具体计划日期）
  - 不影响 US-115 的 overdue / near-deadline 视觉，也不影响 US-149 子卡 badge 规则

### 编辑卡片 & 快捷键

- `US-161` **点标题就改名**,Enter 提交、Esc 回退;emoji / tag / `[estimate::]` / `[actual::]` / block 锚点 / 优先级符号一个不丢。
- `US-163` 新建任务，新建的直接在当天Daily加到文件尾(只允许这个文件入口) - [ ] 任务名 ➕ 创建日期 。默认是未安排截止日期的状态。
- `US-162` 在 Task Card可以创建任务的子任务，如果 US-146 的话就不要额外加 创建时间了。
  - 可以给 Task Card的子任务加子子任务
- `US-164` 右键卡片弹菜单(打开源 / 切完成 / 安排到今天/明天/清空 / 切 1-4 象限 / 放弃)，鼠标用户不用记快捷键。
- `US-165` 鼠标悬停卡片一会儿弹 popover，显示父任务链 + 源文件上下文几行，知道这条任务在哪个项目下。
- `US-166` 全局快捷键：`Ctrl+1~4` 切 tab、`/` 聚焦筛选输入框。
- `US-167` Quick Add 是 **Spotlight 风格的紧凑命令面板**（v2，2026-04-25 重设计）——
  - 单行 input + 右侧 inline parse hint（暗显 `→ ⏳ 04-26 (Sat)`）
  - 一行可点 quick chips（`Today / Tomorrow / 周六 / 下周 / Q1~Q4 / Inbox`，点击 prefill）
  - 单行 footer：`↵ <实际写入路径>` 左 + `Esc` 右（不写"取消"/"确认" 动词）
  - 删除：`<h3>` 标题、X 关闭按钮、散文 hint
  - 容器：540×~240px 桌面 / bottom sheet 移动；圆角 14px；linear-gradient 背景；Spotlight 浮起阴影
  - 视觉心智线：Linear Cmd+K + Things 3 add-task。视觉品质细节详 [UX.md §6.6](./UX.md#66-quick-add-新建任务)。

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
- `US-228` 有 `nest ref=A under=B` 动词,能跨文件把 A 变成 B 的子任务(GUI 拖拽的同胞)。
- `US-212` `list parent=<id>` 能筛出某父任务的所有子任务，方便 agent 走层级。
- `US-213` `add` 接受 `stamp-created=true|false`，覆盖全局的「自动打 ➕」设置——agent 批量回填历史任务时不污染时间戳。
- `US-214` 当 hash 撞到多条任务，返回 `ambiguous_slug` + 候选列表，**绝不猜**(扩展 US-208 的错误码与 payload 形态)。

---

## 做精力管理的人想要的

精力管理本质就是「这周我打算花多久 vs. 真的花了多久」+「最重要的事先做」。这些都通过 US-108(自定义 field/tag)和 US-109(filter + summary)落地，**应用层不为这些字段做硬编码特性**——下面只列**默认约定**和能做的事。

- `US-301` 我想按 Covey 4 象限管理优先级。约定：用 `#1象限`~`#4象限`tag。未排期池按 tag 分组(US-109 的应用)就能看到每个象限的任务堆。换成 `#now / #next / #later / #waiting` 等自定义 tag，分组逻辑同样工作。用户在设置改"分组 tag 集"后，未排期视图分组 / 右键菜单"分组"子项 / 卡片数字键映射全部跟着变；应用层不区别对待 `#1象限` 与 `#now`。
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
- `US-409` 用户写在 markdown 里的字面**绝不翻译 / 替换 / 规范化**：hashtag（任何 `#xxx`）、inline field 字段名（`[xxx::]` 中的 `xxx`）、Obsidian Tasks emoji 字段标记（`⏳ 📅 ✅ ❌ ➕ 🛫 🔁 🔺⏫🔼🔽⏬`）。改名 / 移动 / 嵌套 / 写回时全部字节级保留。
- `US-410` Quick Add / CLI 的自然语言日期至少同时支持中英两套：`今天 / 明天 / 昨天 / 周一~周日 / 本周 / 下周 / 本月 / 下月` 与 `today / tomorrow / yesterday / Mon~Sun / week / next-week / month / next-month`。无法识别**绝不假设日期**——任务落入未排期。
- `US-411` 日期显示跟随 Obsidian / 系统 locale（月份、星期、月日顺序），但**写回文件的日期永远是 ISO `YYYY-MM-DD`**——数据兼容硬约束（呼应 US-401 / US-407）。
- `US-412` CLI 错误形态 `error <code>  <一句人话>` 中：`<code>` 部分恒为英文短码（稳定标识符，AI / 脚本依赖，不能因语言而变）；后接的"一句人话"部分跟随当前语言（呼应 US-211）。
- `US-413` **输入法（IME）composition 守卫——所有支持 Enter 提交的输入框统一规则**。中文 / 日文 / 韩文等 IME 在拼音 / 假名选字过程中按 Enter 是"选词"，不是"提交"——所有 keydown 处理 Enter 的 input 必须**先判 composition 状态**：`e.isComposing === true` 或 `e.keyCode === 229` 时**忽略 Enter，不触发提交动作**（不调 submit、不关闭 modal、不写文件）。覆盖范围（穷举且**面向未来**——任何新增带 Enter 提交的 input 自动落入此规则）：
  - Quick Add input（US-167，桌面 + 移动）
  - 卡片标题 inline 改名 input（US-119 / US-161）
  - 子任务添加 input（US-141 / US-162）
  - 任何设置项里要按 Enter 提交的输入
  - 未来新增的所有 text input / textarea
  反例：用户输入"周六" 拼音过程中按 Enter 选字，被当成 submit 触发——**这是 bug 不是 feature**。Esc 不在此规则内（IME 期间 Esc 是"取消候选词"还是"关 modal"由浏览器 / Electron 决定，不强制覆盖）。

### 移动端独有（Obsidian Mobile / iOS / iPadOS / Android）

详细 UX 设计与硬约束见 [UX-mobile.md](./UX-mobile.md)。下列故事是**移动端的额外语义**，桌面端的 US-101 ~ US-412 在移动端继续成立。

- `US-501` 移动端不支持的桌面功能（CLI、hover popover、键盘快捷键）静默 no-op，不弹错误 / 警告——用户在移动端看不到这些功能存在的痕迹。
- `US-502` 横竖屏适配：屏幕 ≥ 600px CSS 媒体查询走桌面布局，< 600px 走移动布局；用户可在设置里强制保持移动布局。
- `US-503` 周视图在移动端默认垂直 list（7 行折叠面板）；当前日默认展开，其余折叠；row header 显 `星期 MM-DD · N tasks · XhYm`。
- `US-504` 月视图在移动端简化为"日历 + 数字 + 任务数圆点"，点格弹该日 list bottom sheet；不在格内画卡片。
- `US-505` 移动端卡片紧凑模式——meta 行合并、子任务默认显 1 层（>1 显 `+N`，点开弹 bottom sheet 显全树）、拖动加 `scale 1.04`。
- `US-506` 长按卡片 ≥ 500ms（且未移动）弹"右键菜单 + 源信息"合并 sheet。按压周期内若移动 ≥ 4px（最早 250ms 后生效）→ 改走拖拽（详 US-507），long-press menu 取消；两者由同一手势 controller 仲裁，**互斥不并发**。
- `US-507` 移动端拖拽 long-press 250ms 进入 drag mode；跨 tab dwell 800ms（vs 桌面 600ms，手指比鼠标抖）；自动滚动边缘 60px（vs 桌面 40px）；状态栏小部件不存在，`📋 N today · ⚠ M overdue` 嵌进 board header。
- `US-508` 左滑卡 = 标完成、右滑卡 = 放弃；阈值 30% 卡宽，触发后 1 秒 toast 内 undo 可撤销。
- `US-509` Quick Add 在移动端是 bottom sheet，软键盘弹出时自动避让，sheet 上移到键盘上方 + 8px。
- `US-510` UI 文案中桌面特定的快捷键 / 鼠标操作描述要平台条件分支；不在 i18n 字符串里翻译 `Ctrl+T` 这类描述——移动端写 `点 ➕ 按钮`。

### 发版与分发（GitHub Release / Obsidian Plugin Store）

插件需要被装、被更新。下面这些故事讲"插件作者 / 维护者 / 用户" 想从发版机制里得到什么——不讲 yaml 语法 / pnpm 命令 / GitHub Action runner 细节（那些是实现，留给 `.github/workflows/release.yml` + ARCHITECTURE）。两个参考样板：[obsidian-hidden-text](https://github.com/CorrectRoadH/obsidian-hidden-text/blob/main/.github/workflows/release.yml)（MVP 形态）+ [dynamic-views](https://github.com/churnish/dynamic-views/blob/main/.github/workflows/release.yml)（含 release-notes 自动生成）。

- `US-601` **作为插件维护者，我打 semver tag 就自动出版本**。`git tag 1.5.0 && git push --tags` 触发 GitHub Action 跑构建 + 创建对应 GitHub Release，**不再手动 build / 手动上传 main.js**。tag 必须严格匹配 `[0-9]+\.[0-9]+\.[0-9]+`（不允许 `v` 前缀、不允许 pre-release 后缀进 stable channel——Obsidian community plugin store 只认严格 semver）。半自动而非全自动：版本号由我手动 `pnpm version patch/minor/major` 决定，**不接 release-please 之类靠 commit message 自动 bump 的工具**——每次发版的语义边界由 PM 判断，不交给工具。
- `US-602` **作为维护者，发版前我希望工程纪律自动兜底**。tag 触发后必须先跑完 pre-flight gate：`pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:e2e` 全过才进入 build + release 步骤；任何一项失败 → fail fast，**不发**、tag 留着但 GitHub Release 不创建。"build 通过" 不等于 "可发版"——这是今晚（2026-04-25）刚立的工程纪律在发版环节的延伸（呼应 §AGENTS.md TDD / multi-angle review）。
- `US-603` **作为 Obsidian 用户（P1），我升级插件时不希望踩兼容性炸弹**。每次发版必须同步更新 `versions.json`（key = 插件版本，value = 该版本所需的 Obsidian min version，例 `"1.5.0": "1.4.0"`）。Obsidian community plugin store 用这个文件决定要不要把新版本推给用户——如果用户的 Obsidian 比 min version 老，store 会留旧插件版本而不是强升后崩溃。**这不是可选项**，是 Obsidian plugin 标准（参 [Obsidian docs - Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)）。
- `US-604` **作为用户，我点开 Release 页能一眼看到这个版本变了什么**。Release body 自动从"上次 tag 到这次 tag" 之间的 PR 标题 + 已 closed issue 标题生成，按 conventional commit 前缀分组（feat / fix / chore / refactor）。不要求人工写 changelog——但维护者保留**手动覆写** Release body 的余地（GitHub Release UI 改即可，不影响下次发版）。手动覆写是例外不是常态。
- `US-605` **作为用户，我装插件 / 自动更新拿到的 zip 必须是 Obsidian 标准三件套**。每个 GitHub Release 必须挂 `main.js` + `manifest.json` + `styles.css` 三个 asset（不是打包进 zip，是三个独立文件）——这是 Obsidian community plugin store 拉取约定。**禁止把 build 产物 commit 回 main**（dynamic-views 那条样板**反例**——main.js 进 main 会污染 PR diff、和工程纪律冲突，artifact 上 GitHub Release 一处即可，store 自己拉）。

## 故事变更怎么走

1. 新故事:取下一个空编号,写进对应章节,默认 ⬜。
2. 改验收预期: 直接改掉就行
3. 作废: 删掉就行
5. commit 用 `US-XXX:` 开头,双向追溯。
