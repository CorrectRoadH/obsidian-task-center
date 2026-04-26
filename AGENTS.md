# obsidian-task-center

一个 Obsidian 插件：周/月视图 + 父子任务渲染 + 自然语言 Quick Add + 移动端手势。
SSOT 文档：`USER_STORIES.md`（产品需求） + `UX.md`（视觉规范） + `ARCHITECTURE.md`（架构）。

## 元规则

1. 永远中文回复
2. 改完代码先 `pnpm build`（esbuild）+ 跑 e2e（WebDriverIO，跑通后再 push）
3. **不写一次性脚本**（mjs / sh / md）—— 一次性的活直接执行
4. **测试要高质量**——单元 + e2e 双保险
5. `commit` 中文 conventional：`<type>(<scope>): <description>`，type ∈ feat/fix/chore/upgrade/docs

## 项目命令

- 开发：`pnpm dev`
- 构建：`pnpm build`
- e2e：`pnpm e2e`（WebDriverIO，需要 Obsidian 实例）
- 单测：`pnpm test`

## 团队角色

- @Leo —— PM / 产品设计，定 USER_STORIES.md + UX.md
- @Wood —— 全栈，实现新功能 + bug fix
- @Rally —— code reviewer，把关 PR
- @Tiger —— CTO / 架构 / 协调

# 开发流程（2026-04-25 起强制）

由 @Tiger 全员落地，违反由 @Rally 在 review 时拦。

## 三类任务，三种节奏

### 1. Bug fix → 严格 TDD（必须 test-first）

任何 task 的目标是"修一个已发现的行为偏差"（user-reported bug、e2e fail、回归）：

1. **第一个 commit：仅一个 failing test** —— 重现 bug 的最短 e2e / 单测。CI 上这条必须 fail（红）。reviewer 看 git log 能看到"先红"。
2. **第二个 commit：fix 让 test 转绿**。reviewer 看 git log 看到"后绿"。
3. fix commit 不允许带其它无关改动。
4. PR 描述里贴 git log 截图证明先红后绿。

理由：bug 不会回归的唯一保证是有一个**能 fail** 的自动测试；先写 fix 再补的测试很容易"测了个寂寞"。

### 2. New feature → test-alongside（必须有，commit 顺序不限）

新增 spec 行为（USER_STORIES 里新 US-xxx 或 PRD 新功能）：

1. PR 必须包含覆盖新 spec 的 e2e / 单测。
2. 测试源里必须 grep 到 `US-xxx` 字面引用（让 spec audit 可机器化）。
3. PR 描述里列出新 US 编号 + 对应测试 file:line。

### 3. Refactor → 已有测试兜底

不改变行为，只重组代码：

1. 跑现有完整测试套件，必须全绿。
2. 触碰的代码段没有测试覆盖，**先单独 commit 加覆盖（不改行为）**，再 refactor。
3. 不允许"refactor 顺手改一点行为"——发现行为问题先停、起 bug fix task、走 TDD。

## UI / 视觉变更

代码 e2e 不能验证"长得好不好看"。任何 UI / 视觉相关 task：

1. fix push 之后，task assignee 必须在 task thread 贴**视觉 evidence** —— Playwright screenshot diff 或人工截图。
2. PM (@Leo) 在 in_review → done 之前必须看过这条 evidence。"代码 review pass + e2e green" 不再是 PM 验收充要条件。
3. 短期：人工截图兜底；中期：Playwright screenshot baseline diff 标准化。

## Reviewer (@Rally) 的把关清单

- bug fix：检查 git log 是否有"failing test → fix" 两个独立 commit；没有 → 直接打回重做。
- feature：PR 引用对应 US-xxx + 有测试 grep 证明。
- refactor：CI 完整套件 green + 不夹杂行为变化。
- UI：task thread 有 visual evidence + Leo 签过。

### Rally PASS 检查点强制留痕（2026-04-26 起）

每次 Rally 给 PR / task PASS，**必须在对应 task thread 留一条检查点消息**，三栏：
1. **审了什么**（具体 file:line 或函数名 / commit hash / 测试 spec name）
2. **哪些边界已验证**（穷举边界场景，每条标 ✓ / 仅 spot-check / 未覆盖）
3. **哪些没看 / 受限假设**（明确说"未跑 e2e 因为本地缺 OBSIDIAN beta 凭证" 这类受限项）

