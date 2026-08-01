# Skill Designer 1.0 - TODO

> 执行计划版本：v1.0
> 日期：2026-07-27
> 依据：《Skill Designer 1.0 - 产品设计文档》《Skill Designer 1.0 - 系统架构设计文档》

---

## 0. 执行规则

1. 按优先级和依赖关系推进，不以界面完成代替业务闭环完成。
2. 每个任务编码前必须明确：输入、输出、异常、验收用例和不在范围内的内容。
3. 每个任务至少包含单元测试；跨包任务补集成测试；用户流程补端到端测试。
4. 所有项目修改统一形成 `ChangeSet`，经预览、确认后事务提交。不得为某个入口另开直接写文件通道。
5. 所有运行、回放、报告和诊断统一基于 `ExecutionTrace`，不得分别维护互不兼容的事件格式。
6. 内部确定性测试只验证工具正确性，不称为 Skill Benchmark，也不进入用户 Benchmark 成绩。
7. 真实沙箱 Benchmark 排在业务能力、Trace、Bug Report 和诊断之后开发。
8. 每完成一个阶段，使用用户提供的真实 Skill 做一次阶段验收，及时修正抽象。

任务状态约定：`[ ]` 未开始，`[~]` 进行中，`[x]` 已完成，`[!]` 阻塞。

---

## P0 基础契约与安全底座

### T01 [x] Monorepo 与跨平台测试基建

- **目标**：建立 `engine`、`server`、`web` 的明确边界和统一工程入口。
- **输出**：workspace 配置、TypeScript 配置、构建/测试/lint 脚本、Windows/macOS CI、包含多个 Skill 的最小示例 Workspace。
- **验收**：Windows 与 macOS 均可执行安装、构建和测试；`engine` 不依赖浏览器或 server。
- **完成情况**：已建立 npm workspace、统一 build/test/typecheck/ci 入口和基于 TypeScript AST 的包边界 lint；门禁要求 engine 零运行时依赖且只引用自身模块、web 不依赖 Node/server、server 不反向依赖 web。`.github/workflows/ci.yml` 使用 Node 20 的 Linux/macOS/Windows 独立矩阵，依次执行公开 npm registry 的 clean install、边界 Lint、Typecheck、测试、应用构建和发布构建；承载 action 使用官方 `actions/checkout@v7`、`actions/setup-node@v7`。仓库级 `.npmrc` 固定 `registry.npmjs.org`，lockfile 的版本、integrity 和依赖图不变且不再引用本机私服；TypeScript/Vitest CLI 使用根依赖固定路径，Windows 异步文件替换与测试临时目录清理具备有限重试。仓库新增包含 workflow 与 content-only 两个独立项目的 `examples/multi-skill-workspace`，稳定 skillId 不重复，图与文档引用通过确定性测试。可见 macOS Google Chrome 已从空数据目录在页面创建 Workspace、两次原地打开、切换两个 Skill、查看两张 2D 图和 390px 文档页；Canvas 均有非空像素且取景不贴边，源文件 hash 前后一致，控制台错误和失败响应均为 0。证据在 `.skill-designer-dev/chrome-artifacts/example-workspace/verification.json`。GitHub Actions run `30689522606` 在提交 `6b9cce8` 上形成可追溯三系统成功记录，Linux、macOS、Windows 均完成全部六项门禁；本机 clean-room 亦从空 `node_modules` 完成 30 个测试文件、201 项通过、1 项平台专属跳过及双平台发布构建。本项验收完成。

### T02 [x] Workspace、Skill Project 清单与可扩展图 Schema

- **目标**：定义 `Workspace -> Skill Project` 层级和 1.0 Skill 文件事实源，支持 `workflow` 与 `content-only`。
- **输出**：Workspace 私有 manifest、带稳定 skillId 的 Skill manifest、workspaceId/projectId/skillId/nodeId 身份规则、`nodes + edges` Schema、类型注册和未知字段保留规则。
- **验收**：同一 Workspace 可引用多个不同仓库 Skill；重命名或移动目录不改变 skillId；重复 skillId 被阻止；节点行为按类型而非名称或固定 ID 决定。
- **完成情况**：Workspace 私有清单、单 Skill Project 边界、稳定 workspaceId/projectId/skillId/nodeId 语义及 workflow/content-only 图 Schema 已落地，并由多 Skill 生命周期、重复 skillId、路径修复和 Shell 身份验收覆盖。Engine 以 `graphNodeTypeRegistry/graphEdgeTypeRegistry` 作为核心类型单一事实源，图 lint、Runtime、解析器、Generic Export 和 Web UI 均从注册表读取；注册项具有显式 plane、runtimeRole、executable 和 directional 语义，未知类型由 lint 阻断，不按名称执行。节点、边、图顶层与 manifest 的未知 JSON 字段在读取、ChangeSet 编辑、确认和导出中保留；单节点或边的未知字段与 `extensions` 合计限制 64 KiB，有损或非普通 JSON 被拒绝。项目级类型注册和 `graph/_extensions.json` 已按产品决策归入 2.0，不属于本项未完成内容。全仓 28 个测试文件、161 项测试、类型检查和生产构建通过；可见 Google Chrome 已实际搜索并编辑带扩展字段的节点、打开 diff、确认应用、刷新页面，再从磁盘验证 manifest、图、节点和边扩展数据逐项不变；2D Canvas 非空，390px 页面无文档横向溢出，控制台错误和失败请求均为 0。证据在 `.skill-designer-dev/chrome-artifacts/schema-preservation/verification.json` 及三张截图。

### T03 [x] 条件 DSL 与运行变量契约

- **目标**：定义可校验、可解释、不可执行任意代码的分支条件。
- **输出**：条件 AST/Schema、变量命名空间、求值器、错误码和单元测试。
- **验收**：相同输入产生相同结果；非法表达式在加载期被拒绝；条件中不存在动态代码执行。
- **完成情况**：Engine 已实现封闭的结构化 Condition AST，支持 `boolean/not/equals/notEquals/contains/and/or`，操作数只允许 JSON 标量、最多 100 项的标量数组，以及安全的 `skill.* / runtime.*` 嵌套引用。校验限制 32 层嵌套和 100 个组合子条件，拒绝未知操作符、每种 AST/操作数不属于白名单的附加字段、非有限数字、原型链关键段和不安全命名空间；不存在 `eval`、`Function`、脚本字符串执行或动态属性继承。纯求值器只用自有属性读取，缺失/类型不匹配按确定语义返回，重复求值不修改两个变量命名空间。图加载、Graph ChangeSet 预演/确认、Studio 编辑器、Runtime 和通用导出 CLI 使用同一校验与求值语义，错误包含稳定 code 和精确字段 path。全仓 26 个测试文件、152 项测试、类型检查和生产构建通过；可见 Google Chrome 已在图编辑器提交含隐藏 `script` 字段的已知组合条件并看到 `condition_field_unknown` 拒绝，确认 active revision 未变化；随后保存同时引用 `skill.tags` 与 `runtime.currentNodeId` 的合法条件，经 ChangeSet 确认后在测试页分别运行 false/true 两组输入，验证直达终点出口隐藏/显示及真实一步完成。390px 页面无横向溢出，控制台和失败请求均为 0。证据在 `.skill-designer-dev/chrome-artifacts/condition-contract-verification.json` 及三张对应截图。

### T04 [x] ChangeSet 与预览契约

- **目标**：让手工编辑、解析、LLM 助手和诊断建议共享同一种修改提案。
- **输出**：绑定单一 workspaceId/projectId/skillId 的 ChangeSet Schema、操作类型、来源/证据字段、前置 revision、冲突模型、lint 和 diff 生成器。
- **验收**：ChangeSet 本身不改变 active 项目；跨 projectId 操作、身份不一致、过期 revision、无效引用和越界路径能被稳定识别。
- **完成情况**：已实现绑定单 Project 的白名单图、文档、BenchmarkCase、Skill 信息与项目资产操作、隔离预演、lint/diff、`digest + baseRevision` 确认及同身份拒绝。资产域只接受跨 Windows/macOS/Linux 可移植的 `assets/**` 路径和最大 2 MiB 的规范 Base64；`asset.copy` 自动区分新增/替换，`asset.delete` 在预览中列出 Markdown 引用文件、行号和原目标，但不自动改写用户文档。二进制字节不复制进 preview，只展示类型、大小和 SHA-256；确认时重新核对目标字节与引用事实，再以二进制原子写入、Snapshot、Revision 和事务回滚提交。`skill.update` 仅允许名称、版本和说明，稳定 skillId、能力与入口受保护。拒绝持久化 `rejectedAt/rejectionReason`，不推进 revision，且原 ChangeSet 不能再次确认；关闭预览或返回编辑不改变提案状态。冲突持久化 code、说明、原/当前 revision 和可选结构化 details，并通过新 ChangeSet 重新预演，旧冲突记录保持终态。来源/证据统一进入 Schema、持久化和 digest；来源仅用于追溯，不作为授权或已验证证明。全仓 27 个测试文件、156 项测试、类型检查与生产构建通过；可见 Google Chrome 除既有图谱、文档、BenchmarkCase、诊断和 Skill 信息流程外，已实际选择 PNG、修改目标路径、拒绝并验证未落盘、再次确认上传、读取非零图片像素、预览 Markdown 引用、确认删除并检查 390px 布局，控制台和失败请求均为 0。资产证据在 `.skill-designer-dev/chrome-artifacts/project-assets/verification.json` 及对应截图。

### T05 [~] 事务写入、Revision、Snapshot 与 Baseline

- **目标**：建立确认后原子提交、失败回滚和人工已阅基线。
- **输出**：单 Skill 项目锁、事务日志、临时文件原子替换、revision 计算、Workspace/Project 分离的 Studio 私有数据目录、snapshot/baseline、撤销最近提交。
- **验收**：中途失败时项目文件字节不变；确认提交只产生一个新 revision；baseline 不会绕过 ChangeSet 确认。
- **当前进度**：已实现确认提交的文件/状态回滚、完整项目 Snapshot、parent revision 链、逐文件 hash、初始与人工已阅 Baseline、精确 `revisionId + snapshotId` 确认、版本历史/基线差异页面，以及基于父 Snapshot 的“撤销最近提交”。撤销先生成 `project.restore` ChangeSet，预览完整文件差异；确认时逐文件校验当前/目标 Snapshot 和 live 工作树，恢复失败会回滚当前 Snapshot，成功后生成新的 `source: undo` revision 而不改写旧历史。图、文档、BenchmarkCase、二进制资产和完整项目恢复确认路径已统一写入持久化事务 journal，记录 `prepared -> files-written -> revision-captured -> state-committed -> completed`；启动时会核对项目字节、revision 和 state 的耐久事实，能完成已实际提交的 journal，或恢复 base Snapshot、移除半成品 revision 并把 ChangeSet 标记为冲突。文档重命名进一步在 `prepared` 阶段记录目标写入、源文档移除和图引用更新三个 `fileMutation`，恢复后保留 `recoveredFromFileMutation` 用于审计与页面展示。全仓 28 个测试文件、164 项测试、类型检查和生产构建通过；macOS 下两套可见 Google Chrome 脚本分别在 `files-written` 和三个逐文件步骤真实 `SIGKILL` 子进程，先验证半落盘字节，再重启 Store 验证源文档、目标文档、图字节、active revision、revision 数量、ChangeSet 和 journal，并实际操作版本历史、文档搜索和 `390 x 844` 页面，控制台错误与失败请求均为 0。证据在 `.skill-designer-dev/chrome-artifacts/transaction-recovery.json` 和 `.skill-designer-dev/chrome-artifacts/transaction-file-recovery/verification.json`。尚缺真实 Windows 异常退出矩阵，因此保持进行中。

### T06 [x] RuntimeArtifact 与内容指纹

