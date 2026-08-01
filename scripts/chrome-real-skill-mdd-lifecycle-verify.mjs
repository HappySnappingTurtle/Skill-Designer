import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const execFileAsync = promisify(execFile);
const skillRoot = "/Users/hongyuwu/IdeaProjects/yds-skills/mdd-backend-extend-develop";
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-real-mdd-lifecycle-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/real-skill-mdd-lifecycle");
const baseUrl = "http://127.0.0.1:4353";
const editedDocumentPath = "references/routing-table.md";
const editedAnchor = "MDD 完整路由表/1. 需求特征 → Workflow";
await mkdir(artifactDir, { recursive: true });

const sourceBefore = await hashTree(skillRoot);
const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const provider = {
  async probe() {
    return {
      schemaVersion: "1.0",
      providerId: "real-mdd-lifecycle",
      label: "真实 MDD 生命周期验收模型",
      status: "ready",
      keyConfigured: true,
      defaultModel: "real-mdd-lifecycle-model",
      reason: "ready",
      checkedAt: new Date().toISOString()
    };
  },
  async invoke() {
    return {
      providerId: "real-mdd-lifecycle",
      responseId: `real-mdd-lifecycle-${Date.now()}`,
      model: "real-mdd-lifecycle-model",
      output: { action: "reply", reply: "本验收使用手动引擎推进。", nextNodeId: null, summary: "保持当前节点" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1
    };
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const importLLMParser = {
  latest: async () => null,
  start: async () => { throw new Error("LLM parsing is outside this lifecycle verification"); },
  cancel: async () => null
};
const server = createApp({
  store,
  runtimeDebug,
  benchmarkRunner: { list: async () => [] },
  importLLMParser,
  allowedOrigins: [baseUrl]
});
await new Promise((resolve) => server.listen(4353, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, acceptDownloads: true });
page.setDefaultTimeout(45_000);
const consoleErrors = [];
const failedResponses = [];
const traceCanvasChecks = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

let workspaceId;
let projectId;
let skillId;
let sourceRunId;
let reportId;
let repairId;

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("用户真实 MDD Skill 完整链路");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "用户真实 MDD Skill 完整链路" }).waitFor();

  await page.getByRole("button", { name: "导入 Skill", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "导入 Skill 文件夹" });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    importDialog.getByText("选择一个 Skill 文件夹", { exact: true }).click()
  ]);
  await chooser.setFiles(skillRoot);
  await importDialog.getByText(`${sourceBefore.size} 个文件`, { exact: false }).waitFor();
  const [previewResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/workspaces\/[^/]+\/imports$/u.test(new URL(response.url()).pathname)),
    importDialog.getByRole("button", { name: "扫描并预检", exact: true }).click()
  ]);
  const preview = (await previewResponse.json()).data;
  const candidate = preview.candidate;
  if (candidate.parseReview.lint.some((issue) => issue.severity === "error")) throw new Error(`Real Skill parse lint blocked lifecycle: ${JSON.stringify(candidate.parseReview.lint)}`);
  await importDialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await importDialog.waitFor({ state: "hidden" });
  const member = (await store.getWorkspace(preview.workspace.workspaceId)).members.find((item) => item.projectId === candidate.projectId);
  if (!member || member.status !== "ready") throw new Error("Real Skill did not become ready");
  workspaceId = preview.workspace.workspaceId;
  projectId = member.projectId;
  skillId = member.skillId;

  const importedGraph = await store.getProjectGraph(projectId);
  const startNode = importedGraph.graph.nodes.find((node) => node.kind === "start");
  const endNode = importedGraph.graph.nodes.find((node) => node.kind === "end");
  const stepNode = importedGraph.graph.nodes.find((node) => node.kind === "step");
  if (!startNode || !endNode || !stepNode) throw new Error("Imported workflow is missing start, step, or end nodes");
  const orderedPath = sequentialPath(importedGraph.graph, startNode.id, endNode.id);
  if (orderedPath.length !== importedGraph.graph.nodes.length) throw new Error(`Static graph is not one complete sequential path: ${JSON.stringify(orderedPath)}`);

  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill("routing-table");
  await page.getByRole("button", { name: new RegExp(escapeRegExp(editedDocumentPath), "u") }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  const originalDocument = await editor.inputValue();
  const acceptanceSection = "\n## Studio 真实链路验收\n\n该段只写入临时管理副本，并经过 ChangeSet 用户确认。\n";
  await editor.fill(originalDocument + acceptanceSection);
  await page.getByRole("button", { name: "预览并保存", exact: true }).click();
  const documentChangeDialog = page.getByRole("dialog", { name: "确认文档变更" });
  await documentChangeDialog.getByText("修改文档", { exact: true }).waitFor();
  await documentChangeDialog.getByText(editedDocumentPath, { exact: true }).waitFor();
  if ((await store.readDocument(projectId, editedDocumentPath)).content !== originalDocument) throw new Error("Document changed before page confirmation");
  await page.screenshot({ path: path.join(artifactDir, "document-changeset-desktop.png"), fullPage: true });
  await documentChangeDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await documentChangeDialog.waitFor({ state: "hidden" });
  if (!(await store.readDocument(projectId, editedDocumentPath)).content.includes("Studio 真实链路验收")) throw new Error("Confirmed document edit was not persisted");

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("搜索图节点").fill(stepNode.title);
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: stepNode.title, exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑节点", exact: true }).click();
  await page.getByLabel("关联文档").fill(editedDocumentPath);
  await page.getByLabel("标题路径或锚点").fill(editedAnchor);
  await page.getByRole("button", { name: "预览文档片段", exact: true }).click();
  await page.locator(".document-binding-preview").getByText(editedAnchor, { exact: true }).waitFor();
  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  await page.getByRole("button", { name: "预览并保存图", exact: true }).click();
  const graphChangeDialog = page.getByRole("dialog", { name: "确认图谱变更" });
  await graphChangeDialog.getByText(stepNode.id, { exact: true }).waitFor();
  const beforeBinding = await store.getProjectGraph(projectId);
  const nodeBeforeConfirmation = beforeBinding.graph.nodes.find((node) => node.id === stepNode.id);
  if (nodeBeforeConfirmation?.doc !== stepNode.doc || nodeBeforeConfirmation?.docAnchor !== stepNode.docAnchor) {
    throw new Error("Node binding changed before confirmation");
  }
  await page.screenshot({ path: path.join(artifactDir, "graph-binding-changeset-desktop.png"), fullPage: true });
  await graphChangeDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await graphChangeDialog.waitFor({ state: "hidden" });
  const boundNode = (await store.getProjectGraph(projectId)).graph.nodes.find((node) => node.id === stepNode.id);
  if (boundNode?.doc !== editedDocumentPath || boundNode.docAnchor !== editedAnchor) throw new Error("Confirmed nested document binding was not persisted");

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "导出通用包", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出通用 Skill 包" });
  await exportDialog.getByText("generic/1", { exact: true }).waitFor();
  await exportDialog.locator(".export-file-section code").filter({ hasText: editedDocumentPath }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "generic-export-preview-desktop.png"), fullPage: true });
  await exportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await exportDialog.getByRole("button", { name: "下载 ZIP", exact: true }).waitFor();
  const [exportDownload] = await Promise.all([
    page.waitForEvent("download"),
    exportDialog.getByRole("button", { name: "下载 ZIP", exact: true }).click()
  ]);
  const zipPath = path.join(artifactDir, "real-mdd-generic.zip");
  await exportDownload.saveAs(zipPath);
  const zip = new AdmZip(zipPath);
  const exportEntries = zip.getEntries().map((entry) => entry.entryName);
  for (const sourcePath of sourceBefore.keys()) if (!exportEntries.includes(sourcePath)) throw new Error(`Generic export lost original path: ${sourcePath}`);
  for (const required of ["skill.json", "graph/main.json", "engine/skill-engine.mjs", "engine/README.md", "export-manifest.json"]) {
    if (!exportEntries.includes(required)) throw new Error(`Generic export is missing ${required}`);
  }
  if (exportEntries.some((entry) => entry.includes("workspace.json") || entry.includes("runtime-artifact") || entry.includes("baseline.json"))) {
    throw new Error("Generic export leaked Studio-private files");
  }
  const extracted = path.join(artifactDir, "real-mdd-generic-extracted");
  await rm(extracted, { recursive: true, force: true });
  zip.extractAllTo(extracted, true);
  const cliInspection = JSON.parse((await execFileAsync(process.execPath, [path.join(extracted, "engine", "skill-engine.mjs"), "inspect"])).stdout);
  if (cliInspection.nodes !== importedGraph.graph.nodes.length || cliInspection.edges !== importedGraph.graph.edges.length) throw new Error(`Generic CLI inspected the wrong graph: ${JSON.stringify(cliInspection)}`);
  await exportDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await startRun(page, startNode.title);
  await page.getByLabel("下一节点 ID").fill(endNode.id);
  await page.locator(".manual-transition").getByRole("button", { name: "提交", exact: true }).click();
  await page.getByText("错误码：next_node_not_allowed", { exact: false }).waitFor();
  await page.locator(".trace-flow-node.rejected").filter({ hasText: startNode.title }).waitFor();
  traceCanvasChecks.push(await verifyTraceGraph(page, "runtime rejection"));
  await page.screenshot({ path: path.join(artifactDir, "runtime-rejection-trace-desktop.png"), fullPage: true });

  for (const nodeId of orderedPath.slice(1)) {
    const node = importedGraph.graph.nodes.find((candidateNode) => candidateNode.id === nodeId);
    if (!node) throw new Error(`Sequential node disappeared: ${nodeId}`);
    await page.locator(".transition-list").getByRole("button", { name: new RegExp(escapeRegExp(node.title), "u") }).click();
    await page.locator(".current-node-block").getByRole("heading", { name: node.title, exact: true }).waitFor();
  }
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  const completedRun = (await store.listRuns(projectId)).find((run) => run.state.status === "completed");
  if (!completedRun || !completedRun.events.some((event) => event.type === "engine.reject")) throw new Error("Completed real run did not retain rejection Trace");
  sourceRunId = completedRun.runId;
  await page.getByRole("button", { name: "回放", exact: true }).click();
  await page.getByLabel("Trace 回放时间轴").waitFor();
  await page.getByTitle("下一个事件").click();
  await page.getByText("回放只读取已记录事件，不会改变运行或验证状态。", { exact: true }).waitFor();
  traceCanvasChecks.push(await verifyTraceGraph(page, "trace replay"));
  await page.screenshot({ path: path.join(artifactDir, "trace-replay-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "实时", exact: true }).click();

  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const reportDialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await reportDialog.getByLabel("报告脱敏模式").selectOption("default");
  await reportDialog.getByLabel("报告用户说明").fill("真实 MDD Skill 非法跳转 sk-real-lifecycle-secret");
  await reportDialog.getByRole("button", { name: "生成预览", exact: true }).click();
  await reportDialog.getByText("导出预览", { exact: true }).waitFor();
  const reportPreview = await reportDialog.locator(".bug-report-preview-grid > section").nth(1).locator("pre").textContent();
  if (!reportPreview?.includes("[REDACTED]") || reportPreview.includes("sk-real-lifecycle-secret") || !reportPreview.includes("transition_rejected")) {
    throw new Error("Real Skill report preview lost rejection facts or leaked the simulated secret");
  }
  await page.screenshot({ path: path.join(artifactDir, "bug-report-preview-desktop.png"), fullPage: true });
  await reportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  const reports = await store.listBugReports(projectId, workspaceId);
  reportId = reports[0]?.reportId;
  if (!reportId) throw new Error("Confirmed Bug Report was not persisted");
  await reportDialog.getByTestId("report-open-diagnosis").click();
  await reportDialog.waitFor({ state: "hidden" });
  await page.getByText("skillId 与 contentHash 精确匹配当前 Workspace 成员", { exact: true }).waitFor();
  await page.getByRole("button", { name: "分析原因", exact: true }).click();
  const diagnosisCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: "下一节点提交不符合当前合法出口" });
  await diagnosisCandidate.waitFor();
  await diagnosisCandidate.getByText(`提交目标为 ${endNode.id}`, { exact: true }).waitFor();
  await diagnosisCandidate.getByText(`添加 ${startNode.id} -> ${endNode.id} 的流程边`, { exact: true }).waitFor();
  traceCanvasChecks.push(await verifyTraceGraph(page, "diagnosis analysis"));
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-analysis-desktop.png"), fullPage: true });

  const graphBeforeRepair = await store.getProjectGraph(projectId);
  await diagnosisCandidate.getByRole("button", { name: "生成修复提案", exact: true }).click();
  const repairDialog = page.getByRole("dialog", { name: "确认诊断修复提案" });
  await repairDialog.getByText("尚未修改 Skill", { exact: false }).waitFor();
  const addedEdgeGroup = repairDialog.locator(".graph-diff-groups section.added").filter({ hasText: "新增边" });
  await addedEdgeGroup.getByText("新增边", { exact: true }).waitFor();
  const proposedRepairEdgeId = (await addedEdgeGroup.locator("code").textContent())?.trim();
  if (!proposedRepairEdgeId) throw new Error("Repair ChangeSet did not expose the added edge ID");
  if ((await store.getProjectGraph(projectId)).activeRevision !== graphBeforeRepair.activeRevision) throw new Error("Repair proposal changed the graph before confirmation");
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-repair-changeset-desktop.png"), fullPage: true });
  await repairDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await repairDialog.waitFor({ state: "hidden" });
  const graphAfterRepair = await store.getProjectGraph(projectId);
  const repairedEdge = graphAfterRepair.graph.edges.find((edge) => edge.from === startNode.id && edge.to === endNode.id);
  if (!repairedEdge || repairedEdge.id !== proposedRepairEdgeId || graphAfterRepair.graph.edges.length !== graphBeforeRepair.graph.edges.length + 1) {
    throw new Error("Confirmed diagnosis repair did not add the proposed edge");
  }
  const importedReports = await store.listImportedBugReports(workspaceId);
  if (importedReports.length !== 1) throw new Error(`Expected one imported Bug Report, received ${importedReports.length}`);
  const repairRecords = await store.listDiagnosisRepairs(workspaceId, importedReports[0].reportImportId);
  repairId = repairRecords[0]?.repairId;

  await diagnosisCandidate.getByRole("button", { name: "前往测试运行", exact: true }).click();
  await startRun(page, startNode.title);
  await page.locator(".transition-list").getByRole("button", { name: new RegExp(escapeRegExp(endNode.title), "u") }).click();
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  const verificationRun = (await store.listRuns(projectId)).find((run) => run.runId !== sourceRunId && run.revision === graphAfterRepair.activeRevision && run.state.status === "completed");
  if (!verificationRun) throw new Error("Repair verification run was not persisted on the repaired revision");
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  const persistedCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: "下一节点提交不符合当前合法出口" });
  await persistedCandidate.getByLabel("选择修复后运行").selectOption(verificationRun.runId);
  await persistedCandidate.getByRole("button", { name: "验证", exact: true }).click();
  await persistedCandidate.getByText("已验证", { exact: true }).waitFor();
  await persistedCandidate.getByText(new RegExp(`实际经过新增边 ${escapeRegExp(repairedEdge.id)}`, "u")).waitFor();
  traceCanvasChecks.push(await verifyTraceGraph(page, "verified diagnosis"));
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-repair-verified-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.getByRole("group", { name: "Trace 图谱显示模式" }).getByRole("button", { name: "2D", exact: true }).click();
  traceCanvasChecks.push(await verifyTraceGraph(page, "verified diagnosis mobile", "2d"));
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Real lifecycle mobile overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-repair-verified-mobile.png"), fullPage: true });

  const sourceAfter = await hashTree(skillRoot);
  if (!sameTree(sourceBefore, sourceAfter)) throw new Error("Lifecycle verification modified the user-provided source Skill");
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);
  const verification = {
    schemaVersion: "1.0",
    browser: "Google Chrome",
    platform: `${process.platform}-${process.arch}`,
    source: { root: skillRoot, fileCount: sourceBefore.size, bytesUnchanged: true },
    identity: { workspaceId, projectId, skillId },
    document: { path: editedDocumentPath, anchor: editedAnchor, editedThroughPage: true, boundNodeId: stepNode.id },
    export: { archiveFileCount: exportEntries.length, originalPathsPreserved: sourceBefore.size, cliInspection },
    runtime: { sourceRunId, orderedPath, rejectionTarget: endNode.id, finalStatus: completedRun.state.status, traceEventCount: completedRun.events.length },
    report: { reportId, sanitization: "default", simulatedSecretRedacted: true },
    diagnosis: { repairId, repairedEdgeId: repairedEdge.id, verificationRunId: verificationRun.runId, status: "verified" },
    traceCanvasChecks,
    mobileMetrics,
    consoleErrors,
    failedResponses,
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function startRun(targetPage, startTitle) {
  const emptyStart = targetPage.getByRole("button", { name: "启动运行", exact: true });
  if (await emptyStart.count()) await emptyStart.click();
  else await targetPage.getByRole("button", { name: "新建运行", exact: true }).click();
  const dialog = targetPage.getByRole("dialog", { name: "新建运行" });
  await dialog.getByRole("button", { name: "启动", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await targetPage.locator(".current-node-block").getByRole("heading", { name: startTitle, exact: true }).waitFor();
}

async function verifyTraceGraph(targetPage, label, mode = "3d") {
  const graph = targetPage.locator(`.trace-graph-canvas .skill-force-graph[data-graph-mode="${mode}"][data-render-state="settled"]`);
  await graph.waitFor();
  await targetPage.getByTitle("Trace 适应全图").click();
  await targetPage.waitForTimeout(900);
  const canvas = await graphCanvasPixels(graph);
  if (canvas.width < 300 || canvas.height < 180 || canvas.uniqueColorBuckets < 4 || canvas.variedSamples <= 10) {
    throw new Error(`${label} Trace graph is blank or incorrectly framed: ${JSON.stringify(canvas)}`);
  }
  return { label, ...canvas };
}

async function graphCanvasPixels(graphLocator) {
  return graphLocator.locator("canvas").evaluate((canvas) => {
    const width = canvas.width;
    const height = canvas.height;
    const context2d = canvas.getContext("2d");
    let pixels;
    let renderer;
    if (context2d) {
      pixels = context2d.getImageData(0, 0, width, height).data;
      renderer = "canvas-2d";
    } else {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) throw new Error("Trace graph canvas has neither a 2D nor WebGL context");
      pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      renderer = gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
    }
    const colors = new Set();
    let variedSamples = 0;
    const stride = Math.max(4, Math.floor(pixels.length / 20_000 / 4) * 4);
    const baseRed = pixels[0] ?? 0;
    const baseGreen = pixels[1] ?? 0;
    const baseBlue = pixels[2] ?? 0;
    for (let index = 0; index < pixels.length; index += stride) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      const alpha = pixels[index + 3] ?? 0;
      if (Math.abs(red - baseRed) + Math.abs(green - baseGreen) + Math.abs(blue - baseBlue) > 18) variedSamples += 1;
      colors.add(`${red >> 4}-${green >> 4}-${blue >> 4}-${alpha >> 5}`);
    }
    return { renderer, width, height, variedSamples, uniqueColorBuckets: colors.size };
  });
}

function sequentialPath(graph, startNodeId, endNodeId) {
  const result = [startNodeId];
  const seen = new Set(result);
  let current = startNodeId;
  while (current !== endNodeId) {
    const outgoing = graph.edges.filter((edge) => edge.from === current && edge.kind !== "knowledge");
    if (outgoing.length !== 1) throw new Error(`Expected one sequential exit from ${current}, received ${outgoing.length}`);
    current = outgoing[0].to;
    if (seen.has(current)) throw new Error(`Sequential graph contains a cycle at ${current}`);
    seen.add(current);
    result.push(current);
  }
  return result;
}

async function hashTree(root) {
  const result = new Map();
  async function walk(relative = "") {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.set(next, createHash("sha256").update(await readFile(path.join(root, next))).digest("hex"));
      else throw new Error(`Unsupported source entry: ${next}`);
    }
  }
  await walk();
  return result;
}

function sameTree(left, right) {
  return left.size === right.size && [...left].every(([file, digest]) => right.get(file) === digest);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
