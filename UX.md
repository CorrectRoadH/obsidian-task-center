# UX

> 这份文档讲**界面长啥样、交互怎么走**。
>
> - 想知道**谁要什么 / 为什么** → [USER_STORIES.md](./USER_STORIES.md)（SSOT，验收以那份为准）
> - 想知道**数据怎么存 / 模块怎么拆 / 性能怎么扛** → [ARCHITECTURE.md](./ARCHITECTURE.md)
>
> 每条 UX 决策都尽量回引 `US-xxx`，方便双向追溯。看到没引 ID 的，要么是跨故事的通用约定，要么是设计补全（明确标 *设计补全*）。

---

## 0. 设计原则

1. **markdown 是 Truth，UI 只是它的镜子**。屏幕看到的每一张卡都对应文件里的一行，UI 操作 = 改那行。不引入只存在于内存 / 前端的"虚拟任务"。（US-401 / US-407）
2. **不重发明 Obsidian**。颜色、间距、圆角、阴影、字体全部走 Obsidian CSS 变量；不引第三方 UI 库；尊重用户主题。（设计补全 → 维持 Obsidian 工作流连续性，呼应 P1 角色"不愿切出"）
3. **借 Obsidian 原生能力，不做低配替代品**。当用户预期是 Obsidian 编辑器、所见即所得、主题一致、快捷键一致时，`textarea` / 自制 preview / 只读 renderer 只能算技术 fallback，不能算体验完成。体验 gate 必须先验证是否能复用 Obsidian 原生能力；确实不能时，要在 release note / task 中标明"降级"，不能包装成完成。
4. **每个动作都要有可观测的结果**。看不见的 = 没发生。任何"卡片消失 / 出现 / 变形"都要有 0.12–0.18s 的过渡，让眼睛跟得上。（US-127）
5. **PM 一票否决**：任何 UI 上"看起来有用但没人故事"的东西都不做，先去 USER_STORIES 加故事再加 UI。设计不是放装饰品的地方。

---

## 1. 表面（Surfaces）

插件对用户暴露 **4 个表面**，互不替代：

| Surface | 形态 | 何时进入 | 主要故事 |
| --- | --- | --- | --- |
| **看板视图（Task Board）** | 一个全 tab 的 WorkspaceLeaf，标签 = `task-center` | 命令面板"Open Task Board" / `⌘/Ctrl+Shift+T` / ribbon icon / 状态栏点击 / `obsidian command id=obsidian-task-center:open` | US-101~149 / US-161~166 |
| **状态栏小部件** | Obsidian 状态栏右下，文字徽标 | 启用插件即在 | US-106 / US-405 |
| **Quick Add 浮窗** | 看板内置的一行输入；也可由命令面板"Add task" 唤起 | `⌘/Ctrl+T`（看板内）/ 看板上的 `+ Add` 按钮 / 命令面板 | US-163 |
| **Obsidian CLI 动词** | 注册到 Obsidian 原生 CLI 的 `task-center:*` 命名空间 | shell：`obsidian task-center:<verb>` | US-201~214 / US-228 |

**不做**：浮动小窗、独立 Electron 窗口、菜单栏 tray、独立设置 webview。任务永远在 vault 里，UI 永远在 Obsidian 里。

---

## 2. 信息架构（IA）

```
看板视图（Task Board）
├─ 顶部 tab 栏：周 / 月 / 已完成 / 未排期      ← 4 个 tab，每个带未读小圆点  (US-105 / US-166)
├─ 工具条：
│   ├─ 筛选输入框（`/` 聚焦）                  (US-109 / US-166)
│   ├─ 快速添加按钮 `+ Add`                     (US-163)
│   └─ 视图相关切换（周视图：上一周 / 今 / 下一周；月视图同理） (US-101 / US-102)
├─ 主区
│   ├─ 周 tab：7 列 Mon~Sun（或 Sun~Sat，跟设置）
│   ├─ 月 tab：日历 6×7
│   ├─ 已完成 tab：按周分组的时间线
│   └─ 未排期 tab：按 tag 分组的 masonry
├─ 未排期池（仅周 / 月 tab 显示，主区下方常驻）  (US-104)
└─ 底部固定的 🗑 垃圾桶                         (US-123)

状态栏右下：📋 N today · ⚠ M overdue            (US-106)
```

**Tab 切换不重置**视图状态：周视图当前周、月视图当前月、筛选关键字、滚动位置都按 tab 各自记忆。关闭看板时记最后停留的 tab，下次打开回到那一个（US-405）。

**首次打开**走"默认 tab"设置（US-111），默认 = 周。

---

## 3. 看板全局布局

```
┌──────────────────────────────────────────────────────────────────────┐
│  周·M  月·M  已完成·M  未排期·M     🔎 [筛选...]      [< 今 >]  + Add  │  ← 顶部 (US-105 / US-101)
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Mon 4-21    Tue 4-22    Wed 4-23   Thu 今 4-24   Fri 4-25  ...      │  ← 当前 tab 主区
│  3 · 2h45m   1 · 30m     4 · 5h      ── 高亮 ──   2 · 1h30m          │    顶部一行 N tasks · XhYm (US-116)
│                                                                      │
│  ┌────┐      ┌────┐      ┌────┐      ┌────┐       ┌────┐             │
│  │卡片│      │卡片│      │卡片│      │卡片│       │卡片│             │
│  └────┘      └────┘      └────┘      └────┘       └────┘             │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  未排期池 · 按 tag 分组                                                │  ← 仅周 / 月 tab 出现
│  #1象限 ●●●     #2象限 ●●●●●     #3象限 ●●     #4象限 ●               │    (US-104 / US-301)
│                                                                      │
│  [卡片]  [卡片]  [卡片]  ...                                           │
├──────────────────────────────────────────────────────────────────────┤
│                            🗑 拖到这里 = 放弃                          │  ← 底部 sticky (US-123)
└──────────────────────────────────────────────────────────────────────┘
```

- **未排期池**只在周 / 月 tab 显示——核心动作是从未排期池拖到某天。已完成 tab 不需要它，未排期 tab 本身就是它的扩展形态。
- **垃圾桶**始终 sticky 在底部，所有 tab 可见。在已完成 tab 也能用来"放弃 + 加 ❌ 戳"，把误打钩的任务转成放弃（设计补全）。
- 主区与未排期池间用一条 1px Obsidian `--background-modifier-border` 分隔，不要用大色块。

---

## 4. 各 Tab 规格

### 4.1 周视图