- **目标**：运行时冻结不可变输入，避免编辑中的项目污染测试和回放。
- **输出**：绑定 workspaceId/projectId/skillId 的单 Skill RuntimeArtifact Schema、文本归一化/二进制原始字节 hash、编译器、artifact 存储和过期清理策略。
- **验收**：运行开始后切换 Workspace 当前 Skill 或修改项目不影响本次运行；同一内容在三系统得到一致指纹；1.0 不生成联合 Artifact。
- **完成情况**：普通运行与 Benchmark 已统一从 active revision 的不可变 Snapshot 生成单 Skill RuntimeArtifact，并冻结图、内容 hash 与初始变量。运行指纹使用 `sha256(projectContentHash + canonical initialVariables)`：对象键排序后序列化，因此同一 JSON 输入不受键顺序影响，输入变化或项目内容变化都会产生不同总指纹；旧 Artifact 读取保留兼容回填。Workspace 内切换 Skill 和 active revision 漂移均不改变既有运行，页面可查看项目内容 hash、输入 hash、冻结输入、当前输出和最近模型回执。Artifact 存储现采用显式清理和固定 7 天孤立宽限期，同时保护普通 Run 与 Benchmark 的结构化引用；损坏、身份不一致和引用缺失只告警，不自动删除或修复，清理前逐文件复核身份和时间，且不生成 Skill ChangeSet。测试工作台提供存储统计、完整性告警和明确清理入口；可见 macOS Google Chrome 已验证 `3/2/1/1 -> 2/2/0/0`、普通 Run/Benchmark Artifact 保留、孤立 Artifact 删除、390px 无溢出，控制台错误和失败请求均为 0，证据在 `.skill-designer-dev/chrome-artifacts/runtime-artifact-storage/verification.json`。含中文、CRLF 和对象键重排的固定指纹向量已在 GitHub Actions run `30689522606` 的 Linux、macOS、Windows 三个 Node 20 Job 中全部通过；同一内容三系统一致性已有可追溯远端证据，本项验收完成。

### T07 [x] ExecutionTrace 基础契约与存储

- **目标**：先建立统一事件事实源，为后续实时亮灯、回放、报告和诊断复用。
- **输出**：含 workspaceId/projectId/skillId/artifactId 的事件信封、事件类型注册、递增序号、运行/节点/工具/模型事件、trace store、脱敏钩子。
- **验收**：事件可按 `runId + seq` 幂等读取；同时运行多个 Skill 不串线；未知事件类型可保留；敏感字段不会默认进入 Trace。
- **完成情况**：已实现 `schemaVersion: 1.0` 的 RuntimeArtifact、ProjectRun 与事件信封，事件含 run/workspace/project/skill/artifact 身份和递增 seq；独立 TraceStore 按 projectId/runId 保存私有 NDJSON 追加日志，批次追加后 fsync，并在读取时验证身份、连续序号及与 Run 兼容事实的一致性。旧 Run 仍保留事件镜像用于兼容和异常恢复；日志缺失、截断或偏离时只从已原子持久化的 Run 重建，不能反向改写运行状态。`afterSeq` 幂等补拉、断线续传、三 Skill 隔离和同一 reducer 投影均已实现。集中 `traceEventRegistry` 注册 engine、condition、document、context、conversation、llm/model、tool、sandbox、benchmark、assertion、review 的当前事件类型，并为每类声明 domain、默认敏感级别和可分发结构字段；未知类型保留信封、计入 unknown，但默认报告不导出未知 data。Bug Report 的 default/strict 脱敏直接读取注册表字段，off 仍受禁 Key 规则约束。Runtime 对话和真实 Benchmark 在实际使用条件、文档上下文和声明式查询时写入聚合 `condition.evaluated`、无正文 `document.context` 和无结果正文 `context.queried`。单元、TraceStore/HTTP 与可见 Chrome 已验证注册事件不改变图状态、未知事件前向兼容、结构字段保留、自由内容移除、条件/文档/查询事件持久化和报告投影；Chrome 控制台与失败请求为 0。

### T08 [x] 本地服务安全边界

- **目标**：在完整沙箱之前先实现不可省略的本地安全。
- **输出**：仅 loopback 监听、随机会话令牌、Origin 校验、Workspace 成员逐目录授权、项目根限制、路径规范化、符号链接逃逸检查、上传限制。
- **验收**：加入同一 Workspace 不会获得其他成员或共同父目录权限；跨项目路径、目录穿越、非授权请求和恶意符号链接均被拒绝；导入脚本不被执行。
- **完成情况**：本地服务只由启动脚本绑定 `127.0.0.1`，HTTP 与 Trace WebSocket 统一校验本机 Host、精确 Origin 和每次启动生成的随机会话令牌；除会话交换外的 API 均要求令牌，请求体、导入文件数量、单文件和总字节受限，导入脚本只作为文件清点且不存在执行路径。Workspace 只通过不透明 projectId 访问逐成员授权根，项目路径拒绝绝对路径、`..`、Windows 保留名、大小写冲突和跨项目身份。managed-copy、in-place 打开、路径修复、Snapshot 和所有项目读取均拒绝符号链接；原地项目不只在加入时扫描，文档、图、用例、ChangeSet 预演和 Workspace 摘要每次读取前都会从项目根逐级 `lstat`，阻止加入后把文件替换为外部符号链接的 TOCTOU 逃逸。全仓 26 个测试文件、149 项测试、类型检查和生产构建通过；可见 Google Chrome 已实际把已加入项目的 Markdown 替换为项目外链接，页面返回预期 `403` 且外部秘密未进入 DOM，同时验证恶意 Origin/Host、缺少令牌和 2 MiB 超限请求分别为 `403/403/401/413`，390px 页面无横向溢出，额外失败响应与控制台错误均为 0。证据在 `.skill-designer-dev/chrome-artifacts/local-security-verification.json` 及两张对应截图。

---

## P1 核心业务闭环

### T09 [x] Workspace 与多 Skill Project 生命周期 API

- **目标**：支持创建 Workspace，在其中添加、查看、切换和移除多个本地 Skill Project。
- **输出**：WorkspaceService、SkillProjectService、成员摘要、selectedProjectId、排序、`pending-import/ready/missing/error` 状态、`managed-copy | in-place` 模式、重复 skillId 检测、失联修复和错误恢复。
- **验收**：没有已确认 skillId 的 pending 成员不可运行或导出；移除成员或删除 Workspace 默认不删除 Skill 文件；单个成员失联不阻断其他成员；所有 Skill 写操作经 T05，异常退出不静默覆盖用户文件。
- **完成情况**：已实现 Workspace 创建/重命名/切换/删除、成员添加/搜索/选择/排序/移除，managed-copy 新建与静态导入，以及显式绝对路径授权的 in-place 打开。成员摘要区分 `pending-import/ready/missing/error`，单成员失联不阻断其他成员；pending 或异常成员不能进入图谱、运行、版本、Git 和导出。重复 skillId 被阻断；原地打开和路径修复均解析 realpath、要求完整有效格式、限制 2000 文件/128 MiB 并拒绝内部符号链接。失联修复只接受 in-place 成员，必须精确匹配原 skillId、通过图 lint，且目录内容 hash 必须等于当前 Revision，工具不自动修改用户目录。移除成员和删除 Workspace 均只删除 Workspace 引用，managed-copy/in-place 源文件及项目状态、Snapshot、Revision 历史保持不变。Store/HTTP 定向测试与全仓 25 个测试文件、142 项测试通过；可见 Chrome 已实际完成正常/失联成员并存、排序与刷新持久化、路径修复、重命名、390px 布局、删除后切换和四项文件保留检查，控制台错误与失败响应均为 0。证据在 `.skill-designer-dev/chrome-artifacts/workspace-lifecycle-verification.json` 及三张对应截图。

### T10 [x] 图加载、校验与运行引擎

- **目标**：完成有向工作流的确定性运行核心。
- **输出**：图加载器、入口/终点、合法下一节点、条件分支、状态更新、暂停/继续/终止、结构化错误和 CLI。
- **验收**：模型提交不允许的下一节点时保持当前状态、记录拒绝事件并返回原因；引擎不替用户自动改图或自动改走其他路线。
- **完成情况**：Engine 已实现 Schema/身份/类型/端点/入口/可达终点/Condition AST 加载校验，工作流从 `entry:start` 建立确定状态；合法出口只取当前节点的非 knowledge 出边并按 `skill.* / runtime.*` 安全条件求值。`advance/pause/resume/stop` 均返回 `accepted + state + allowedTransitions + events + rejection`，非法跳转追加带稳定 code、requestedNodeId 和 allowedNodeIds 的 `engine.reject`，只递增事件序号，不改变当前节点、step 或变量；服务端原子持久化 Run 与独立 Trace，并在 HTTP 响应中返回 `commandResult.accepted/eventSeqs/rejection`。页面展示当前节点、合法出口、结构化错误码和“不自动修复或改走其他路线”的明确说明。通用导出包的零依赖 Node 20 CLI 支持 `inspect / transitions / run start|status|next|pause|resume|stop`；本轮修正了 CLI 曾把 Studio 的 `skill.* / runtime.*` 条件错误地按裸变量求值的问题，并加入与 Studio 对齐的加载期图和安全 Condition 校验。全仓 25 个测试文件、144 项测试、类型检查及生产构建通过；可见 Chrome 实际完成条件禁用目标拒绝、状态不动、合法完成、暂停/继续/停止和 390px 页面验收，控制台错误与失败响应均为 0。证据在 `.skill-designer-dev/chrome-artifacts/runtime-engine-verification.json` 及两张对应截图。

### T11 [x] 声明式查询与精确文档切片

- **目标**：节点可按声明引用项目事实和精确文档片段。
- **输出**：查询原语、标题路径切片、锚点解析、缺失/歧义诊断、引用追踪。
- **验收**：同名标题可由完整标题路径区分；找不到切片时明确失败或降级，不静默返回错误内容。
- **完成情况**：Engine 新增版本化 `ProjectFactQuery`，节点可声明 `graph.node / graph.neighborhood / graph.search / document.slice` 四类项目事实查询；每条查询具有稳定 queryId，图 Lint 校验类型、数量、ID、方向、过滤、结果上限和安全文档路径，ChangeSet 服务端重解析后才允许确认。查询执行顺序稳定且搜索最多返回 20 项；节点结果剔除其 `lookup` 声明，避免递归重复上下文和 token 浪费。Markdown 切片支持完整标题路径、`#anchor`、重复标题锚点编号、ATX/Setext、Frontmatter 与代码围栏排除；默认只做精确匹配，只有声明 `fallback: title` 才允许按末级标题降级，唯一命中返回 `degraded + requestedAnchor/resolvedPath`，多命中返回全部候选并保持 `ambiguous`，缺失保持 `missing`，从不静默选择第一项。普通 Runtime 与真实 Benchmark 都只从冻结 revision 读取查询文档，将有界结果注入模型；手动运行页展示 found/empty/degraded/ambiguous/missing 及真实片段。`context.queried` Trace 只记录 queryId、类型、状态、结果字符数和降级路径，不复制正文。全仓 26 个测试文件、148 项测试、类型检查与生产构建通过；可见 Google Chrome 实际完成 7 条查询的页面配置、ChangeSet 确认、冻结运行、精确/降级/歧义/缺失展示、模型上下文、Trace 和 390px 操作，文档宽度 390，控制台错误与失败响应均为 0。证据在 `.skill-designer-dev/chrome-artifacts/declarative-context-verification.json` 及三张对应截图。

### T12 [~] 中文桌面式 Web 外壳

