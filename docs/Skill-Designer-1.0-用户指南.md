# Skill Designer 1.0 用户指南

> 当前仓库版本为 0.1.0 开发预览。本指南描述 1.0 交付方式；正式发布前仍以“已知限制”中的验收状态为准。

## 1. 系统要求

- Windows 10/11 x64 或 macOS 13 及更高版本。
- Node.js 20 或更高版本。发布 ZIP 已包含应用代码和生产依赖，不需要运行 `npm install`。
- Google Chrome，作为本地工作台的必需浏览器。启动器不会降级到系统默认浏览器。
- Docker Desktop 仅是“真实 Benchmark”必需条件；图谱、文档、导入、导出、调试和报告功能不依赖 Docker。
- 真实模型功能需要用户自己的 Provider API Key，默认适配 OpenAI Responses API。

Skill Designer 只监听本机 `127.0.0.1`。页面、API 和用户数据均留在本机；模型调用和用户主动执行的沙箱任务除外。

## 2. 下载与校验

1. macOS 下载 `skill-designer-<version>-macos.zip`；Windows 下载 `skill-designer-<version>-windows.zip`。
2. 使用同目录的 `SHA256SUMS.txt` 核对 ZIP 的 SHA-256。该步骤只检查下载完整性，不证明发布者身份。
3. 解压到普通文件夹，不要直接在 ZIP 预览器中运行。
4. 执行 `diagnose.command`（macOS）或 `diagnose.cmd`（Windows）。诊断会检查 Node 版本、发布清单、实际文件集合与全部文件 SHA-256、目标平台、数据目录写权限和 Chrome，并只报告 Benchmark 所需的 Docker/Provider 配置状态，不读取密钥内容。当前 `0.1.0` 的 `package.releaseChannel` 必须为 `development-preview`，`package.platformMatchesRuntime` 必须为 `true`，`releaseTrust` 必须明确报告 `unsigned / integrity-only / publisherTrustEstablished: false`；错平台、未找到 Chrome、符号链接、特殊文件、未声明文件以及缺失、未知或自相矛盾的状态都会使诊断失败。

macOS 首次运行下载文件时，系统可能要求用户在“隐私与安全性”中确认打开。当前开发预览未提供 Apple 代码签名/公证或 Windows Authenticode 签名。发布 SHA-256 和包内清单可以发现意外损坏或与清单不一致的内容，但不能证明清单和程序来自可信发布者；本地开发分发前仍需通过受控渠道核对来源。

## 3. 安装、启动与卸载

### macOS

1. 双击 `install.command`，默认安装到 `~/Applications/Skill Designer`。安装器先完整校验解压源且只接受 macOS 包，再复制到 staging。
2. 进入安装目录并双击 `start.command`。
3. 卸载时双击安装目录中的 `uninstall.command`。默认只删除程序，保留用户数据。

### Windows

1. 双击 `install.cmd`，默认安装到 `%LOCALAPPDATA%\Programs\Skill Designer`。安装器先完整校验解压源且只接受 Windows 包，再复制到 staging。
2. 进入安装目录并双击 `start.cmd`。
3. 卸载时双击安装目录中的 `uninstall.cmd`。默认只删除程序，保留用户数据。

双击入口只是快捷方式，与下面的 Node 命令等价，并原样返回底层命令的退出码：

- `diagnose`、`install`、`uninstall` 是一次性命令，无论成功还是失败都会停在“按回车键关闭...”，方便直接在 Finder 或资源管理器中查看完整结果。
- `start` 是常驻服务，正常结束时直接关闭窗口；只有启动失败时才会停下显示原因。

跨平台命令入口始终可用：

```bash
node bin/skill-designer.mjs
node bin/skill-designer.mjs --no-open
node bin/skill-designer.mjs --port 4315
node bin/skill-designer.mjs --data-dir /absolute/private/data
node bin/doctor.mjs
```

启动器会从 `4310-4399` 选择首个空闲端口，并只调用探测到的 Google Chrome 打开页面，不会改用系统默认浏览器。未找到 Chrome 时普通启动会明确失败；`--no-open` 只跳过自动打开并启动本地服务，用户仍需使用 Chrome 访问命令输出的本地地址。关闭启动命令所在终端会停止本地服务，但不会删除数据。

默认数据目录：

- macOS：`~/Library/Application Support/Skill Designer`
- Windows：`%LOCALAPPDATA%\Skill Designer`

卸载默认保留此目录。只有明确执行 `node bin/uninstall.mjs --delete-data` 并在终端确认时才会删除程序和全部本地数据。删除前应先备份数据目录以及所有 in-place Skill 仓库。

## 4. 第一个项目闭环