- **列序**：跟设置（周一为首 / 周日为首，US-112）。共 7 列。
- **今日列**：背景 = `--background-secondary-alt`，列头加点强调色 dot（不要整列染色）。
- **列头**：`星期 MM-DD` + 第二行 `N tasks · XhYm`（US-116）。点击列头无操作（避免误触）。
- **列内排序**：按 `⏳` 同日内的"建立时间"升序（先加的在上）；同时间按文件路径字典序。
- **跨周翻**：`< 今 >`；今 = 跳到包含今天的那一周（US-101）。
- **键盘**：`Page Up/Down` 翻周；卡选中后 `←/→` 改 `⏳` ±1 天（README 已约定）。
- **拖入目标**：每一列的整片列体都是 drop zone，不只是已有卡片之间的缝。
- **空列**：列体显示一个浅色 `+` 微提示，hover 显出"在 4-25 加任务"占位行；点占位行 = 在该日 quick-add（设计补全）。

### 4.2 月视图

- **形态**：6 行 × 7 列日历（US-102）。月初 / 月末灰显非本月日期。
- **每格**：日期数字 + 最多 3 张卡片缩略；超出显示 `+N more`，点开弹一个该日的小列表（设计补全，避免格子撑爆布局）。
- **每格也是 drop target**（US-122）。
- **拖到 `+N more`**直接落在该天，不需要先展开。

### 4.3 已完成视图

- **形态**：按周分组的时间线，最新一周在顶（README）。
- **每周组顶**：`第 N 周 · YYYY-MM-DD ~ YYYY-MM-DD · 准确率 sum(actual)/sum(estimate) · top tag 时长`（US-303）。
- **历史周默认折叠**，本周展开（US-304）。展开 = 点周组头任意位置或 `►` 图标。
- **卡形态**：和别处一致；右上 `✅ MM-DD` 戳；如果有 `[actual::]` 显在 estimate 旁，色调暗淡。
- **`[-] ❌`（放弃）的任务**显示在**单独的 "放弃" 子分组**里（US-305），不混进完成里。
- **筛选**：复用主筛选输入框，可以按 tag / 关键字过滤完成历史。

### 4.4 未排期视图

- **分组**：按**用户配置的"分组 tag 集"**——这是一个有序的 hashtag 列表，由设置面板（§9）维护。第一次启用插件时该列表的**默认值** = `#1象限 / #2象限 / #3象限 / #4象限`（恰好对应 P3 角色 Covey 4 象限的约定，US-301），用户可改成 `#now / #next / #later / #waiting`、`#A / #B / #C` 或任何自定义集合（US-108 "约定大于配置"）。**应用本身不知道"象限"是什么**——它只是默认配置里的字面量。
- **未匹配任何分组 tag 的任务** → 进 "其他" 分组（始终在最末）。
- **顶部**永远是 "该挑下一件的那件"（US-104）：先按 `📅 deadline` 升序，再按"加入未排期"时间升序。这条排序规则在分组上方写一行说明文字（视觉上小字、灰色），让用户意识到这不是随机顺序。
- **形态**：masonry 卡片瀑布（README）。卡间距 8px，列宽 280px ± 20%。

---

## 5. 任务卡（Card）

### 5.1 卡的解剖

```
┌────────────────────────────────────────────────────┐
│ [✓] 任务标题                            ⏳ 04-25  │  ← 行 1
│     #2象限 #基建                                   │  ← 行 2 (tags)
│     est 90m · actual 75m · 📅 05-15               │  ← 行 3 (meta，按需渲染)
│   ├ [ ] 子任务                          ⏳ 04-26  │  ← 行 4+ (subtasks，递归 US-142)
│   └ [ ] 子任务                                     │
└────────────────────────────────────────────────────┘
```

- 行 1 永远是：checkbox（决定状态语义）+ 标题 + 右侧 schedule badge（仅当 `⏳` 与所在列日期不同时显示，US-149）。
- 行 2 = tag 行；无 tag 不出现。
- 行 3 = meta 行；任意 meta（`estimate / actual / 📅 deadline`）有就显，没有就不留空。三个都没有时整行不渲染。
- 行 4+ = 子任务递归。
- **不显示**：源文件路径（点卡片进入 source edit panel 后可见）、`➕ 创建日期`（默认隐藏；用户可设开关，设计补全）、未识别的 emoji / 内联字段（字节级保留，但不在卡上画——US-407）。

### 5.2 卡的状态机

| 状态 | 触发 | 视觉 |
| --- | --- | --- |
| 默认 | — | 卡 = `--background-secondary`，1px border = `--background-modifier-border`，圆角 6px |
| Hover | 鼠标停留 | 阴影微抬 (`--shadow-s`)；可显示三点更多按钮；不再显示 `+ 子任务` |
| Focused | 键盘 Tab / 程序聚焦 | border 改成强调色 (`--interactive-accent`)；可接收键盘命令（README 卡级快捷键） |
| Overdue | `📅` 已过且未完成 | 卡左侧 3px 红色条 (`--color-red`)（US-115） |
| Near-deadline | `📅 ≤ 3 天` | 卡左侧 3px 黄色条 (`--color-yellow`)（US-115） |
| Dragging | 鼠标按下移动 | opacity 0.85 + shadow `--shadow-l`；原位置变成虚线占位框 |
| Completed | `[x]` | checkbox 勾选；标题 line-through；卡 opacity 0.65 |
| Abandoned | `[-] ❌` | checkbox 显示 `−` 线；标题 line-through + italic；左侧条灰色；右上小 ❌ 戳 |
| Hidden by ancestor | 父级 / section header 是 `[x] / [-] / #dropped` | 不渲染（README "ancestor propagation"） |

**完成 / 放弃的视觉差异必须一眼能分**——不要都用 strike-through 一种处理。放弃的额外加 italic + 灰色 ❌ 戳（呼应 US-305 "回头复盘才知道自己放弃过什么"）。

### 5.3 父子在卡内的呈现

- 子任务在父卡内**递归显示所有层级**（US-142）。每深一层缩进 16px，**用原生 DOM 嵌套渲染**（不用 ├ └ box-drawing 字符——那是 CLI 形态）。CLI 与 GUI 共享 traversal / sort 函数（§16-6），渲染层各自适配。
- 子任务在自己有 `⏳` **且与父不同**时，显示一个 schedule badge（US-149）。
- 父在周 / 月视图当天显示时，**继承的子也跟着显示在父卡内**（US-148）。子若有自己的 `⏳` 落在另一天，**那一天另出一张独立卡**显示该子（仅那条子，不重复显示父）。
- **完成 / 放弃父级 = 整条分支视觉上消失在活动 tab**，可在已完成 tab 历史里看（US-145）。
- **卡片内不再提供 `+ 子任务` 按钮或 inline 子任务输入**（US-141 revised）。新增 / 删除 / 编辑子任务统一进入 US-168 源 Markdown 编辑面板，在原文里按 Obsidian 列表缩进直接写。卡片只负责显示子任务树和状态动作，不再维护第二套子任务编辑器。

