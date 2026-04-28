# Obsidian Task Center

[English](./README.md)

Task Center 是一个 Obsidian 插件：在普通 Obsidian Tasks markdown 之上，增加今日 / 周 / 月任务看板、父子任务渲染、自然语言 Quick Add、移动端手势，以及方便 AI agent 使用的 CLI。

它不创建新数据库，也不发明新任务格式。任务仍然是 markdown：

```markdown
- [ ] 准备发布 #work ⏳ 2026-05-15 📅 2026-05-20 [estimate:: 90m]
    - [ ] 写 release notes [estimate:: 30m]
- [x] 修完回归 ✅ 2026-04-28 [actual:: 45m]
- [-] 放弃旧方案 ❌ 2026-04-28
```

## 为什么用 Task Center

Obsidian Tasks 负责任务语法和查询模型。Task Center 继续使用这套基础，只补上纯笔记里不太顺手的工作表面：

| 需求 | Task Center 提供 |
| --- | --- |
| 安排一周任务 | 全页看板：今日、周、月、已完成、未排期 |
| 调整计划 | 拖到日期改排期，拖到卡片变子任务，拖到放弃区标记放弃 |
| 管理父子任务 | 递归父子卡片，支持排期 / 状态继承 |
| 快速捕捉 | Spotlight 风格 Quick Add，支持中英文自然语言日期 |
| 复盘估时 | 通过 `[estimate::]` / `[actual::]` 汇总计划与实际耗时 |
| 移动端使用 | 手机布局、长按菜单、滑动动作、避让软键盘 |
| 让 AI agent 帮忙 | 稳定的 `obsidian task-center:*` CLI，输出适合 grep 和自动化 |

## 安装

Task Center 还没有上架 Obsidian 官方 Community Plugins。上架前，推荐用 BRAT 安装，因为它可以直接从 GitHub Release 安装并检查更新，不需要每次手动复制文件。

### 前置条件

1. 安装并启用 [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)。Task Center 读写兼容 Tasks 的 markdown，并把 Tasks 插件视为数据层伙伴。
2. 启用 Obsidian 内置 **Daily Notes** 核心插件，并配置 "New file location"。Quick Add 会把新任务写入当天 Daily Note；如果 Daily Notes 没启用或没配置，Task Center 会拒绝写入，而不是偷偷写到 inbox fallback。

### 方式一：用 BRAT 安装（推荐）

1. 在 Obsidian 打开 **Settings -> Community plugins**。
2. 如果 Obsidian 提示 Restricted Mode，先关闭。
3. 点击 **Browse**，搜索 **BRAT**，安装 **Obsidian42 - BRAT** 并启用。
4. 打开 **Settings -> BRAT**。
5. 选择 **Add Beta Plugin**。
6. 粘贴这个仓库地址：

   ```text
   https://github.com/CorrectRoadH/obsidian-task-center
   ```

7. 等 BRAT 安装最新 release。
8. 回到 **Settings -> Community plugins**，启用 **Task Center**。

### 方式二：手动安装

