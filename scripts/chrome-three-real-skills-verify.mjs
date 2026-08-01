import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const execFileAsync = promisify(execFile);
const riskDocumentPath = "references/output-schema.md";
const riskDocumentAnchor = "输出结构契约/字段说明";
const referenceDocumentPath = "references/core-api/data-access/MetaDaoHelper.md";
const referenceDocumentAnchor = "MetaDaoHelper - 元数据数据访问工具类/关键方法/新增 (Insert)";

const sources = [
  {
    key: "mdd",
    root: "/Users/hongyuwu/IdeaProjects/yds-skills/mdd-backend-extend-develop",
    displayName: "mdd-backend-extend-develop",
    capability: "workflow",
    nodeCount: 10,
    edgeCount: 9,
    documentCount: 223
  },
  {
    key: "risk",
    root: "/Users/hongyuwu/.codex/skills/risk-assessment-judgement",
    displayName: "risk-assessment-judgement",
    capability: "workflow",
    nodeCount: 8,
    edgeCount: 7,
    documentCount: 5
  },
  {
    key: "reference",
    root: "/Users/hongyuwu/.codex/skills/mdd-backend-extend-develop/mdd-framework-reference",
    displayName: "mdd-framework-reference",
    capability: "content-only",
    nodeCount: 1,
    edgeCount: 0,
    documentCount: 129
  }
];

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-three-real-skills-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/three-real-skills");
const port = 4380;
const baseUrl = `http://127.0.0.1:${port}`;
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
await assertBuildFresh("engine", path.resolve("packages/engine/src"), path.resolve("packages/engine/dist"));
await assertBuildFresh("server", path.resolve("packages/server/src"), path.resolve("packages/server/dist"));
await assertBuildFresh("web", path.resolve("packages/web/src"), path.resolve("packages/web/dist"));