### 5.4 Source edit panel（点击卡片唯一查看/编辑路径）

点击任意 Task Card 打开源 Markdown 编辑面板（US-168）。这个入口**取代**旧的"双击打开源文件"、"hover 看上下文"和"右键打开源文件"。本功能的目标不是"能改一段 markdown 文本"，而是**让用户在 Task Center 当前页获得接近 Obsidian 原生编辑器的上下文编辑体验**：

```
┌──────────────────────────────────────────────────────────────┐
│  Tasks/Inbox.md:L42                                      [×] │
│  ───────────────────────────────────────────────────────────  │
│                                                              │
│  <Obsidian 原生 Live Preview / 所见即所得 Markdown editor>       │
│  ...                                                         │
│  - [ ] 父任务                                                │
│      - [ ] 当前任务 ⏳ 2026-04-24   ← 光标在这里，滚动居中      │
│          - [ ] 子任务                                        │
│  ...                                                         │
│                                                              │
│  ───────────────────────────────────────────────────────────  │
│  Esc 关闭 · 修改会按 Obsidian 编辑器保存语义写回                │
└──────────────────────────────────────────────────────────────┘
```

- **唯一查看/编辑入口**：单击卡片。普通看板卡、Today 卡、保存视图过滤后的卡都走同一个 `open task source dialog` 动作。
- **定位**：打开后光标落在任务原始 markdown 行开头，编辑器把该行滚动到可视区域中间；不是只滚到附近，也不是只高亮卡片。
- **编辑能力**：面板里展示并编辑任务所在文件的原文 Markdown，用户可以直接改当前任务、加/删/改子任务、查看上下文。默认验收目标是 Obsidian 自己的 Live Preview / 所见即所得 Markdown 编辑体验：主题、光标、选择、快捷键、列表缩进、checkbox 编辑都应尽量与普通 Obsidian 页面一致。
- **禁止低配冒充**：只读 `MarkdownRenderer`、纯 preview、普通 `textarea` 都不能算 US-168 完成。`textarea` 只允许作为明确标注的临时 fallback / emergency patch；若使用 fallback，本任务必须保持 open 或另开 P1，不允许把 fallback release 当成 100% 体验。
- **形态说明**：#78 spike 已证明 Obsidian public API 不能把 `MarkdownView` 安全嵌进 plugin `Modal`。因此实现可使用 dialog-like shell / floating workspace / popover leaf 等方式承载真实 `WorkspaceLeaf + MarkdownView`，但用户可见旅程必须仍像当前 Task Center 上方的编辑面板：不能裸切到新的 Markdown 页面，不能让 Task Center 消失。
- **保存与刷新**：沿用 Obsidian 编辑器保存语义；文件变更事件到达后，看板刷新，卡片内容与子任务树同步。如果实现有显式 Save，也必须和 Obsidian 自动保存语义不冲突。
- **关闭**：Esc / 右上关闭 / 点击遮罩关闭编辑面板；关闭后仍回到原 Task Center tab / filter / scroll 状态。
- **旧路径删除**：卡片 hover popover 不再存在；卡片双击不再绑定打开源文件；右键菜单不再展示"打开源文件"。减少用户在三套查看/编辑入口之间选择。
- **视觉质量 gate**：不得出现"整屏 textarea / preview markdown"的开发者工具感；不得让用户以为自己离开了 Task Center；不得把标题、路径、按钮挤压成桌面控件堆叠。桌面与移动都必须提供截图/录屏证据，证明编辑器、关闭、保存、定位、背景状态保留可用。
- **移动端**：手机上同一动作可落为全屏编辑面板；仍必须是可编辑 Markdown 编辑体验，不是只读预览；软键盘出现时关闭/保存按钮不能被遮挡。

### 5.5 右键菜单

右键卡片弹原生 Obsidian 风格菜单（US-164）：

```
切换完成                      Space
─────
安排到今天
安排到明天
清空 ⏳
─────
分组  →  <用户配置的分组 tag 集>            1 / 2 / 3 / 4 …
       （默认 = #1象限 / #2象限 / #3象限 / #4象限，可改）
─────
放弃                          Delete
```

- "分组"子菜单的**项**和**数字快捷键**都从设置（§9 "分组 tag 集"）动态生成；用户改了配置，菜单与快捷键映射跟着变。
- 选某项 = 在卡上**追加**该 tag；如果卡上已经有"分组 tag 集"中的另一项，**先移除旧的、再加新的**（互斥，避免一个任务同时落两组）。
- 右键键盘等价：选中卡按 `Menu` 键 / `Shift+F10`。

---

## 6. 交互细则

### 6.1 拖拽

- **拖起**：鼠标按下 + 移动 ≥ 4px 才视作拖拽，避免点改名误触发。
- **拖动中视觉**：原卡变虚线占位（保持邻居稳定），跟随鼠标的是缩略浮卡（卡的标题一行 + 一个移动指针图标）。
- **drop target 高亮**：合法目标用 `--background-modifier-hover`；非法目标（自己 / 后代，US-126）用 `--color-red` 浅底 + 禁止光标。
- **跨 tab 拖**：拖动时悬停在另一个 tab 头部 ≥ 600ms 自动切到那个 tab（US-114）。视觉上 tab 头出现进度条从 0% 涨到 100%，到 100% 切换；中途松开取消。
- **卡片消失动画**：当拖拽落定导致卡从原位置消失，原位置 fade-out 100ms + 邻居 transform 平滑上移 150ms（US-127）。原位不动的不放动画。
- **自动滚动**：拖拽时鼠标停在主区上下 40px 范围，主区按 200px/s 自动滚动；松开 / 鼠标回到中央停止。
- **多选**：v1 不做。一次拖一张。

### 6.2 拖到另一张卡 = 嵌套

- 落点 = 另一张卡的卡体（不仅是末尾），把被拖的卡变成它的子任务（US-125 / US-228）。
- **真的会跨文件移动行**——把被拖卡这一行从源文件物理移到目标卡所在的文件、目标位置末尾，并按层级缩进。
- **落定后弹一个 toast**（US-125）：

  ```
  ✓ 「调研」已变成「项目 X」的子任务  · [撤销]
  ```

  - toast 6 秒后自动消失；点撤销 = 恢复到 drag 之前的物理位置 + 缩进 + 文件归属。