- **目标**：提供面向开发者的工作台，而不是营销页面。
- **输出**：工作区/图谱/文档/测试/诊断五个主导航、Workspace 多 Skill 摘要、当前 Skill 切换器、成员状态、错误边界和首次创建/导入流程。
- **验收**：Windows 和 macOS 主流浏览器可用；无需离开工作区即可看到多个 Skill 并切换；所有业务页明确显示当前 skillId/名称，失联成员不破坏页面。
- **未来兼容约束**：成员总览的数据模型需允许 2.0 增加跨 Skill 依赖摘要（满足、缺失、版本不兼容、目标异常），1.0 不展示虚假的依赖结果。
- **当前进度**：工作区顶栏、图谱、文档、测试三种模式与内容型空状态、诊断页已统一显示当前 Skill 名称和稳定 `skillId`；名称只用于展示，切换和页面作用域继续由 `projectId + skillId` 确定。可见 macOS Google Chrome 已实际创建包含工作流、内容型和路径失联成员的 Workspace，完成成员切换、五个主页面导航、390px 文档/测试页操作；失联成员未阻断其他成员，控制台错误和失败响应均为 0。图谱步骤真实切换 2D 并执行适应全图，Canvas `1440 × 914` 抽样检测到 2698 个有效绘制像素。证据在 `.skill-designer-dev/chrome-artifacts/shell-identity/verification.json` 及对应截图。Windows 主流浏览器对照尚未执行，因此本项保持进行中，并由 T39 收口跨系统验收。

### T13 [x] 2D/3D 通用图谱查看器

- **目标**：以原始项目的力导向图谱语法稳定展示当前 Skill，而不是把通用图谱做成工作流卡片画布。
- **输出**：同一图数据的 3D 立体/2D 平面模式、缩放/平移/旋转、搜索、节点与边类型筛选、两跳聚焦、节点定位、入边/出边查看、Trace 状态覆盖和大图降级策略。
- **验收**：首次进入桌面默认 3D且可往返切换 2D；两种模式选择与筛选一致；流程边有方向、知识边不成为运行路径；切换 Skill 清空前一 Skill 状态；500 节点两种模式仍可交互且 Canvas/WebGL 像素非空；内容型项目没有伪造流程边；1.0 不生成误导性的跨 Skill 合并图。
- **完成情况**：旧 React Flow 工作流卡片已从主图谱和 Trace 移除。当前图谱直接以 `/Users/hongyuwu/Documents/graph-engine-demo/graph-viewer/index.html` 源码为视觉基准：全窗口径向无限画布、46px 原版顺序单行工具条、210px 搜索框、固定顺序左上类型图例、底部形状校验与 11px 操作提示、右侧 440px/14px 圆角档案、浅深主题，以及同一投影的 3D CanvasTexture Sprite/WebGL 与 2D Canvas 力导向视图。原版搜索、全部/流程面/知识面、关系多选、草稿变更面板、适应视图、节点半径/辉光/标题药丸、边宽/粒子和力参数均保留；草稿新增/修改节点显示原版绿/琥珀角标。模式切换会清除 hover，避免上一投影的悬停对象把新投影错误压暗；单击和搜索的 3D 定位恢复原版以世界原点为基准的径向飞行。沉浸式 Canvas 恢复原版视口高度，12–200 节点的 3D 视图在原版 `zoomToFit` 后校正 ESM 与原版 UMD 三维包围球造成的相机距离差异，稀疏图和 500 节点大图不应用该校正。2D 适应视图继续使用原版 `zoomToFit`，但统一把最终缩放限制在 3.2x，防止只有一两个知识节点时被放大成占满画布的圆块；29/500 节点常规图不触发该上限。工具条标题恢复原版纯名称文本，稳定 skillId 保留在完整悬停提示和 `data-skill-id`，不再挤压原版控件。节点和关系默认打开原版式只读档案，Studio 新增、编辑、批量操作和 ChangeSet 保存从档案或“变更”浮层进入，不污染原版顶栏。导入候选继续复用同一组件。专项可见 Chrome 已实际操作 3D/2D、搜索、节点/关系档案、主题、关系下拉、刷新持久化和 390px 移动页；同数据验收脚本直接从原始页面读取 29 节点/48 边并在当前页面渲染，实测工具栏 46px、搜索框 210px、图例 12px/10px、详情面板 top/right/bottom 为 56/12/12px，3D 首屏覆盖 89.0% 宽与 86.3% 高、2D 首屏覆盖 71.3% 宽与 86.6% 高，控制台错误与失败请求均为 0。默认 3 节点 Skill 额外完成桌面 3D/2D、搜索档案和 390px 移动端验收。500 节点专项仍验证 WebGL2/Canvas 非空像素、拖拽、搜索与筛选。证据保存在 `.skill-designer-dev/chrome-artifacts/force-graph-verification.json`、`original-graph-replica/verification.json`、`example-workspace/verification.json`、`import-review.json`、`graph-scale-500.json` 及对应截图。

### T14 [x] 图编辑器与持续 Lint

- **目标**：支持节点/边创建、修改、删除和校验。
- **输出**：按类型生成的表单、连线编辑、批量修改、问题面板、修复入口、ChangeSet 生成。
- **验收**：编辑只产生 ChangeSet；用户确认后才写入；错误定位到具体节点、边或字段。
- **完成情况**：已实现节点/边创建、修改、删除、显式端点表单、条件边安全 Condition AST 校验、批量节点修改、实时 Lint 计数、字段/节点/边精确定位和自环边确定性草稿修复；所有操作统一生成 Graph ChangeSet，确认前 active revision 和项目图不变。旧版 handle 拖线属于工作流编排器交互，在 2D/3D 通用图谱中取消，改为工具栏建边和节点档案关系入口。可见 Chrome 已在新 3D 图谱中实际完成新增确认节点、两条显式端点连线、条件创建与非法 AST 拒绝、条件再次编辑、空标题错误定位、自环警告定位与修复、双节点批量说明、ChangeSet 预览确认、刷新持久化及 390px 移动弹窗；后端原位检查同时证明确认前仍是 3 节点/2 边，确认后才成为 4 节点/4 边并推进 revision。证据保存在 `.skill-designer-dev/chrome-artifacts/graph-editor-advanced.json` 及三张对应截图。

### T15 [x] 文档管理、编辑与绑定

- **目标**：在项目内管理 `SKILL.md` 和关联 Markdown 文档。
- **输出**：文件树、Markdown 编辑/预览、文档新建/重命名/删除、节点绑定、引用计数、切片预览。
- **验收**：删除被引用文档前明确提示；重命名可通过 ChangeSet 同步引用；100 篇文档可正常检索。
- **完成情况**：已实现 Markdown 文件树、路径检索、编辑/安全预览、新建、重命名和删除、节点 `doc + docAnchor` 绑定、引用计数与精确切片预览。文档管理不再假定 `docs/**`：项目内任意符合三系统共同安全路径规则的 Markdown 均可管理，engine 图 lint、ChangeSet、节点绑定、`document.slice` 和冻结运行复用同一校验；隐藏目录和 `node_modules` 跳过，符号链接不跟随。根级 `SKILL.md` 受保护；`docs.rename` 自动同步节点路径并保留锚点，`docs.delete` 在明确列出受影响节点后清除绑定，文档和 graph 共同进入一个 ChangeSet 的预览、确认、snapshot、revision 与多文件回滚。确认期间源字节、目标占用或图引用变化会标记冲突。存储测试和可见 Chrome 已验证确认前零写入、重命名内容保留、引用同步、删除警告/解绑、路径搜索及桌面/移动布局。100 篇关联文档专项仍满足既有性能阈值；用户真实 MDD Skill 的 223 篇 Markdown 已全部进入文档列表，`references/routing-table.md` 可搜索，证据在 `.skill-designer-dev/chrome-artifacts/real-skill-mdd-import/verification.json`。跨平台总体性能仍由 T39 验收。

### T16 [x] 统一 Diff、Git 对比、确认与撤销界面

- **目标**：让所有来源的修改都经过同一用户确认界面。
- **输出**：ChangeSet 文件/图 diff、只读 Git 工作树与 commit/tag 对比、风险提示、冲突裁决、确认即原子提交、拒绝、最近一次撤销、置 baseline。
- **验收**：Workspace 中每个 Skill 独立显示 Git 状态；用户能区分提案 diff 与仓库 Git diff；Studio 私有运行数据不污染 Git；部分失败不会造成半提交；拒绝不修改项目。
- **完成情况**：已有文档/图/BenchmarkCase/完整项目恢复 ChangeSet diff、确认应用、版本与 Baseline；文档重命名/删除可在一次确认中同时预览并提交文档与图引用差异。通用 ChangeSet 已支持绑定 `changeSetId + digest + baseRevision` 的明确拒绝，图谱、文档、Benchmark 用例和设计助手均提供拒绝动作；拒绝只写 Studio 私有状态，不写项目、不推进 revision，草稿可生成新 ChangeSet，旧提案不可再次应用。版本历史可把最近提交的父 Snapshot 生成恢复预览，确认后新增 `undo` revision；真实 Chrome 已验证拒绝、撤销、刷新和移动布局，证据在 `changeset-reject.json` 与 `revision-undo.json`。

  in-place 项目的 Git 页面现支持 `HEAD`、近期 commit 和 tag 的只读选择，使用规范化 commit OID 比较旧基准到当前工作树的已提交/暂存/未暂存/未跟踪变化，并分别展示文本 patch 与二进制基准/当前大小摘要。Git 命令固定参数与 Skill pathspec，清除继承 Git 环境，禁用 pager、外部 diff、textconv、fsmonitor 和子模块递归；同仓库其他目录不会进入结果。专项可见 Chrome 已实际创建双 commit/tag 仓库，切换 `HEAD/v1.0`、检查两个二进制文件、刷新选择、验证只读说明和 390px 弹窗滚动/层级，证据在 `git-reference-verification.json` 及四张截图。

  诊断修复与报告 Benchmark 候选提供专用拒绝入口，来源记录会根据 ChangeSet 事实同步为 `rejected/conflicted/applied`；修复的提案状态与 `unverified/verified/failed` 验证状态已分离。拒绝不写项目，页面关闭后列表仍显示终态，并允许从原始证据生成新记录和新 ChangeSet。图、文档、BenchmarkCase、设计助手和撤销五个通用确认入口现统一保留冲突弹窗，展示原/当前 revision、稳定冲突 code 和事实说明；用户只能保留当前项目，或创建新 ID、新 digest、新 baseRevision 的 ChangeSet 重新预演，不能自动合并或直接应用。服务端覆盖 revision、文件、图、引用、用例和撤销目标漂移，并持久化 conflict 审计事实。

  全仓 17 个测试文件、88 项测试与生产构建通过。可见 Chrome 使用真实第二个 ChangeSet 抢先推进 revision，亲手确认旧文档提案得到预期 409，检查当前项目零覆盖、桌面/390px 冲突裁决、重新预演的新 diff、第二次确认、并发修改保留和旧冲突记录保留；证据在 `changeset-conflict.json`、`changeset-conflict-desktop.png`、`changeset-conflict-mobile.png` 和 `changeset-conflict-repreview-desktop.png`。至此 T16 验收项完成；T04 的统一来源/证据字段与 T19 的解析候选冲突仍按各自任务继续。

### T17 [x] RuntimeArtifact 调试运行入口

- **目标**：从已确认 revision 创建可追踪的本地运行。
- **输出**：编译/启动/暂停/继续/停止 API、运行列表、当前节点、输入输出查看、Trace 写入。
- **验收**：每次运行绑定 workspaceId/projectId/skillId、唯一 artifact 和 fingerprint；切换当前 Skill 不改变后台运行归属；active 项目变化有明确“需重新构建”提示。
- **完成情况**：已实现运行创建、列表、详情、暂停、继续、停止和确定性下一节点 API；每条运行持久化唯一 run/artifact 身份、冻结 revision、初始变量、项目内容 hash、输入 hash 和总指纹，普通运行与 Benchmark 使用同一指纹生成器。页面“运行事实”可展开查看冻结输入、当前状态输出和最近模型结构化回执；active revision 变化后旧运行继续读取原 Artifact，并显示“使用新版本需要新建运行”，重建动作沿用旧输入但创建新 run、Artifact 和内容绑定指纹。单元测试覆盖 JSON 键序稳定性、输入变化、项目变化与旧运行拒绝语义；全仓 23 个测试文件、123 项测试及生产构建通过。可见 Chrome 实际完成 Workspace 内双 Skill 切换、外部 revision 漂移、显式重建、暂停/继续/停止和 390px 布局验收，第二 Skill 运行数保持 0，控制台与失败请求均为 0；证据在 `runtime-artifact-verification.json` 及三张 `runtime-artifact-*.png` 截图。

