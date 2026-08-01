import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-document-repair-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/document-binding-repair");
const baseUrl = "http://127.0.0.1:4350";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "文档绑定修复 Chrome 验收" });
const detail = await store.createManagedSkill(workspace.workspaceId, { name: "文档绑定修复流程", capability: "workflow" });
const member = detail.members[0];
if (!member) throw new Error("Managed Skill was not created");
const initial = await store.getProjectGraph(member.projectId);
const startNode = initial.graph.nodes.find((node) => node.id === "flow.start");
const coreNode = initial.graph.nodes.find((node) => node.id === "flow.core-step");
const endNode = initial.graph.nodes.find((node) => node.id === "flow.end");
if (!startNode || !coreNode || !endNode) throw new Error("Default workflow graph is incomplete");

const documentProposal = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: initial.activeRevision,
  reason: "建立待诊断的运行文档",
  operations: [{ op: "docs.write", target: "docs/start.md", value: "# 开始说明\n\n该内容只用于文档绑定修复验收。\n" }]
});
const documentApplied = await store.confirmAndApplyChangeSet(documentProposal.changeSetId, {
  digest: documentProposal.digest,
  baseRevision: documentProposal.baseRevision
});
const bindingProposal = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: documentApplied.activeRevision,
  reason: "绑定开始节点文档",
  operations: [{ op: "graph.node.update", target: startNode.id, value: { ...startNode, doc: "docs/start.md", docAnchor: "#开始说明" } }]
});
await store.confirmAndApplyChangeSet(bindingProposal.changeSetId, {
  digest: bindingProposal.digest,
  baseRevision: bindingProposal.baseRevision
});

const sourceRun = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId });
const revision = JSON.parse(await readFile(path.join(dataRoot, "projects", member.projectId, "revisions", `${sourceRun.run.revision}.json`), "utf8"));
const source = JSON.parse(await readFile(path.join(dataRoot, "projects", member.projectId, "source.json"), "utf8"));
await rm(path.join(dataRoot, "projects", member.projectId, "snapshots", revision.snapshotId, "files", "docs", "start.md"));
await rm(path.join(source.root, "docs", "start.md"));