### 6.3 拖到垃圾桶 = 放弃

- 拖到底部 🗑（US-123）：被拖卡变成 `[-] ❌ 今天`。
- 如果是父任务：所有未打钩的子任务一起继承"放弃"状态；**已打钩的子任务保留**作为历史（US-124）。
- 落定后 toast：

  ```
  ✓ 「项目 X」放弃 (含 3 个子任务)  · [撤销]
  ```

- 不删文件，不改文件命名，只改 checkbox 字符 + 加 `❌ YYYY-MM-DD` 戳。

### 6.4 不能成环

把 A 拖到 A 自己 / A 的后代上 → drop target 变红 + 禁止光标 + 松开后无操作（US-126）。

### 6.5 标题编辑（由 Source edit panel 承担）

- 卡片层不再提供 inline title input（US-161 revised）。
- 单击卡片标题和单击卡片主体一样，打开 US-168 源 Markdown 编辑面板。
- 用户在 Obsidian 原生 MarkdownView / CodeMirror 编辑器里直接修改原文标题、子任务和上下文；关闭后回到原 Task Center 状态。
- 字节级保留不再靠卡片 input 的局部重写，而是靠用户编辑原文 markdown；CLI/API `rename` 仅作为 agent / 自动化入口。

### 6.6 Quick Add（新建任务）

`⌘/Ctrl+T` / `+ Add` 唤起一个 **Spotlight 风格的紧凑命令面板**（US-163 + US-167 redesign v2 / 2026-04-25）。设计参照 Linear `Cmd+K` + Things 3 add-task：紧凑、命令式、自带语法智能。

```
┌────────────────────────────────────────────────────────────────┐
│  去营业厅问携号转网 #3象限 周六 [estimate:: 25m]│  →  ⏳ 04-26 (Sat) │  ← 单行 input，placeholder 例子；右侧 inline parse hint 暗显
│  ────────────────────────────────────────────────────────────  │
│  [Today]  [Tomorrow]  [Q1]  [Q2]  [Q3]  [Q4]  [Inbox]            │  ← 可点 quick-chip 行（点 = prefill 到 input）
│  ↵ Daily/2026-04-25.md                              Esc          │  ← 极简 footer，1 行 12px text-muted
└────────────────────────────────────────────────────────────────┘
```

**核心理念**（跟 v1 的差）：
- 删 `<h3>` 标题——input placeholder 自己说了在干嘛
- 删 X 关闭——Esc / 点外部就走，少一个噪音元素
- 删 prose hint "Shortcuts: today/tomorrow/Mon-Sun auto-resolve to..."——改成**可点 chip**：5-7 个 quick chips（`Today / Tomorrow / Q1~Q4 / Inbox`），点一下自动 prefill 到 input
- 解析预览**inline 在 input 右侧**（不另起 chip 行），用 `text-muted + monospace` 显 `→ ⏳ 04-26 (Sat)` 这样的暗示，不抢主输入注意力
- 整个 modal 紧凑到 ~240px 高、540px 宽，**无空白堆**

**容器与布局**：
- 桌面：modal 宽 540px，最大高 240px（按内容自适应，预设上限），垂直居中**偏上**（视口 30% 处，类似 Spotlight），不在正中央
- 移动：bottom sheet（沿用 US-509），软键盘按 §13 #5 visualViewport 避让
- 圆角：14px
- 背景：`linear-gradient(180deg, var(--background-primary) 0%, var(--background-secondary) 100%)` —— 让 brand 触感不依赖第三方
- 阴影：`0 24px 64px -16px rgba(0,0,0,0.5), 0 8px 24px -8px rgba(0,0,0,0.4)` —— spotlight 那种"漂浮感"（用透明黑而非 Obsidian shadow var，是这个组件独有的强调）
- 分隔：input 和 chip row 间 1px `--background-modifier-border`；chip row 和 footer 间不分隔（间距说话）

**Input**：
- 单行，无 border、无 background（透明融入容器），focus 时也无 border——靠 cursor 反馈
- font-size 18px 桌面 / 16px 移动（iOS 16px 防 zoom）
- font-weight 400，color `--text-normal`
- placeholder color `--text-faint`，举例式（不是描述式）：`例：买菜 #3 周六 25m`
- padding：input 区域整体 20px 上下 / 24px 左右，input 自身无 padding
- 输入即解析（每 keystroke），输出 → inline parse hint（见下）

**Inline parse hint**（在 input 右侧 / 下方）：
- 解析出 ⏳ → input 右侧暗显 `→ ⏳ 04-26 (Sat)`（text-muted，monospace）
- 解析出 #tag / [estimate::] → 不显（用户自己输入的字面已经在 input 里了，不需要重复）
- 解析出 deadline (📅) → 同 ⏳ 处理
- input 太长时 hint 折行到 input 下方，仍 text-muted

**Quick chips（可点 prefill）**：
- 5-7 个 chip，水平排布，溢出可横向滚动
- 内容：`Today` / `Tomorrow` / `周六` / `下周` / `Q1` / `Q2` / `Q3` / `Q4` / `Inbox`
- 点击行为：把对应 token 追加进 input 当前光标位置（已存在则不重复加）；input 重新 focus
- 视觉：浅灰底 chip（`--background-modifier-hover`）+ 12px text-muted + 6px round + hover 加深底色
- chip 间距 6px

**Footer**：
- 单行 12px text-muted
- 左侧：`↵ <实际写入路径>`——`Daily/2026-04-25.md`（由 Obsidian 内置 Daily Notes 核心插件的 folder/format + todayISO 计算；Daily Notes 未启用时回落到 settings.inboxPath。0.3.0 删了 settings.dailyFolder，详见 README "Breaking Changes"）
- 右侧：`Esc`
- 不写"取消" / "确认" 等动词——用纯 keystroke 标志（视觉简洁）
- 误操作恢复：错误态在 footer **上方**插一行红色 `⚠ <一句人话>`，input 不清空让用户重试

**默认行为**（不变 v1，从 v2 保留）：
- 唯一写入位置：当天 daily note 文件尾（US-163）。无 daily 配置时 inbox 回退。
- 不允许选目标文件入口（仅这一个）
- 自然语言日期：中英两套（`今天/明天/周六/Mon/today/tomorrow`）解析为 ISO ⏳；不识别**不假设**
- 默认打 ➕ 创建戳（设置可关）
- 周列空列占位触发时预填 `⏳ <该列日期>`
- 错误态：footer 上方红色 `⚠`