---

## P2 导入、辅助开发与通用导出

### T18 [x] 资产清点与静态导入

- **目标**：安全导入现有 Skill，先保全文件再推断结构。
- **输出**：目录清单、格式识别、Markdown/frontmatter 解析、引用扫描、provenance、导入诊断、项目建立前的导入候选（pre-project ChangeSet）。
- **验收**：导入过程零脚本执行；未知文件和字段不丢失；没有可靠流程证据时归类为 `content-only`。
- **当前进度**：已实现 Chrome 目录选择、跨 Windows/macOS 安全路径校验、文件数/单文件/总量限制、逐文件 hash、Markdown/JSON/配置/文本/脚本/资产/未知类型清点、脚本零执行、未知二进制保全、`pending-import`、digest 确认/取消和 managed-copy 入库。服务端使用结构化解析器支持 YAML/TOML/JSON frontmatter，识别名称、说明、版本、许可证、兼容性和 allowed-tools，同时在候选中原样保留未知嵌套字段；扫描所有 Markdown 链接、图片、定义、路径代码和 frontmatter 引用，区分已解析、缺失文件、缺失锚点、外部、无效和越界，既不访问外部 URL 也不读取导入目录之外。格式、名称、说明、能力与图判断均保存 provenance；外部 Skill 无可靠流程证据时仍保守生成单知识节点图。19 个测试文件、99 项测试与生产构建通过；可见 Chrome 已亲手完成目录选择、元数据/引用/provenance 审阅、缺失与越界诊断、配置/文本类型、确认前项目不存在、确认后源 frontmatter 字节不变及 390px 页面验收，证据在 `import-inventory.json`、`import-inventory-desktop.png` 和 `import-inventory-mobile.png`。

### T19 [x] 解析审阅与冲突裁决

- **目标**：让首次非 100% 正确的解析结果可被用户有效确认和修正。
- **输出**：候选节点/边、置信度、来源片段、未决问题、接受/修改/拒绝、重新解析入口。
- **验收**：解析结果在确认前不进入 active 项目；人工修改默认受保护；重解析冲突必须显式裁决。
- **当前进度**：已实现 `static-v2` 原生图/明确 Markdown 流程解析、保守 `content-only` 降级、候选节点与关系、置信度、来源行与片段、未决问题、接受/修改/拒绝、服务端 lint、reviewRevision/digest 乐观锁和冻结源文件重解析。`static-v2` 在原精确标题集合上增加带`快速 / 标准 / 默认`前缀的中文流程标题，仍要求至少两个明确有序步骤；标题写明默认工作流但正文否定流程且无步骤时不会误建有向图。候选审阅复用原项目风格的 3D/2D 力导向图谱；人工修改后重解析形成持久化 `manual-vs-reparse` 冲突，只能显式保留人工版本或采用新解析结果。冲突、未保存修改和 lint error 均阻断确认，确认前项目不存在，确认后写入已裁决图且不改写源 Markdown。engine/store/HTTP 定向测试和可见 Chrome 已实际完成 3D/2D 非空画布、证据展示、节点修改、重解析冲突、移动端裁决、保留人工版本和最终图核对；`static-v2` 的真实回归进一步通过页面确认 `risk-assessment-judgement` 的“快速流程”形成 8 节点/7 边 workflow，而明确写着“本 skill 无工作流”的 `mdd-framework-reference` 仍是 1 节点 content-only，证据在 `.skill-designer-dev/chrome-artifacts/three-real-skills/verification.json` 及对应导入审阅截图。原解析审阅证据仍在 `import-review.json`、`import-review-3d-desktop.png`、`import-review-conflict-desktop.png`、`import-review-conflict-mobile.png`。

### T20 [x] LLM Provider 与本地密钥管理

- **目标**：为设计助手、解析和真实测试提供统一模型调用层。
- **输出**：provider 接口、模型配置、连通性检查、取消/超时/重试、token 用量记录、本地安全存储。
- **验收**：API Key 不进入项目、日志、Trace、Bug Report 或导出包；provider 错误可诊断且不破坏项目。
- **当前进度**：已实现厂商无关 `LLMProvider` 契约、运行时 `ModelSettingsService` 和首个 `OpenAIResponsesProvider`。设置保存在项目之外；API Key 按环境变量、系统凭据库的优先级解析，macOS 使用 Keychain，Windows 使用当前用户 DPAPI 加密文件，不支持的平台仅允许环境变量。前端 GET 只返回配置状态和来源，写入后立即清空密码框；模型 ID、30–300 秒超时、删除本地密钥和显式连通性检查均可在中文设置弹窗操作。连通性使用不生成 token 的模型查询，网络/5xx 最多重试一次；模型生成固定零自动重试，支持调用方取消与独立超时，并分类认证、限流、Provider、协议、超时和取消错误。Responses 请求固定官方 endpoint、`store: false` 和严格 JSON Schema，usage 记录输入、输出、总量、缓存输入、cache write 与 reasoning token。21 个测试文件、107 项测试和生产构建通过；可见 Chrome 已实际完成桌面保存/连接/删除、密钥不回显、无控制台错误及 390px 移动布局验收。

### T21 [~] 设计助手：读取与 ChangeSet 提案

- **目标**：用中文对话简化节点、文档和测试用例的创建与修改。
- **输出**：只读 Workspace 成员摘要工具、绑定当前 Skill 的项目工具、意图澄清、单 Skill 结构化 ChangeSet、证据引用和预览跳转。
- **验收**：助手无直接写文件权限；不会把一个 Skill 的内容写入另一个 Skill；所有建议必须进入 T16；无足够信息时不得臆造项目事实。
- **当前进度**：已实现持久化 DesignAssistantSession、Provider 能力检查、单 projectId/skillId 会话锁、受限 Workspace 成员摘要、当前图、文档/Benchmark 索引和按需求直接命中的少量正文。模型协议扩展为 `read | clarify | propose`：最多 3 次模型调用、10 次只读操作，每轮最多 5 次，只允许节点、邻域、图搜索、项目文档/切片和测试用例读取；所有读取绑定会话 projectId，索引外路径只返回拒绝，active revision 漂移会中止，读取正文只回灌当轮模型而不写入会话。最终提案仍必须提供可核对 evidence 和 `valueJson` 白名单操作，再进入既有 ChangeSet 预演/lint；项目内容和工具结果均视为不可信数据，不能覆盖系统约束。中文抽屉展示 Provider、锁定目标、历史、按需读取记录、聚合 token/调用次数和 diff，并支持取消、拒绝、冲突重预演与确认。21 个测试文件、110 项测试及生产构建通过；可见 Chrome 已实际完成桌面/390px 的两轮文档读取、读取记录、token 聚合和无溢出验收。尚缺用户提供真实 Skill 后的真实 Provider 多轮稳定性验收，因此保持进行中。

### T22 [~] LLM 辅助解析与重解析

- **目标**：在静态导入基础上提高流程识别质量。
- **输出**：解析工作流、结构化候选输出、lint 修正循环上限、manual 保护、重新解析 ChangeSet。
- **验收**：模型输出不能绕过 Schema 和 lint；超限或失败如实保留诊断；不会自动覆盖人工内容。
- **当前进度**：已实现绑定 Workspace、冻结源摘要和 reviewRevision 的 `llm-v1` 解析运行；模型只可读取清单内 Markdown/JSON/配置/文本，冻结文件逐次复验 SHA-256。循环限制为最多 4 次调用、8 次按需读取、每轮 4 项、单文件 20,000 字符、总正文 48,000 字符和 1 次 lint 修正；无效读取会作为反馈回灌。结构化结果依次通过严格 Schema、服务端字段重解析、证据路径/行号/原文片段核验和共享图 lint，失败、超限、取消与服务重启中断均持久化诊断且不改变候选。成功结果只更新 pre-project candidate；人工审阅后再次解析会生成 `manual-vs-reparse` 冲突，不自动覆盖。现已增加按文件 SHA-256 命中的跨运行私有摘要缓存：首次仍发送经上限截断的完整正文并建立带原始行号的摘要，后续种子上下文优先发送摘要；模型可再次请求同一路径升级全文。摘要模式只能引用实际可见的原始行，不能利用服务端持有的全文伪造证据，最终证据仍按冻结原文字节复核。运行记录和中文界面展示 `miss/hit/promoted`、上下文模式与字符数。全仓 26 个测试文件、150 项测试、类型检查及生产构建通过；可见 Chrome 除既有解析/冲突流程外，又实际连续完成两次页面 LLM 解析，观测首轮 20,000 字符、次轮 3,066 字符摘要和显式升级后的 20,000 字符全文，桌面/390px 无失败请求、控制台错误或横向溢出。证据在 `.skill-designer-dev/chrome-artifacts/import-llm-cache-verification.json` 及两张对应截图。尚缺用户提供真实 Skill 后的真实 Provider 稳定性验收，因此保持进行中。

### T23 [x] Benchmark 用例编写器

- **目标**：允许用户、用户自己的 Agent 或 Studio 助手共同编写和调试测试用例。
- **输出**：用例 Schema、输入、默认 `subsequence`/可选 `exact` 路径匹配、终态/产物断言、人工判定字段、标签和用例编辑界面。
- **验收**：用例本身是项目文件并经 ChangeSet 修改；此任务只负责编写和静态校验，不伪装成真实 Benchmark 执行。
- **完成情况**：已实现版本化 BenchmarkCase Schema、稳定 caseId/skillId、draft/ready、初始变量、预设用户回答、`subsequence | exact` 路径、终态/变量/产物/工具结果/禁止副作用断言、标签与备注；创建、编辑、删除均经持续 lint、ChangeSet 预览和用户确认。缺少 gate 回答时明确 `fixture_incomplete`，不宣称可自动通过。人工判定作为真实 BenchmarkRun 的追加 `humanReviews[]` 保存，不写进测试输入；T33 另提供 Bug Report 候选转换与确认链。普通 `completed/stopped` Trace 现可生成 Studio 私有候选，带入冻结初始变量、观察路径、终态和最终变量，但保持 draft 并明确“观察结果不等于正确期望”；run/artifact 身份不会写入可导出用例。页面支持标题/ID/标签检索。全仓 23 个测试文件、125 项测试与生产构建通过；可见 Chrome 在导入的 100 用例项目中搜索第 73 项，从终态运行生成、编辑、预览并确认第 101 项，桌面侧栏独立滚动、390px 无溢出、控制台和失败请求均为 0，且项目用例无运行私有身份泄漏。证据在 `runtime-benchmark-candidate-verification.json` 及三张对应截图。

### T24 [x] Generic Export Profile

- **目标**：从明确选中的一个 Skill 输出不绑定 Claude、Codex 或其他 Agent 品牌的通用包。
- **输出**：导出 manifest、文档/图/测试资产、零依赖 engine CLI、导出预览。
- **验收**：干净环境只需系统 Node 即可读取并运行 CLI；导出包含稳定 skillId，不夹带 Workspace 其他成员、厂商专用格式或 Studio 私有数据。
- **完成情况**：已实现绑定精确 active revision/Snapshot 的 `generic/1` 预览、冲突拒绝、ZIP 生成与浏览器下载。归档包含 `export-manifest.json`、原 Snapshot 文件、接入说明和零 npm 依赖 Node 20 CLI；CLI 支持 `inspect`、条件感知的 `transitions`，以及 `run start/status/next/pause/resume/stop`，用外置 JSON 状态文件持久化连续事件，非法下一节点会记录 `engine.reject` 且不改变当前节点、变量或 step。Studio 提供按当前 Skill 隔离的导出历史、旧版本重下和显式清理；删除导出记录及 ZIP 不影响 Skill、Revision 或 Snapshot。全仓 24 个测试文件、128 项测试通过；可见 Google Chrome 已实际完成新旧 revision 导出预览、确认下载、历史删除、390px 页面检查，并在解包后的干净目录中用系统 Node 执行暂停、恢复、非法拒绝和完整流程。归档未包含 Workspace 其他成员、厂商格式或 Studio 私有身份，证据保存在 `.skill-designer-dev/chrome-artifacts/generic-export-runtime-verification.json` 及对应截图。

