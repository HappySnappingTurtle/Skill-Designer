# T39 macOS 专项验收矩阵

## 1. 范围

本矩阵记录 Skill Designer 1.0 在 macOS arm64、可见 Google Chrome 上已经执行的非功能验收，并补充远端 Node 20 三系统 CI 状态。它不替代 Windows 浏览器和 Windows 异常退出实机验收。

共同要求：浏览器使用 `channel: "chrome", headless: false`；桌面流程必须实际操作页面；移动端使用 `390x844`；除用例明确预期的安全拒绝外，控制台错误和失败请求必须为 0。

## 2. 当前结果

| 能力 | 当前矩阵 | 结果 | 结构化证据 |
| --- | --- | --- | --- |
| Workspace 多 Skill | 50 个成员：25 workflow、25 content-only；49 ready、1 missing；首/中/末搜索、切换、刷新持久化、图谱/文档页身份 | 通过。首屏 744ms，搜索 8–12ms，切换 56–111ms；390px 无溢出或身份串线 | `.skill-designer-dev/chrome-artifacts/workspace-scale-50/verification.json` |
| 单 Skill 大图 | 500 节点、499 边；2D/3D 非空像素、搜索、筛选、关系、缩放和平移 | macOS 通过 | `.skill-designer-dev/chrome-artifacts/graph-scale-500.json` |
| 单 Skill 文档 | 100 篇关联文档加 `SKILL.md`；列表、首/中/末搜索和正文打开 | macOS 通过 | `.skill-designer-dev/chrome-artifacts/document-scale-100.json` |
| 成员路径隔离 | 加入后把项目文档替换为项目外符号链接；页面读取和 Store 读取均拒绝，外部正文不进入 DOM | 通过。预期文档请求为 403；额外失败请求为 0 | `.skill-designer-dev/chrome-artifacts/local-security-verification.json` |
| 本地服务边界 | 恶意 Origin、恶意 Host、缺少令牌、2 MiB 超限请求 | 通过，状态分别为 403、403、401、413 | `.skill-designer-dev/chrome-artifacts/local-security-verification.json` |
| Bug Report 脱敏 | 严格脱敏预览、JSON、Markdown 下载；模拟密钥不得出现；用户说明被替换 | 通过；JSON 与 Markdown 对应同一 reportId，Markdown 保留完整脱敏 JSON | `.skill-designer-dev/chrome-artifacts/bug-report-history-verification.json` |
| 异常恢复 | 文档重命名的目标写入、源移除、图引用更新三个文件步骤分别真实 `SIGKILL` | macOS 通过；三次均恢复源字节、移除目标、恢复图字节，revision 数不变，journal 记录具体恢复步骤 | `.skill-designer-dev/chrome-artifacts/transaction-file-recovery/verification.json` |
| 发布包完整性与平台 | macOS 安装源/staging 各 3599 个文件与清单精确一致；错平台安装、清单外文件、符号链接和特殊文件拒绝；共享规则探测 Google Chrome，未找到时诊断硬失败且启动器不降级到默认浏览器；安装产物启动可见 Chrome 完成真实 Skill 页面闭环 | macOS 通过；`platformMatchesRuntime=true`、`chrome.found=true`，清单外文件与链接测试返回稳定错误，源 Skill 不变，浏览器/服务清理成功 | `.skill-designer-dev/chrome-artifacts/release-package/verification.json` |

## 3. 平台状态

| 平台 | 浏览器业务矩阵 | 异常退出矩阵 | 指纹/引擎/导出一致性 |
| --- | --- | --- | --- |
| macOS arm64 | 当前表内项目通过 | 三个文档重命名文件步骤通过 | 本机门禁通过；GitHub Actions run `30689522606` 的 macOS Node 20 Job 全部通过 |
| Windows | 按用户决定暂缓 | 待执行真实进程终止与文件恢复 | GitHub Actions run `30689522606` 的 Windows Node 20 Job 已完成依赖安装、Lint、Typecheck、198 项测试（4 项平台预期跳过）、应用构建和发布构建；不等同于浏览器实机验收 |
| Linux | 不属于 1.0 桌面 UI 正式平台 | 不要求桌面异常恢复 | GitHub Actions run `30689522606` 的 Ubuntu Node 20 Job 全部通过 |

## 4. 未完成条件

T39 保持进行中，直至：

1. Windows 主流浏览器完成与 macOS 对照的核心业务、500 节点、100 文档和 50 成员 Workspace 验收；
2. Windows 完成事务异常退出与恢复矩阵。

远端 Linux、macOS、Windows CI 对核心引擎、Generic Export 和固定指纹向量的条件已由 run `30689522606` 关闭。T39 仍保持进行中，CI 成功和 Windows ZIP 构建均不得替代上述两项真实 Windows 操作证据。

任何未执行项均不得用模拟平台结果替代。