**对比 v1 spec / 当前实现**：

| 维度 | 当前实现（2026-04-25 截图） | v1 spec（撤回） | **v2 spec（采用）** |
| --- | --- | --- | --- |
| 标题 | `<h3> "Add task"` 占行 | 保留 h3 | **删** — placeholder 自己说 |
| Input | 默认 TextComponent | 单独 input 段，加 focus border | 透明 input，融入容器；只靠 cursor 反馈 focus |
| Hint | 散文 prose | 解析 chip 行（独立段） | inline parse hint（input 右侧暗显） + 可点 quick chips（一行） |
| Footer | 无 | 三段："写入 X / Esc / 语法" | 极简两端：`↵ 路径` 和 `Esc` |
| 关闭 | 右上 X | 保留 X | **删 X** — Esc / 外部点关 |
| Modal 形态 | 标准 Obsidian modal（中央，~600×300，多空白） | 同当前但加内容 | Spotlight 风格（顶部偏上 ~30%、540×~240、紧凑无空白、自家 shadow） |
| Brand | 标准 Obsidian chrome | 圆角 12px | gradient bg + spotlight shadow + 14px 圆角 = 自有质感 |

> v2 是**重构**而不只是**填充**——取消那些不传达信息的元素（h3 / X / 散文 hint / 大留白），换成**可操作 + 可瞥见 + 紧凑**的命令面板形态。

**拟 US-167（落 USER_STORIES.md）**：Quick Add 是 Spotlight 风格紧凑命令面板——单行 input + 右侧 inline parse hint + 一行 quick chips（Today/Tomorrow/Q1~Q4/Inbox 可点 prefill）+ 单行 footer 显写入路径。不要 h3 标题、不要 X 关闭、不要 prose hint。视觉品质走 Linear Cmd+K + Things 3 add-task 心智线。

### 6.7 Undo

- `⌘/Ctrl+Z` 撤销最近 20 步（US-128）。
- 撤销范围 = 在看板内做的所有"卡的字节级写动作"：拖拽改期、改名、勾完成、放弃、嵌套、quick-add。
- **撤销不会跨进程恢复磁盘已经被外部改写的状态**——若文件在期间被其他工具改过，撤销会先校验再退；不能干净撤销时 toast：

  ```
  ⚠ 「调研」自上次变更后被外部修改，撤销不安全已停止
  ```

### 6.8 键盘快捷键总览

**全局**（USER_STORIES US-166 + README）：

| 键 | 动作 |
| --- | --- |
| `⌘/Ctrl+Shift+T` | 打开看板 |
| `⌘/Ctrl+T` | 打开 Quick Add（仅看板焦点时；非焦点时由命令面板触发） |
| `⌃1 / ⌃2 / ⌃3 / ⌃4` | 切到 周 / 月 / 已完成 / 未排期 |
| `/` | 聚焦筛选输入框 |
| `⌘/Ctrl+Z` | Undo |

**卡片选中后**（README）：

| 键 | 动作 |
| --- | --- |
| `1 / 2 / 3 / 4 / …` | 应用"分组 tag 集"的第 N 项（动态映射，默认 = `#1象限~#4象限`，由 §9 配置；超出集合长度的数字键无操作） |
| `←` / `→` | `⏳` ±1 天 |
| `D` | 弹日期对话框 |
| `Space` | 切完成 |
| `E` / `Enter` | 打开源文件并定位行 |
| `Delete` / `Backspace` | 放弃 |

**键盘可达**：tab key 在卡间循环（按视觉顺序：列内自上而下，列间自左向右）。卡上焦点用 2px outline + Obsidian 强调色，**永远不要 `outline:none`**。

### 6.9 筛选 / 搜索

- 筛选输入框支持：
  - 自由关键字（在标题中匹配，子串，不区分大小写）
  - `tag:#xxx`（精确 tag）
  - `est:>30m` / `actual:<60m` / `accuracy:<0.7` 等数值过滤（US-109 应用）
- 输入即过滤（≥ 300ms debounce）。
- **筛选不改文件**，只改可见集合。
- 过滤后空集 → 显示"没有符合的任务，按 `/` 修改条件"。
- 在已完成 tab 也可用，与时间筛选叠加。

### 6.10 状态栏小部件（US-106）

- 文字：`📋 N today · ⚠ M overdue`
- N = 当天 `⏳ = today` 且未 `[x]` 的任务数（含子任务）。
- M = `📅 < today` 且未完成的任务数。
- 点击 = 打开看板（如已开则聚焦）。
- **绝不**在状态栏里加 spinner / 长字符串 / 颜色块。状态栏是被动指示器。

---

## 7. 父子任务的视图规则汇总

> 这块是冲突最容易出现的地方，单列。

| 场景 | 规则 | 故事 |
| --- | --- | --- |
| 父可见时 | 子任务在父卡内递归显示，**不**作为独立顶层卡再出现 | US-143 / US-142 |
| 子的属性继承 | 子无 `⏳ / 📅 / 状态`时继承父的；父变，子继承的同步变；子已经写了就保留 | US-144 / US-147 |
| 完成 / 放弃父 | 整条分支自动完成 / 放弃，**已打钩的子原样保留** | US-124 / US-145 |
| 父子同日创建 | 子不重复打 `➕` 戳 | US-146 |
| 父子 `⏳` 不同日 | 子在父所在那天的卡里照样显示（继承显示），同时**在子自己的 `⏳` 那天另起独立卡** | US-148 / US-149 |
| 跨视图 | 子卡显示 `⏳ MM-DD` badge 仅当**子的 `⏳` ≠ 父的 `⏳`** | US-149 |

---

## 8. 空状态 / 错误态 / 加载态

### 8.1 看板空状态（vault 一条任务都没有）

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│              📭                                     │
│                                                     │
│       还没有任务。按 `+ Add` 或 ⌘T 建一条，          │
│       或在任意 markdown 文件里写 `- [ ] 任务名`。     │
│                                                     │
│           [+ 在 Daily 加一条]                        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

故事：US-113。点击 `+ 在 Daily 加一条` = 等同 `⌘T`。

### 8.2 当前 tab 空（vault 有任务但当前 tab 没匹配）

- 周 tab 当周空：当周日历正常画 7 列，每列空提示一行小字 "今天没安排任务"。
- 已完成 tab 空：`📭 这一周还没有完成任何任务`。
- 未排期 tab 空：`📭 没有未排期任务，干得漂亮`。

### 8.3 筛选无结果

文字 + 一个清空筛选按钮：`没有符合「<query>」的任务  · [清空筛选]`。

### 8.4 加载态