### T25 [x] Runtime/Debug 对话框

- **目标**：让没有把 Skill 接入自身 Agent 的用户也能通过简化对话框运行和调试。
- **输出**：运行对话、节点上下文组装、模型回执、取消/重试、当前状态与 Trace 联动。
- **验收**：该对话框不能修改项目；非法下一节点由引擎拒绝并向用户解释，不自动修复或绕行。
- **完成情况**：已实现每个 run 独立持久化的中文模型调试面板，严格绑定 workspaceId/projectId/runId/artifactId；每轮从冻结 revision 组装当前节点、合法出口、skill 变量、绑定文档精确切片、节点声明的有界项目事实和有界最近对话，不读取 active 工作树。模型只可结构化返回 reply/advance/stop，一轮一次调用且零自动重试；advance 始终进入现有 Runtime Engine，非法节点留下 `engine.reject`、保持节点和 step，并展示合法出口，不自动改图或绕行。用户消息、查询观察、LLM 请求/回执/错误、引擎结果和可见回复共用连续 ExecutionTrace；生成期间用 artifact/currentNode/eventSeq 乐观锁阻止陈旧决策。取消不推进运行，错误/取消可显式重试且保留旧事实，页面展示 resolved model、token 和耗时。T11 已补齐声明式上下文页面和 `context.queried`。基础对话专项可见 Chrome 完成新建运行、合法推进、非法拒绝、刷新恢复、取消、重试、最终完成和 390px 移动端操作；声明式查询专项另完成 7 条页面配置、模型注入和无正文 Trace 验收，均无横向溢出、控制台错误或失败请求。证据保存在 `.skill-designer-dev/chrome-artifacts/runtime-dialog-verification.json`、`declarative-context-verification.json` 及对应截图。

---

## P3 Trace、Bug Report 与诊断闭环

### T26 [x] Trace 实时通道与状态归约器

- **目标**：把运行事件可靠同步到界面并还原运行状态。
- **输出**：WebSocket 协议、断线续传、事件补拉、状态 reducer、乱序/重复处理。
- **验收**：重连后无丢事件和重复状态；多个 Skill 并行运行时按 workspaceId/projectId/skillId 隔离；实时展示与持久化 Trace 归约结果一致。
- **完成情况**：已实现经本地 session token、Host/Origin 和 `skill-designer.trace.v1` 子协议校验的 WebSocket 流，按 projectId/runId 隔离；客户端维护最大 seq，以 `afterSeq` 自动重连并补拉缺失页。状态 reducer 按 seq 排序、去重并保留未知事件计数，实时页、HTTP 补拉和独立 TraceStore 使用同一事件事实。集成故障注入强制断开一条流，在三个不同 Skill 并行执行 16 个事件后重连，验证各流连续收到 `seq 3..18` 且 workspace/project/skill/run 身份无串线；截断 NDJSON 在服务重启后可由完整 Run 恢复为一致投影。可见 Google Chrome 又实际执行浏览器离线、三个 Skill 各追加 13 个事件、恢复网络自动补齐到 `seq 15 / completed`，并逐个切换 Skill 核对页面归属；390px 无横向溢出，控制台和失败请求均为 0。证据保存在 `.skill-designer-dev/chrome-artifacts/trace-resilience-verification.json` 及对应桌面/移动截图。

### T27 [~] 通用 Trace 图上渲染

- **目标**：以同一套逻辑展示调试、回放和 Benchmark 的节点状态。
- **输出**：当前/已完成/失败/拒绝/未访问状态、边路径、步进、速度控制、时间轴。
- **验收**：节点依次亮起由 Trace 驱动；渲染器不包含 Benchmark 或 Bug Report 的专用业务判断。
- **当前进度**：通用 reducer 已能从持久化 Trace 归约当前、已访问、拒绝、完成、停止状态和已走边。调试页、确定性回放、运行对比、诊断与 Bug Report 复现现已共用主图谱的 2D/3D 力导向渲染器，通过状态环、路径高亮和原图缺失占位表达事实；渲染器只接收通用投影，不包含 Bug Report 专用判断，知识边也不会被推断为运行路径。步进、0.5x/1x/2x 播放、时间轴与首个路径偏差已经过完整可见 Chrome 操作。尚缺真实可执行 Benchmark 环境下的同一覆盖层接入与双模式验收，因此保持进行中。

### T28 [x] Trace 回放与运行对比

- **目标**：通过事件回放定位问题出现的过程和首个偏差点。
- **输出**：回放控制、状态快照、两次运行对比、revision/artifact 漂移提示、缺失节点降级展示。
- **验收**：同一 Trace 可确定性还原；回放只用于分析，不宣称证明修复成功。
- **完成情况**：已实现按 `throughSeq` 生成确定性历史投影、上一步/下一步、时间轴、0.5x/1x/2x 播放和实时/回放切换；回放模式禁用运行写操作并明确不改变验证状态。同一 Skill 的两次运行按稳定 nodeId 比较完整路径、共同前缀、首个偏差、revision 和 artifact 身份，并排展示状态、当前节点、step/eventSeq、顶层变量差异和精确事件类型计数差异；嵌套对象使用确定性键序比较，不把键顺序误报为值变化。模型、工具和其他事件域只展示持久化类型/次数事实，不推断原因。对比运行的历史节点若不在当前 Artifact 图中，会在同一 2D/3D 图谱显示虚线“对比图缺失”占位，不按名称映射。可见 Google Chrome 已实际完成实时/回放步进与播放、两路径首偏差、模型事件差异、变量增删改、2D/3D 切换，以及删除旧节点后的跨 revision 对比；最终场景显示 `flow.end / flow.core-step`、`1/4` 对 `2/9`，桌面与 390px 无溢出，控制台和失败请求均为 0。证据保存在 `.skill-designer-dev/chrome-artifacts/trace-comparison-verification.json` 及对应截图。

### T29 [x] Bug Report 生成、脱敏与预览

- **目标**：一次测试或调试后生成可移交、可检查的结构化报告。
- **输出**：含 skillId 和来源运行身份的 Report Schema、Trace 投影、失败摘要、环境/指纹、用户说明、off/default/strict 脱敏、预览和 JSON/Markdown 导出。
- **验收**：默认报告不包含密钥和原始敏感自由文本；报告可追溯到 artifact；用户可在导出前检查内容。
- **完成情况**：已实现 `reportVersion: 1.0` 的运行与 Benchmark 报告，精确记录 run/workspace/project/skill/artifact/revision 身份、覆盖范围、脱敏 Trace、路径自包含图投影、拒绝/停止事实症状和用户说明；仅终态运行可生成。支持 `off/default/strict`，任何模式都强制递归屏蔽 Key/Token/Password/Authorization 等字段和常见密钥文本；默认模式对 conversation/llm/tool/sandbox 等非引擎事件只保留回放结构字段，严格模式进一步移除用户说明。预览冻结 digest，用户确认后从同一份已脱敏报告同时生成 `<skill-slug>-<timestamp>.report.json` 与 `.report.md`，Markdown 内嵌完整脱敏 JSON，不读取原始 Trace。页面同时展示不下载的本地原始投影与实际导出预览，并明确未观测工具/外部 Agent 覆盖边界。报告历史按 Workspace + Project 隔离，可选择旧报告、下载两种格式或删除源报告；删除只移除该报告目录，已加入诊断的独立副本、来源运行、Trace、Artifact 和 Skill 文件均不受影响。1.0 明确不接收任意附件，待后续定义附件类型、数量/大小上限和逐类型脱敏规则后再扩展，避免附件绕过报告安全模型。单元、HTTP 及可见 Google Chrome 已完成同源双格式、默认/严格脱敏、模拟密钥、历史选择、删除隔离和 390px 移动端验收；证据保存在 `.skill-designer-dev/chrome-artifacts/bug-report-history-verification.json` 及对应截图。

### T30 [x] Bug Report 导入与图上复现

- **目标**：导入报告后直接呈现实际路径、异常节点和上下文。
- **输出**：格式校验、fingerprint 对比、图上回放、首异常标注、事件详情、缺失内容提示。
- **验收**：报告按 skillId 精确匹配 Workspace 成员并校验指纹；不一致时明确告警；不存在的 Skill/节点不被映射到相似名称对象。
- **完成情况**：已实现单份 2 MiB 内 JSON 报告导入、版本/ID/Trace 身份/严格递增 seq/图端点校验和 Workspace 私有持久化；页面支持文件多选与真实拖放，单批最多 10 份、总计 10 MiB，每份独立校验并保留部分成功结果。相同 reportId 与相同内容幂等复用已有副本，相同 reportId 对应不同内容时拒绝身份冲突。匹配结果明确区分 `matched`、`fingerprint-mismatch`、`skill-missing`、`target-unavailable`；只按 skillId 精确匹配并比较 contentHash，不按名称兜底。新报告携带完整 RuntimeArtifact 指纹，Benchmark 报告另携带 Provider、模型、runner 和沙箱策略执行指纹；导入页完整展示这些冻结事实，早期 1.0 报告缺失时明确显示未记录并保持可回放。诊断页支持报告列表、匹配告警、默认定位首个事实症状、逐症状跳转、时间轴步进、报告自带 2D/3D 图谱回放、缺失节点占位、事件与用户说明。用户可删除导入副本，服务端同时清理绑定的诊断、修复、夹具和候选用例私有记录，但不回滚已应用 ChangeSet，不删除来源运行、Trace、Artifact 或 Skill 文件。1.0 报告协议不接收附件，因此不存在附件缺失推断。单元/HTTP 覆盖精确匹配、指纹不同、Skill 缺失、幂等导入、身份冲突和删除隔离；可见 Google Chrome 已完成三文件拖放批量导入、重复去重、两症状独立定位、指纹展示、派生记录清理、来源运行保留和 390px 移动端验收，控制台与失败请求均为 0。证据保存在 `.skill-designer-dev/chrome-artifacts/report-import-lifecycle-verification.json` 及对应截图。

### T31 [x] 诊断分类、证据与建议

- **目标**：分析用户出错原因，并给出可操作建议，但不替用户自动修改。
- **输出**：图结构/条件/文档/模型输出/工具/环境等诊断分类、证据链、置信度、建议和未知原因状态。
- **验收**：每条结论引用 Trace 或项目证据；无法确定时明确表达不确定性；建议不会自动提交。
- **完成情况**：已实现版本化 DiagnosisRecord、图引用/条件/文档/模型/工具/环境等候选分类、`high/medium/low` 置信度、逐条 Trace/图/报告证据、建议、证据边界，以及结构化 `verification.method/steps/successEvidence`，并按 Workspace + reportImportId 私有持久化。确定性规则覆盖拒绝跳转、运行图缺少提交目标、被拒目标对应条件为 false、文档缺失/标题切片不唯一、运行停止、Benchmark 断言/技术失败、`llm/model` 调用或协议错误、tool 失败/非零结果、sandbox 超时/失败和 Provider 不可用；同一失败域的多个事件合并为一个候选并保留全部 seq 证据，Benchmark failureCategory 映射到对应模型、工具或环境域。条件候选必须同时存在先行 `condition.evaluated=false` 和后续同目标 `engine.reject`；文档候选只接受运行时 `document.context=missing/ambiguous`，不从静态字段猜测。非法跳转事实与提交责任严格分离，无可用症状和失败事件时返回证据不足。诊断页支持显式分析、重新分析、刷新恢复、桌面双列与移动单列；旧记录缺少 verification 时保守降级，且不会自动修改或显示已验证。单元、HTTP 持久化及两组可见 Chrome 已覆盖多症状、模型、工具、环境、真实条件拒绝、冻结文档缺失、报告脱敏投影和结构化验证方式；390px 无溢出，控制台与失败请求均为 0。证据保存在 `.skill-designer-dev/chrome-artifacts/condition-document-diagnosis-verification.json`、`report-import-lifecycle-verification.json` 及对应截图。