**为什么强制**：reviewer 默认低 visibility，PASS 没有可回溯的检查记录就等于 rubber stamp. 如果一个 bug 从 PASS 的 PR 漏出，团队需要能 trace Rally 当时是否真的看了相关路径.

**执行**：没有检查点的 PASS 不算 PASS，PM (@Leo) 不接受这种 in_review → done 转换. 由 @Tiger 周复盘统计"有检查点 PASS 占比"，未达 100% retro 升级.

argv-style false-positive（如 task #25 release argv[1] case）不影响这条规则，撤回时同样在 thread 留"撤回原因 + 我误判了什么"的一行说明.

## 团队工作纪律（跨项目流程，2026-04-26 起）

@Jerry 拍措辞（task #7/#8 audit），@Tiger 落地，本仓库 mirror 适用部分。it-infra/CLAUDE.md 是主文档.

### 1. 诊断顺序

用户报"X 挂了"，第一步看 **X 自身日志 / 健康状态**（dev console / e2e log / 控制台输出 / network tab），再看上下游（Obsidian API / 插件版本 / vault 状态）.

诊断 thread 必须分三栏：**事实证据** / **假说** / **已反驳**. 未验证假说不能写成根因；写"目前最强解释是 X，证据 Y/Z 支撑，待 W 验证"。

出处：2026-04-26 task #25 e2e fail 我假设是 TZ-mismatch（之前 task #23 模板套用），Wood 复现真根因是 Sunday-week-boundary。

### 2. memory / docs 状态标签

`docs/audit/` / 复盘文档 / 决策记录顶部必须标状态：`已证实` / `未证实` / `已推翻，见 ...` / `已废弃，见 ...`. 结论改变时追加勘误段，不静默覆盖。

### 3. 破坏性操作 last-call

执行**改变现状不可立即回滚**的动作前，thread 发"最后取证窗口"五栏（范围 / 命令 / 影响 / 回滚点 / 等待对象）。

涵盖：发版 tag push / `npm version major` / breaking change merge / settings schema 改 / data.json 结构改 / 发版 commit force push.

### 4. 部署入口清单

本仓库 deploy 入口：
- `.github/workflows/release.yml` —— push **strict semver tag** `0.x.y`（**无 `v` 前缀，无 `-beta` 等 pre-release 后缀**，正则 `[0-9]+.[0-9]+.[0-9]+`）触发 pre-flight gate (typecheck + lint + unit + e2e + tag↔manifest 对齐) → 创建 GitHub Release → 上传 `main.js` / `manifest.json` / `styles.css`. 推 `v0.x.y` 不会触发，只会被静默忽略.
- `npm version patch/minor/major` —— 本地 bump 版本 + 自动 git tag（npm 默认会加 `v` 前缀，**必须 `npm version --no-git-tag-version` 然后手动 tag 无 v**，或 npm config `tag-version-prefix=""`），配合 `git push --follow-tags`
- 手动 `gh release create` —— 紧急回退路径，需 `release.yml` 失败后才走

改 release 流程前先在 thread 写"我准备改 X gate，旁路 Y/Z 是否仍 active？"，等确认。

### 5. Reviewer PASS 检查点

见上方 `### Rally PASS 检查点强制留痕（2026-04-26 起）`。本规则与跨项目流程同根。

---

**生效**：2026-04-26 13:00 起.
**违反处理**：第一次 @Rally 或 @Jerry 标红打回；第二次 @Tiger / @Omar 在 #高管群 + retro 升级.

## CTO (@Tiger) 的把关清单

- 接 task 时 review 是否分对类（bug / feature / refactor）。分错的 task thread 立刻纠正。
- 每周日 周复盘检视违反次数 + 改进流程。

---

**生效**：2026-04-25 23:35 起，所有 slock agent 在所有项目的开发任务。
**违反处理**：第一次 @Rally 标红打回；第二次 @Tiger 在 #高管群 提出。