1. 启动后点击“创建 Workspace”，填写一个工作区名称。
2. 选择“导入 Skill”并指定现有 Skill 根目录。Studio 先只读扫描，不执行其中的脚本。
3. 检查识别出的身份、文件清单、引用、候选图和诊断；确认后才把内容写入 Studio 管理副本。
4. 在图谱页检查入口、节点类型、流程边和 Lint；2D/3D 只是同一图事实的不同视图。
5. 在文档页修改 Markdown，或在图谱页编辑节点和文档绑定。每次修改都先生成 ChangeSet 和 diff，用户确认后才推进 revision。
6. 在测试页创建一次手动运行，检查节点路径、Trace 和终态。非法下一节点会被记录并保持当前状态，不会自动修图。
7. 对已结束运行生成脱敏 Bug Report，检查导出预览后再下载；可把报告加入诊断并按证据生成待确认修复提案。
8. 在“通用导出”中预览并确认 ZIP，使用包内 `engine/skill-engine.mjs verify` 校验，再交给能读取文件、运行 Node CLI 和处理 JSON 的外部 Agent。

这条流程中的导入确认、编辑确认、报告确认和导出确认是四个独立动作，任何一步都不会替用户自动接受下一步。

## 5. Workspace 与 Skill Project

- Workspace 是组织容器，可以同时列出和切换多个 Skill。
- Skill Project 是 1.0 的编辑、revision、运行、报告、Benchmark 和导出原子边界。
- 每个 Skill 使用稳定 `skillId`，名称和磁盘路径只用于展示或定位。
- Workspace 切换不会把一个 Skill 的运行、报告或 ChangeSet 转移给另一个 Skill。
- 1.0 不执行跨 Skill 联合图谱、联合运行或跨项目原子修改；这些能力属于 2.0。

## 6. Skill 项目格式

一个可执行 workflow Skill 至少包含：

```text
SKILL.md
skill.json
graph/main.json
```

可选内容包括项目内任意安全相对路径的 Markdown、`benchmarks/cases/*.json`、资产、配置和脚本。Markdown 不要求集中在 `docs/`；符号链接、项目外路径、Windows 保留名、大小写冲突和不安全相对路径会被拒绝。

`content-only` Skill 可以没有可执行流程图；Studio 会提供文档和资产管理能力。节点行为由类型注册表决定，不按节点名称猜测。

## 7. 导入方式

- “原地打开”保留原仓库路径，适合已经受 Git 管理的 Skill。确认后的修改会写回该 Skill，但 Studio 私有运行数据仍在应用数据目录。
- “导入 Skill”先只读扫描源目录，确认后创建 Studio 管理副本；源目录不会被修改。
- 静态解析结果是候选事实，必须人工审阅。
- LLM 辅助解析需要 Provider，只能读取冻结清单内的有限文本；结果仍是候选并继续走确认流程。

## 8. ChangeSet、Revision 与 Git

所有图、文档、用例、Skill 信息和资产修改都必须经过 ChangeSet 预览。确认时如果 base revision 或文件事实变化，旧提案进入冲突状态，不自动合并。版本历史支持设置人工已阅 baseline 和撤销最近提交，撤销本身也要再次确认。

Git 对比是只读能力，可比较 HEAD、commit 或 tag 到当前工作树；Studio 不替用户执行 commit、checkout、reset 或 push。

## 9. 调试、Trace、报告与诊断

手动运行从已确认 revision 创建不可变 RuntimeArtifact。运行期间继续编辑项目不会改变该次运行。Trace 是实时亮灯、回放、运行对比、Bug Report 和诊断的统一事实源。

Bug Report 导出前必须选择脱敏级别并检查预览。即使关闭可选脱敏，密钥、密码、令牌和授权字段也不会导出。诊断展示事实症状、候选原因、限制和验证建议；修复只能形成 ChangeSet，不能自动写入项目。回放有助于定位，但不能证明修复成功；必须创建修复版本的新运行。

## 10. 真实 Benchmark

Benchmark 必须同时满足：

- 已确认且 lint 有效的 ready 用例；
- 可用的真实模型 Provider；
- Docker Desktop 本机 Linux containers 后端；
- 配置固定 digest 的 runner 镜像；
- 沙箱生命周期自检通过。

每次真实 Benchmark 都必须产生实际模型调用和 token 用量。Docker、模型或镜像缺失时页面会记录 `blocked/not-run`，不会降级到宿主执行，也不会把零 token 的确定性测试称为 Benchmark。自动断言和用户人工判定分别保存；工具不替用户判断 Skill 是否适合最终业务。

## 11. 通用导出

1.0 每次只导出一个 Skill Project。导出 ZIP 包含项目文件、`export-manifest.json` 和零 npm 依赖的 `engine/skill-engine.mjs`。外部 Agent 至少需要 Node 20，并先运行：

```bash
node engine/skill-engine.mjs verify
node engine/skill-engine.mjs inspect
```

外部运行状态写入调用方指定的包外状态文件。通用引擎不执行包内脚本、不访问网络、不自动修图，也不提供 Claude/Codex 专用安装方式。

## 12. 备份与故障诊断

- 定期备份默认数据目录；in-place Skill 还要按原仓库方式备份或提交 Git。
- 程序升级只替换安装目录，不应删除数据目录。
- 启动失败先运行 `doctor`，检查清单 mismatch、Node 版本和写权限。
- 端口被占用时启动器会自动换端口；显式 `--port` 被占用时会直接报错。
- Benchmark 不可用时在测试页检查 Provider、Docker context、固定镜像和沙箱自检，不要用宿主命令替代。