for (const source of sources) source.before = await hashTree(source.root);

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const provider = {
  async probe() {
    return {
      schemaVersion: "1.0",
      providerId: "three-real-skills-verification",
      label: "三个真实 Skill 页面验收",
      status: "ready",
      keyConfigured: true,
      defaultModel: "three-real-skills-verification",
      reason: "只验证页面手动运行",
      checkedAt: new Date().toISOString()
    };
  },
  async invoke() {
    return {
      providerId: "three-real-skills-verification",
      responseId: `three-real-skills-${Date.now()}`,
      model: "three-real-skills-verification",
      output: { action: "reply", reply: "本验收通过页面手动推进节点。", nextNodeId: null, summary: "保持当前节点" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1
    };
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const importLLMParser = {
  latest: async () => null,
  start: async () => { throw new Error("LLM parsing is outside this static parser verification"); },
  cancel: async () => null
};
const server = createApp({ store, runtimeDebug, benchmarkRunner: { list: async () => [] }, importLLMParser, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

console.log("[three-real-skills] launching visible Google Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, acceptDownloads: true });
page.setDefaultTimeout(60_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

let workspaceId;
const imported = new Map();
let riskRun;
let riskCanvas;
let referenceCanvas;
let riskLifecycle;
let referenceLifecycle;
const traceCanvasChecks = [];
let mobileMetrics;
let lastStage = "boot";

try {
  stage("create-workspace");
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("三个真实 Skill 验收");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "三个真实 Skill 验收", exact: true }).waitFor();

  for (const source of sources) {
    stage(`import-${source.key}`);
    const result = await importThroughPage(source);
    workspaceId ??= result.workspace.workspaceId;
    if (workspaceId !== result.workspace.workspaceId) throw new Error(`${source.key} was imported into another Workspace`);
    imported.set(source.key, result);
  }

  const workspace = await store.getWorkspace(workspaceId);
  stage("verify-workspace-members");
  if (workspace.members.length !== sources.length) throw new Error(`Expected ${sources.length} members, received ${workspace.members.length}`);
  if (new Set(workspace.members.map((member) => member.skillId)).size !== sources.length) throw new Error("Real Skill identities are not unique");
  for (const source of sources) {
    const candidate = imported.get(source.key).candidate;
    const member = workspace.members.find((item) => item.projectId === candidate.projectId);
    if (!member || member.status !== "ready" || member.capability !== source.capability) throw new Error(`${source.key} member identity or capability drifted`);
    source.member = member;
    const row = page.getByRole("row", { name: new RegExp(escapeRegExp(source.displayName), "u") });
    await row.getByText(source.capability === "workflow" ? "工作流" : "内容型", { exact: true }).waitFor();
    await row.getByText("就绪", { exact: true }).waitFor();
  }
  await page.screenshot({ path: path.join(artifactDir, "three-real-skills-workspace-desktop.png"), fullPage: true });

  const risk = sources.find((source) => source.key === "risk");
  const riskGraphRecord = await store.getProjectGraph(risk.member.projectId);
  const riskGraph = riskGraphRecord.graph;
  const riskStart = riskGraph.nodes.find((node) => node.id === riskGraph.entry);
  const riskEnd = riskGraph.nodes.find((node) => node.kind === "end");
  const riskBindingNode = riskGraph.nodes.find((node) => node.title.includes("output-schema"));
  if (!riskStart || !riskEnd || !riskBindingNode) throw new Error("Risk workflow is missing the lifecycle target nodes");
  const riskPath = sequentialPath(riskGraph);

  stage("edit-risk-document");
  const riskDocument = await editDocumentThroughPage(risk, riskDocumentPath, "output-schema", "Studio 风险链路验收");

  stage("open-risk-graph");
  await returnToWorkspace();
  await openMember(risk);
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await bindNodeThroughPage(risk, riskBindingNode, riskDocumentPath, riskDocumentAnchor, "risk-graph-binding-changeset-desktop.png");
  const riskGraphView = page.locator(`.skill-force-graph[data-node-count="${risk.nodeCount}"][data-render-state="settled"]`);
  await riskGraphView.waitFor();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  riskCanvas = await waitForPaintedCanvas(riskGraphView, "risk-assessment workflow graph");
  await page.screenshot({ path: path.join(artifactDir, "risk-workflow-graph-desktop.png"), fullPage: true });

  stage("export-risk");
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("heading", { name: "三个真实 Skill 验收", exact: true }).waitFor();
  const riskExport = await exportThroughPage(risk, riskDocumentPath, "risk-generic.zip", risk.nodeCount, risk.edgeCount);

  stage("open-risk-tests");
  await openMember(risk);
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "手动运行", exact: true }).waitFor();
  stage(`start-risk-run-${riskPath.length}-nodes`);
  const runId = await startRun(risk, riskGraph);
  await page.getByLabel("下一节点 ID").fill(riskEnd.id);
  await page.locator(".manual-transition").getByRole("button", { name: "提交", exact: true }).click();
  await page.getByText("错误码：next_node_not_allowed", { exact: false }).waitFor();
  traceCanvasChecks.push(await verifyTraceGraph("risk rejection"));
  await page.screenshot({ path: path.join(artifactDir, "risk-runtime-rejection-desktop.png"), fullPage: true });
  for (const [index, nodeId] of riskPath.slice(1).entries()) {
    stage(`advance-risk-${index + 1}-${nodeId}`);
    await advanceTo(risk, riskGraph, nodeId);
  }
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  const runView = await store.getRun(risk.member.projectId, runId);
  assertRunIdentity(runView, risk, riskPath);
  if (!runView.run.events.some((event) => event.type === "engine.reject")) throw new Error("Risk run lost the rejected transition event");
  traceCanvasChecks.push(await verifyTraceGraph("risk completed"));
  riskRun = {
    runId,
    artifactId: runView.run.artifactId,
    status: runView.run.state.status,
    visitedNodeIds: runView.run.state.visitedNodeIds,
    traceEventCount: runView.run.events.length
  };
  await page.screenshot({ path: path.join(artifactDir, "risk-workflow-completed-desktop.png"), fullPage: true });

  stage("risk-report-diagnosis-repair");
  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const reportDialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await reportDialog.getByLabel("报告脱敏模式").selectOption("default");
  await reportDialog.getByLabel("报告用户说明").fill("原油风险 Skill 非法跳转 sk-risk-lifecycle-secret");
  await reportDialog.getByRole("button", { name: "生成预览", exact: true }).click();
  await reportDialog.getByText("导出预览", { exact: true }).waitFor();
  const reportPreview = await reportDialog.locator(".bug-report-preview-grid > section").nth(1).locator("pre").textContent();
  if (!reportPreview?.includes("[REDACTED]") || reportPreview.includes("sk-risk-lifecycle-secret") || !reportPreview.includes("transition_rejected")) {
    throw new Error("Risk report preview lost rejection facts or leaked the simulated secret");
  }
  await page.screenshot({ path: path.join(artifactDir, "risk-bug-report-preview-desktop.png"), fullPage: true });
  await reportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  const reports = await store.listBugReports(risk.member.projectId, workspaceId);
  const reportId = reports[0]?.reportId;
  if (!reportId) throw new Error("Risk Bug Report was not persisted");
  await reportDialog.getByTestId("report-open-diagnosis").click();
  await reportDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "分析原因", exact: true }).click();
  const diagnosisCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: "下一节点提交不符合当前合法出口" });
  await diagnosisCandidate.waitFor();
  await diagnosisCandidate.getByText(`提交目标为 ${riskEnd.id}`, { exact: true }).waitFor();
  traceCanvasChecks.push(await verifyTraceGraph("risk diagnosis"));
  await page.screenshot({ path: path.join(artifactDir, "risk-diagnosis-analysis-desktop.png"), fullPage: true });

  const graphBeforeRepair = await store.getProjectGraph(risk.member.projectId);
  await diagnosisCandidate.getByRole("button", { name: "生成修复提案", exact: true }).click();
  const repairDialog = page.getByRole("dialog", { name: "确认诊断修复提案" });
  await repairDialog.getByText("尚未修改 Skill", { exact: false }).waitFor();
  const addedEdgeGroup = repairDialog.locator(".graph-diff-groups section.added").filter({ hasText: "新增边" });
  const repairedEdgeId = (await addedEdgeGroup.locator("code").textContent())?.trim();
  if (!repairedEdgeId) throw new Error("Risk repair did not expose the proposed edge ID");
  await page.screenshot({ path: path.join(artifactDir, "risk-diagnosis-repair-changeset-desktop.png"), fullPage: true });
  await repairDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await repairDialog.waitFor({ state: "hidden" });
  const graphAfterRepair = await store.getProjectGraph(risk.member.projectId);
  const repairedEdge = graphAfterRepair.graph.edges.find((edge) => edge.id === repairedEdgeId && edge.from === riskStart.id && edge.to === riskEnd.id);
  if (!repairedEdge || graphAfterRepair.graph.edges.length !== graphBeforeRepair.graph.edges.length + 1) throw new Error("Risk repair was not applied exactly once");
  const importedReports = await store.listImportedBugReports(workspaceId);
  const riskReportImport = importedReports.find((item) => item.report.reportId === reportId);
  if (!riskReportImport) throw new Error("Risk report was not added to diagnosis");
  const repairs = await store.listDiagnosisRepairs(workspaceId, riskReportImport.reportImportId);
  const repairId = repairs[0]?.repairId;
  if (!repairId) throw new Error("Risk diagnosis repair record is missing");

  await diagnosisCandidate.getByRole("button", { name: "前往测试运行", exact: true }).click();
  const verificationRunId = await startRun(risk, graphAfterRepair.graph);
  await page.locator(".transition-list").getByRole("button", { name: new RegExp(escapeRegExp(riskEnd.title), "u") }).click();
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  const persistedCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: "下一节点提交不符合当前合法出口" });
  await persistedCandidate.getByLabel("选择修复后运行").selectOption(verificationRunId);
  await persistedCandidate.getByRole("button", { name: "验证", exact: true }).click();
  await persistedCandidate.getByText("已验证", { exact: true }).waitFor();
  await persistedCandidate.getByText(new RegExp(`实际经过新增边 ${escapeRegExp(repairedEdge.id)}`, "u")).waitFor();
  traceCanvasChecks.push(await verifyTraceGraph("risk verified diagnosis"));
  await page.screenshot({ path: path.join(artifactDir, "risk-diagnosis-repair-verified-desktop.png"), fullPage: true });
  riskLifecycle = {
    document: riskDocument,
    export: riskExport,
    reportId,
    repairId,
    repairedEdgeId: repairedEdge.id,
    verificationRunId,
    diagnosisStatus: "verified"
  };

  stage("open-reference");
  await returnToWorkspace();
  const reference = sources.find((source) => source.key === "reference");
  const referenceGraphRecord = await store.getProjectGraph(reference.member.projectId);
  const referenceNode = referenceGraphRecord.graph.nodes[0];
  if (!referenceNode || referenceGraphRecord.graph.nodes.length !== 1) throw new Error("Reference content graph is not a single knowledge node");

  stage("edit-reference-document");
  const referenceDocument = await editDocumentThroughPage(reference, referenceDocumentPath, "MetaDaoHelper", "Studio 知识库链路验收");

  stage("bind-reference-knowledge-node");
  await returnToWorkspace();
  await openMember(reference);
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await bindNodeThroughPage(reference, referenceNode, referenceDocumentPath, referenceDocumentAnchor, "reference-graph-binding-changeset-desktop.png");
  const referenceGraphView = page.locator(`.skill-force-graph[data-node-count="${reference.nodeCount}"][data-render-state="settled"]`);
  await referenceGraphView.waitFor();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.screenshot({ path: path.join(artifactDir, "reference-content-graph-desktop.png"), fullPage: true });
  referenceCanvas = await waitForPaintedCanvas(
    referenceGraphView,
    "mdd-framework-reference content graph",
    path.join(artifactDir, "reference-content-graph-canvas.png")
  );

  stage("export-reference");
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("heading", { name: "三个真实 Skill 验收", exact: true }).waitFor();
  const referenceExport = await exportThroughPage(reference, referenceDocumentPath, "reference-generic.zip", reference.nodeCount, reference.edgeCount);

  stage("verify-reference-documents");
  await openMember(reference);
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill("MetaDaoHelper");
  await page.getByRole("button", { name: new RegExp(escapeRegExp(referenceDocumentPath), "u") }).click();
  await page.locator(".document-preview").getByRole("heading", { name: "Studio 知识库链路验收", exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "reference-content-documents-desktop.png"), fullPage: true });

  referenceLifecycle = {
    document: referenceDocument,
    export: referenceExport,
    boundNodeId: referenceNode.id,
    runtimeApplicable: false,
    bugReportApplicable: false,
    diagnosisApplicable: false
  };

  await returnToWorkspace();
  await openMember(reference);
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("heading", { name: "当前 Skill 没有可执行流程", exact: true }).waitFor();
  if (await page.getByRole("button", { name: /启动运行|新建运行/u }).count()) throw new Error("Content-only real Skill exposed a runtime start action");
  if ((await store.listRuns(reference.member.projectId)).length !== 0) throw new Error("Content-only real Skill unexpectedly acquired a run");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "reference-content-runtime-mobile.png"), fullPage: true });

  stage("verify-source-hashes");
  for (const source of sources) {
    const after = await hashTree(source.root);
    if (!sameTree(source.before, after)) throw new Error(`${source.key} source changed during page verification`);
  }
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures: ${JSON.stringify({ consoleErrors, failedResponses })}`);
  if (!riskLifecycle || !referenceLifecycle) throw new Error("Real Skill lifecycle facts are incomplete");

  const verification = {
    schemaVersion: "1.0",
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version(), visibleChrome: true },
    workspace: {
      workspaceId,
      memberCount: workspace.members.length,
      uniqueSkillIds: true,
      members: workspace.members.map(({ projectId, skillId, displayName, capability, status }) => ({ projectId, skillId, displayName, capability, status }))
    },
    sources: await Promise.all(sources.map(async (source) => {
      const candidate = imported.get(source.key).candidate;
      const graph = (await store.getProjectGraph(source.member.projectId)).graph;
      const documents = await store.listDocuments(source.member.projectId);
      if (documents.length !== source.documentCount) throw new Error(`${source.key} document count ${documents.length}/${source.documentCount}`);
      return {
        key: source.key,
        root: source.root,
        fileCount: source.before.size,
        bytesUnchanged: true,
        importedThroughPage: true,
        parserVersion: candidate.parseReview.parserVersion,
        capability: graph.capability,
        importedNodeCount: candidate.parseReview.nodes.length,
        importedEdgeCount: candidate.parseReview.edges.length,
        activeNodeCount: graph.nodes.length,
        activeEdgeCount: graph.edges.length,
        documentCount: documents.length,
        diagnostics: candidate.diagnostics,
        reviewLint: candidate.parseReview.lint
      };
    })),
    riskWorkflow: { completedThroughPage: true, ...riskRun, graphCanvas: riskCanvas, lifecycle: riskLifecycle },
    contentOnlyBoundary: { startActionHidden: true, runCount: 0, graphCanvas: referenceCanvas, lifecycle: referenceLifecycle },
    traceCanvasChecks,
    mobileMetrics,
    consoleErrors,
    failedResponses,
    screenshots: [
      "mdd-import-review-desktop.png",
      "risk-import-review-desktop.png",
      "reference-import-review-desktop.png",
      "three-real-skills-workspace-desktop.png",
      "risk-document-changeset-desktop.png",
      "risk-graph-binding-changeset-desktop.png",
      "risk-workflow-graph-desktop.png",
      "risk-generic-export-preview-desktop.png",
      "risk-runtime-rejection-desktop.png",
      "risk-workflow-completed-desktop.png",
      "risk-bug-report-preview-desktop.png",
      "risk-diagnosis-analysis-desktop.png",
      "risk-diagnosis-repair-changeset-desktop.png",
      "risk-diagnosis-repair-verified-desktop.png",
      "reference-document-changeset-desktop.png",
      "reference-graph-binding-changeset-desktop.png",
      "reference-content-graph-desktop.png",
      "reference-content-graph-canvas.png",
      "reference-generic-export-preview-desktop.png",
      "reference-content-documents-desktop.png",
      "reference-content-runtime-mobile.png"
    ],
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  stage("verification-complete");
  console.log(JSON.stringify(verification, null, 2));
} catch (error) {
  await writeFile(path.join(artifactDir, "failure.json"), `${JSON.stringify({
    lastStage,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    failedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  console.error("[three-real-skills] FAILED", error instanceof Error ? error.stack : error);
  throw error;
} finally {
  stage("cleanup");
  const browserClosed = await withTimeout(browser.close().then(() => true), 20_000, false);
  const serverClosed = await withTimeout(new Promise((resolve) => server.close(() => resolve(true))), 10_000, false);
  await rm(dataRoot, { recursive: true, force: true });
  if (!browserClosed || !serverClosed) {
    console.error(`[three-real-skills] cleanup timeout: ${JSON.stringify({ browserClosed, serverClosed })}`);
    process.exit(1);
  }
}

async function importThroughPage(source) {
  await page.getByRole("button", { name: "导入 Skill", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入 Skill 文件夹" });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByText("选择一个 Skill 文件夹", { exact: true }).click()
  ]);
  await chooser.setFiles(source.root);
  await dialog.getByText(`${source.before.size} 个文件`, { exact: false }).waitFor();
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === "POST" && /\/api\/workspaces\/[^/]+\/imports$/u.test(new URL(candidate.url()).pathname)),
    dialog.getByRole("button", { name: "扫描并预检", exact: true }).click()
  ]);
  const preview = (await response.json()).data;
  const candidate = preview.candidate;
  if (candidate.parseReview.parserVersion !== "static-v2") throw new Error(`${source.key} used ${candidate.parseReview.parserVersion}`);
  if (candidate.capability !== source.capability || candidate.parseReview.nodes.length !== source.nodeCount || candidate.parseReview.edges.length !== source.edgeCount) {
    throw new Error(`${source.key} parse mismatch: ${JSON.stringify({ capability: candidate.capability, nodes: candidate.parseReview.nodes.length, edges: candidate.parseReview.edges.length })}`);
  }
  const blocking = [...candidate.diagnostics, ...candidate.parseReview.lint].filter((issue) => issue.severity === "error");
  if (blocking.length) throw new Error(`${source.key} import blocked: ${JSON.stringify(blocking)}`);
  await dialog.locator(".import-identity strong").filter({ hasText: source.displayName }).waitFor();
  await dialog.locator(".import-identity").getByText(source.capability === "workflow" ? "工作流" : "内容型", { exact: true }).waitFor();
  await dialog.getByText("静态解析器 static-v2", { exact: false }).waitFor();
  const graph = dialog.locator(`.skill-force-graph[data-node-count="${source.nodeCount}"][data-render-state="settled"]`);
  await graph.waitFor();
  await dialog.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(500);
  const pixels = await graphCanvasPixels(graph);
  assertPaintedCanvas(pixels, `${source.key} import review graph`);
  await page.screenshot({ path: path.join(artifactDir, `${source.key}-import-review-desktop.png`), fullPage: true });
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: new RegExp(escapeRegExp(source.displayName), "u") }).waitFor();
  return preview;
}

