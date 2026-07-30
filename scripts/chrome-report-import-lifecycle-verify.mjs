import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-report-import-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4335";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "报告导入 Chrome 验收" });
const detail = await store.createManagedSkill(workspace.workspaceId, { name: "报告复现 Skill", capability: "workflow", description: "验证批量导入、指纹和清理" });
const member = detail.members[0];
if (!member) throw new Error("Managed Skill was not created");
const started = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { request: "report-import" } });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.missing-first" });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.core-step" });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.missing-second" });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.end" });
const first = await store.createBugReport(member.projectId, started.run.runId, { workspaceId: workspace.workspaceId, sanitizationMode: "default", userNote: "批量导入第一份" });
const second = await store.createBugReport(member.projectId, started.run.runId, { workspaceId: workspace.workspaceId, sanitizationMode: "strict", userNote: "批量导入第二份" });
const firstDocument = structuredClone(first.report);
const traceIdentity = firstDocument.trace.at(-1);
if (!traceIdentity) throw new Error("Report trace is empty");
firstDocument.trace.push(
  { ...traceIdentity, seq: 8, type: "llm.error", actor: "system", data: { category: "protocol", message: "结构化输出无效" } },
  { ...traceIdentity, seq: 9, type: "tool.error", actor: "tool", data: { status: "failed", message: "工具退出" } },
  { ...traceIdentity, seq: 10, type: "sandbox.timed-out", actor: "sandbox", data: { status: "failed", message: "超过执行时限" } }
);
firstDocument.coverage.conversation = true;
firstDocument.coverage.tools = true;

const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataRoot, "runtime-dialog"),
  store,
  provider: {
    probe: async () => ({ schemaVersion: "1.0", providerId: "report-import-verification", label: "导入验收模型", status: "ready", keyConfigured: true, defaultModel: "report-import-verification", reason: "ready", checkedAt: new Date().toISOString() }),
    invoke: async () => { throw new Error("报告导入验收不调用模型"); }
  }
});
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, benchmarkRunner: { list: async () => [] }, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4335, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "报告导入 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await page.getByRole("heading", { name: "导入一份 Bug Report" }).waitFor();

  const payload = [
    { name: "first.report.json", content: JSON.stringify(firstDocument) },
    { name: "second.report.json", content: JSON.stringify(second.report) },
    { name: "first-duplicate.report.json", content: JSON.stringify(firstDocument) }
  ];
  await page.evaluate((files) => {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(new File([file.content], file.name, { type: "application/json" })));
    window.__skillDesignerReportTransfer = transfer;
    document.querySelector(".diagnosis-page")?.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
  }, payload);
  await page.getByText("放下 JSON Bug Report", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "report-import-drag-overlay.png") });
  await page.evaluate(() => {
    const transfer = window.__skillDesignerReportTransfer;
    document.querySelector(".diagnosis-page")?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    delete window.__skillDesignerReportTransfer;
  });

  await page.locator(".report-import-list-panel > header").getByText("2", { exact: true }).waitFor();
  const importedBeforeDelete = await store.listImportedBugReports(workspace.workspaceId);
  if (importedBeforeDelete.length !== 2) throw new Error(`Batch import did not deduplicate identical reportId: ${importedBeforeDelete.length}`);
  await page.locator(".report-runtime-fingerprint.recorded").waitFor();
  const fingerprintText = await page.locator(".report-runtime-fingerprint").innerText();
  if (!fingerprintText.includes(started.artifact.fingerprint.value) || !fingerprintText.includes(started.artifact.fingerprint.inputHash)) throw new Error("RuntimeArtifact fingerprint is not visible in report replay");

  const symptoms = page.locator(".report-symptoms > button");
  if (await symptoms.count() !== 2) throw new Error("Multiple report symptoms were not rendered as independent seek controls");
  await symptoms.nth(1).click();
  if (await page.getByLabel("报告回放时间轴").inputValue() !== "5") throw new Error("Second symptom did not seek to seq 5");
  await page.locator(".trace-flow-node.rejected").filter({ hasText: "核心步骤" }).waitFor();
  await page.getByRole("button", { name: "分析原因", exact: true }).click();
  const rejectionDiagnoses = page.getByRole("heading", { name: "下一节点提交不符合当前合法出口", exact: true });
  await rejectionDiagnoses.first().waitFor();
  if (await rejectionDiagnoses.count() !== 2) throw new Error("Two symptoms did not produce two independently evidenced diagnosis candidates");
  await page.getByText("模型输出", { exact: true }).waitFor();
  await page.getByText("工具执行", { exact: true }).waitFor();
  await page.getByText("运行环境", { exact: true }).waitFor();
  await page.getByText("验证方式 · 新运行验证", { exact: true }).first().waitFor();
  await page.getByText("验证方式 · 环境自检后重跑", { exact: true }).waitFor();
  const deletedImport = (await store.listImportedBugReports(workspace.workspaceId)).find((item) => item.report.reportId === first.reportId);
  if (!deletedImport) throw new Error("Selected imported report was not persisted");
  await page.screenshot({ path: path.join(artifactDir, "report-import-lifecycle-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const diagnosisMobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (diagnosisMobileMetrics.body > diagnosisMobileMetrics.viewport || diagnosisMobileMetrics.html > diagnosisMobileMetrics.viewport) throw new Error(`Mobile diagnosis domain overflow: ${JSON.stringify(diagnosisMobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-domains-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".report-import-item.active .report-import-delete").click();
  await page.locator(".report-import-list-panel > header").getByText("1", { exact: true }).waitFor();
  const remaining = await store.listImportedBugReports(workspace.workspaceId);
  if (remaining.length !== 1 || remaining[0].reportImportId === deletedImport.reportImportId) throw new Error("Imported report deletion removed the wrong record");
  let derivedRemoved = false;
  try { await store.listDiagnoses(workspace.workspaceId, deletedImport.reportImportId); } catch (error) { derivedRemoved = error?.code === "report_import_not_found"; }
  if (!derivedRemoved) throw new Error("Derived diagnosis records remained accessible after imported report deletion");
  if ((await store.getRun(member.projectId, started.run.runId)).run.state.status !== "completed") throw new Error("Deleting an imported copy changed the source run");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile report import overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "report-import-lifecycle-mobile.png"), fullPage: true });

  const verification = {
    importedReportIds: importedBeforeDelete.map((item) => item.reportImportId),
    deletedReportImportId: deletedImport.reportImportId,
    remainingReportImportId: remaining[0].reportImportId,
    fingerprint: started.artifact.fingerprint,
    secondSymptomSeq: 5,
    derivedRemoved,
    sourceRunStatus: (await store.getRun(member.projectId, started.run.runId)).run.state.status,
    diagnosisMobileMetrics,
    mobileMetrics,
    consoleErrors,
    failedResponses
  };
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);
  await writeFile(path.join(artifactDir, "report-import-lifecycle-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