### T32 [~] 辅助修复与验证状态

- **目标**：用户可选择把诊断建议转为修复提案，并通过再次运行验证。
- **输出**：Diagnosis -> ChangeSet、预览确认、修复前后关联、`unverified/verified/failed` 状态和 `runtime/benchmark` 验证级别。
- **验收**：工具不自动修复；只有用户确认才提交；回放不能把状态变为 `verified`，必须以原问题相同或更强的执行方式创建新 artifact 并重新运行。
- **当前进度**：已实现结构化 DiagnosisRepairOption、DiagnosisRepairRecord 和 `unverified/verified/failed` 状态。确定性修复现注册 `graph.add-edge | graph.remove-condition | graph.remove-document-binding`：新增边要求报告与当前 Skill 指纹精确一致、目标节点存在且没有同起终点的非知识边；移除条件要求 Trace 先证明指定边 `condition.evaluated=false`、随后同目标 reject，且报告冻结图中的该边确实含 condition；移除文档绑定要求 Trace 明确记录同节点、路径、锚点的 `document.context=missing/ambiguous`，并由 Store 复核当前绑定仍然 lint 失败。文档事件按绑定分组，不会把多个节点合并成一个建议；Engine 只形成候选，Store 才能依据当前项目事实附加 `graph.node.update`。诊断创建和生成提案两个时点都复核绑定，文档已恢复或节点已变化时不提供或拒绝旧修复；不会编造替代文档。三类都只生成 ChangeSet，页面展示 Diff，用户确认前图仍保留原绑定，确认后记录 changeSetId/appliedRevision 并保持 `unverified`。runtime 验证只接受修复后 revision 的新 run：边修复实际经过新增/更新边并 completed 才通过；文档修复要求 Artifact 节点已无绑定、Trace 实际进入目标节点、没有重复同节点文档失败并 completed。同节点再次失败记为 failed，无关下游失败或未完成只返回 inconclusive；回放和旧 run 均不能验证。跨报告多轮修复以来源 runId 精确等于上一轮 `verification.runId` 建立 `round + follow-up lineage`，页面显示第 N-1 轮到第 N 轮并可返回父报告；旧记录保守回填 round 1。Benchmark 来源报告另有专用启动与验证入口：新运行显式绑定 parentBenchmarkRunId/repairId/changeSetId/appliedRevision，验证读取父子两份持久化 RuntimeArtifact，并要求技术 completed、自动断言和最新人工判定均形成明确结论；任一失败即记为 failed，待定或阻断不能验证。全仓 29 个测试文件、174 项测试、Lint、类型检查和生产构建通过；可见 Google Chrome 已实际完成条件删除、新增边多轮修复和文档绑定节点修改的 Diff/确认/新运行验证。文档修复验收同时检查了确认前后图事实、非空 3D 画布和 390×844 页面，控制台错误和失败请求均为 0，证据在 `.skill-designer-dev/chrome-artifacts/document-binding-repair/verification.json` 及三张截图；既有多轮证据仍在 `.skill-designer-dev/chrome-artifacts/diagnosis-repair-lineage/verification.json`。尚缺真实 Docker 条件下 post-repair completed 的页面实操，因此保持进行中。

### T33 [x] Report 转确定性夹具与候选 Benchmark 用例

- **目标**：复用故障材料，降低复现和编写回归用例的成本。
- **输出**：引擎级确定性 fixture、候选 BenchmarkCase、人工补充期望、来源追踪。
- **验收**：fixture 用于工具内部回归，不计入 Skill Benchmark；候选用例经用户确认后才进入项目用例集。
- **完成情况**：已实现 `ReportFixture 1.0`，从报告自带图和引擎 Trace 提取命令与事件签名，创建时立即使用真实引擎重放；不一致返回 422 且不保存，一致后写入 Studio 私有 `report-fixtures`，并固定 `kind: engine-regression`、`benchmarkEligible: false`。已实现带 `source.reportImportId/reportId/sourceRunId` 的 draft BenchmarkCase 候选和独立 `draft -> changeset-created -> applied` 状态；页面可补充标题、业务意图、期望路径、终态和说明，生成双栏 ChangeSet 预览，确认前项目用例集不变，确认后才写入 `benchmarks/cases`。引擎、HTTP、全仓 52 项测试、生产构建、0 漏洞审计及两轮可见 Chrome 桌面/移动端操作均通过；页面明确区分内部夹具与真实模型/沙箱 Benchmark。

---

## P4 真实沙箱 Benchmark（1.0 最后建设）

### T34 [x] SandboxRunner 技术选型与平台契约

- **目标**：针对 Windows 和 macOS 设计可落地的真实隔离执行方案。
- **输出**：威胁模型、能力检测、文件/网络/进程/资源策略、统一 SandboxRunner 接口、降级与“不支持”状态。
- **验收**：完成原型和风险评审后再定实现；不能达到声明隔离级别时不得假装已沙箱化。
- **完成情况**：已选择 Windows/macOS 共用的 Docker Desktop `desktop-linux` Linux VM 作为 1.0 唯一执行后端；macOS `sandbox-exec` 因弃用不采用，Windows Sandbox 因交互式生命周期和产物协议不足不采用，也禁止降级到裸宿主进程。已实现 `SandboxRunner`/`SandboxPolicy`/能力状态契约、固定 digest 的严格 Docker 参数计划、网络/文件/进程/内存/CPU/超时策略、只读 `/api/sandbox/capabilities` 探测、远程 context 拒绝和测试工作台能力弹窗。当前机器没有 Docker CLI，页面如实显示 unavailable；即使探测到 Docker，在 T35 容器生命周期负向自测前也保持 `readyForBenchmark: false`。仓库级威胁模型见 `Skill-Designer-threat-model.md`。全仓 58 项测试、生产构建、0 漏洞审计和可见 Chrome 桌面/移动操作通过。

### T35 [~] 沙箱生命周期与权限执行

- **目标**：在临时工作副本中运行用户批准的 Skill 与工具命令。
- **输出**：创建/启动/监控/取消/超时/销毁、只读输入、产物目录、网络策略、命令白名单、资源限制和审计事件。
- **验收**：运行不能写回 active 项目；越权文件、网络和子进程操作被阻止或明确标记为平台不支持；取消后无残留运行进程。
- **当前进度**：已实现持久化 `SandboxHandle` 状态机、私有冻结输入副本、独立产物目录、固定 digest 镜像与命令允许列表、严格 Docker 参数、启动/输出/失败/超时/取消/收集/清理审计、日志与产物数量/体积上限、symlink/hardlink/特殊文件拒绝、取消后 `inspect` 无残留复核，以及固定协议的隔离自检 API 和测试工作台界面。模拟 Docker 执行器覆盖正常执行、越权命令拒绝、恶意链接产物、取消清理和自检通过/失败持久化；全仓 66 项测试、生产构建、0 漏洞审计和可见 Chrome 桌面/移动端实操通过。当前 macOS 机器未安装 Docker CLI，也未配置固定 digest runner 镜像，因此页面如实持久化 `unavailable`，未执行真实容器中的文件、网络、资源、取消和清理负向验收；该验收完成前 T35 保持进行中，`readyForBenchmark` 保持 false。

### T36 [~] 真实模型 Benchmark Runner

- **目标**：用真实模型、真实 Skill 和真实沙箱执行用例。
- **输出**：用例队列、模型调用、工具执行、路径/终态/产物断言、失败分类、RuntimeFingerprint、Trace。
- **验收**：每次运行都实际产生模型调用和 token 用量；不以模拟回执替代真实 Benchmark；工具自身避免重复上下文和无效重试。
- **当前进度**：已实现单并发 FIFO、重启中断恢复、启动/列表/详情/取消 API、active revision 的不可变 BenchmarkCase/图/文档 snapshot 冻结、RuntimeArtifact、真实沙箱 snapshot 预读、宿主 Provider 结构化节点决策、action 节点已确认 `benchmarkCommand` 与沙箱命令白名单、40 步上限、无自动重试、节点文档按需切片、工具上下文裁剪、token 累计、技术失败分类、路径/终态/变量/文本产物/工具结果/禁止副作用断言、RuntimeFingerprint 和统一 Benchmark Trace。页面支持 Provider/沙箱 preflight、ready 用例选择、模型与 reasoning 配置、运行记录、usage、指纹、断言和 Trace。全仓 17 个测试文件、84 项测试、生产构建、0 漏洞审计及可见 Chrome 桌面/移动实操通过；当前页面实际点击启动后因 Docker Desktop 自检与固定 runner 镜像缺失而形成 `blocked` 记录，模型调用和 token 均为 0，未伪装真实 Benchmark。必须在 T35 真实容器验收完成后，用用户提供的真实 Skill 实际产生模型 token、沙箱产物和断言结果，T36 才能勾选完成。

### T37 [~] Benchmark 调试与人工判定界面

- **目标**：支持反复编写、运行、检查、修改和确认结果。
- **输出**：单用例/批量运行、实时 Trace、断言结果、人工成功/失败/待定、备注、token/耗时、取消、失败后转诊断。
- **验收**：自动断言和人工判定分别保存；用户可追溯每次迭代；工具不替用户决定 Skill 是否适合其最终业务。
- **当前进度**：已实现单用例启动、显式多选批量入队、活动运行轮询、取消、执行 Trace、逐条自动断言、模型调用/token/缓存输入/耗时展示，以及 `passed/failed/inconclusive + 备注` 的只追加人工判定历史。批量接口先校验整批 ready 用例再按选择顺序进入同一单并发 FIFO；人工结论与自动断言分开持久化，后续复核不会覆盖旧记录或改变自动结果；只有技术执行 `completed` 的运行可人工判定，`blocked/failed` 不能被手工改成通过。失败/待定结果已可按 T38 生成报告并直接加入诊断。全仓 17 个测试文件、84 项测试覆盖完成运行的多次复核、阻断运行拒绝复核、批量顺序和整批校验；可见 Chrome 已真实操作单用例与批量阻断流程，并验证桌面/移动布局、两条独立记录、零模型调用/token 和全部人工控件锁定。尚缺 Docker runner 可用后在真实 `completed` 运行上的页面端人工保存/刷新验收，因此保持进行中。

### T38 [~] Benchmark 结果与 Bug Report 联动

- **目标**：测试失败后无缝进入报告、回放、诊断和辅助修复闭环。
- **输出**：一键生成报告、诊断入口、修复后新 run 关联、前后对比、结果导出。
- **验收**：修复前后运行使用不同 artifact 且链路可追踪；只有新真实运行可以确认问题是否解决。
- **当前进度**：Bug Report 1.0 已向后兼容增加 `source.kind=benchmark`、真实 `benchmarkRunId/caseId`、通用 Trace 事件信封、自动断言/技术失败症状和 Benchmark 专用诊断分类。只有已冻结 RuntimeArtifact 的 `completed/failed/cancelled` 运行可生成报告，preflight `blocked` 明确拒绝；报告复用现有强制密钥脱敏、预览、digest 确认和 JSON 下载，并可幂等地直接加入当前 Workspace 诊断。诊断只把断言失败/待定或技术失败陈述为近因，不猜测 Skill、模型、工具或环境责任。普通重跑显式保存 `rerun` 父子关系；DiagnosisRepair 专用入口建立 `post-repair` 关系并锁定 repairId/changeSetId/appliedRevision，启动时拒绝 revision 漂移，验证时依据父子冻结 Artifact 而非当前活动版本。只有同 Workspace/Skill/case、不同持久化 Artifact、修复版本 completed、自动断言与最新人工复核都明确的运行才能更新修复状态。关联运行页面现基于稳定 assertionId、按 seq 排序的 `engine.enter`、完整 Trace 事件类型和持久化 usage 展示父子 Artifact ID/revision/contentHash、路径共同前缀与首个偏差、断言新增/移除/变化、六类 token、模型调用和事件计数 delta；比较器只陈述记录差异，不推断根因。存储与 Runner 测试覆盖来源身份、Artifact 指纹、缺少人工判定、专用 lineage 和阻断零 token；可见 Chrome 已验证普通报告直达诊断、重跑与 post-repair 深度对比、桌面和 390px 布局，深度对比证据在 `.skill-designer-dev/chrome-artifacts/benchmark-deep-comparison/verification.json`。该页面验收使用持久化 completed 夹具验证比较器和交互，不冒充真实模型或沙箱运行。尚缺真实 Docker 条件下 completed post-repair 页面验收和真实 completed 报告按钮验收，因此保持进行中。