async function editDocumentThroughPage(source, documentPath, searchText, marker) {
  await openMember(source);
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill(searchText);
  await page.getByRole("button", { name: new RegExp(escapeRegExp(documentPath), "u") }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  const original = await editor.inputValue();
  const addition = `\n## ${marker}\n\n该段只写入 Studio 临时管理副本，并经过页面 ChangeSet 显式确认。\n`;
  await editor.fill(original + addition);
  await page.getByRole("button", { name: "预览并保存", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认文档变更" });
  await dialog.getByText("修改文档", { exact: true }).waitFor();
  await dialog.getByText(documentPath, { exact: true }).waitFor();
  if ((await store.readDocument(source.member.projectId, documentPath)).content !== original) throw new Error(`${source.key} document changed before confirmation`);
  await page.screenshot({ path: path.join(artifactDir, `${source.key}-document-changeset-desktop.png`), fullPage: true });
  await dialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const confirmed = (await store.readDocument(source.member.projectId, documentPath)).content;
  if (!confirmed.includes(marker) || confirmed !== original + addition) throw new Error(`${source.key} confirmed document bytes are incorrect`);
  return { path: documentPath, marker, editedThroughPage: true, changedOnlyAfterConfirmation: true };
}

async function bindNodeThroughPage(source, node, documentPath, anchor, screenshot) {
  const before = await store.getProjectGraph(source.member.projectId);
  const persistedBefore = before.graph.nodes.find((item) => item.id === node.id);
  await page.getByLabel("搜索图节点").fill(node.title);
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: node.title, exact: true }).last().waitFor();
  await page.getByRole("button", { name: "编辑节点", exact: true }).click();
  await page.getByLabel("关联文档").fill(documentPath);
  await page.getByLabel("标题路径或锚点").fill(anchor);
  await page.getByRole("button", { name: "预览文档片段", exact: true }).click();
  await page.locator(".document-binding-preview").getByText(anchor, { exact: true }).waitFor();
  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  await page.getByRole("button", { name: "预览并保存图", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认图谱变更" });
  await dialog.getByText(node.id, { exact: true }).waitFor();
  const stillBefore = (await store.getProjectGraph(source.member.projectId)).graph.nodes.find((item) => item.id === node.id);
  if (stillBefore?.doc !== persistedBefore?.doc || stillBefore?.docAnchor !== persistedBefore?.docAnchor) throw new Error(`${source.key} binding changed before confirmation`);
  await page.screenshot({ path: path.join(artifactDir, screenshot), fullPage: true });
  await dialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const bound = (await store.getProjectGraph(source.member.projectId)).graph.nodes.find((item) => item.id === node.id);
  if (bound?.doc !== documentPath || bound.docAnchor !== anchor) throw new Error(`${source.key} confirmed binding was not persisted`);
  return { nodeId: node.id, documentPath, anchor, changedOnlyAfterConfirmation: true };
}

async function exportThroughPage(source, editedDocumentPath, archiveName, expectedNodes, expectedEdges) {
  await page.getByRole("button", { name: "导出通用包", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出通用 Skill 包" });
  await dialog.getByText("generic/1", { exact: true }).waitFor();
  await dialog.locator(".export-file-section code").filter({ hasText: editedDocumentPath }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, `${source.key}-generic-export-preview-desktop.png`), fullPage: true });
  await dialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await dialog.getByRole("button", { name: "下载 ZIP", exact: true }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "下载 ZIP", exact: true }).click()
  ]);
  const zipPath = path.join(artifactDir, archiveName);
  await download.saveAs(zipPath);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName);
  for (const sourcePath of source.before.keys()) if (!entries.includes(sourcePath)) throw new Error(`${source.key} export lost ${sourcePath}`);
  for (const required of ["skill.json", "graph/main.json", "engine/skill-engine.mjs", "engine/README.md", "export-manifest.json"]) {
    if (!entries.includes(required)) throw new Error(`${source.key} export is missing ${required}`);
  }
  if (entries.some((entry) => /(?:^|\/)(?:workspace\.json|runtime-artifact|baseline\.json|traces?|reports?)(?:\/|$)/u.test(entry))) throw new Error(`${source.key} export leaked Studio-private files`);
  const documentEntry = zip.getEntry(editedDocumentPath);
  if (!documentEntry || !documentEntry.getData().toString("utf8").includes("Studio")) throw new Error(`${source.key} export lost the confirmed document edit`);
  const extracted = path.join(dataRoot, `extracted-${source.key}`);
  zip.extractAllTo(extracted, true);
  const inspection = JSON.parse((await execFileAsync(process.execPath, [path.join(extracted, "engine", "skill-engine.mjs"), "inspect"])).stdout);
  if (inspection.skillId !== source.member.skillId || inspection.nodes !== expectedNodes || inspection.edges !== expectedEdges) throw new Error(`${source.key} exported CLI identity mismatch: ${JSON.stringify(inspection)}`);
  await dialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  return { archiveFileCount: entries.length, originalPathsPreserved: source.before.size, cliInspection: inspection, confirmedEditPresent: true };
}

