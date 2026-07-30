import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-condition-document-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4336";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "条件文档诊断 Chrome 验收" });
const detail = await store.createManagedSkill(workspace.workspaceId, { name: "条件与文档事实 Skill", capability: "workflow" });
const member = detail.members[0];
if (!member) throw new Error("Managed Skill was not created");
const initial = await store.getProjectGraph(member.projectId);
const start = initial.graph.nodes.find((node) => node.id === "flow.start");
const startEdge = initial.graph.edges.find((edge) => edge.id === "edge.start-core");
if (!start || !startEdge) throw new Error("Default graph is incomplete");
const documentProposal = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: initial.activeRevision,
  reason: "建立冻结文档事实",
  operations: [{ op: "docs.write", target: "docs/start.md", value: "# 起始上下文\n\n条件判断前使用的文档。\n" }]
});
const documentApplied = await store.confirmAndApplyChangeSet(documentProposal.changeSetId, { digest: documentProposal.digest, baseRevision: documentProposal.baseRevision });
const graphProposal = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: documentApplied.activeRevision,
  reason: "绑定文档并设置 false 条件",
  operations: [
    { op: "graph.node.update", target: start.id, value: { ...start, doc: "docs/start.md", docAnchor: "#起始上下文" } },
    { op: "graph.edge.update", target: startEdge.id, value: { ...startEdge, kind: "condition", condition: { op: "boolean", value: false } } }
  ]
});
await store.confirmAndApplyChangeSet(graphProposal.changeSetId, { digest: graphProposal.digest, baseRevision: graphProposal.baseRevision });
const started = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { approved: false } });
const revision = JSON.parse(await readFile(path.join(dataRoot, "projects", member.projectId, "revisions", `${started.run.revision}.json`), "utf8"));
const frozenDocument = path.join(dataRoot, "projects", member.projectId, "snapshots", revision.snapshotId, "files", "docs", "start.md");
await rm(frozenDocument);

const provider = {
  async probe() {
    return { schemaVersion: "1.0", providerId: "condition-document-verification", label: "条件文档验收模型", status: "ready", keyConfigured: true, defaultModel: "condition-document-model", reason: "ready", checkedAt: new Date().toISOString() };
  },
  async invoke() {
    return {
      providerId: "condition-document-verification",
      responseId: "condition-document-response",
      model: "condition-document-model-resolved",
      output: { action: "advance", reply: "提交条件目标。", nextNodeId: "flow.core-step", summary: "验证条件关闭的出口" },
      usage: { inputTokens: 18, outputTokens: 7, totalTokens: 25, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 24
    };
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, benchmarkRunner: { list: async () => [] }, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4336, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "条件文档诊断 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  const dialog = page.getByLabel("模型运行对话");
  await dialog.getByText("模型调试", { exact: true }).waitFor();
  await dialog.getByLabel("运行对话消息").fill("提交条件关闭的核心步骤");
  await dialog.getByTitle("发送消息").click();
  await dialog.getByText(/引擎拒绝了下一节点 flow\.core-step/u).waitFor();
  await page.locator(".runtime-events").getByText("condition.evaluated", { exact: true }).waitFor();
  await page.locator(".runtime-events").getByText("document.context", { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByRole("button", { name: "生成报告", exact: true }).waitFor();
  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const reportDialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await reportDialog.getByRole("button", { name: "生成预览", exact: true }).click();
  const preview = reportDialog.locator(".bug-report-preview-grid > section").nth(1);
  await preview.getByText("condition.evaluated", { exact: false }).waitFor();
  await preview.getByText("document.context", { exact: false }).waitFor();
  const previewText = await preview.innerText();
  if (!previewText.includes('"result": false') || !previewText.includes('"status": "missing"')) throw new Error("Sanitized report omitted condition or document facts");
  await reportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await reportDialog.getByTestId("report-open-diagnosis").click();
  await reportDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "分析原因", exact: true }).click();
  await page.getByRole("heading", { name: "提交目标对应条件在本次运行中为 false", exact: true }).waitFor();
  await page.getByRole("heading", { name: "运行节点的文档上下文不可用", exact: true }).waitFor();
  await page.getByText("条件计算", { exact: true }).waitFor();
  await page.getByText("文档上下文", { exact: true }).waitFor();
  await page.getByText("验证方式 · 新运行验证", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(artifactDir, "condition-document-diagnosis-desktop.png"), fullPage: true });

  const persistedRun = await store.getRun(member.projectId, started.run.runId);
  const conditionEvent = persistedRun.run.events.find((event) => event.type === "condition.evaluated");
  const documentEvent = persistedRun.run.events.find((event) => event.type === "document.context");
  if (conditionEvent?.data.evaluations?.[0]?.result !== false || documentEvent?.data.status !== "missing") throw new Error("Runtime Trace did not persist observation facts");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile condition/document diagnosis overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "condition-document-diagnosis-mobile.png"), fullPage: true });

  const verification = {
    runId: started.run.runId,
    conditionSeq: conditionEvent.seq,
    documentSeq: documentEvent.seq,
    conditionResult: conditionEvent.data.evaluations[0].result,
    documentStatus: documentEvent.data.status,
    mobileMetrics,
    consoleErrors,
    failedResponses
  };
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);
  await writeFile(path.join(artifactDir, "condition-document-diagnosis-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