- **大 vault 首次开看板**显示 skeleton：列头骨架 + 每列 3 张占位卡（灰底，无内容），≤ 1.5s 内被真数据替换。
- **永远不显示 spinning loader 在主区中央**——会让用户觉得"是不是卡了"。骨架是更好的解。
- 如果 ≥ 5s 还没出数据，主区中央显示 `⏳ 正在解析 vault... (N/M files)`，提供取消按钮。

### 8.5 错误态（在 GUI 内）

- **写文件失败**：弹 Obsidian 原生 notice + toast：

  ```
  ⚠ 写入 Tasks/Inbox.md 失败：<原因一句话>
  ```

  原文件不动（US-403 原子写）。

- **拖拽到一个磁盘已删除的目标**：toast `⚠ 目标已不存在，操作取消`。

---

## 9. 设置面板

按 USER_STORIES 整理出唯一的设置项清单（任何 README 里有但 US 没说的，标 *设计补全*）：

| 设置 | 默认 | 说明 | 故事 |
| --- | --- | --- | --- |
| 默认 inbox 路径 | `Tasks/Inbox.md` | `add` 写入位置（无当日 daily 时） | US-163 |
| 默认 tab | 周 | 首次打开停在哪个 tab | US-111 |
| 启动时自动打开看板 | 关 | | US-110 |
| 一周第一天 | 周一 | 影响周列序 + 本周边界 | US-112 |
| 自动打 `➕ 创建日期` | 开 | 全局开关，CLI 可单次覆盖（US-213） | US-213 |
| 显示 `➕ 创建日期`在卡上 | 关 | *设计补全*：默认隐藏避免视觉噪音 | — |
| **分组 tag 集** | `#1象限, #2象限, #3象限, #4象限` | 未排期视图分组、右键菜单"分组"项、卡选中后数字键映射都从这里来。可加 / 删 / 重排；为空时禁用相关 UI。集合**互斥**：一个任务只能落集合内的一项 | US-108 / US-301 |

**版式**：用 Obsidian 原生 `Setting` 组件，不写自定义 webview。每项一行：`label · description · control`。**不**做多 tab 设置；条目少。

---

## 10. 国际化（i18n）

底层规则（呼应 US-402 + 拟新增的 US-408~412，详见与 ctrdh 的故事补充提案）：

- **UI 字符串跟随 Obsidian 当前语言**自动切换 zh-CN / en；不暴露插件级语言开关，不要求重启 / 重开看板（实时重渲染）。
- 字符串集中在 `i18n/{zh-CN,en}.ts`（具体文件位置在 ARCHITECTURE.md 决定）。
- **数据字面绝不翻译**。这条是数据兼容硬约束（US-401 / US-407 / 拟 US-408）：
  - 用户写在 markdown 里的 **hashtag 字面**（无论是 `#1象限` `#now` `#A` `#项目X` 还是其他）—— 原样保留，原样匹配，原样写回。
  - 用户写在 markdown 里的 **inline field 字段名**（`[estimate::]` `[planned::]` `[花了::]` ...）—— 同上。
  - **emoji 字段标记**（`⏳ / 📅 / ✅ / ❌ / ➕ / 🛫 / 🔁 / 🔺⏫🔼🔽⏬`）—— 这是 Obsidian Tasks 的字面字段标记，不是装饰，绝不翻译 / 替换。
- **应用层文案可以本地化**：tab 名、列头、按钮、设置项 label / description、空状态、toast、错误信息的"一句人话"部分。这些是**应用提供的字符串**，不是用户数据。
- **CLI 错误码** (`error <code>` 中的 `<code>`) 恒为英文短码（`not_found / ambiguous_slug / ...`，见 §14.3）；它是稳定标识符，AI / 脚本依赖。**仅** 后接的"一句人话"跟语言切换。
- **日期显示**跟随 Obsidian / 系统 locale（月份、星期、月日顺序）；**写回文件的日期**永远是 ISO `YYYY-MM-DD`（数据兼容）。
- **自然语言日期解析**（Quick Add / CLI 输入）至少同时支持中英两套词汇（`今天/明天/昨天/周一~周日/本周/下周/本月/下月` 与 `today/tomorrow/yesterday/Mon~Sun/week/next-week/month/next-month`），不识别时落入未排期，**绝不假设**。

设计补全（USER_STORIES 没明确要求，但在 i18n 上下文里需要定下来）：

- 切换 Obsidian 语言时，已打开看板**实时**换文案，不需要重开看板（避免丢失当前 tab / 滚动位置）。
- 中英混排（中文标题 + 英文 hashtag、或反之）一切正常工作；卡片渲染按视觉规则不按语言分支。

---

## 11. 视觉与组件约束

### 11.1 颜色 / 字体 / 圆角 / 阴影

- 全部走 Obsidian CSS 变量：
  - 背景：`--background-primary / --background-secondary / --background-secondary-alt`
  - 边框：`--background-modifier-border / --background-modifier-hover`
  - 强调：`--interactive-accent`
  - 状态：`--color-red / --color-yellow / --color-green`
  - 文本：`--text-normal / --text-muted / --text-faint`
  - 阴影：`--shadow-s / --shadow-l`
- **不**写常量 `#xxx`、不引入第三方 token。
- 圆角：6px（卡）、4px（小按钮 / badge）。
- 间距尺度：`4 / 8 / 12 / 16 / 24` px，不引第六档。
- 字体：继承 Obsidian。卡标题 = `--font-text-size`，meta 行 = `0.875em` + `--text-muted`。

### 11.2 动效

| 场景 | 时长 | Easing |
| --- | --- | --- |
| 卡 hover 抬阴影 | 80ms | ease-out |
| 卡消失 | 100ms fade + 150ms 邻居上移 | ease-in-out |
| Tab 切换 | 120ms cross-fade | ease-out |
| 拖拽自动切 tab 进度条 | 600ms 线性 | linear |
| Toast 入场 | 120ms | ease-out |

**Reduced motion**：用户系统启用 `prefers-reduced-motion`，所有过渡降到 ≤ 50ms 或瞬切，但**保留状态变化**（不要让用户失去操作反馈）。

### 11.3 不引入

- 不引第三方 UI 库（Mantine / chakra / antd / radix / shadcn）。
- 不引动画库（除非必要，GSAP / framer-motion 都不要）。CSS transition + transform 够用。
- 不引图标库——用 Obsidian 内置 lucide 图标 + emoji。

---

## 12. 可达性（a11y）