async function openMember(source) {
  await page.getByRole("row", { name: new RegExp(escapeRegExp(source.displayName), "u") }).click();
  await page.locator(`[data-skill-id="${source.member.skillId}"]`).first().waitFor();
}

async function returnToWorkspace() {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("heading", { name: "三个真实 Skill 验收", exact: true }).waitFor();
}

async function startRun(source, graph) {
  const previousRunIds = new Set((await store.listRuns(source.member.projectId)).map((run) => run.runId));
  const emptyStart = page.getByRole("button", { name: "启动运行", exact: true });
  if (await emptyStart.count()) await emptyStart.click();
  else await page.getByRole("button", { name: "新建运行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建运行" });
  await dialog.getByLabel("初始 skill 变量（JSON）").fill(JSON.stringify({ verification: source.key }, null, 2));
  await dialog.getByRole("button", { name: "启动", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const start = graph.nodes.find((node) => node.id === graph.entry);
  await page.locator(".current-node-block").getByRole("heading", { name: start.title, exact: true }).waitFor();
  const runs = await store.listRuns(source.member.projectId);
  const started = runs.find((run) => !previousRunIds.has(run.runId));
  if (!started || started.workspaceId !== workspaceId || started.skillId !== source.member.skillId || started.state.status !== "running") throw new Error("Risk run started with the wrong identity");
  return started.runId;
}

async function advanceTo(source, graph, nodeId) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  await page.locator(".transition-list").getByRole("button", { name: new RegExp(escapeRegExp(node.title), "u") }).click();
  await page.locator(".current-node-block").getByRole("heading", { name: node.title, exact: true }).waitFor();
  const latest = (await store.listRuns(source.member.projectId))[0];
  if (latest.state.currentNodeId !== nodeId) throw new Error(`Page advanced to ${nodeId}, Store remained at ${latest.state.currentNodeId}`);
}

function assertRunIdentity(view, source, expectedPath) {
  if (!view.artifact) throw new Error("Completed risk run has no RuntimeArtifact");
  if (view.run.workspaceId !== workspaceId || view.run.projectId !== source.member.projectId || view.run.skillId !== source.member.skillId) throw new Error("Risk run identity drifted");
  if (view.artifact.workspaceId !== workspaceId || view.artifact.projectId !== source.member.projectId || view.artifact.skillId !== source.member.skillId) throw new Error("Risk artifact identity drifted");
  if (view.run.state.status !== "completed" || JSON.stringify(view.run.state.visitedNodeIds) !== JSON.stringify(expectedPath)) throw new Error("Risk workflow did not complete its exact graph path");
}

function sequentialPath(graph) {
  const start = graph.nodes.find((node) => node.id === graph.entry || node.kind === "start");
  if (!start) throw new Error("Workflow has no start node");
  const result = [start.id];
  const seen = new Set(result);
  let current = start.id;
  while (true) {
    const outgoing = graph.edges.filter((edge) => edge.from === current && edge.kind !== "knowledge");
    if (!outgoing.length) break;
    if (outgoing.length !== 1) throw new Error(`Workflow is not sequential at ${current}`);
    current = outgoing[0].to;
    if (seen.has(current)) throw new Error("Workflow contains a cycle");
    seen.add(current);
    result.push(current);
  }
  return result;
}

async function verifyTraceGraph(label, mode = "3d") {
  const graph = page.locator(`.trace-graph-canvas .skill-force-graph[data-graph-mode="${mode}"][data-render-state="settled"]`);
  await graph.waitFor();
  await page.getByTitle("Trace 适应全图").click();
  await page.waitForTimeout(850);
  const canvas = await graphCanvasPixels(graph);
  if (canvas.width < 300 || canvas.height < 180 || canvas.variedSamples <= 10 || canvas.uniqueColorBuckets < 4) throw new Error(`${label} Trace graph is blank: ${JSON.stringify(canvas)}`);
  return { label, ...canvas };
}

async function graphCanvasPixels(graphLocator) {
  await graphLocator.locator("canvas").waitFor();
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
      if (!gl) throw new Error("Graph canvas has no rendering context");
      pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      renderer = gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
    }
    const colors = new Set();
    let variedSamples = 0;
    const base = [pixels[0], pixels[1], pixels[2]];
    const step = Math.max(1, Math.floor((width * height) / 24_000));
    for (let pixel = 0; pixel < width * height; pixel += step) {
      const offset = pixel * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (Math.abs(red - base[0]) + Math.abs(green - base[1]) + Math.abs(blue - base[2]) > 24) variedSamples++;
      colors.add(`${red >> 4}-${green >> 4}-${blue >> 4}-${alpha >> 5}`);
    }
    return { renderer, width, height, variedSamples, uniqueColorBuckets: colors.size };
  });
}