const provider = {
  async probe() {
    return {
      schemaVersion: "1.0",
      providerId: "document-repair-verification",
      label: "文档修复验收模型",
      status: "ready",
      keyConfigured: true,
      defaultModel: "document-repair-model",
      reason: "ready",
      checkedAt: new Date().toISOString()
    };
  },
  async invoke() {
    return {
      providerId: "document-repair-verification",
      responseId: `document-repair-response-${Date.now()}`,
      model: "document-repair-model-resolved",
      output: { action: "advance", reply: "继续进入核心步骤。", nextNodeId: coreNode.id, summary: "读取上下文后继续" },
      usage: { inputTokens: 17, outputTokens: 6, totalTokens: 23, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 19
    };
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, benchmarkRunner: { list: async () => [] }, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4350, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function startRun() {
  await page.getByRole("button", { name: "新建运行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建运行" });
  await dialog.getByRole("button", { name: "启动", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator(".current-node-block").getByRole("heading", { name: startNode.title, exact: true }).waitFor();
}

async function advanceTo(title) {
  await page.locator(".transition-list").getByRole("button", { name: new RegExp(title, "u") }).click();
  await page.locator(".current-node-block").getByRole("heading", { name: title, exact: true }).waitFor();
}

async function canvasStats() {
  const graph = page.locator('.trace-graph-canvas .skill-force-graph[data-render-state="settled"]');
  await graph.waitFor();
  return graph.locator("canvas").evaluate((canvas) => {
    const width = canvas.width;
    const height = canvas.height;
    const context2d = canvas.getContext("2d");
    let pixels;
    let renderer = "2d";
    if (context2d) pixels = context2d.getImageData(0, 0, width, height).data;
    else {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) throw new Error("Graph canvas has no readable context");
      pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      renderer = gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
    }
    const buckets = new Set();
    let visibleSamples = 0;
    const stride = Math.max(4, Math.floor(pixels.length / 20_000 / 4) * 4);
    for (let index = 0; index < pixels.length; index += stride) {
      if (pixels[index + 3] > 0) visibleSamples += 1;
      buckets.add(`${pixels[index] >> 4}-${pixels[index + 1] >> 4}-${pixels[index + 2] >> 4}-${pixels[index + 3] >> 5}`);
    }
    return { renderer, width, height, visibleSamples, uniqueColorBuckets: buckets.size };
  });
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "文档绑定修复 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  const runtimeDialog = page.getByLabel("模型运行对话");
  await runtimeDialog.getByLabel("运行对话消息").fill("读取开始说明并继续");
  await runtimeDialog.getByTitle("发送消息").click();
  await page.locator(".current-node-block").getByRole("heading", { name: coreNode.title, exact: true }).waitFor();
  await page.locator(".runtime-events").getByText("文档上下文", { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const reportDialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await reportDialog.getByLabel("报告用户说明").fill("开始节点绑定的文档上下文缺失");
  await reportDialog.getByRole("button", { name: "生成预览", exact: true }).click();
  await reportDialog.locator(".bug-report-preview-grid > section").nth(1).getByText('"status": "missing"', { exact: false }).waitFor();
  await reportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await reportDialog.getByTestId("report-open-diagnosis").click();
  await reportDialog.waitFor({ state: "hidden" });
  await page.getByText("skillId 与 contentHash 精确匹配当前 Workspace 成员", { exact: true }).waitFor();
  await page.getByRole("button", { name: "分析原因", exact: true }).click();

  const repairTitle = `移除节点 ${startNode.id} 的不可用文档绑定`;
  const candidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: repairTitle });
  await candidate.getByText(repairTitle, { exact: true }).waitFor();
  const graphPixels = await canvasStats();
  if (graphPixels.uniqueColorBuckets < 4 || graphPixels.visibleSamples < 20) throw new Error(`Diagnosis graph canvas is blank: ${JSON.stringify(graphPixels)}`);
  await candidate.getByRole("button", { name: "生成修复提案", exact: true }).click();
  const repairDialog = page.getByRole("dialog", { name: "确认诊断修复提案" });
  await repairDialog.getByText("尚未修改 Skill", { exact: false }).waitFor();
  await repairDialog.getByText("修改节点", { exact: true }).waitFor();
  await repairDialog.getByText(startNode.id, { exact: true }).first().waitFor();
  const beforeConfirm = (await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === startNode.id);
  if (beforeConfirm?.doc !== "docs/start.md" || beforeConfirm.docAnchor !== "#开始说明") throw new Error("Repair changed the graph before confirmation");
  await page.screenshot({ path: path.join(artifactDir, "document-binding-diff-desktop.png"), fullPage: true });
  await repairDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await repairDialog.waitFor({ state: "hidden" });
  await candidate.getByText("未验证", { exact: true }).waitFor();
  const afterConfirm = (await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === startNode.id);
  if (!afterConfirm || afterConfirm.doc || afterConfirm.docAnchor) throw new Error("Confirmed repair did not remove the document binding");

  await candidate.getByRole("button", { name: "前往测试运行", exact: true }).click();
  await startRun();
  await advanceTo(coreNode.title);
  await advanceTo(endNode.title);
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  const persistedCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: repairTitle });
  await persistedCandidate.getByLabel("选择修复后运行").selectOption({ index: 1 });
  await persistedCandidate.getByRole("button", { name: "验证", exact: true }).click();
  await persistedCandidate.getByText("已验证", { exact: true }).waitFor();
  await persistedCandidate.getByText(new RegExp(`RuntimeArtifact 中节点 ${startNode.id.replaceAll(".", "\\.")} 已无文档绑定`, "u")).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "document-binding-verified-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile document repair overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "document-binding-verified-mobile.png"), fullPage: true });

  const persistedRun = await store.getRun(member.projectId, sourceRun.run.runId);
  const documentEvent = persistedRun.run.events.find((event) => event.type === "document.context");
  const reports = await store.listImportedBugReports(workspace.workspaceId);
  const repairs = (await Promise.all(reports.map((report) => store.listDiagnosisRepairs(workspace.workspaceId, report.reportImportId)))).flat();
  const repair = repairs.find((item) => item.candidateId.startsWith("candidate-document-"));
  if (documentEvent?.data.status !== "missing" || repair?.status !== "verified") throw new Error("Persisted document failure or repair verification is incomplete");
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);

  const verification = {
    browser: "Google Chrome",
    workspaceId: workspace.workspaceId,
    projectId: member.projectId,
    sourceRunId: sourceRun.run.runId,
    documentEvent: { seq: documentEvent.seq, status: documentEvent.data.status },
    repairId: repair.repairId,
    repairStatus: repair.status,
    confirmationGuard: { beforeHadBinding: true, afterRemovedBinding: true },
    verificationRunId: repair.verification?.runId,
    verificationEvidence: repair.verification?.evidence,
    graphPixels,
    mobileMetrics,
    consoleErrors,
    failedResponses,
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