---

## P5 验收与发布

### T39 [~] 跨平台、性能与安全专项验收

- **目标**：验证 1.0 非功能基线。
- **输出**：Windows/macOS 用例矩阵、Workspace 多 Skill 摘要/切换、单 Skill 500 节点/100 文档性能报告、成员路径隔离与脱敏测试、异常恢复测试。
- **验收**：产品文档中的非功能指标逐项有证据；核心引擎、通用导出物和 hash 规则补充 Linux 一致性测试；未达标项在发布前明确处置。
- **当前进度**：已完成 macOS arm64 Chrome 150 的可见页面规模专项。100 篇关联文档记录列表加载、首/中/末搜索和正文打开；500 节点/499 边连通图记录加载、首/中/末定位、类型筛选、关系跳转、缩放和平移。Workspace 专项使用 25 个 workflow、25 个 content-only 的 50 成员矩阵，其中 49 个 ready、1 个路径失联；实测首屏 744ms、首/中/末搜索 8–12ms、切换 56–111ms，选中成员刷新后保持，图谱/文档页稳定 skillId 无串线。三项均检查 390x844 移动布局，未出现控制台错误、失败响应或横向溢出。路径隔离专项真实拒绝加入后替换的项目外符号链接，外部正文未进入 DOM；恶意 Origin/Host、缺令牌和超限请求得到预期拒绝。严格脱敏专项验证预览、JSON 和 Markdown 均未泄露模拟密钥。异常恢复专项在文档重命名的目标写入、源移除和图引用更新三个步骤分别真实 `SIGKILL`，重启后均恢复稳定 revision、源文档和图字节。统一结果见 `T39-macOS专项验收矩阵.md`。GitHub Actions run `30689522606` 已在提交 `6b9cce8` 上完成 Linux、macOS、Windows 的依赖安装、边界 Lint、Typecheck、测试、应用构建和发布构建，核心引擎、Generic Export 与固定指纹向量的远端三系统条件已关闭。真实 Windows 浏览器业务矩阵与事务异常退出对照按用户决定暂缓，不能由 CI 或 Windows ZIP 静态构建替代，因此 T39 保持进行中。

### T40 [~] 用户真实 Skill 端到端验收

- **目标**：将用户提供的 3-5 个 Skill 放入同一 Workspace，验证多 Skill 管理和每个 Skill 的完整产品链路。
- **输出**：Workspace 概览/切换/失联恢复，以及各 Skill 创建/导入、编辑、文档绑定、确认、导出、调试、Trace、报告、诊断、辅助修复和真实 Benchmark 验收记录。
- **验收**：至少覆盖有向工作流和 `content-only`；重命名、移动路径、切换和并行运行不造成身份或数据串线；发现的抽象问题回到对应任务修正，不以特例硬编码通过。
- **当前进度**：已用第 1 个真实样本 `mdd-backend-extend-develop` 完成只读源目录导入和除真实 Benchmark 外的完整产品生命周期验收。该目录是 1 个根 Skill 而不是多个独立 Skill，共 332 个文件、223 个 Markdown、16 个脚本；静态解析得到 10 节点/9 边 workflow，修复了长标题拼接导致生成边 ID 超过 128 字符的问题。确认导入后管理副本保留全部原始字节，源仓库逐文件 SHA-256 不变；223/223 Markdown 全部可管理，覆盖 `workflows/`、`references/`、`assets/` 和能力子目录。可见 Google Chrome 已通过页面完成导入确认、编辑 `references/routing-table.md` 并确认文档 ChangeSet、用完整标题路径绑定节点并确认图 ChangeSet、生成和下载 Generic Export、用包内 CLI 检查 10 节点/9 边、手动运行完整路径、提交非法下一节点、Trace 回放、默认脱敏 Bug Report、原因分析、诊断修复 ChangeSet、修复后新 revision 运行和验证。导出 ZIP 共 337 个条目并保留全部 332 个原始路径，未包含 Studio 私有文件；模拟密钥只显示为 `[REDACTED]`。桌面 3D Trace 和 390x844 移动 2D Trace 均等待稳定、执行适应全图并通过 Canvas/WebGL 像素检查，移动端无横向溢出，控制台错误和失败请求均为 0。真实预检进一步暴露并修复了 inlineCode 路径误报：当前 30 条 Markdown 链接全部解析成功，73 条代码路径精确解析，另有 361 条未命中代码路径作为候选事实展示；页面摘要为 `103 已解析 · 361 候选 · 0 待检查`，只保留 16 个脚本不执行警告，不再把示例文件名或外部知识路径冒充缺失引用。真实 Skill 的 BenchmarkCase 预检也已完成：页面按实际 10 节点顺序创建 `exact` 全路径 ready 用例，Store 证明确认 ChangeSet 前不存在、确认后才写入且 lint 有效；真实 `BenchmarkRunnerService`、Provider 能力和沙箱能力共同执行 preflight，在 API Key、Docker 生命周期自检和固定 digest 镜像均未就绪时持久化 `blocked/not-run`，模型调用 0、Token 0、Artifact 未冻结、沙箱句柄 0，人工判定不可用。桌面和 390x844 页面均经可见 Chrome 操作与截图检查，控制台错误和失败请求为 0，源 Skill 332 个文件的 SHA-256 仍不变。导入证据在 `.skill-designer-dev/chrome-artifacts/real-skill-mdd-import/verification.json`、`real-skill-reference-candidates-desktop.png` 及对应图谱/移动截图，完整生命周期证据在 `.skill-designer-dev/chrome-artifacts/real-skill-mdd-lifecycle/verification.json`，Benchmark 环境边界证据在 `.skill-designer-dev/chrome-artifacts/real-skill-mdd-benchmark-preflight/verification.json` 及对应截图。该记录只证明真实用例确认链与真实环境阻断边界，不是沙箱模型 Benchmark 成功。

  同 Workspace 身份与交错运行现已用可见 Google Chrome 进一步验收：页面创建 1 个 Workspace，页面导入上述 332 文件真实 workflow，再原地加入仓库示例 workflow 与 content-only，共 3 个 ready 成员且 `skillId` 唯一。两个 workflow 同时保持活动运行，经过真实页面多次切换后分别按 `10 节点/9 步` 和 `4 节点/3 步` 完成；两套 `runId/artifactId/projectId/skillId`、RuntimeArtifact、Trace 事件身份和节点集合逐项隔离。content-only 页面明确没有可执行流程、没有启动按钮且运行数为 0。真实源和两个示例源前后逐文件 SHA-256 不变，真实 MDD 3D Trace 为非空 WebGL2 画布；`390x844` 无横向溢出，控制台错误和失败请求为 0。证据在 `.skill-designer-dev/chrome-artifacts/mixed-workspace-real-skill/verification.json` 及五张截图。两个仓库示例只用于验证通用多 Skill 与 content-only 契约，不能冒充额外的用户真实 Skill。

  真实 Skill 数量与类型下限现已补齐：可见 Google Chrome 通过目录选择器把 `mdd-backend-extend-develop`、`risk-assessment-judgement` 和 `mdd-framework-reference` 三个独立真实 Skill 全部从扫描预检、解析审阅到确认导入同一 Workspace，三者均为唯一 `skillId` 的 ready 成员。逐文件 SHA-256 证明 332、8、130 个源文件全部未改写，管理文档分别为 223、5、129 篇。`static-v2` 将“快速流程”下 6 个编号步骤解析为 8 节点/7 边 workflow；写明“本 skill 无工作流”的参考知识库保持 1 节点/0 边 content-only。三个真实 Skill 的适用产品生命周期现已分别完成：MDD 证据见前述独立完整生命周期；risk 通过页面编辑 `references/output-schema.md`、确认文档与图绑定 ChangeSet、生成 13 文件 Generic Export、提交并保留非法跳转 Trace、按 8 节点路径完成运行、生成默认脱敏 Bug Report、分析原因、确认新增边修复提案，并由新 revision/new Artifact 运行直接经过新增边后把诊断更新为“已验证”；reference 通过页面编辑 `MetaDaoHelper.md`、把单知识节点绑定到精确标题路径、生成保留全部 130 个源路径的 135 文件 Generic Export、页面复核确认文档，并验证测试页无启动入口且运行数为 0，不为 content-only 伪造 Bug Report 或诊断。

  该轮页面验收同时发现并修复了 1–2 节点 3D 图的退化包围盒问题：通用图渲染器现在为小图计算确定中心和相机距离，不再让 `zoomToFit` 把单知识节点移出视野。最终 reference 图的 WebGL2 直接读回为 126 个差异采样/28 个颜色桶，可见 canvas 中央区域另有 75 个高色度节点采样；截图人工确认蓝色知识节点与标签居中且未被编辑器遮挡。验收脚本每次清空自身 artifact 目录，拒绝运行落后于 `engine/server/web` 源码的 dist，并同时检查 WebGL 缓冲和可见 canvas，避免旧截图或背景渐变造成假通过。最终完整记录包含 21 张页面截图，`390x844` 无横向溢出，控制台错误和失败响应均为 0，三个源目录字节保持不变；证据在 `.skill-designer-dev/chrome-artifacts/three-real-skills/verification.json`。真实 Docker、固定 digest runner 镜像和模型可用后的非零 Token 沙箱 Benchmark 仍缺失，因此 T40 保持进行中，且不能降级为宿主执行冒充完成。

### T41 [~] Generic Export 外部 Agent 验收

