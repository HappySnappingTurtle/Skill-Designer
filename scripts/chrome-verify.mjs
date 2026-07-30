import path from "node:path";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { chromium } from "playwright";

const baseUrl = process.env.SKILL_DESIGNER_URL ?? "http://127.0.0.1:4310";
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const importFixtureDir = path.resolve("scripts/fixtures/import-skill");
const gitFixtureSource = path.resolve("scripts/fixtures/git-skill");
const execFileAsync = promisify(execFile);
const workspaceName = `Chrome 验收 ${Date.now().toString().slice(-6)}`;
await mkdir(artifactDir, { recursive: true });

const gitRepositoryRoot = path.resolve(".skill-designer-dev/chrome-fixtures", `git-repository-${Date.now()}`);
const gitProjectRoot = path.join(gitRepositoryRoot, "skills", "git-skill");
await rm(gitRepositoryRoot, { recursive: true, force: true });
await mkdir(path.dirname(gitProjectRoot), { recursive: true });
await cp(gitFixtureSource, gitProjectRoot, { recursive: true });
await writeFile(path.join(gitRepositoryRoot, "outside.txt"), "项目外初始内容\n");
await execFileAsync("git", ["init", "-q"], { cwd: gitRepositoryRoot });
await execFileAsync("git", ["config", "user.email", "chrome@example.invalid"], { cwd: gitRepositoryRoot });
await execFileAsync("git", ["config", "user.name", "Chrome Verification"], { cwd: gitRepositoryRoot });
await execFileAsync("git", ["add", "."], { cwd: gitRepositoryRoot });
await execFileAsync("git", ["commit", "-qm", "initial skill"], { cwd: gitRepositoryRoot });
await writeFile(path.join(gitProjectRoot, "SKILL.md"), "# Chrome Git Skill\n\nChrome 工作树修改。\n");
await mkdir(path.join(gitProjectRoot, "docs"), { recursive: true });
await writeFile(path.join(gitProjectRoot, "docs", "untracked.md"), "# Chrome 未跟踪文档\n");
await writeFile(path.join(gitRepositoryRoot, "outside.txt"), "项目外修改不得显示\n");

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const failedResponses = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("response", (response) => {
  if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
});

