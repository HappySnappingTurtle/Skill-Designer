# Skill Designer

Skill Designer 是面向 Skill 开发者的本地工作台。它以 Workspace 管理多个独立 Skill Project，提供图谱与文档编辑、ChangeSet 审阅、调试运行、Trace、Bug Report、诊断、通用导出和真实沙箱 Benchmark 入口。

当前仓库版本是 `0.1.0` 开发预览，不是已经完成全部跨平台验收的 1.0 正式版。已知验收缺口见 [Skill-Designer-1.0-已知限制.md](docs/Skill-Designer-1.0-已知限制.md)。

## 源码运行

前置条件：Node.js 20 或更高版本、npm、Google Chrome。

```bash
npm ci
npm run dev
```

开发页面默认位于 `http://127.0.0.1:5173/`，本地 API 默认位于 `http://127.0.0.1:4310/`。

生产预览使用单进程本地服务：

```bash
npm run preview
```

## 发布包

```bash
npm run release
```

产物写入 `dist/releases/`：

- `skill-designer-<version>-macos.zip`
- `skill-designer-<version>-windows.zip`
- `SHA256SUMS.txt`

发布包不需要 npm install，但需要系统已安装 Node.js 20 或更高版本和 Google Chrome。`doctor` 未找到 Chrome 时会以失败退出；启动器只打开 Google Chrome，不会降级到系统默认浏览器。`--no-open` 只跳过自动打开并启动本地服务，实际使用页面仍需通过 Chrome 访问本地地址。启动、安装、诊断和卸载步骤见 [Skill Designer 1.0 用户指南](docs/Skill-Designer-1.0-用户指南.md)。

`0.1.0` 发布清单把当前产物明确标记为 `development-preview / unsigned / integrity-only`：macOS 未进行 Apple 代码签名和公证，Windows 未进行 Authenticode 签名。`SHA256SUMS.txt` 和包内逐文件清单只能证明下载及落盘内容是否与该清单一致，不能建立发布者身份信任。完整校验要求实际文件集合与清单声明精确一致，并拒绝符号链接、特殊文件和未声明文件；安装、启动与诊断也会拒绝目标平台和当前系统不匹配的包。`doctor` 会在 `package.releaseChannel`、`package.platformMatchesRuntime` 和 `releaseTrust` 中输出相同事实；字段缺失、未知或伪称已签名的清单会被拒绝。

## 验证

```bash
npm run ci
```

`ci` 包含边界 Lint、类型检查、单元/集成测试、生产构建及 macOS/Windows 发布包构建。页面能力还必须通过仓库内对应的 `scripts/chrome-*.mjs` 使用可见 Google Chrome 实际操作，不以 CI 代替页面验收。
