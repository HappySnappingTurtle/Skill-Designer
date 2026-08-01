# Skill Designer Claude 开发交接文档

> 更新时间：2026-08-01 08:14（Asia/Shanghai）
>
> 当前分支：`main`
>
> 当前 HEAD：`566ea31 feat:补充接力文档`
>
> 交接对象：继续开发本仓库的 Claude 或其他 Agent

## 0. 执行纪律

1. **唯一任务来源是 `TODOList.md`。** 本文只记录当前事实、证据和外部断点，不能替代 TODO，也不能据此自行删减或重排任务。
2. 先读取仓库/用户提供的 `AGENTS.md`，顶层会话读取 `/Users/hongyuwu/.codex/skills/arming-thought/SKILL.md`。
3. 工作树包含大量连续、未提交成果。禁止 `reset`、`checkout`、`clean` 或覆盖现有修改；除非用户明确要求，不要提交或推送。
4. 页面能力必须由开发者使用可见 Google Chrome 实际操作验证：

   ```js
   chromium.launch({ channel: "chrome", headless: false })
   ```

   单元测试、接口测试、无头浏览器、旧截图或只读 JSON 都不能替代本轮页面验收。截图必须人工查看。
5. 用户提供的真实 Skill 是只读源：

   ```text
   /Users/hongyuwu/IdeaProjects/yds-skills/mdd-backend-extend-develop
   ```

   验收前后必须比较逐文件 SHA-256，不能修改源仓库。
6. 不要把模拟 Provider、内部 fixture、持久化 completed 夹具或宿主进程执行称为真实 Benchmark。真实 Benchmark 必须同时有真实模型、非零 token、真实 Docker 沙箱和真实断言/产物。

## 1. 产品边界

Skill Designer 是面向开发者的通用 Skill 开发工具，不是 Claude、Codex 或某一家 Agent 的专用编辑器。

- Workspace 是产品根对象，可管理多个独立 Skill Project。
- 1.0 的 ChangeSet、Revision、RuntimeArtifact、Trace、运行、报告、Benchmark 和导出仍以单一 Skill Project 为原子边界。
- workflow Skill 使用有向图；content-only Skill 不伪造可执行流程。
- 节点行为按类型决定，不按名称、标题或固定 ID 决定。
- 图谱必须保持原项目风格的 2D/3D 力导向图，不得回退为流程图卡片画布。
- 所有修改先生成 ChangeSet 和 Diff，用户确认后才推进 Revision。
- 工具可以解释问题、生成建议和修复 ChangeSet，但不能自动修改用户 Skill。
- 非法下一节点由引擎拒绝并保持当前状态；1.0 不自动改图或生成所谓“回归路线”。
- 1.0 只提供厂商无关 Generic Export；厂商专用适配、文档元模型和跨 Skill 联合执行属于 2.0。

权威文件：

- `TODOList.md`：任务状态、验收条件和证据。
- `产品设计文档.md`：产品范围和用户行为。
- `架构设计文档.md`：Schema、边界、持久化、运行和发布契约。

## 2. 当前工作树

- `main` 与远端 `origin/main` 仍停在 `566ea31`。
- 当前 HEAD 后没有新提交，但 engine/server/web、产品/架构文档、README、发布脚本、测试和 Chrome 验收脚本均有大量修改或新增。
- 不要用 HEAD 版本覆盖工作树；先用 `git status --short` 和 `git diff` 理解重叠修改。
- `dist/` 和 `.skill-designer-dev/` 是构建/验收产物，不提交。
- 上一次收尾已确认没有残留 `playwright_chromiumdev_profile`、发布启动器或临时 server 进程。

## 3. 当前真实状态

### 3.1 T42 发布包

T42 已是 `[~]`，本机可完成部分已经收口，但不能标为完成。

已实现：

- Node 20 单进程本地服务加系统 Google Chrome，不引入 Electron。
- macOS/Windows ZIP 包含已构建 engine/server/web 和生产依赖闭包，解压后不需要 `npm install`。
- 严格 `development-preview / unsigned / integrity-only / local-development` 清单；SHA-256 只证明完整性，不建立发布者身份信任。
- 实际普通文件集合必须与 manifest 精确一致；拒绝未声明文件、符号链接、目录和特殊文件。
- 安装器校验解压源和 staging，拒绝错平台包；程序目录与数据目录分离。
- `doctor` 输出平台、完整性、数据目录、Chrome、发布信任和 Benchmark 前置条件；缺少 Chrome 是硬失败。
- 启动器只打开 Google Chrome，不降级到系统默认浏览器；`--no-open` 仅跳过自动打开并保留本地服务。
- macOS `.command` 和 Windows `.cmd` 快捷入口共享 `scripts/release/entrypoints.mjs`，保留 Node 原始退出码和正确暂停策略。
- 卸载默认保留用户数据，只有显式 `--delete-data` 才删除。

当前本地门禁：

```text
npm run ci
Lint：通过
TypeScript：通过
Vitest：30 个测试文件，200 项通过，1 项 Windows 专属跳过
生产构建：通过
macOS/Windows 发布构建：各 3599 个声明文件
```