1. 打开 [最新 GitHub Release](https://github.com/CorrectRoadH/obsidian-task-center/releases/latest)。
2. 下载三个 release 资产：
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. 在你的 vault 里创建这个文件夹：

   ```text
   <你的 vault>/.obsidian/plugins/task-center/
   ```

4. 把这三个文件直接放进该文件夹顶层。不要放在 zip 里，也不要多套一层解压目录。
5. 重启 Obsidian。
6. 打开 **Settings -> Community plugins**，启用 **Task Center**。

### 移动端安装

Task Center 支持移动端（`isDesktopOnly: false`）。在插件上架官方 Community Plugins 前，最稳的移动端安装方式是：

1. 先在桌面端用 BRAT 或手动三件套装好 Task Center。
2. 通过 Obsidian Sync 同步 `.obsidian/plugins/task-center/` 到手机，或手动把同一个文件夹复制到移动端 vault。
3. 在 Obsidian Mobile 打开 **Settings -> Community plugins**，启用 **Task Center**。

如果手机上看不到 Task Center，检查 `manifest.json`、`main.js`、`styles.css` 是否直接位于 `.obsidian/plugins/task-center/`，Restricted Mode 是否已关闭，以及手机打开的是否是同一个 vault 副本。

## 快速开始

1. 继续在任意 markdown 文件里写普通 Tasks 风格 checkbox。
2. 需要时再加排期、截止、估时、实际耗时：

   ```markdown
   - [ ] Review PR #work ⏳ today [estimate:: 30m]
   - [ ] 换护照 📅 2026-05-30
   ```

3. 通过 ribbon icon、命令面板、`Ctrl/Cmd+Shift+T`，或下面的命令打开 Task Center：

   ```bash
   obsidian command id=task-center:open
   ```

4. 在看板里按 `Ctrl/Cmd+T` 使用 **Quick Add**：

   ```text
   Review beta feedback #work tomorrow [estimate:: 25m]
   处理发布清单 #3象限 周六 [estimate:: 45m]
   ```

`today`、`tomorrow`、`Mon`、`今天`、`明天`、`周六` 这类自然语言日期会在写入 markdown 前解析成 ISO 日期。

## 视图

- **今日**：逾期、今日安排、未排期推荐三组，并提供快捷动作。
- **周**：七列看板，高亮今天，显示每日任务数与估时合计。
- **月**：日历网格，每天都是拖拽落点。
- **已完成**：按周分组的复盘时间线，展示估时与实际耗时。
- **未排期**：按 deadline 和创建顺序排序的任务池。

把卡片拖到某天会改 `⏳`。拖到另一张卡片上会变成子任务。拖到底部放弃区会标记 `[-] ❌`，不会删除源 markdown 行。

## 语法

Task Center 在编辑、移动、嵌套任务时，会字节级保留 Obsidian Tasks 元数据和未知 inline field。

| 含义 | Markdown |
| --- | --- |
| 排期 | `⏳ YYYY-MM-DD` |
| 截止 | `📅 YYYY-MM-DD` |
| 开始 | `🛫 YYYY-MM-DD` |
| 创建 | `➕ YYYY-MM-DD` |
| 完成 | `[x]` 加 `✅ YYYY-MM-DD` |
| 放弃 | `[-]` 加 `❌ YYYY-MM-DD` |
| 估时 | `[estimate:: 90m]`、`[estimate:: 1h30m]` |
| 实际耗时 | `[actual:: 75m]` |
| 标签 | `#work`、`#1象限`、`#next` |

标签和 inline field 名都是用户数据。Task Center 不翻译、不规范化、不硬编码它们。

## CLI

Task Center 注册到 Obsidian 原生 CLI，不提供额外 wrapper 脚本。

```bash
obsidian task-center:list scheduled=today
obsidian task-center:list scheduled=unscheduled tag='#work'
obsidian task-center:show ref=Tasks/Inbox.md:L42
obsidian task-center:add text="Review launch checklist" tag='#work' scheduled=2026-05-15
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-05-16
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-28
obsidian task-center:abandon ref=Tasks/Inbox.md:L42
obsidian task-center:nest ref=Tasks/Inbox.md:L42 under=Projects/Launch.md:L10
obsidian task-center:actual ref=Tasks/Inbox.md:L42 minutes=+30m
obsidian task-center:review days=7
obsidian task-center:review days=7 format=json
```

CLI 输出同时服务人和 agent：

- 列表行第一列是稳定 id，例如 `path:L42`。
- 写操作幂等，可以重复执行。
- 变更命令输出 `before` / `after`。
- hash 撞车时返回 `ambiguous_slug` 和候选列表，绝不猜。

安装配套 AI skill：

```bash
npx skills add CorrectRoadH/obsidian-task-center
```

## 设置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| 默认视图 | 周 | 首次打开停在哪个 tab |
| 一周开始日 | 周一 | 周视图和日历边界 |
| 启动时打开 Task Center | 关 | 打开 vault 时是否自动打开看板 |
| 自动打创建日期 | 开 | 新任务是否加 `➕ YYYY-MM-DD` |
| 强制移动布局 | 关 | 在宽屏上也使用手机布局 |

## License

MIT.