async function clickGraphEditorTool(name) {
  await page.getByRole("button", { name: /^变更 / }).click();
  await page.getByTitle("图谱编辑工具").click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function previewGraphChanges() {
  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  await page.getByRole("button", { name: "预览并保存图", exact: true }).click();
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  if (!(await createDialog.isVisible())) {
    await page.getByRole("button", { name: "新建工作区" }).first().click();
  }
  await createDialog.waitFor();
  await page.getByLabel("工作区名称").fill(workspaceName);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: workspaceName }).waitFor();

  await page.getByRole("button", { name: "导入 Skill" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入 Skill 文件夹" });
  const [directoryChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    importDialog.getByText("选择一个 Skill 文件夹", { exact: true }).click()
  ]);
  await directoryChooser.setFiles(importFixtureDir);
  await importDialog.getByText("import-skill", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "import-directory-selected-desktop.png"), fullPage: true });
  await importDialog.getByRole("button", { name: "扫描并预检" }).click();
  await importDialog.locator(".import-identity strong").filter({ hasText: "Chrome 导入知识" }).waitFor();
  await importDialog.getByText("内容型", { exact: true }).waitFor();
  await importDialog.getByText("4 个原文件 · 2 个生成文件", { exact: true }).waitFor();
  await importDialog.getByText("保留 1 个脚本文件；导入过程不会执行它们", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "import-preview-desktop.png"), fullPage: true });
  await importDialog.getByRole("button", { name: "确认导入" }).click();
  await importDialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /Chrome 导入知识/ }).waitFor();

  await page.getByRole("button", { name: "原地打开" }).click();
  const inPlaceDialog = page.getByRole("dialog", { name: "原地打开 Git Skill" });
  await inPlaceDialog.getByLabel("Skill 根目录绝对路径").fill(gitProjectRoot);
  await inPlaceDialog.getByRole("button", { name: "确认并打开" }).click();
  await inPlaceDialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /Chrome Git Skill/ }).waitFor();
  await page.getByRole("button", { name: "Git 对比" }).click();
  const gitDialog = page.getByRole("dialog", { name: "Git 对比" });
  await gitDialog.locator(".git-file-section li").filter({ hasText: "SKILL.md" }).waitFor();
  await gitDialog.locator(".git-file-section li").filter({ hasText: "docs/untracked.md" }).waitFor();
  if ((await gitDialog.locator(".git-file-section li").count()) !== 2) throw new Error("Git diff escaped the authorized Skill path");
  await gitDialog.locator(".git-patch-section pre").getByText(/Chrome 工作树修改/).waitFor();
  if ((await gitDialog.getByText(/outside\.txt|项目外修改/).count()) !== 0) throw new Error("Git diff exposed repository files outside the Skill root");
  await page.screenshot({ path: path.join(artifactDir, "git-diff-desktop.png"), fullPage: true });
  await gitDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "添加 Skill" }).first().click();
  await page.getByLabel("Skill 名称").fill("需求分析流程");
  await page.getByLabel("说明").fill("收集需求并形成结构化确认流程");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("cell", { name: /需求分析流程/ }).waitFor();

  await page.getByRole("button", { name: "添加 Skill" }).first().click();
  await page.getByLabel("Skill 名称").fill("术语知识库");
  await page.getByRole("button", { name: "内容型" }).click();
  await page.getByLabel("说明").fill("维护产品术语和定义");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("cell", { name: /术语知识库/ }).waitFor();

  const rows = page.locator("tbody tr");
  if ((await rows.count()) !== 4) throw new Error(`Expected 4 skill rows, received ${await rows.count()}`);
  await page.getByRole("cell", { name: /需求分析流程/ }).click();
  await page.locator("tr.selected-row").filter({ hasText: "需求分析流程" }).waitFor();

  await page.getByRole("button", { name: "文档", exact: true }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.waitFor();
  const originalDocument = await editor.inputValue();
  const acceptanceSection = "\n## Chrome 验收\n\n文档变更已通过 ChangeSet 确认。\n";
  await editor.fill(originalDocument + acceptanceSection);
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("heading", { name: "Chrome 验收" }).waitFor();
  if (await page.getByRole("heading", { name: /name:.*version:/ }).count()) {
    throw new Error("SKILL.md frontmatter was rendered as document content");
  }
  await page.screenshot({ path: path.join(artifactDir, "documents-preview-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "预览并保存" }).click();
  const editChangeDialog = page.getByRole("dialog", { name: "确认文档变更" });
  await editChangeDialog.waitFor();
  await editChangeDialog.getByText("修改文档", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "documents-changeset-desktop.png"), fullPage: true });
  await editChangeDialog.getByRole("button", { name: "确认并应用" }).click();
  await editChangeDialog.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "新建文档" }).click();
  const newDocumentDialog = page.getByRole("dialog", { name: "新建 Markdown 文档" });
  await newDocumentDialog.getByLabel("项目内路径").fill("docs/chrome-guide.md");
  await newDocumentDialog.getByRole("button", { name: "创建草稿" }).click();
  await editor.fill("# Chrome Guide\n\n该文档由页面创建，并经过 ChangeSet 确认。\n");
  await page.getByRole("button", { name: "预览并保存" }).click();
  const createChangeDialog = page.getByRole("dialog", { name: "确认文档变更" });
  await createChangeDialog.getByText("新建文档", { exact: true }).waitFor();
  await createChangeDialog.getByRole("button", { name: "确认并应用" }).click();
  await createChangeDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "docs/chrome-guide.md" }).waitFor();

  await page.getByRole("button", { name: "新建文档" }).click();
  const repeatedDocumentDialog = page.getByRole("dialog", { name: "新建 Markdown 文档" });
  await repeatedDocumentDialog.getByLabel("项目内路径").fill("docs/repeated.md");
  await repeatedDocumentDialog.getByRole("button", { name: "创建草稿" }).click();
  await editor.fill("# Guide\n\n## Windows\n\n### Retry\n\nwindows-only\n\n## macOS\n\n### Retry\n\nmac-only\n");
  await page.getByRole("button", { name: "预览并保存" }).click();
  const repeatedChangeDialog = page.getByRole("dialog", { name: "确认文档变更" });
  await repeatedChangeDialog.getByText("新建文档", { exact: true }).waitFor();
  await repeatedChangeDialog.getByRole("button", { name: "确认并应用" }).click();
  await repeatedChangeDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "docs/repeated.md" }).waitFor();

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("需求分析流程 图谱").waitFor();
  await page.locator('.skill-force-graph[data-node-count="3"][data-edge-count="2"]').waitFor();
  await page.getByLabel("搜索图节点").fill("核心步骤");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.getByRole("heading", { name: "核心步骤" }).waitFor();
  await page.getByLabel("搜索图节点").fill("核心");
  await page.getByLabel("搜索图节点").fill("");
  await page.screenshot({ path: path.join(artifactDir, "graph-workflow-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "编辑节点" }).click();
  await page.getByLabel("关联文档").fill("docs/repeated.md");
  await page.getByLabel("标题路径或锚点").fill("Guide/macOS/Retry");
  await page.getByRole("button", { name: "预览文档片段" }).click();
  const exactSlice = page.locator(".document-binding-preview");
  await exactSlice.getByText("Guide/macOS/Retry", { exact: true }).waitFor();
  await exactSlice.locator("pre").filter({ hasText: "mac-only" }).waitFor();
  const exactSliceText = await exactSlice.textContent();
  if (!exactSliceText?.includes("mac-only") || exactSliceText.includes("windows-only")) throw new Error("Exact document slice did not isolate the macOS section");
  await page.screenshot({ path: path.join(artifactDir, "document-slice-desktop.png"), fullPage: true });

  await page.getByLabel("节点标题").fill("需求澄清与确认");
  await clickGraphEditorTool("新增节点");
  const nodeDialog = page.getByRole("dialog", { name: "新增节点" });
  await nodeDialog.getByLabel("节点 ID").fill("flow.chrome-review");
  await nodeDialog.getByLabel("节点标题").fill("Chrome 人工确认");
  await nodeDialog.getByLabel("节点类型").selectOption({ label: "闸门" });
  await nodeDialog.getByRole("button", { name: "加入草稿" }).click();
  await page.locator('.skill-force-graph[data-node-count="4"]').waitFor();
  await page.locator(".graph-inspector").getByRole("heading", { name: "Chrome 人工确认", exact: true }).waitFor();

  await clickGraphEditorTool("新增边");
  const firstEdgeDialog = page.getByRole("dialog", { name: "新增边" });
  await firstEdgeDialog.getByLabel("边 ID").fill("edge.core-chrome-review");
  await firstEdgeDialog.getByLabel("起点").selectOption({ label: "需求澄清与确认" });
  await firstEdgeDialog.getByLabel("终点").selectOption({ label: "Chrome 人工确认" });
  await firstEdgeDialog.getByRole("button", { name: "加入草稿" }).click();

  await clickGraphEditorTool("新增边");
  const secondEdgeDialog = page.getByRole("dialog", { name: "新增边" });
  await secondEdgeDialog.getByLabel("边 ID").fill("edge.chrome-review-end");
  await secondEdgeDialog.getByLabel("起点").selectOption({ label: "Chrome 人工确认" });
  await secondEdgeDialog.getByLabel("终点").selectOption({ label: "完成" });
  await secondEdgeDialog.getByRole("button", { name: "加入草稿" }).click();
  await page.getByText(/形状校验通过（4 节点 \/ 4 边）/).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "graph-editor-draft-desktop.png"), fullPage: true });

  await previewGraphChanges();
  const graphChangeDialog = page.getByRole("dialog", { name: "确认图谱变更" });
  await graphChangeDialog.getByText("flow.chrome-review", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "graph-changeset-desktop.png"), fullPage: true });
  await graphChangeDialog.getByRole("button", { name: "确认并应用" }).click();
  await graphChangeDialog.waitFor({ state: "hidden" });
  await page.locator('.skill-force-graph[data-node-count="4"][data-edge-count="4"]').waitFor();

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  const benchmarkEmpty = page.locator(".runtime-empty");
  await benchmarkEmpty.getByRole("heading", { name: "创建第一个测试用例" }).waitFor();
  await benchmarkEmpty.getByRole("button", { name: "新建测试用例" }).click();
  await page.getByLabel("测试用例标题").fill("Chrome 完整需求确认");
  await page.getByLabel("测试用例状态").selectOption("ready");
  await page.getByLabel("测试意图").fill("完成需求澄清并经过人工确认");
  await page.getByLabel("测试用例标签").fill("smoke, chrome");
  await page.getByLabel("用例初始变量").fill('{"approved":true}');
  await page.getByLabel("预设用户回答").fill('[{"nodeId":"flow.chrome-review","message":"确认通过"}]');
  await page.getByLabel("期望路径模式").selectOption("exact");
  await page.getByLabel("期望路径节点").fill("flow.start\nflow.core-step\nflow.chrome-review\nflow.end");
  await page.getByLabel("期望终态", { exact: true }).selectOption("completed");
  await page.getByLabel("期望终态节点", { exact: true }).selectOption("flow.end");
  await page.getByLabel("禁止副作用").fill("不得修改 Skill 项目\n不得访问项目外路径");
  await page.getByText("校验通过", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "benchmark-case-editor-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "预览并保存用例" }).click();
  const benchmarkCaseDialog = page.getByRole("dialog", { name: "确认测试用例变更" });
  await benchmarkCaseDialog.getByText("新建用例", { exact: true }).waitFor();
  await benchmarkCaseDialog.getByText("创建测试用例 Chrome 完整需求确认", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "benchmark-case-changeset-desktop.png"), fullPage: true });
  await benchmarkCaseDialog.getByRole("button", { name: "确认并应用" }).click();
  await benchmarkCaseDialog.waitFor({ state: "hidden" });
  await page.locator(".benchmark-case-list").getByText("Chrome 完整需求确认", { exact: true }).waitFor();

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("button", { name: "版本与基线" }).click();
  const revisionDialog = page.getByRole("dialog", { name: "版本与基线" });
  await revisionDialog.waitFor();
  await revisionDialog.getByText("5 个文件变化", { exact: true }).waitFor();
  for (const changedFile of ["SKILL.md", "docs/chrome-guide.md", "docs/repeated.md", "graph/main.json"]) {
    await revisionDialog.getByText(changedFile, { exact: true }).waitFor();
  }
  await revisionDialog.getByText(/benchmarks\/cases\/case-.*\.json/).waitFor();
  if ((await revisionDialog.locator(".revision-list li").count()) !== 6) {
    throw new Error(`Expected 6 project revisions, received ${await revisionDialog.locator(".revision-list li").count()}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "revision-history-desktop.png"), fullPage: true });
  await revisionDialog.getByRole("button", { name: "将当前设为已阅" }).click();
  await revisionDialog.getByText("0 个文件变化", { exact: true }).waitFor();
  await revisionDialog.getByText("当前快照与已阅基线一致", { exact: true }).waitFor();
  await revisionDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "导出通用包" }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出通用 Skill 包" });
  await exportDialog.getByText("generic/1", { exact: true }).waitFor();
  await exportDialog.locator(".export-file-section code").filter({ hasText: "engine/skill-engine.mjs" }).waitFor();
  await exportDialog.locator(".export-file-section code").filter({ hasText: "export-manifest.json" }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "export-preview-desktop.png"), fullPage: true });
  await exportDialog.getByRole("button", { name: "确认并生成" }).click();
  await exportDialog.getByRole("button", { name: "下载 ZIP" }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportDialog.getByRole("button", { name: "下载 ZIP" }).click()
  ]);
  const downloadedZip = path.join(artifactDir, "generic-skill-export.zip");
  await download.saveAs(downloadedZip);
  const zip = new AdmZip(downloadedZip);
  const exportedEntries = zip.getEntries().map((entry) => entry.entryName);
  for (const expected of ["SKILL.md", "skill.json", "graph/main.json", "docs/chrome-guide.md", "docs/repeated.md", "engine/skill-engine.mjs", "export-manifest.json"]) {
    if (!exportedEntries.includes(expected)) throw new Error(`Generic export missing ${expected}`);
  }
  if (!exportedEntries.some((entry) => /^benchmarks\/cases\/case-.*\.json$/u.test(entry))) throw new Error("Generic export missing benchmark case");
  if (exportedEntries.some((entry) => entry.includes("workspace.json") || entry.includes("baseline.json") || entry.includes("runtime-artifacts"))) {
    throw new Error("Generic export leaked Studio private data");
  }
  const extractedExport = path.join(artifactDir, "generic-skill-export-extracted");
  await rm(extractedExport, { recursive: true, force: true });
  zip.extractAllTo(extractedExport, true);
  const cliResult = await execFileAsync(process.execPath, [path.join(extractedExport, "engine/skill-engine.mjs"), "inspect"]);
  const cliInspection = JSON.parse(cliResult.stdout);
  if (cliInspection.name !== "需求分析流程" || cliInspection.nodes !== 4) throw new Error("Exported zero-dependency CLI inspected unexpected skill data");
  await exportDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("cell", { name: /术语知识库/ }).click();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("术语知识库 图谱").waitFor();
  await page.locator('.skill-force-graph[data-node-count="1"][data-edge-count="0"]').waitFor();
  await page.getByLabel("搜索图节点").fill("SKILL.md");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.getByRole("heading", { name: "SKILL.md" }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "graph-content-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("cell", { name: /需求分析流程/ }).click();

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: workspaceName }).waitFor();
  await page.getByRole("cell", { name: /需求分析流程/ }).waitFor();
  await page.getByRole("cell", { name: /术语知识库/ }).waitFor();
  await page.getByRole("cell", { name: /Chrome 导入知识/ }).waitFor();
  await page.getByRole("cell", { name: /Chrome Git Skill/ }).waitFor();
  const currentSkill = await page.locator(".current-skill span").textContent();
  if (currentSkill !== "需求分析流程") throw new Error(`Selection did not persist: ${currentSkill}`);
  await page.getByRole("button", { name: "版本与基线" }).click();
  const reloadedRevisionDialog = page.getByRole("dialog", { name: "版本与基线" });
  await reloadedRevisionDialog.getByText("0 个文件变化", { exact: true }).waitFor();
  if ((await reloadedRevisionDialog.locator(".revision-list li").count()) !== 6) {
    throw new Error("Revision history did not persist after reload");
  }
  await reloadedRevisionDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("需求分析流程 图谱").waitFor();
  await page.locator('.skill-force-graph[data-node-count="4"][data-edge-count="4"]').waitFor();
  await page.getByLabel("搜索图节点").fill("需求澄清与确认");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "需求澄清与确认", exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑节点" }).click();
  if ((await page.getByLabel("关联文档").inputValue()) !== "docs/repeated.md") throw new Error("Document binding did not persist after reload");
  if ((await page.getByLabel("标题路径或锚点").inputValue()) !== "Guide/macOS/Retry") throw new Error("Document anchor did not persist after reload");
  await page.getByRole("button", { name: "预览文档片段" }).click();
  await page.locator(".document-binding-preview pre").filter({ hasText: "mac-only" }).waitFor();

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await editor.waitFor();
  if (!(await editor.inputValue()).includes("文档变更已通过 ChangeSet 确认")) {
    throw new Error("Confirmed SKILL.md change did not persist after reload");
  }
  await page.getByRole("button", { name: "docs/chrome-guide.md" }).click();
  if (!(await editor.inputValue()).includes("该文档由页面创建")) {
    throw new Error("New document did not persist after reload");
  }
  const repeatedDocumentButton = page.getByRole("button", { name: /docs\/repeated\.md.*1 引用/ });
  await repeatedDocumentButton.click();
  if (!(await editor.inputValue()).includes("windows-only") || !(await editor.inputValue()).includes("mac-only")) {
    throw new Error("Repeated-heading document did not persist after reload");
  }

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  await page.locator(".benchmark-case-list").getByText("Chrome 完整需求确认", { exact: true }).click();
  if ((await page.getByLabel("期望路径模式").inputValue()) !== "exact") throw new Error("Benchmark case path mode did not persist");
  if (!(await page.getByLabel("预设用户回答").inputValue()).includes("flow.chrome-review")) throw new Error("Benchmark user reply fixture did not persist");
  await page.getByRole("button", { name: "手动运行", exact: true }).click();

  await page.getByRole("button", { name: "新建运行" }).click();
  const runDialog = page.getByRole("dialog", { name: "新建运行" });
  await runDialog.getByLabel("初始 skill 变量（JSON）").fill('{"approved":true}');
  await runDialog.getByRole("button", { name: "启动", exact: true }).click();
  await page.locator(".current-node-block").getByRole("heading", { name: "开始" }).waitFor();
  await page.locator(".trace-flow-node.current").filter({ hasText: "开始" }).waitFor();
  await page.locator(".transition-list").getByRole("button", { name: /需求澄清与确认/ }).click();
  await page.locator(".current-node-block").getByRole("heading", { name: "需求澄清与确认" }).waitFor();
  await page.locator(".trace-flow-node.visited").filter({ hasText: "开始" }).waitFor();
  await page.locator(".trace-flow-node.current").filter({ hasText: "需求澄清与确认" }).waitFor();

  await page.getByLabel("下一节点 ID").fill("flow.not-declared");
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await page.getByText("下一节点被拒绝，运行仍停留在当前节点", { exact: true }).waitFor();
  await page.locator(".current-node-block").getByRole("heading", { name: "需求澄清与确认" }).waitFor();
  await page.locator(".trace-flow-node.rejected").filter({ hasText: "需求澄清与确认" }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "runtime-rejected-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.locator(".runtime-status").getByText("已暂停", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.locator(".runtime-status").getByText("运行中", { exact: true }).waitFor();
  const traceToken = await page.evaluate(async () => {
    const response = await fetch("/api/session", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    return payload.data.token;
  });
  const traceHeaders = { Accept: "application/json", Origin: baseUrl, "x-skill-designer-token": traceToken };
  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, { headers: traceHeaders });
  const workspacePayload = await workspaceResponse.json();
  const traceWorkspace = workspacePayload.data.find((item) => item.name === workspaceName);
  if (!traceWorkspace) throw new Error("External Trace client could not resolve the Chrome workspace");
  const workspaceDetailResponse = await fetch(`${baseUrl}/api/workspaces/${traceWorkspace.workspaceId}`, { headers: traceHeaders });
  const workspaceDetailPayload = await workspaceDetailResponse.json();
  const traceProjectId = workspaceDetailPayload.data.selectedProjectId;
  const runListResponse = await fetch(`${baseUrl}/api/projects/${traceProjectId}/runs`, { headers: traceHeaders });
  const runListPayload = await runListResponse.json();
  const traceRunId = runListPayload.data[0].runId;
  const externalAdvanceResponse = await fetch(`${baseUrl}/api/projects/${traceProjectId}/runs/${traceRunId}/next`, {
    method: "POST",
    headers: { ...traceHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ nextNodeId: "flow.chrome-review" })
  });
  if (!externalAdvanceResponse.ok) throw new Error(`External Trace advance failed with ${externalAdvanceResponse.status}`);
  await page.locator(".current-node-block").getByRole("heading", { name: "Chrome 人工确认" }).waitFor();
  await page.locator(".trace-flow-node.visited").filter({ hasText: "需求澄清与确认" }).waitFor();
  await page.locator(".trace-flow-node.current").filter({ hasText: "Chrome 人工确认" }).waitFor();
  await page.locator(".transition-list").getByRole("button", { name: /完成/ }).click();
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  await page.locator(".trace-flow-node.completed").filter({ hasText: "完成" }).waitFor();
  if ((await page.locator(".trace-flow-edge.traversed").count()) !== 3) throw new Error("Trace graph did not mark the three traversed edges");
  await page.screenshot({ path: path.join(artifactDir, "runtime-completed-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const reportDialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await reportDialog.getByLabel("报告脱敏模式").selectOption("default");
  await reportDialog.getByLabel("报告用户说明").fill("Chrome 拒绝复现 sk-abcdefghijklmnop");
  await reportDialog.getByRole("button", { name: "生成预览" }).click();
  await reportDialog.getByText("本地原始投影", { exact: true }).waitFor();
  await reportDialog.getByText("导出预览", { exact: true }).waitFor();
  const reportPreviewText = await reportDialog.locator(".bug-report-preview-grid > section").nth(1).locator("pre").textContent();
  if (!reportPreviewText?.includes("[REDACTED]") || reportPreviewText.includes("sk-abcdefghijklmnop")) {
    throw new Error("Bug Report preview did not redact the simulated secret");
  }
  if (!reportPreviewText.includes("transition_rejected") || !reportPreviewText.includes("flow.not-declared")) {
    throw new Error("Bug Report preview omitted the observed rejection symptom");
  }
  await page.screenshot({ path: path.join(artifactDir, "bug-report-preview-desktop.png"), fullPage: true });
  await reportDialog.getByRole("button", { name: "确认并生成" }).click();
  await reportDialog.getByText(/\.report\.json/).waitFor();
  const reportDownloadPromise = page.waitForEvent("download");
  await reportDialog.getByRole("button", { name: "下载 JSON" }).click();
  const reportDownload = await reportDownloadPromise;
  const reportDownloadPath = path.join(artifactDir, reportDownload.suggestedFilename());
  await reportDownload.saveAs(reportDownloadPath);
  const downloadedBugReport = JSON.parse(await readFile(reportDownloadPath, "utf8"));
  if (downloadedBugReport.reportVersion !== "1.0" || downloadedBugReport.source.runId !== traceRunId) {
    throw new Error("Downloaded Bug Report identity is incorrect");
  }
  if (JSON.stringify(downloadedBugReport).includes("sk-abcdefghijklmnop") || downloadedBugReport.symptoms[0]?.code !== "transition_rejected") {
    throw new Error("Downloaded Bug Report failed redaction or symptom projection");
  }
  await reportDialog.getByTestId("report-open-diagnosis").click();
  await reportDialog.waitFor({ state: "hidden" });
  await page.getByText("skillId 与 contentHash 精确匹配当前 Workspace 成员", { exact: true }).waitFor();
  if ((await page.getByLabel("报告回放时间轴").inputValue()) !== "4") throw new Error("Imported report did not seek to the first symptom");
  await page.locator(".trace-flow-node.rejected").filter({ hasText: "需求澄清与确认" }).waitFor();
  await page.locator(".report-symptoms").getByText("提交目标 flow.not-declared", { exact: true }).waitFor();
  await page.getByRole("button", { name: "分析原因", exact: true }).click();
  await page.getByRole("heading", { name: "下一节点提交不符合当前合法出口", exact: true }).waitFor();
  await page.getByRole("heading", { name: "提交目标未声明在运行图中", exact: true }).waitFor();
  await page.getByText("报告没有 conversation 事件，无法判断提交来自模型、用户还是测试脚本。", { exact: true }).waitFor();
  if (await page.getByText("已验证", { exact: true }).count()) throw new Error("Diagnosis must not claim a candidate is verified");
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-analysis-desktop.png"), fullPage: true });
  await page.screenshot({ path: path.join(artifactDir, "bug-report-replay-desktop.png"), fullPage: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: workspaceName }).waitFor();
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await page.getByText("skillId 与 contentHash 精确匹配当前 Workspace 成员", { exact: true }).waitFor();
  await page.locator(".trace-flow-node.rejected").filter({ hasText: "需求澄清与确认" }).waitFor();
  await page.getByRole("heading", { name: "下一节点提交不符合当前合法出口", exact: true }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();

  await page.getByRole("button", { name: "回放", exact: true }).click();
  if ((await page.getByLabel("Trace 回放时间轴").inputValue()) !== "1") throw new Error("Trace replay did not start at the first event");
  await page.locator(".trace-flow-node.current").filter({ hasText: "开始" }).waitFor();
  await page.getByTitle("下一个事件").click();
  await page.getByTitle("下一个事件").click();
  await page.locator(".trace-flow-node.current").filter({ hasText: "需求澄清与确认" }).waitFor();
  await page.getByLabel("Trace 回放时间轴").focus();
  await page.getByLabel("Trace 回放时间轴").press("ArrowRight");
  await page.locator(".trace-flow-node.rejected").filter({ hasText: "需求澄清与确认" }).waitFor();
  await page.getByText("回放只读取已记录事件，不会改变运行或验证状态。", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "trace-replay-rejected-desktop.png"), fullPage: true });
  await page.getByLabel("回放速度").selectOption("350");
  await page.getByTitle("播放回放").click();
  await page.locator(".trace-flow-node.completed").filter({ hasText: "完成" }).waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "实时", exact: true }).click();

  await page.getByRole("button", { name: "新建运行" }).click();
  const comparisonRunDialog = page.getByRole("dialog", { name: "新建运行" });
  await comparisonRunDialog.getByRole("button", { name: "启动", exact: true }).click();
  await page.locator(".transition-list").getByRole("button", { name: /需求澄清与确认/ }).click();
  await page.locator(".current-node-block").getByRole("heading", { name: "需求澄清与确认" }).waitFor();
  await page.locator(".transition-list").getByRole("button", { name: /^完成/ }).click();
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  await page.getByLabel("对比运行").selectOption({ index: 1 });
  await page.getByText("首个路径偏差 #3：flow.end / flow.chrome-review", { exact: true }).waitFor();
  await page.getByText("Revision 相同", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "trace-run-comparison-desktop.png"), fullPage: true });

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: workspaceName }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  await page.locator(".trace-flow-node.completed").filter({ hasText: "完成" }).waitFor();
  if ((await page.locator(".runtime-events li").count()) < 5) throw new Error("Persisted runtime event sequence is incomplete");

  await page.getByRole("button", { name: "工作区", exact: true }).click();

  await page.screenshot({ path: path.join(artifactDir, "workspace-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: workspaceName }).waitFor();
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  if (overflow.document > overflow.viewport) {
    throw new Error(`Mobile horizontal overflow: ${overflow.document}px > ${overflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "workspace-mobile.png"), fullPage: true });

  await page.getByRole("button", { name: "导入 Skill" }).click();
  const mobileImportDialog = page.getByRole("dialog", { name: "导入 Skill 文件夹" });
  await mobileImportDialog.getByText("选择一个 Skill 文件夹", { exact: true }).waitFor();
  const importMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (importMobileOverflow.document > importMobileOverflow.viewport) {
    throw new Error(`Mobile import modal horizontal overflow: ${importMobileOverflow.document}px > ${importMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "import-mobile.png"), fullPage: true });
  await mobileImportDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("cell", { name: /Chrome Git Skill/ }).click();
  await page.getByRole("button", { name: "Git 对比" }).click();
  const mobileGitDialog = page.getByRole("dialog", { name: "Git 对比" });
  await mobileGitDialog.locator(".git-patch-section pre").getByText(/Chrome 工作树修改/).waitFor();
  const gitMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (gitMobileOverflow.document > gitMobileOverflow.viewport) {
    throw new Error(`Mobile Git diff horizontal overflow: ${gitMobileOverflow.document}px > ${gitMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "git-diff-mobile.png"), fullPage: true });
  await mobileGitDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("cell", { name: /需求分析流程/ }).click();
  await page.locator(".detail-heading").getByRole("heading", { name: "需求分析流程" }).waitFor();

  await page.getByRole("button", { name: "导出通用包" }).click();
  const mobileExportDialog = page.getByRole("dialog", { name: "导出通用 Skill 包" });
  await mobileExportDialog.getByText("generic/1", { exact: true }).waitFor();
  const exportMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (exportMobileOverflow.document > exportMobileOverflow.viewport) {
    throw new Error(`Mobile export modal horizontal overflow: ${exportMobileOverflow.document}px > ${exportMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "export-mobile.png"), fullPage: true });
  await mobileExportDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "版本与基线" }).click();
  const mobileRevisionDialog = page.getByRole("dialog", { name: "版本与基线" });
  await mobileRevisionDialog.getByText("当前快照与已阅基线一致", { exact: true }).waitFor();
  const revisionMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (revisionMobileOverflow.document > revisionMobileOverflow.viewport) {
    throw new Error(`Mobile revision modal horizontal overflow: ${revisionMobileOverflow.document}px > ${revisionMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "revision-history-mobile.png"), fullPage: true });
  await mobileRevisionDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  await page.locator(".benchmark-case-list").getByText("Chrome 完整需求确认", { exact: true }).waitFor();
  const benchmarkMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (benchmarkMobileOverflow.document > benchmarkMobileOverflow.viewport) {
    throw new Error(`Mobile benchmark case horizontal overflow: ${benchmarkMobileOverflow.document}px > ${benchmarkMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "benchmark-case-mobile.png"), fullPage: true });

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("需求分析流程 图谱").waitFor();
  await page.locator('.skill-force-graph[data-node-count="4"][data-edge-count="4"]').waitFor();
  await page.waitForTimeout(500);
  const graphMobileOverflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  if (graphMobileOverflow.document > graphMobileOverflow.viewport) {
    throw new Error(`Mobile graph horizontal overflow: ${graphMobileOverflow.document}px > ${graphMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "graph-editor-mobile.png"), fullPage: true });
  await page.getByLabel("搜索图节点").fill("需求澄清与确认");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "需求澄清与确认", exact: true }).waitFor();
  await page.getByRole("button", { name: "预览文档片段" }).click();
  await page.locator(".document-binding-preview pre").filter({ hasText: "mac-only" }).waitFor();
  const sliceMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (sliceMobileOverflow.document > sliceMobileOverflow.viewport) {
    throw new Error(`Mobile document slice horizontal overflow: ${sliceMobileOverflow.document}px > ${sliceMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "document-slice-mobile.png"), fullPage: true });

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await editor.waitFor();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("heading", { name: "Chrome 验收" }).waitFor();
  const docsOverflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  if (docsOverflow.document > docsOverflow.viewport) {
    throw new Error(`Mobile documents horizontal overflow: ${docsOverflow.document}px > ${docsOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "documents-mobile.png"), fullPage: true });

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  await page.locator(".trace-flow-node.completed").filter({ hasText: "完成" }).waitFor();
  await page.getByLabel("对比运行").selectOption({ index: 1 });
  await page.getByText("首个路径偏差 #3：flow.end / flow.chrome-review", { exact: true }).waitFor();
  const runtimeMobileOverflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  if (runtimeMobileOverflow.document > runtimeMobileOverflow.viewport) {
    throw new Error(`Mobile runtime horizontal overflow: ${runtimeMobileOverflow.document}px > ${runtimeMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "runtime-mobile.png"), fullPage: true });

  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const mobileReportDialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await mobileReportDialog.getByLabel("报告脱敏模式").selectOption("strict");
  await mobileReportDialog.getByLabel("报告用户说明").fill("移动端严格脱敏预览");
  await mobileReportDialog.getByRole("button", { name: "生成预览" }).click();
  await mobileReportDialog.getByText("导出预览", { exact: true }).waitFor();
  const reportMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (reportMobileOverflow.document > reportMobileOverflow.viewport) {
    throw new Error(`Mobile Bug Report horizontal overflow: ${reportMobileOverflow.document}px > ${reportMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "bug-report-preview-mobile.png"), fullPage: true });
  await mobileReportDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await page.getByText("skillId 与 contentHash 精确匹配当前 Workspace 成员", { exact: true }).waitFor();
  await page.locator(".trace-flow-node.rejected").filter({ hasText: "需求澄清与确认" }).waitFor();
  await page.getByRole("heading", { name: "下一节点提交不符合当前合法出口", exact: true }).waitFor();
  const diagnosisMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (diagnosisMobileOverflow.document > diagnosisMobileOverflow.viewport) {
    throw new Error(`Mobile report replay horizontal overflow: ${diagnosisMobileOverflow.document}px > ${diagnosisMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-analysis-mobile.png"), fullPage: true });
  await page.screenshot({ path: path.join(artifactDir, "bug-report-replay-mobile.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 960 });
  const repairableReport = structuredClone(downloadedBugReport);
  repairableReport.symptoms[0].requestedNodeId = "flow.start";
  repairableReport.trace.find((event) => event.type === "engine.reject").data.requestedNodeId = "flow.start";
  const repairableReportPath = path.join(artifactDir, "repairable-report.json");
  await writeFile(repairableReportPath, JSON.stringify(repairableReport, null, 2));
  await page.locator('.diagnosis-toolbar input[type="file"]').setInputFiles(repairableReportPath);
  await page.getByText("skillId 与 contentHash 精确匹配当前 Workspace 成员", { exact: true }).waitFor();
  await page.getByRole("button", { name: "分析原因", exact: true }).click();
  const repairCandidate = page.locator(".diagnosis-candidate-list article").filter({ has: page.getByRole("button", { name: "生成修复提案", exact: true }) });
  await repairCandidate.getByText("添加 flow.core-step -> flow.start 的回退边", { exact: true }).waitFor();
  await repairCandidate.getByRole("button", { name: "生成修复提案", exact: true }).click();
  const repairDialog = page.getByRole("dialog", { name: "确认诊断修复提案" });
  await repairDialog.getByText("edge.diagnosis-4", { exact: true }).waitFor();
  await repairDialog.getByText("尚未修改 Skill", { exact: false }).waitFor();
  const repairMetadata = repairDialog.getByTestId("changeset-metadata");
  await repairMetadata.getByText("诊断修复建议", { exact: true }).waitFor();
  await repairMetadata.getByText("诊断结论", { exact: true }).waitFor();
  await repairMetadata.getByText("Trace 事件", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-repair-proposal-desktop.png"), fullPage: true });
  await repairDialog.getByRole("button", { name: "拒绝提案", exact: true }).click();
  await repairDialog.getByText("该 ChangeSet 已被拒绝，不会修改项目；需要调整时请重新生成提案。", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-repair-rejected-desktop.png"), fullPage: true });
  await repairDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  const rejectedRepairCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: "添加 flow.core-step -> flow.start 的回退边" });
  await rejectedRepairCandidate.getByText("提案已拒绝", { exact: true }).waitFor();
  await rejectedRepairCandidate.getByRole("button", { name: "重新生成修复提案", exact: true }).click();
  const replacementRepairDialog = page.getByRole("dialog", { name: "确认诊断修复提案" });
  await replacementRepairDialog.getByText("edge.diagnosis-4", { exact: true }).waitFor();
  await replacementRepairDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await replacementRepairDialog.waitFor({ state: "hidden" });
  const appliedRepairCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: "添加 flow.core-step -> flow.start 的回退边" });
  await appliedRepairCandidate.getByText("未验证", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-repair-unverified-desktop.png"), fullPage: true });

  await appliedRepairCandidate.getByRole("button", { name: "前往测试运行", exact: true }).click();
  await page.getByRole("button", { name: "新建运行" }).click();
  const repairRunDialog = page.getByRole("dialog", { name: "新建运行" });
  await repairRunDialog.getByRole("button", { name: "启动", exact: true }).click();
  await page.locator(".transition-list").getByRole("button", { name: /需求澄清与确认/ }).click();
  await page.locator(".current-node-block").getByRole("heading", { name: "需求澄清与确认" }).waitFor();
  await page.locator(".transition-list").getByRole("button", { name: /^开始/ }).click();
  await page.locator(".current-node-block").getByRole("heading", { name: "开始" }).waitFor();
  await page.locator(".transition-list").getByRole("button", { name: /需求澄清与确认/ }).click();
  await page.locator(".transition-list").getByRole("button", { name: /^完成/ }).click();
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();

  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await page.getByText("skillId 匹配，但当前内容指纹不同；使用报告自带图复现", { exact: true }).waitFor();
  const persistedRepairCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: "添加 flow.core-step -> flow.start 的回退边" });
  await persistedRepairCandidate.getByText("未验证", { exact: true }).waitFor();
  await persistedRepairCandidate.getByLabel("选择修复后运行").selectOption({ index: 1 });
  await persistedRepairCandidate.getByRole("button", { name: "验证", exact: true }).click();
  await persistedRepairCandidate.getByText("已验证", { exact: true }).waitFor();
  await persistedRepairCandidate.getByText("Trace 实际经过新增边 edge.diagnosis-4", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-repair-verified-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const repairMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (repairMobileOverflow.document > repairMobileOverflow.viewport) {
    throw new Error(`Mobile diagnosis repair horizontal overflow: ${repairMobileOverflow.document}px > ${repairMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-repair-verified-mobile.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 960 });
  const reportReuse = page.getByTestId("report-reuse");
  await reportReuse.scrollIntoViewIfNeeded();
  await page.getByTestId("fixture-lane").getByRole("button", { name: "生成并验证夹具", exact: true }).click();
  await page.getByTestId("fixture-lane").getByText("已保存并重放一致", { exact: true }).waitFor();
  await page.getByTestId("fixture-lane").getByText("不计入 Benchmark", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "report-fixture-desktop.png"), fullPage: true });

  await page.getByTestId("benchmark-candidate-lane").getByRole("button", { name: "生成候选用例", exact: true }).click();
  const reportBenchmarkDialog = page.getByRole("dialog", { name: "补充候选 Benchmark 用例" });
  await reportBenchmarkDialog.getByText("来源身份不可修改", { exact: false }).waitFor();
  await reportBenchmarkDialog.getByLabel("候选用例标题").fill("报告回归：非法回退后完成流程");
  await reportBenchmarkDialog.getByLabel("候选用例业务意图").fill("人工确认非法回退被拒绝，随后仍可沿合法路径完成流程。");
  await reportBenchmarkDialog.getByLabel("候选用例补充说明").fill("由 Chrome 页面操作补充；保持 draft，等待真实模型 Benchmark。");
  await page.screenshot({ path: path.join(artifactDir, "report-benchmark-candidate-editor-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const candidateMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (candidateMobileOverflow.document > candidateMobileOverflow.viewport) {
    throw new Error(`Mobile report benchmark editor horizontal overflow: ${candidateMobileOverflow.document}px > ${candidateMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "report-benchmark-candidate-editor-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByTestId("propose-benchmark-candidate").click();
  const reportBenchmarkConfirmDialog = page.getByRole("dialog", { name: "确认候选 Benchmark 变更" });
  await reportBenchmarkConfirmDialog.getByText("项目中不存在", { exact: false }).waitFor();
  await reportBenchmarkConfirmDialog.getByText("Bug Report → 人工补充 → ChangeSet → 项目 Benchmark 用例", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "report-benchmark-changeset-desktop.png"), fullPage: true });
  await reportBenchmarkConfirmDialog.getByRole("button", { name: "拒绝提案", exact: true }).click();
  await reportBenchmarkConfirmDialog.getByText("该 ChangeSet 已被拒绝，不会修改项目；需要调整时请重新生成提案。", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "report-benchmark-rejected-desktop.png"), fullPage: true });
  await reportBenchmarkConfirmDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  const benchmarkCandidateLane = page.getByTestId("benchmark-candidate-lane");
  await benchmarkCandidateLane.getByText("ChangeSet 已拒绝", { exact: true }).waitFor();
  await benchmarkCandidateLane.getByRole("button", { name: "重新生成候选用例", exact: true }).click();
  const replacementBenchmarkDialog = page.getByRole("dialog", { name: "补充候选 Benchmark 用例" });
  await replacementBenchmarkDialog.getByLabel("候选用例标题").fill("报告回归：非法回退后完成流程");
  await replacementBenchmarkDialog.getByLabel("候选用例业务意图").fill("人工确认非法回退被拒绝，随后仍可沿合法路径完成流程。");
  await replacementBenchmarkDialog.getByLabel("候选用例补充说明").fill("拒绝首个 ChangeSet 后重新生成；保持 draft，等待真实模型 Benchmark。");
  await page.getByTestId("propose-benchmark-candidate").click();
  const replacementBenchmarkConfirmDialog = page.getByRole("dialog", { name: "确认候选 Benchmark 变更" });
  await replacementBenchmarkConfirmDialog.getByText("项目中不存在", { exact: false }).waitFor();
  await page.getByTestId("confirm-benchmark-candidate").click();
  await replacementBenchmarkConfirmDialog.waitFor({ state: "hidden" });
  await page.getByTestId("benchmark-candidate-lane").getByText("已加入项目 · draft", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "report-reuse-applied-desktop.png"), fullPage: true });

  await page.getByTestId("benchmark-candidate-lane").getByRole("button", { name: "前往测试用例", exact: true }).click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  await page.locator(".benchmark-case-list").getByText("报告回归：非法回退后完成流程", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const convertedCaseMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (convertedCaseMobileOverflow.document > convertedCaseMobileOverflow.viewport) {
    throw new Error(`Mobile converted benchmark case horizontal overflow: ${convertedCaseMobileOverflow.document}px > ${convertedCaseMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "report-benchmark-applied-mobile.png"), fullPage: true });

  await page.getByLabel("查看沙箱能力").click();
  const sandboxCapabilityDialog = page.getByRole("dialog", { name: "沙箱能力" });
  await sandboxCapabilityDialog.getByText("当前机器没有可用沙箱", { exact: true }).waitFor();
  await sandboxCapabilityDialog.locator(".sandbox-backends article").first().getByText("未安装 Docker CLI", { exact: true }).waitFor();
  await sandboxCapabilityDialog.getByText("不采用", { exact: true }).waitFor();
  await page.getByTestId("run-sandbox-self-test").click();
  const sandboxSelfTest = page.getByTestId("sandbox-self-test");
  await sandboxSelfTest.getByText("无法运行", { exact: true }).waitFor();
  await sandboxSelfTest.getByText("未检测到可用的本机 Docker Desktop", { exact: true }).waitFor();
  await sandboxSelfTest.getByText(/sandbox-self-test-/u).waitFor();
  const sandboxMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (sandboxMobileOverflow.document > sandboxMobileOverflow.viewport) {
    throw new Error(`Mobile sandbox capability horizontal overflow: ${sandboxMobileOverflow.document}px > ${sandboxMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "sandbox-capability-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: path.join(artifactDir, "sandbox-capability-desktop.png"), fullPage: true });
  await sandboxCapabilityDialog.getByRole("button", { name: "重新检测", exact: true }).click();
  await sandboxCapabilityDialog.locator(".sandbox-backends article").first().getByText("未安装 Docker CLI", { exact: true }).waitFor();
  await sandboxCapabilityDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("查看沙箱能力").click();
  const reopenedSandboxDialog = page.getByRole("dialog", { name: "沙箱能力" });
  await reopenedSandboxDialog.getByTestId("sandbox-self-test").getByText("无法运行", { exact: true }).waitFor();
  await reopenedSandboxDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "真实测试", exact: true }).click();
  const benchmarkPreflight = page.getByTestId("benchmark-preflight");
  await benchmarkPreflight.getByText("OpenAI Responses API", { exact: true }).waitFor();
  await benchmarkPreflight.getByText("真实沙箱未就绪", { exact: true }).waitFor();
  await benchmarkPreflight.getByText("运行将记录为 blocked", { exact: true }).waitFor();
  await benchmarkPreflight.getByText("真实沙箱生命周期自检未通过", { exact: true }).waitFor();
  await benchmarkPreflight.getByText("未配置固定 digest 的 runner 镜像", { exact: true }).waitFor();
  const benchmarkCaseSelect = page.getByLabel("Benchmark 用例");
  if (!(await benchmarkCaseSelect.inputValue())) await benchmarkCaseSelect.selectOption({ index: 1 });
  await page.getByTestId("start-real-benchmark").click();
  const benchmarkFailure = page.locator(".benchmark-run-failure");
  await benchmarkFailure.getByText("沙箱不可用", { exact: true }).waitFor();
  await page.locator(".benchmark-run-summary").getByText("未运行", { exact: true }).waitFor();
  const benchmarkSummary = page.locator(".benchmark-run-summary");
  if ((await benchmarkSummary.locator("div").filter({ hasText: /^模型调用0$/u }).count()) !== 1) throw new Error("Blocked Benchmark recorded a model call");
  if ((await benchmarkSummary.locator("div").filter({ hasText: /^Token0$/u }).count()) !== 1) throw new Error("Blocked Benchmark recorded token usage");
  await page.locator(".benchmark-fingerprint").getByText("preflight 前阻断，未冻结", { exact: true }).waitFor();
  const benchmarkReviews = page.getByTestId("benchmark-reviews");
  await benchmarkReviews.getByText("只有技术执行完成的运行可以人工判定；条件阻断或技术失败不能手工改成通过。", { exact: true }).waitFor();
  if (await page.getByTestId("save-benchmark-review").isEnabled()) throw new Error("Blocked Benchmark allowed a human pass override");
  if (await page.getByLabel("人工判定备注").isEnabled()) throw new Error("Blocked Benchmark enabled the review note editor");
  await page.getByLabel("Benchmark 运行方式").getByRole("button", { name: "批量", exact: true }).click();
  const batchCases = page.getByRole("group", { name: "批量 Benchmark 用例" });
  await batchCases.getByRole("checkbox").first().check();
  const batchStart = page.getByTestId("start-real-benchmark");
  await batchStart.getByText("批量入队 1", { exact: true }).waitFor();
  await batchStart.click();
  await page.locator(".benchmark-run-list .run-status-dot.blocked").nth(1).waitFor();
  await page.locator(".benchmark-run-list > header strong").getByText("2", { exact: true }).waitFor();
  await page.locator(".benchmark-run-failure").getByText("沙箱不可用", { exact: true }).waitFor();
  if (await page.getByTestId("save-benchmark-review").isEnabled()) throw new Error("Blocked batch run allowed a human pass override");
  await page.getByTestId("rerun-benchmark").click();
  await page.locator(".benchmark-run-list .run-status-dot.blocked").nth(2).waitFor();
  await page.locator(".benchmark-run-list > header strong").getByText("3", { exact: true }).waitFor();
  const benchmarkComparison = page.getByTestId("benchmark-comparison");
  await benchmarkComparison.getByText("关联运行对比", { exact: true }).waitFor();
  await benchmarkComparison.getByText("条件阻断 -> 条件阻断", { exact: true }).waitFor();
  await benchmarkComparison.getByText("两次均在 Artifact 冻结前结束", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "benchmark-runner-blocked-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const realBenchmarkMobileOverflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (realBenchmarkMobileOverflow.document > realBenchmarkMobileOverflow.viewport) {
    throw new Error(`Mobile real Benchmark horizontal overflow: ${realBenchmarkMobileOverflow.document}px > ${realBenchmarkMobileOverflow.viewport}px`);
  }
  await page.screenshot({ path: path.join(artifactDir, "benchmark-runner-blocked-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);

  console.log("Chrome workflow verified: create workspace, add 2 skills, switch, navigate, reload persistence.");
  console.log("Chrome graph verified: workflow 3-node flow, search/inspect, content-only 1-node graph with 0 edges.");
  console.log("Chrome graph editor verified: update node, create node, create edges, lint, ChangeSet confirm/apply, reload persistence.");
  console.log("Chrome documents verified: edit, preview, ChangeSet confirm/apply, create document, reload persistence.");
  console.log("Chrome runtime verified: start, legal/rejected transitions, pause/resume, external WebSocket push, completion, reload persistence.");
  console.log("Chrome Trace analysis verified: sequence stepping, timeline seek, speed playback, read-only replay, and first path divergence across two runs.");
  console.log("Chrome Bug Report verified: observed-fact projection, default/strict preview, mandatory secret redaction, confirmation, JSON download, and mobile layout.");
  console.log("Chrome report import verified: confirmed report attached directly to diagnosis, exact skillId/contentHash match, persistence, first-symptom seek, self-contained graph replay, and mobile layout.");
  console.log("Chrome diagnosis verified: evidence-backed candidates, explicit uncertainty, no automatic repair/verification claim, persistence, and mobile layout.");
  console.log("Chrome assisted repair verified: proposal-only diff, explicit confirmation, unverified state, post-revision runtime traversal, verified evidence, and mobile layout.");
  console.log("Chrome report reuse verified: deterministic internal fixture replay, editable draft Benchmark candidate, ChangeSet preview, explicit apply, provenance, and mobile layout.");
  console.log("Chrome sandbox capability verified: honest unavailable state, fixed policy, backend checks, refresh, and desktop/mobile layout without claiming Benchmark readiness.");
  console.log("Chrome sandbox lifecycle verified: fixed self-test action, persisted unavailable evidence, and no unsandboxed fallback when Docker Desktop is absent.");
  console.log("Chrome real Benchmark runner verified: provider/sandbox preflight, single and explicit batch enqueue, explicit rerun lineage/comparison, blocked records, zero model calls/tokens, review lock, frozen fingerprint boundary, and desktop/mobile layout.");
  console.log("Chrome document slicing verified: duplicate titles, exact path binding, isolated preview, reference count, reload persistence, mobile layout.");
  console.log("Chrome benchmark case editor verified: project file, exact path, user reply fixture, terminal/effect assertions, ChangeSet, export, reload, mobile layout.");
  console.log("Chrome revisions verified: 6 immutable revisions, 5 changed files, exact baseline acknowledgement, reload persistence.");
  console.log("Chrome import verified: directory selection, static preview, content-only fallback, script warning, confirmation, preserved membership.");
  console.log("Chrome export verified: pinned generic/1 preview, ZIP download, private-data exclusion, zero-dependency CLI execution.");
  console.log("Chrome Git verified: explicit in-place open, HEAD-scoped status/patch, project boundary isolation, mobile diff layout.");
  console.log(`Desktop screenshot: ${path.join(artifactDir, "workspace-desktop.png")}`);
  console.log(`Mobile screenshot: ${path.join(artifactDir, "workspace-mobile.png")}`);
} finally {
  await browser.close();
}