function assertPaintedCanvas(canvas, label) {
  if (canvas.width < 300 || canvas.height < 240 || canvas.variedSamples <= 10 || canvas.uniqueColorBuckets < 4) throw new Error(`${label} is blank: ${JSON.stringify(canvas)}`);
}

async function waitForPaintedCanvas(locator, label, screenshotPath) {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(450);
    last = await graphCanvasPixels(locator);
    if (last.width >= 300 && last.height >= 240 && last.variedSamples > 10 && last.uniqueColorBuckets >= 4) {
      if (!screenshotPath) return last;
      const screenshot = await canvasScreenshotPixels(locator, screenshotPath);
      if (screenshot.chromaticSamples <= 20 || screenshot.uniqueColorBuckets < 4) {
        throw new Error(`${label} WebGL readback is nonblank but the visible canvas lacks node-colored pixels: ${JSON.stringify({ webglReadback: last, screenshot })}`);
      }
      return { ...last, visibleCanvasScreenshot: screenshot };
    }
  }
  const screenshot = await canvasScreenshotPixels(locator, screenshotPath);
  if (screenshot.width >= 300 && screenshot.height >= 240 && screenshot.chromaticSamples > 20 && screenshot.uniqueColorBuckets >= 4) {
    return { ...screenshot, pixelSource: "canvas-screenshot", webglReadback: last };
  }
  throw new Error(`${label} is blank in WebGL readback and canvas screenshot: ${JSON.stringify({ webglReadback: last, screenshot })}`);
}

