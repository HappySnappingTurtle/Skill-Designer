# Skill Designer 1.0 已知限制

> 状态日期：2026-08-01。当前仓库版本为 0.1.0 开发预览，不应标记为 1.0 正式发布。

## 尚未完成的发布门禁

- Windows 浏览器、异常退出恢复和安装/卸载按当前计划暂缓，尚未取得真实 Windows 操作证据。GitHub Actions run `30689522606` 的 Windows Node 20 Job 成功和 Windows ZIP 构建只证明自动化门禁，不替代这些实机验收。
- 当前 macOS 环境没有 Docker CLI、固定 digest runner 镜像和真实模型 API Key，因此真实沙箱 Benchmark、completed 人工判定和 post-repair Benchmark 尚未完成。
- 三个真实 Skill 已在同一 Workspace 完成 workflow/content-only 产品链路验收，但没有真实 Docker 与模型条件，因此不能把这些确定性运行称为真实沙箱 Benchmark。
- Generic Export 已由当前 Codex 使用导出目录外状态文件完成 clean-room 运行，最终 ZIP SHA-256 为 `ba73c8965f18028a1adf45b696e7ce05bc39623a95b39a874e19455ff83271c4`。Claude CLI 返回 `403 Request not allowed`，独立 Codex CLI 在首轮模型采样阶段超时，均未形成独立外部 Agent 成功记录；另缺 Windows Node 对照。
- macOS ZIP 未做 Apple 签名/公证，Windows ZIP 未做 Authenticode 签名。`release-manifest.json` 和 `doctor` 已把当前产物严格声明为 `development-preview / unsigned / integrity-only / local-development`，并明确 `publisherTrustEstablished: false`；发布 SHA-256 和包内逐文件清单仍只检查完整性，不建立发布者身份信任。正式签名发布链仍是未完成门禁。

## 1.0 产品边界

- Studio 界面只提供中文。
- 仅支持单人本地使用，不提供团队权限、协作、云同步、市场或签名信任体系。
- Workspace 用于组织多个 Skill，但所有 ChangeSet、revision、运行、报告、Benchmark 和导出仍绑定单一 Skill Project。
- 不实现跨 Skill 依赖执行、联合图谱、联合 RuntimeArtifact、联合运行或跨 Skill 原子修改。
- 只实现核心有向 workflow 与 content-only；元模型、文档关系图、知识语义图和项目级自定义类型属于 2.0。
- 不生成 Claude、Codex 或其他 Agent 的专用 Skill 适配格式，只提供通用导出包。
- 不自动修复用户 Skill，不自动改图，也不为非法下一节点选择“回归路线”。工具只分析证据、给出建议并形成待确认 ChangeSet。
- 完整项目格式迁移系统不在 1.0；未知字段会尽量无损往返，但不因此获得执行语义。

## 运行与安全边界

- Studio 只观察经过自身引擎、对话框和沙箱的行为，无法记录外部 Agent 绕过 Studio 的过程。
- API Key 优先来自环境变量，也可写入系统凭据后端；读取接口不会返回明文。用户仍需管理 Provider 账户与费用。
- 真实 Benchmark 必然使用模型 token。工具限制重复上下文、自动重试和最大步数，但不承诺零 token。
- Docker 不可用、context 远程、非 Linux containers、固定镜像缺失或自检失败时，Benchmark 必须阻断，不会降级为宿主进程。
- 诊断候选不是已证实根因；Bug Report 回放也不是修复成功证明。
- 通用导出包的清单校验用于检查文件完整性，不替代发布签名，也不能防御攻击者同时替换 CLI 与清单。

## 规模基线

1.0 的本机目标是单 Skill 500 节点、100 文档和 Workspace 50 成员。当前 macOS 专项已经覆盖该规模；超出规模并不保证同等交互延迟。大图 3D 渲染依赖浏览器和 GPU，狭窄移动端默认使用 2D。
