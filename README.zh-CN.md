# Obsidian Task Center

[简体中文](https://github.com/CorrectRoadH/obsidian-task-center/blob/main/README.zh-CN.md) / [English](https://github.com/CorrectRoadH/obsidian-task-center/blob/main/README.md)

Task Center 把你写在 Obsidian 各处的 `- [ ]` 任务收拢到一个看板里，按天、周、月排期和复盘。

任务还是普通 Markdown，存在你原来的笔记里。插件不建数据库，也不发明新格式；卸载后笔记一字不变。

```markdown
- [ ] 准备发布 #work ⏳ 2026-05-15 📅 2026-05-20 [estimate:: 90m]
    - [ ] 写发布说明 [estimate:: 30m]
- [x] 修完回归问题 ✅ 2026-04-28 [actual:: 45m]
```

![周视图拖拽演示](screenshots/week-drag.gif)

![月视图拖拽演示](screenshots/month-drag.gif)

## 安装

<a href="https://obsidian.md/plugins?id=task-center"><img src="assets/install-button.svg" alt="在 Obsidian 中安装" height="52"></a>

或在 **设置 → 第三方插件 → 浏览** 里搜索 “Task Center”。

还需要两步准备：

1. 安装并启用 [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) 或 [Dataview](https://github.com/blacksmithgu/obsidian-dataview) 其中一个。Task Center 用的是它们的任务写法。
2. 打开 Obsidian 自带的 **日记（Daily Notes）** 核心插件，并设置“新文件的存放位置”。Quick Add 新建的任务会写进今天的日记。

## 能做什么

- 一个整页看板，自带今日、本周、本月、TODO、未排期、已完成、已放弃这几个 Tab。
- 拖拽改排期、拖到另一张卡上变成子任务、拖进放弃区标记放弃。
- 父任务和子任务显示在同一张卡上，子任务没写排期就跟着父任务。
- 自己搭视图：每个 Tab 可以分成几块，每块有自己的筛选条件。比如四象限，或者工作 / 个人并排。
- Quick Add 一行输入新建任务，听得懂“明天”“周六”这类中英文日期。
- 记录估时和实际耗时，复盘自己估得准不准。
- 手机上长按出菜单，左滑完成、右滑放弃。
- 一套 Obsidian 命令行（CLI）命令，让 Claude Code 等 AI agent 读写同一批任务。

## 快速开始

1. 照常在任意笔记里写任务：

   ```markdown
   - [ ] 看一下 PR #work ⏳ 2026-05-15 [estimate:: 30m]
   - [ ] 续签护照 📅 2026-05-30
   ```

2. 点左侧边栏的看板图标，或在命令面板运行 “Task Center: 打开任务看板”。
3. 在看板里点 `+`，或在命令面板运行 “Task Center: 快速新建任务”：

   ```text
   处理发布清单 #work 周六 [estimate:: 45m]
   Review beta feedback #work tomorrow
   ```

   “今天”“明天”“周六”“tomorrow” 这类词会在写入前换成具体日期（`2026-05-16`）。

想用快捷键打开，在 **设置 → 快捷键** 里搜索 “Task Center” 自己绑定。

## 任务写法

两种常见写法都能读：

```markdown
- [ ] Tasks 的 emoji 写法 ⏳ 2026-05-15 📅 2026-05-20 ➕ 2026-05-01
- [ ] Dataview 的写法 [scheduled:: 2026-05-15] [due:: 2026-05-20] [created:: 2026-05-01]
```

| 含义 | Tasks emoji | Dataview |
| --- | --- | --- |
| 排期（打算哪天做） | `⏳` | `[scheduled::]` |
| 截止 | `📅` | `[due::]` |
| 创建于 | `➕` | `[created::]` |
| 完成于 | `✅` | `[completion::]` |
| 放弃于 | `❌` | `[cancelled::]` |

插件写入时用哪一种，在 **设置 → Task Center → 任务格式风味** 里选。拖拽改期、选日期、Quick Add、CLI 都按这个设置写。同一行同一字段两种都有时，以 emoji 为准。

估时和实际耗时用普通的行内字段：

```markdown
[estimate:: 90m] [estimate:: 1h30m] [actual:: 75m]
```

插件不认识的字段和标签会原样保留。

## 给 AI agent 用的命令行

Task Center 把命令注册到 Obsidian 自带的命令行（需要 Obsidian 桌面版开启 CLI）：

```bash
obsidian task-center                                   # 查看全部命令
obsidian task-center:list scheduled=today
obsidian task-center:show ref=Tasks/Inbox.md:L42
obsidian task-center:add text="检查发布清单" tag='#work' scheduled=2026-05-15
obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-05-16
obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-28
obsidian task-center:review days=7 format=json
```

为了让 agent 用得放心：

- 每条任务有一个固定编号，格式是 `文件路径:L行号`。行号变了，会按标题自动找回。
- 同一条命令重复执行，结果一样。比如对已完成的任务再跑 `done`，会返回 `unchanged`，不会重复写。
- 每次修改都打印改前、改后两行，方便核对。

安装配套的 AI skill，让 agent 知道怎么用这些命令：

```bash
npx skills add CorrectRoadH/obsidian-task-center
```

## 设置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| 默认 Query Tab | 跟随第一个可见 Tab | 打开看板时先显示哪个 Tab |
| 一周从哪天开始 | 周一 | 周视图的列顺序和“本周”范围 |
| 启动时打开看板 | 关闭 | Obsidian 启动时是否自动打开看板 |
| 自动打创建日期 | 开启 | 新任务是否写上创建日期 |
| 任务格式风味 | Tasks emoji | 写入用 emoji 还是 Dataview 写法 |
| 强制移动端布局 | 关闭 | 在平板、大屏上也用手机布局 |

## 许可证

MIT