async function canvasScreenshotPixels(graphLocator, screenshotPath) {
  const canvas = graphLocator.locator("canvas");
  await canvas.waitFor();
  const bytes = await canvas.screenshot(screenshotPath ? { path: screenshotPath } : undefined);
  const source = `data:image/png;base64,${bytes.toString("base64")}`;
  return await page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const scratch = document.createElement("canvas");
    scratch.width = image.naturalWidth;
    scratch.height = image.naturalHeight;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas screenshot has no 2D decoding context");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
    const colors = new Set();
    let variedSamples = 0;
    let chromaticSamples = 0;
    const sampleLeft = Math.floor(scratch.width * 0.08);
    const sampleRight = Math.floor(scratch.width * (scratch.width >= 1_000 ? 0.68 : 0.92));
    const sampleTop = Math.floor(scratch.height * 0.2);
    const sampleBottom = Math.floor(scratch.height * 0.88);
    const sampleWidth = Math.max(1, sampleRight - sampleLeft);
    const sampleHeight = Math.max(1, sampleBottom - sampleTop);
    const baseOffset = (sampleTop * scratch.width + sampleLeft) * 4;
    const base = [pixels[baseOffset], pixels[baseOffset + 1], pixels[baseOffset + 2]];
    const step = Math.max(1, Math.floor((sampleWidth * sampleHeight) / 96_000));
    for (let sample = 0; sample < sampleWidth * sampleHeight; sample += step) {
      const x = sampleLeft + (sample % sampleWidth);
      const y = sampleTop + Math.floor(sample / sampleWidth);
      const offset = (y * scratch.width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (Math.abs(red - base[0]) + Math.abs(green - base[1]) + Math.abs(blue - base[2]) > 24) variedSamples++;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) > 35) chromaticSamples++;
      colors.add(`${red >> 4}-${green >> 4}-${blue >> 4}-${alpha >> 5}`);
    }
    return {
      renderer: "canvas-screenshot",
      width: scratch.width,
      height: scratch.height,
      variedSamples,
      chromaticSamples,
      uniqueColorBuckets: colors.size
    };
  }, source);
}

async function hashTree(root) {
  const result = new Map();
  async function walk(relative = "") {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === ".DS_Store") continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.set(next, createHash("sha256").update(await readFile(path.join(root, next))).digest("hex"));
      else throw new Error(`Unsupported source entry: ${path.join(root, next)}`);
    }
  }
  await walk();
  return result;
}

async function assertBuildFresh(label, sourceRoot, buildRoot) {
  const sourceMtime = await latestFileMtime(sourceRoot);
  const buildMtime = await latestFileMtime(buildRoot);
  if (buildMtime < sourceMtime) {
    throw new Error(`${label} dist is stale; rebuild before visible Chrome verification`);
  }
}

async function latestFileMtime(root) {
  let latest = 0;
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) latest = Math.max(latest, (await stat(target)).mtimeMs);
    }
  }
  await walk(root);
  return latest;
}

function sameTree(left, right) {
  return left.size === right.size && [...left].every(([file, digest]) => right.get(file) === digest);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stage(name) {
  lastStage = name;
  console.log(`[three-real-skills] ${name}`);
}

async function withTimeout(promise, timeoutMs, fallback) {
  return await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs))]);
}
