import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-repair-lineage-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/diagnosis-repair-lineage");
const baseUrl = "http://127.0.0.1:4347";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "辅助修复多轮 Chrome 验收" });
const detail = await store.createManagedSkill(workspace.workspaceId, { name: "辅助修复流程", capability: "workflow" });
const member = detail.members[0];
if (!member) throw new Error("Managed Skill was not created");
const initial = await store.getProjectGraph(member.projectId);
const startNode = initial.graph.nodes.find((node) => node.id === "flow.start");
const coreNode = initial.graph.nodes.find((node) => node.id === "flow.core-step");
const endNode = initial.graph.nodes.find((node) => node.id === "flow.end");
const coreEndEdge = initial.graph.edges.find((edge) => edge.from === coreNode?.id && edge.to === endNode?.id);
if (!startNode || !coreNode || !endNode || !coreEndEdge) throw new Error("Default workflow graph is incomplete");
const conditionChange = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: initial.activeRevision,
  reason: "Chrome 验收构造 false 条件",
  operations: [{
    op: "graph.edge.update",
    target: coreEndEdge.id,
    value: { ...coreEndEdge, kind: "condition", condition: { op: "boolean", value: false } }
  }]
});
await store.confirmAndApplyChangeSet(conditionChange.changeSetId, {
  digest: conditionChange.digest,
  baseRevision: conditionChange.baseRevision
});