最终可见 Chrome 发布包验收：

```text
completedAt: 2026-07-31T15:32:08.479Z
doctor.chromeFound: true
doctor.checkedFiles: 3599
真实 MDD Skill: 332 文件
图谱: 10 节点 / 9 边 / 16123 非背景像素
Generic Export: 337 条目
390x844: 无横向溢出
源 Skill: SHA-256 不变
Console errors / failed responses: 0 / 0
browserCloseCompleted / launcherStopped: true / true
```

证据：

```text
.skill-designer-dev/chrome-artifacts/release-package/verification.json
.skill-designer-dev/chrome-artifacts/release-package/release-package-changeset-desktop.png
.skill-designer-dev/chrome-artifacts/release-package/release-package-graph-desktop.png
.skill-designer-dev/chrome-artifacts/release-package/release-package-mobile.png
```

### 3.2 GitHub Actions

当前工作树的 `.github/workflows/ci.yml`：

- `ubuntu-latest / macos-latest / windows-latest` 三系统矩阵；
- 项目运行时仍由 `node-version: 20` 验证；
- 承载 action 已升级到官方当前稳定 `actions/checkout@v7` 和 `actions/setup-node@v7`，两者 action runtime 为 Node 24。

不要声称远端已通过：

- 公开远端最新仍是旧提交 `566ea31` 的 run `30523525492`；
- macOS Job 退出 127；
- Windows Job 退出 1；
- 旧 workflow 没有 Linux Job；
- 当前工作树未提交、未推送，所以 v7/三系统矩阵没有新远端记录。

公开记录：

```text
https://github.com/HappySnappingTurtle/Skill-Designer/actions/runs/30523525492
```

### 3.3 其他主要任务

具体状态只看 `TODOList.md`。当前 `[~]` 项的剩余条件主要是：

- T01/T05/T06/T12/T39：真实 Windows、异常退出矩阵和远端三系统成功记录。
- T21/T22：用户真实 Skill 加真实 Provider 的多轮稳定性验收。
- T27/T32/T35-T38/T40：真实 Docker、固定 digest runner 镜像、真实 Provider 和非零 token Benchmark。
- T41：另一个独立外部 Agent/环境读取同一 Generic Export，以及 Windows Node 对照。
- T42：Windows 安装/启动/Chrome/卸载、正式签名/公证和全部 1.0 前置门禁。

当前机器重新核对结果：

```text
Docker CLI: 不存在
SKILL_DESIGNER_SANDBOX_IMAGE: 未配置
OPENAI_API_KEY / SKILL_DESIGNER_OPENAI_API_KEY: 未配置
PowerShell: 不存在
GitHub CLI: 存在但未登录
Claude CLI: 存在，但未经用户明确授权不要自行调用产生外部模型费用
```

## 4. 下一位开发者如何继续

1. 先读 `TODOList.md`，不要按本文复制一套新 TODO。
2. 用 `git status --short` 确认工作树没有被其他人继续修改；遇到新修改时与其合并，不要回滚。
3. 根据实际可用外部条件选择主线：
   - 有 Docker Desktop、固定 digest 镜像和 Provider：优先完成 T35，再按依赖推进 T36-T38/T40。
   - 有真实 Windows：执行 T01/T05/T06/T12/T39/T42 的 Windows 矩阵。
   - 用户明确要求提交和推送且提供 GitHub 权限：先审查并提交当前连续成果，再触发三系统 CI；只有三个 Job 都成功才更新为通过。
   - 有独立外部 Agent/环境：执行 T41，不允许同一进程的重复运行冒充独立 Agent。
4. 如果外部条件仍不可用，只能继续代码审计、文档修正和本机负向测试；不得把对应 `[~]` 改成 `[x]`。

## 5. 验证命令

基础门禁：

```bash
npm run ci
git diff --check
```

发布包最终页面验收：

```bash
node scripts/chrome-release-package-verify.mjs
```

验收脚本必须：

- 清空自己的 artifact 目录；
- 使用最终构建产物和独立临时数据目录；
- 实际操作页面，不只请求 API；
- 检查 Canvas/WebGL 非空、390x844 布局、控制台和失败请求；
- 验证真实 Skill 源字节不变；
- 关闭浏览器和自己启动的服务；
- 最后人工查看本轮截图。

专项脚本与证据路径已逐项写在 `TODOList.md`，执行前核对脚本是否拒绝落后于源码的 `dist`。

## 6. 禁止的错误结论

- “本机 macOS CI 通过，所以 Windows/Linux 也通过。”
- “workflow 已修改，所以远端失败已经修复。”
- “生成了 Windows ZIP，所以 Windows 安装和 Chrome 已验收。”
- “模型调用数和 token 为 0，但 Benchmark 已完成。”
- “fixture/模拟 Provider completed，所以真实 Docker Benchmark 已完成。”
- “Chrome 脚本退出 0，所以截图不需要人工看。”
- “SHA-256 完整，所以发布者身份可信。”
- “用户 Skill 有错误，所以工具可以自动修改它。”

完成一个子项后，只更新 `TODOList.md` 中对应事实。所有外部证据完整前保持 `[~]`。