- **目标**：证明通用包不依赖 Studio 和厂商专用适配。
- **输出**：干净环境安装/读取/运行记录、CLI 契约验证、资产完整性与 git diff 展示验证。
- **验收**：目标 Agent 只需具备读文件、运行 Node CLI 和处理结构化输出的能力；不承诺 Claude/Codex 专用体验。
- **当前进度**：已补齐零 npm 依赖 CLI 的 `verify` 命令，读取 `export-manifest.json` 后校验通用包身份、安全相对路径、逐文件大小和 SHA-256；完整包返回结构化 `valid/checkedFiles/totalBytes`，文件缺失或篡改返回结构化 `package_integrity_failed` 和逐文件 mismatch，不自动修复。生成器单元测试覆盖有效包、篡改和缺失文件，Store 集成测试从真实 ZIP 执行 `verify`。用户真实 `mdd-backend-extend-develop` 已通过可见 Google Chrome 完成导入、导出预览、确认、下载和 390x844 操作；ZIP 共 337 个条目，清单声明并成功校验 336 个文件，保留全部 332 个原路径且无 Studio 私有文件。仓库外 clean-room 未执行 npm install，CLI 只导入 `node:crypto/fs/path/url`；实际完成 `verify`、`inspect`、入口 transitions、包外状态文件 start/pause/resume、非法跳转拒绝、10 节点完整运行、第二运行 stop 和运行后再次 `verify`，包字节及源 Skill 逐文件 hash 均不变。人为篡改导出副本的 `SKILL.md` 被精确识别。页面无控制台错误或失败请求，证据在 `.skill-designer-dev/chrome-artifacts/real-skill-mdd-generic-export/verification.json` 及对应桌面/移动截图。Git 对比另有可见 Chrome 证据 `.skill-designer-dev/chrome-artifacts/git-reference-verification.json`，覆盖 HEAD/tag、文本 patch、二进制摘要、项目边界、刷新和移动布局。最终发布包可见 Chrome 验收下载的同一 ZIP 位于 `.skill-designer-dev/chrome-artifacts/release-package/release-package-first-project.zip`，SHA-256 为 `ba73c8965f18028a1adf45b696e7ce05bc39623a95b39a874e19455ff83271c4`；导出 README 已把非法 next 契约校正为“节点、step、variables 不变，同时持久化 `engine.reject` Trace”。外部 Claude CLI 的最小与正式请求均返回 `403 Request not allowed`；独立 Codex CLI 的默认模型和 `gpt-5.6-terra` 均在首轮模型采样阶段超时，未执行包内命令。按用户授权，当前 Codex 随后直接加载最终包并使用导出目录外状态文件完成 `verify/inspect/transitions/start/status/next/pause/resume/非法 next/stop/再次 verify`：336 个声明文件保持有效，非法跳转返回 `next_node_not_allowed`，节点、step、variables 不变且新增 `engine.reject`。以“纯 MDD 采购订单保存前非空校验，补齐规则类、billruleregister SQL 与 Spring XML”为真实需求时，包正确路由到 `rule-orchestration + script-assembly`，并要求先补充实际 billnum、字段编码、Java package/import、SQL/XML 落点、Bean ID、类名和 iorder；同时识别出源 Skill 内 `mdd_billruleregister` 模板与已验证 `billruleregister` 参考冲突，以及保存前模板仍使用已废弃单字符串 `BusinessException`，这些属于被测 Skill 内容问题，未修改只读源目录。当前 Codex 回退证明包契约可用，但不冒充独立外部 Agent 验收；仍缺独立外部 Agent 成功记录和 Windows Node 对照，因此 T41 保持进行中。

### T42 [~] 1.0 发布包与使用文档

- **目标**：形成可安装、可诊断、可升级的首个版本。
- **输出**：Windows/macOS 启动包、安装/卸载、快速开始、Workspace/Skill Project 层级、项目格式、导入导出、报告与 Benchmark 使用说明、已知限制。
- **验收**：全新环境按文档可完成首个项目闭环；发布说明明确 1.0 与 2.0 边界。
- **当前进度**：已建立不引入 Electron 的“Node 20 单进程本地服务 + 系统 Chrome”发布链。`npm run release` 先全仓构建，再由 `scripts/release/build-release.mjs` 生成 `dist/releases/skill-designer-<版本>-{macos,windows}.zip` 和 `SHA256SUMS.txt`；ZIP 内含已构建的 server/web/engine、按 `dependencies` 与 `optionalDependencies` 递归解析并按 realpath 去重的 server 生产依赖闭包、`bin/` 运行工具、README 与两份用户文档，解压后不需要 `npm install`。`release-manifest.json` 声明 `schemaVersion/product/version/targetPlatform/releaseChannel/signing/minimumNode/entry/dataDirectoryPolicy` 和逐文件 `path + size + sha256`，清单不含自身；完整校验要求实际普通文件集合与清单声明集合精确相等，并对声明文件 100% 校验大小/hash，不把文件数量写成长期契约。清单外文件返回 `undeclared_file`，符号链接、目录和特殊文件返回 `unsupported_file_type`，校验不跟随链接。当前 `0.1.0` 只接受严格的 `development-preview / unsigned / integrity-only / local-development` 契约，并明确 macOS 未 Apple 签名/公证、Windows 未 Authenticode 签名；缺字段、未知值、自相矛盾状态或任意文本 `signed` 声明直接拒绝。启动器只绑定 loopback，默认在 `4310-4399` 探测空闲端口，支持 `--port`（占用即失败而不改端口）、`--data-dir`、`--no-open` 和 `--diagnose`，启动前要求目标平台匹配并校验 server/web/engine 三个核心普通文件 hash，等待 `GET /api/session` 就绪后按共享探测规则只打开 Google Chrome；未找到时普通启动明确失败，不降级到系统默认浏览器，`--no-open` 只跳过自动打开并保留本地服务。程序目录与数据目录分离，macOS 默认 `~/Library/Application Support/Skill Designer`，Windows 默认 `%LOCALAPPDATA%\Skill Designer`。安装器拒绝错平台包，先完整校验解压源，再复制到同级 staging 并二次校验，随后 `rename` 替换旧程序；任一步失败都清理 staging 并恢复 backup，升级不触碰数据。卸载默认只删除程序目录，要求 TTY 输入 `UNINSTALL` 或显式 `--yes`，只有同时给出 `--delete-data` 才删除数据，且拒绝删除文件系统根目录或用户主目录。`doctor` 输出结构化结果：包身份与 `package.releaseChannel/package.platformMatchesRuntime`、`releaseTrust` 签名/信任事实和警告、平台/架构/Node 版本与最低要求、精确文件集合及全量完整性、数据目录写探针、共享规则探测到的 Chrome 路径，以及 Docker/Provider 是否已配置的布尔状态（不读取也不回显密钥）。合法的未签名开发预览警告不作为硬失败；错平台、manifest 非法、未找到 Chrome 及其他硬性检查失败时退出码为 1。SHA-256 与清单只证明完整性，不建立发布者身份信任。

  本轮修正了双击快捷入口的退出码与暂停语义，并把它们收口到唯一事实源 `scripts/release/entrypoints.mjs`，由构建脚本与单元测试共同引用：macOS `.command` 只启用 `set -u`（启用 `set -e` 会在 node 失败时跳过 `status=$?` 和暂停提示，用户在 Finder 双击时看不到原因）；Windows `.cmd` 在 node 之后立即 `set "status=%errorlevel%"` 再 `pause`，最后 `exit /b %status%`，避免 `pause` 覆盖 errorlevel 导致丢失真实退出码；`start` 只在非零退出时暂停，`diagnose/install/uninstall` 无论成功失败都暂停；两个平台都透传参数并原样返回 Node 退出码。同时修正 `probeWritableDirectory`：创建目录失败现在与写探针一起归入同一结构化结果，`doctor` 会明确报告“数据目录不可写”并以退出码 1 结束，而不是以未捕获异常终止。

  `packages/server/test/release-package.test.ts` 现在除路径策略、Node 最低版本、清单指纹/篡改/缺失/不安全路径和写探针外，还断言快捷入口：四个入口的 id 与暂停策略、macOS 脚本不含 errexit 且在 node 之后立即保存退出码、Windows 脚本在 pause 之前保存 errorlevel 且不以 `%errorlevel%` 收尾、`start` 与三个一次性入口的暂停分支不同；并真实以 `/bin/sh` 执行生成脚本，验证 node 退出码 7 被原样返回、失败时显示关闭提示、`start` 成功时不暂停、一次性入口成功时仍暂停且 `"$@"` 参数被透传。Windows `.cmd` 的等价执行断言在 `win32` 真实运行、在其他平台显式跳过，不用字符串匹配冒充平台执行。

  `README.md`、`docs/Skill-Designer-1.0-用户指南.md`、`docs/Skill-Designer-1.0-已知限制.md` 已随发布链更新；`产品设计文档.md` 4.1 补充了 Node 20 ZIP、前置条件、程序/数据分离、staging 升级、诊断与卸载保留数据；`架构设计文档.md` 新增 15.1/15.2/15.3 记录发布包结构与校验协议、启动器/安装/诊断/卸载语义，以及快捷入口的退出码与暂停约束。

  验证状态：开发预览信任、平台、Chrome 前置条件和精确文件集合契约、快捷入口与写探针修正后已重新执行全仓门禁和完整发布包验收。本机 clean-room 的边界 Lint、TypeScript、30 个测试文件、201 项测试与生产构建通过；GitHub Actions run `30689522606` 又在 Linux、macOS、Windows 三个 Node 20 Job 中完成相同门禁和发布构建，macOS 下按设计跳过 1 项只能在真实 Windows 执行的 `.cmd` 断言；测试覆盖合法开发预览、缺失 signing、伪 signed 声明、未知 channel/trust level、固定 Node/entry/data policy、平台映射、macOS/Windows/Linux Chrome 候选、首个存在路径与全部缺失结果、错平台安装拒绝、清单外文件、符号链接和直接执行临时发布包 `doctor` 的结构化输出。发布链重新生成 macOS/Windows 两个平台产物，两者均声明 `development-preview / unsigned / integrity-only`，且各自 3599 个文件与清单精确一致。最终 macOS 安装产物先后通过解压源和 staging 校验；`doctor` 对 3599 个文件全部校验通过，并与 manifest 一致报告 `platformMatchesRuntime=true`、`publisherTrustEstablished=false`、`chrome.found=true`、两平台未签名事实和完整性边界警告。最终可见 Google Chrome 验收于 `2026-08-01T06:31:44.476Z` 完成，从安装目录启动独立 server，页面创建 Workspace、导入 332 文件真实 MDD Skill、确认文档 ChangeSet、渲染 10 节点/9 边 2D Canvas（16203 非背景像素）、生成并下载 337 条目 Generic Export 且包含确认修改，`390x844` 无横向溢出；卸载后程序删除并保留 1351 个用户数据文件，源 Skill SHA-256 不变。快捷入口验收真实执行 macOS `diagnose.command` 成功/失败和 `start.command --diagnose` 成功路径，确认暂停策略、退出码、平台与开发预览信任输出；Windows 产物只做静态语义与 manifest 检查，不冒充真实平台执行。验收器先尝试关闭当前重图页面释放 Canvas/下载句柄，无论页面关闭结果如何都继续关闭浏览器，并只以 Playwright 连接断开作为成功证据；本轮重跑的 `browserCloseCompleted/launcherStopped` 均为 true，控制台错误和失败响应为 0。三张最终截图已经人工复核，证据在 `.skill-designer-dev/chrome-artifacts/release-package/verification.json`。

  T42 不能标为 `[x]`，仍缺：真实 Windows 安装/启动/Chrome/卸载证据；Windows Authenticode 与 macOS Apple 签名/公证的正式发布链；以及完整 1.0 前置门禁（尤其 T35/T36 真实 Docker 沙箱 Benchmark 与 T39 跨平台验收）。因此本项保持进行中，当前只按机器可识别的未签名开发预览交付。

---

## 依赖关系

```text
T01 -> T02 -> T03
          \-> T04 -> T05 -> T06
                         \-> T07
T01/T02/T08 -> T09

T02/T03/T05/T07/T09 -> T10 -> T11 -> T17
T09 -> T12 -> T13 -> T14 -> T16
                \-> T15 -> T16

T16 -> T18 -> T19
T20 -> T21
T18/T20/T21 -> T22
T16 -> T23
T10/T11/T18 -> T24
T17/T20 -> T25

T07/T17 -> T26 -> T27 -> T28
T28 -> T29 -> T30 -> T31 -> T32 -> T33

T23/T25/T29/T31 -> T34 -> T35 -> T36 -> T37 -> T38

T01-T38 -> T39 -> T40 -> T41 -> T42
```

依赖图表达的是最低前置关系，不代表同一阶段只能串行。任何并行开发都必须共享已经冻结的 Schema、ChangeSet 和 Trace 契约。

---

## 明确延后到 2.0

- `skill.meta.json` 元模型。
- 文档关系图、知识语义图、工具图和多层图谱联动。
- 带 targetSkillId/版本约束/目标入口的跨 Skill 依赖、Workspace 成员依赖解析与状态总览、关系边、联合图谱、联合 RuntimeArtifact、联合运行、跨 Skill 原子 ChangeSet 和编排。
- Claude、Codex 等 Agent 专用导出和加载适配。
- 团队协作、权限、签名、市场和云同步。
- 多语言 Studio。
- 完整项目格式自动迁移系统。
- 未经用户确认的自动修复、自动改图或自动回归路线。

---

*Skill Designer 1.0 执行计划，2026-07-27*
