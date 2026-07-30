import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-diagnosis-attribution-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4342";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "诊断来源 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "诊断修复流程", capability: "workflow" });
const member = created.members[0];
if (!member) throw new Error("Managed Skill was not created");
const started = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: {} });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.core-step" });
const rejected = await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.start" });
if (rejected.commandResult.accepted) throw new Error("Invalid transition was unexpectedly accepted");
await store.commandRun(member.projectId, started.run.runId, "stop", {});
const reportPreview = await store.createBugReport(member.projectId, started.run.runId, {
  workspaceId: workspace.workspaceId,
  sanitizationMode: "default",
  userNote: "验证诊断来源和 Trace 证据"
});
const report = await store.confirmBugReport(reportPreview.reportId, { digest: reportPreview.digest });
const imported = await store.importStoredBugReport(workspace.workspaceId, report.reportId);

const server = createApp({ store, benchmarkRunner: { list: async () => [] }, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4342, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "诊断来源 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await page.getByText("skillId 与 contentHash 精确匹配当前 Workspace 成员", { exact: true }).waitFor();
  await page.getByRole("button", { name: "分析原因", exact: true }).click();
  const candidate = page.locator(".diagnosis-candidate-list article").filter({ has: page.getByRole("button", { name: "生成修复提案", exact: true }) });
  await candidate.getByText("添加 flow.core-step -> flow.start 的回退边", { exact: true }).waitFor();
  await candidate.getByRole("button", { name: "生成修复提案", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "确认诊断修复提案" });
  const metadata = dialog.getByTestId("changeset-metadata");
  await metadata.getByText("诊断修复建议", { exact: true }).waitFor();
  await metadata.getByText("诊断结论", { exact: true }).waitFor();
  await metadata.getByText("Trace 事件", { exact: true }).first().waitFor();
  const diagnosisSourceId = await metadata.locator("header code").getAttribute("title");
  if (!diagnosisSourceId?.startsWith("diagnosis-")) throw new Error(`Diagnosis sourceId was not rendered: ${diagnosisSourceId}`);
  if ((await store.getProjectGraph(member.projectId)).graph.edges.some((edge) => edge.from === "flow.core-step" && edge.to === "flow.start")) throw new Error("Repair changed the graph before confirmation");
  await page.screenshot({ path: path.join(artifactDir, "changeset-diagnosis-attribution-proposed.png"), fullPage: true });

  await dialog.getByRole("button", { name: "拒绝提案", exact: true }).click();
  await dialog.getByText("该 ChangeSet 已被拒绝，不会修改项目；需要调整时请重新生成提案。", { exact: true }).waitFor();
  if ((await store.getProjectGraph(member.projectId)).graph.edges.some((edge) => edge.from === "flow.core-step" && edge.to === "flow.start")) throw new Error("Rejected repair changed the graph");
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();

  const rejectedCandidate = page.locator(".diagnosis-candidate-list article").filter({ hasText: "添加 flow.core-step -> flow.start 的回退边" });
  await rejectedCandidate.getByRole("button", { name: "重新生成修复提案", exact: true }).click();
  const replacement = page.getByRole("dialog", { name: "确认诊断修复提案" });
  await replacement.getByTestId("changeset-metadata").getByText("诊断修复建议", { exact: true }).waitFor();
  await replacement.getByRole("button", { name: "确认并应用", exact: true }).click();
  await replacement.waitFor({ state: "hidden" });
  const appliedGraph = await store.getProjectGraph(member.projectId);
  if (!appliedGraph.graph.edges.some((edge) => edge.from === "flow.core-step" && edge.to === "flow.start")) throw new Error("Confirmed repair was not applied");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mobile = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  if (mobile.document > mobile.viewport) throw new Error(`Mobile diagnosis overflow: ${mobile.document}px > ${mobile.viewport}px`);
  await page.screenshot({ path: path.join(artifactDir, "changeset-diagnosis-attribution-mobile.png"), fullPage: true });
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);

  const verification = {
    browser: "Google Chrome",
    workspaceId: workspace.workspaceId,
    projectId: member.projectId,
    reportImportId: imported.reportImportId,
    diagnosisSourceId,
    evidenceKinds: ["diagnosis", "trace"],
    graphUnchangedBeforeConfirmation: true,
    rejectedProposalDidNotWrite: true,
    replacementRequiredNewConfirmation: true,
    confirmedRepairApplied: true,
    mobile,
    consoleErrors,
    failedResponses,
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "changeset-diagnosis-attribution-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, rejectClose) => server.close((error) => error ? rejectClose(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