- **键盘可达**：所有可点元素必须可由 Tab 键到达，回车 / 空格触发。卡级动作完整覆盖（见 §6.8）。
- **可见焦点**：用 2px `--interactive-accent` outline，永不 `outline:none`。
- **对比度**：跟 Obsidian 主题。不在主题之上重写文字色。Overdue / near-deadline 的红 / 黄条只是辅助信号，不依赖颜色（同时配 `⚠ overdue` 文字 + `📅 near` 文字在 meta 行作为可读 fallback）。
- **屏幕阅读器**：
  - 卡 = `role="article"`，`aria-label` = "任务: <标题>, 状态 <todo/done/abandoned>, 日期 <⏳>, 估时 <est>"
  - tab 栏 = `role="tablist"`，每个 tab `role="tab"` + `aria-selected`。
  - 拖拽不可达 → 提供键盘等价（`D` 弹日期对话框 + `←/→` 改期 + 嵌套对话框，见下）。
- **拖拽的键盘等价**：选中卡 → `Shift+N`（设计补全）= 弹"嵌套到... (`path:Lnnn` 或在卡列表里选)"对话框。给非鼠标用户一条同等路径。
- **可达性 outline 测试**：仅靠键盘 + 屏读完成"加任务 / 改期 / 完成 / 放弃 / 嵌套"五个动作。任何一个走不通都是 P0。

---

## 13. 性能感知层（UX 视角）

ARCHITECTURE 决定具体实现，UX 这里只定**用户能感受到什么**：

- **打开看板 ≤ 1.5s**（vault ≤ 1 万文件、≤ 5000 任务）。超过显示 §8.4 的骨架；超 5s 显示进度。
- **拖拽到落定 ≤ 100ms** 反馈。
- **状态栏更新延迟 ≤ 1s**（不能因为状态栏老更新触发主线程卡顿——回 BUG.md，UX 这里要求"状态栏不能让 Obsidian 整体卡"）。
- **未打开看板时插件应感觉不存在**——只有状态栏一条文字。BUG.md 里"启用就卡死"的反例就是 UX 失败的硬上限。

---

## 14. CLI UX