const provider = {
  async probe() {
    return {
      schemaVersion: "1.0",
      providerId: "repair-lineage-verification",
      label: "辅助修复验收模型",
      status: "ready",
      keyConfigured: true,
      defaultModel: "repair-lineage-model",
      reason: "ready",
      checkedAt: new Date().toISOString()
    };
  },
  async invoke(request) {
    const returnToStart = request.input.userMessage.includes("返回开始");
    return {
      providerId: "repair-lineage-verification",
      responseId: `repair-lineage-response-${Date.now()}`,
      model: "repair-lineage-model-resolved",
      output: {
        action: "advance",
        reply: returnToStart ? "尝试返回开始节点。" : "尝试进入完成节点。",
        nextNodeId: returnToStart ? startNode.id : endNode.id,
        summary: returnToStart ? "提交返回开始节点" : "提交完成节点"
      },
      usage: { inputTokens: 16, outputTokens: 6, totalTokens: 22, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 18
    };
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, benchmarkRunner: { list: async () => [] }, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4347, "127.0.0.1", resolve));
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

async function submitModelTarget(message, targetNodeId) {
  const dialog = page.getByLabel("模型运行对话");
  await dialog.getByLabel("运行对话消息").fill(message);
  await dialog.getByTitle("发送消息").click();
  await dialog.getByText(new RegExp(`引擎拒绝了下一节点 ${targetNodeId.replaceAll(".", "\\.")}`, "u")).waitFor();
}

async function stopAndOpenDiagnosis(note) {
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByRole("button", { name: "生成报告", exact: true }).waitFor();
  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await dialog.getByLabel("报告用户说明").fill(note);
  await dialog.getByRole("button", { name: "生成预览", exact: true }).click();
  await dialog.getByText("导出预览", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await dialog.getByTestId("report-open-diagnosis").click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("skillId 与 contentHash 精确匹配当前 Workspace 成员", { exact: true }).waitFor();
}

async function analyzeReport() {
  await page.getByRole("button", { name: "分析原因", exact: true }).click();
  await page.locator(".diagnosis-candidate-list").waitFor();
}

async function proposeAndApply(repairTitle, beforeConfirm) {
  const candidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: repairTitle });
  await candidate.getByRole("button", { name: "生成修复提案", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认诊断修复提案" });
  await dialog.getByText("尚未修改 Skill", { exact: false }).waitFor();
  await beforeConfirm(dialog);
  await dialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await candidate.getByText("未验证", { exact: true }).waitFor();
  return candidate;
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "辅助修复多轮 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();

  await startRun();
  await advanceTo(coreNode.title);
  await submitModelTarget("提交完成", endNode.id);
  await page.locator(".runtime-events").getByText("条件计算", { exact: true }).waitFor();
  const conditionSourceRun = (await store.listRuns(member.projectId))[0];
  const conditionEvent = conditionSourceRun?.events.find((event) => event.type === "condition.evaluated");
  if (conditionEvent?.data.evaluations?.[0]?.result !== false) throw new Error("Condition evaluation was not persisted as false");
  await stopAndOpenDiagnosis("条件为 false 导致完成节点被拒绝");
  await analyzeReport();
  const conditionRepairTitle = `移除边 ${coreEndEdge.id} 的条件限制`;
  const conditionCandidate = await proposeAndApply(conditionRepairTitle, async (dialog) => {
    await dialog.getByText(coreEndEdge.id, { exact: true }).first().waitFor();
    const edgeBefore = (await store.getProjectGraph(member.projectId)).graph.edges.find((edge) => edge.id === coreEndEdge.id);
    if (!edgeBefore?.condition) throw new Error("Condition repair changed the graph before confirmation");
    await page.screenshot({ path: path.join(artifactDir, "condition-remove-diff-desktop.png"), fullPage: true });
  });
  const edgeAfter = (await store.getProjectGraph(member.projectId)).graph.edges.find((edge) => edge.id === coreEndEdge.id);
  if (edgeAfter?.condition) throw new Error("Confirmed condition repair did not remove the condition");

  await conditionCandidate.getByRole("button", { name: "前往测试运行", exact: true }).click();
  await startRun();
  await advanceTo(coreNode.title);
  await advanceTo(endNode.title);
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  const persistedConditionCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: conditionRepairTitle });
  await persistedConditionCandidate.getByLabel("选择修复后运行").selectOption({ index: 1 });
  await persistedConditionCandidate.getByRole("button", { name: "验证", exact: true }).click();
  await persistedConditionCandidate.getByText("已验证", { exact: true }).waitFor();
  await persistedConditionCandidate.getByText(new RegExp(`实际经过更新边 ${coreEndEdge.id}`, "u")).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "condition-remove-verified-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await startRun();
  await advanceTo(coreNode.title);
  await submitModelTarget("返回开始", startNode.id);
  await stopAndOpenDiagnosis("第一轮缺少返回开始节点的边");
  await analyzeReport();
  const firstRepairTitle = `添加 ${coreNode.id} -> ${startNode.id} 的回退边`;
  const firstCandidate = await proposeAndApply(firstRepairTitle, async (dialog) => {
    await dialog.getByText(new RegExp(`edge\\.diagnosis-\\d+`, "u")).first().waitFor();
  });
  await firstCandidate.getByText("第 1 轮", { exact: true }).waitFor();

  await firstCandidate.getByRole("button", { name: "前往测试运行", exact: true }).click();
  await startRun();
  await advanceTo(coreNode.title);
  await advanceTo(startNode.title);
  await submitModelTarget("提交完成", endNode.id);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  const failedCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: firstRepairTitle });
  await failedCandidate.getByLabel("选择修复后运行").selectOption({ index: 1 });
  await failedCandidate.getByRole("button", { name: "验证", exact: true }).click();
  await failedCandidate.getByText("验证失败", { exact: true }).waitFor();
  await failedCandidate.getByText(/随后在 seq \d+ 发生拒绝跳转，验证运行未完成/u).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "repair-downstream-failed-desktop.png"), fullPage: true });

  await failedCandidate.getByRole("button", { name: "查看验证运行", exact: true }).click();
  await page.getByRole("button", { name: "生成报告", exact: true }).waitFor();
  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const followUpReportDialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await followUpReportDialog.getByLabel("报告用户说明").fill("第一轮修复边已通过，但下游仍拒绝完成节点");
  await followUpReportDialog.getByRole("button", { name: "生成预览", exact: true }).click();
  await followUpReportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await followUpReportDialog.getByTestId("report-open-diagnosis").click();
  await followUpReportDialog.waitFor({ state: "hidden" });
  await analyzeReport();
  const secondRepairTitle = `添加 ${startNode.id} -> ${endNode.id} 的流程边`;
  const secondCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: secondRepairTitle });
  await secondCandidate.getByRole("button", { name: "生成修复提案", exact: true }).click();
  const secondDialog = page.getByRole("dialog", { name: "确认诊断修复提案" });
  await secondDialog.getByText("尚未修改 Skill", { exact: false }).waitFor();
  await secondDialog.locator(".modal-actions").getByRole("button", { name: "暂不应用", exact: true }).click();
  await secondDialog.waitFor({ state: "hidden" });
  await secondCandidate.getByText("第 1 轮", { exact: true }).waitFor();
  await secondCandidate.getByText("第 2 轮", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "repair-lineage-round-2-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth
  }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) {
    throw new Error(`Mobile repair lineage overflow: ${JSON.stringify(mobileMetrics)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "repair-lineage-round-2-mobile.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 960 });
  await secondCandidate.getByRole("button", { name: /^第 1 轮/u }).click();
  await page.locator(".diagnosis-candidate-list article").filter({ hasText: firstRepairTitle }).getByText("第 1 轮", { exact: true }).waitFor();

  const reports = await store.listImportedBugReports(workspace.workspaceId);
  const repairs = (await Promise.all(reports.map((report) => store.listDiagnosisRepairs(workspace.workspaceId, report.reportImportId)))).flat();
  const secondRepair = repairs.find((repair) => repair.round === 2);
  const firstRepair = repairs.find((repair) => repair.repairId === secondRepair?.lineage?.parentRepairId);
  if (!secondRepair?.lineage || !firstRepair || secondRepair.lineage.parentReportImportId !== firstRepair.reportImportId) {
    throw new Error("Persisted repair lineage is incomplete");
  }
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);

  const verification = {
    browser: "Google Chrome",
    workspaceId: workspace.workspaceId,
    projectId: member.projectId,
    conditionRepair: {
      edgeId: coreEndEdge.id,
      diffOpenedBeforeConfirmation: true,
      conditionRemoved: true,
      verifiedWithNewRun: true
    },
    failedRepair: {
      repairId: firstRepair.repairId,
      status: firstRepair.status,
      verificationRunId: firstRepair.verification?.runId,
      evidence: firstRepair.verification?.evidence
    },
    lineage: secondRepair.lineage,
    round: secondRepair.round,
    parentNavigationVerified: true,
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