> 完整动词清单与参数语义见 [USER_STORIES §AI agent](./USER_STORIES.md#ai-agent-想要的) 和 [README#CLI](./README.md#cli)。这里写**输出形态规范**和**错误形态规范**——这是 AI / 用户实际"看到"的部分。

### 14.1 命名空间

`task-center:*` 注册到 Obsidian 原生 CLI（US-201）。**不**写独立二进制、**不**走 shell wrapper。

### 14.2 输出形态规范（必须）

1. **第一列恒为稳定 id**（US-202）：`path:Lnnn` 或 12-char hex hash。
2. **不输出 JSON / YAML**（US-205）。人类与 AI 都读纯文本表格。
3. **每一行可被 grep / awk / cut**：列分隔用 ≥ 2 空格（不强行用 tab，避免与文件路径里的空格冲突）；多列对齐由内部计算。
4. **多行块**（任务 + 子任务）用 box-drawing 字符 (`├ └ │`) 表达层级。这是 **CLI 输出形态**，与 GUI 不强制视觉一致——GUI 卡内子任务用原生 DOM 嵌套渲染（§16-6 修订）。两边共享 tree traversal / sort 函数即可。
5. 写动词永远返回 `ok / before / after` 三行（US-204）：

   ```
   ok      <id>  <标题>
       before  <原始那一行 markdown>
       after   <修改后那一行 markdown>
   ```

6. 幂等命中："已经是目标状态"返回（US-203）：

   ```
   ok  <id>  <标题>  unchanged (already done ✅ 2026-04-23)
   ```

   注意：**仍然是 `ok`，不是 error。** AI 可重复跑。

### 14.3 错误形态规范（必须）

格式（US-211）：

```
error <code>  <一句人话>
```

`<code>` 是短而固定的集合，至少包含：

| code | 含义 | 后续 payload |
| --- | --- | --- |
| `not_found` | 给的 ref 在文件 / hash 里都找不到 | — |
| `ambiguous_slug` | hash 撞多条 | 候选列表（一行一条，`<id>  <标题>`）（US-208 / US-214） |
| `out_of_date` | 行号失效，已 fallback 到 hash | 找到的新 id（不报错继续，仅 stderr 一行 warn） |
| `invalid_date` | 日期解析失败 | 期望格式提示 |
| `write_conflict` | 文件被外部改了，原子写中止 | — |
| `read_only` | 任务在只读区域 / 模板里 | — |

**绝不猜**：`ambiguous_slug` 必须列候选让 AI / 人选；不自动挑第一个。

### 14.4 时间词汇

跟自然语言一致（US-207）：`today / tomorrow / yesterday / week / next-week / month / next-month / unscheduled / YYYY-MM-DD / FROM..TO`。中文 alias 至少支持 `今天 / 明天 / 昨天 / 本周 / 下周 / 本月 / 下月`。

### 14.5 文档化的工作流（在 README / `obsidian help task-center` 输出中）

直接给三个示例工作流（US-210），AI / 用户复制改改就能跑：

1. **典型一天收尾**：`stats days=1` → 看哪些超估 / 漏估 → `actual` 补 → `done` 完成 → `schedule` 把没做完的推到明天。
2. **快速捕捉**：`add text="..."`（无 `⏳` 落入未排期）。
3. **补记完成**：`done ref=... at=YYYY-MM-DD`。

### 14.6 帮助输出

`obsidian help task-center`：

- 列出每个动词、一行 summary、`example:` 一行。
- 输出长度 ≤ 一屏（80 行内），不刷屏。

---

## 15. Out of scope（明确不做）

- 多 vault 聚合 / 跨 vault 视图。Obsidian 一次一个 vault。
- 通知 / 提醒 / 闹钟。系统通知是另一个产品的事。
- 协作 / 多人 / 同步。markdown 文件本身可被任何同步工具同步，但插件不管。
- 任务依赖图（A blocks B）/ 甘特图。
- 自定义视图（手写 query）——我们不是 Dataview，让用户用 Dataview。
- 富文本卡内容 / 附件 / 评论。
- 主题 / 颜色自定义 UI——主题归 Obsidian。
- 多选拖拽（v1）。

---

## 16. 待 @Tiger 在 ARCHITECTURE.md 决策的影响项

UX 决策对实现的硬性约束（这些条进 ARCHITECTURE 时不能违反）：

1. **状态栏与看板必须共享同一份解析缓存**——不能各自 rescan vault（BUG.md 主要 root cause）。看板不开时，状态栏的更新必须基于"被改动的那一个文件"做增量，不做 full rescan。
2. **`allTasks()` 不能再每个 CLI 入口都跑一次**（BUG.md #2）；写动词只读涉及的那一个文件 + 它的祖先链。
3. **撤销栈是 UI 状态**，不是文件级。每条 undo 记录前后两版的"该行 markdown 字节"。撤销前做**内容比对**——把当前文件里 `op.line ~ op.line + op.after.length` 这几行与栈里记的 `after` 对比，**只在那几行被外部改写时**拒绝撤销（throw `undo_diverged`）。**不**用 mtime 比对——mtime 会因 Obsidian 自身的 backlink / metadata 写入或文件别处的编辑而误报，把"安全的撤销"挡住。内容比对精到 op 行，符合用户期望"我没动你写的，撤回去就行"（§6.7）。
4. **拖拽落定到嵌套**真的会移动文件之间的行，需要文件级原子写 + 跨文件事务（要 / 不要回滚由 ARCHITECTURE 决定，但行为上 UI 已答应了"撤销一定能回退"）。
5. **i18n 字符串集**与"用户写在 markdown 里的字面"互不污染——只翻应用提供的 UI 文案；用户的 hashtag 字面（任何 `#xxx`）、inline field 字段名、emoji 字段标记都按字节级保留（拟 US-408）。CLI `error <code>` 部分恒英文，"一句人话"部分跟随语言。日期 ISO 写回、locale 显示。
6. **CLI 与 GUI 共享同一个 tree traversal / sort 函数**（哪条是父、子任务排序顺序、是否被祖先终态隐藏）——避免两边业务规则漂移。**渲染层可以按 surface 不同**：CLI 用 `├ └ │` box-drawing 字符（纯文本环境），GUI 用原生 DOM 嵌套（卡片内层级缩进 16px + 状态机），二者不必视觉一致。原 §5.3 / §14.2 的 box-drawing 描述指的是 **CLI 输出形态**；GUI 卡内子任务用原生 DOM 渲染即可（设计补全 2026-04-25）。
7. **空 / overdue / near-deadline 视觉信号**走 CSS 变量；不要在 TS 里硬编码颜色。
8. **拖拽自动切 tab 的 600ms dwell** 是 UX 决策，不要用 setTimeout 漂移；用 requestAnimationFrame 算 elapsed。

---

## 17. 验收 checklist（PM 验收用）

完成上述实现后，下列每条都必须能由我（@Leo）在真 vault 上手动跑通；任意一条不过 = 不放行。

### 看板

- [ ] 周 / 月 / 已完成 / 未排期 4 个 tab 切换正常；`⌃1~4` 切到对应 tab。（US-105 / US-166）
- [ ] 周视图本周高亮今日列；`< 今 >` 正确翻周；列头显示 `N tasks · XhYm`。（US-101 / US-116）
- [ ] 月视图日历每格可拖入。（US-122）
- [ ] 已完成 tab 历史周折叠、本周展开；周组顶显示准确率。（US-303 / US-304）
- [ ] 未排期池顶恒为"按 deadline 升序的下一件"。（US-104）
- [ ] 状态栏显示 `📋 N today · ⚠ M overdue`，点击打开看板。（US-106）
- [ ] 关闭看板再打开记住上次 tab。（US-405）

### 卡 / 子任务

- [ ] 点标题不会进入 inline input；会打开源 Markdown 编辑面板，用户在原文里改标题。（US-161 / US-168）
- [ ] 卡片上没有 `+ 子任务` / inline 子任务输入；点卡片打开源 Markdown 编辑面板后，在原文里新增子任务，新子按父级继承规则显示。（US-141 / US-144 / US-168）
- [ ] 子任务在父卡内递归显示所有层级，不另起顶层卡。（US-142 / US-143）
- [ ] 完成 / 放弃父级，活动 tab 整条分支消失，已完成 tab 可见。（US-145）
- [ ] 子的 `⏳ ≠` 父时显示 badge；相同时不显示。（US-149）

### 拖拽 / 撤销 / 放弃

- [ ] 拖卡到另一天改 `⏳`，淡出 + 邻居上移有动画。（US-121 / US-127）
- [ ] 拖卡到另一卡变子任务，跨文件移动行，toast + 撤销。（US-125 / US-228）
- [ ] 拖卡到垃圾桶变 `[-] ❌ 今天`，未打钩子任务级联，已打钩子任务保留。（US-123 / US-124）
- [ ] 不能把 A 拖到 A 自己 / 后代上。（US-126）
- [ ] `⌘/Ctrl+Z` 撤销 ≤ 20 步拖拽 / 改期 / 改名。（US-128）
- [ ] 拖拽过程中悬停 tab 头 ≥ 600ms 自动切到那个 tab。（US-114）

### Quick Add / 筛选 / 复盘

- [ ] `⌘T` 唤起 Quick Add，写到当日 daily 文件尾，无 daily 走 inbox。（US-163）
- [ ] 自然语言日期解析（中英）。
- [ ] `/` 聚焦筛选；筛选支持 tag / 数值 / 关键字。（US-109 / US-166）
- [ ] 已完成 tab 7 天准确率 + top tag 时长 显示正确。（US-303）

### 空 / 错 / 性能

- [ ] vault 一条任务都没有时显示空状态引导。（US-113）
- [ ] 启用插件后**不打开看板**，Obsidian 在 6000+ 文件 vault 上无明显卡顿。（BUG.md 反向验收）
- [ ] 打开看板首次 ≤ 1.5s 出数据；超时显骨架。

### CLI

- [ ] `obsidian task-center:list scheduled=today` 输出第一列为 `path:Lnnn`，子任务用 `├ └`。（US-202 / US-205）
- [ ] 写动词输出 `ok / before / after`。（US-204）
- [ ] 已完成任务再 `done` 返回 `ok ... unchanged`。（US-203）
- [ ] hash 撞多条返回 `ambiguous_slug` + 候选列表。（US-214）
- [ ] `actual minutes=+30m` 增量改时间生效。（US-209）
- [ ] `nest ref=A under=B` 跨文件嵌套生效，与 GUI 拖拽等价。（US-228）
- [ ] 错误格式：`error <code>  <一句人话>`。（US-211）

### 跨角色

- [ ] 改名 / 移动 / 嵌套时未识别的 emoji / inline field 字节级保留。（US-407）
- [ ] callout 里的任务（`> - [ ]`、多层 `>>`）也能解析、渲染、写回。（US-406）
- [ ] 切 Obsidian 语言 zh ↔ en，UI 文案自动切换；hashtag 字面不变。（US-402）
- [ ] `prefers-reduced-motion` 启用时动效降级但状态变化保留。
