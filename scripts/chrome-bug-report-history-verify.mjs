import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-report-history-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4334";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Bug Report Chrome 验收" });
const detail = await store.createManagedSkill(workspace.workspaceId, { name: "报告生命周期 Skill", capability: "workflow", description: "验证双格式报告历史" });
const member = detail.members[0];
if (!member) throw new Error("Managed Skill was not created");
const started = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.core-step" });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.end" });
const oldPreview = await store.createBugReport(member.projectId, started.run.runId, { workspaceId: workspace.workspaceId, sanitizationMode: "default", userNote: "旧报告说明" });
const oldReady = await store.confirmBugReport(oldPreview.reportId, { digest: oldPreview.digest });
const currentPreview = await store.createBugReport(member.projectId, started.run.runId, { workspaceId: workspace.workspaceId, sanitizationMode: "strict", userNote: "客户 secret sk-abcdefghijklmnop" });

const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataRoot, "runtime-dialog"),
  store,
  provider: {
    probe: async () => ({ schemaVersion: "1.0", providerId: "report-verification", label: "报告验收模型", status: "ready", keyConfigured: true, defaultModel: "report-verification", reason: "ready", checkedAt: new Date().toISOString() }),
    invoke: async () => { throw new Error("报告历史验收不调用模型"); }
  }
});
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4334, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Bug Report Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.locator(".runtime-summary").getByText("已完成", { exact: true }).waitFor();
  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "生成 Bug Report" });
  await dialog.getByText("报告记录", { exact: true }).waitFor();
  await dialog.locator(".bug-report-history > header").getByText("2", { exact: true }).waitFor();
  await dialog.getByText("待确认", { exact: true }).waitFor();
  await dialog.getByText("严格脱敏", { exact: true }).waitFor();
  const exportPreview = dialog.locator(".bug-report-preview-grid > section").nth(1);
  await exportPreview.getByText("[已按严格模式移除用户说明]", { exact: false }).waitFor();
  if ((await exportPreview.innerText()).includes("sk-abcdefghijklmnop")) throw new Error("Strict preview leaked the simulated secret");

  await dialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await dialog.getByRole("button", { name: "下载 JSON", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "下载 Markdown", exact: true }).waitFor();
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "下载 JSON", exact: true }).click()
  ]);
  const jsonPath = path.join(artifactDir, "bug-report-history.report.json");
  await jsonDownload.saveAs(jsonPath);
  const [markdownDownload] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "下载 Markdown", exact: true }).click()
  ]);
  const markdownPath = path.join(artifactDir, "bug-report-history.report.md");
  await markdownDownload.saveAs(markdownPath);
  const json = JSON.parse(await readFile(jsonPath, "utf8"));
  const markdown = await readFile(markdownPath, "utf8");
  if (json.reportId !== currentPreview.reportId || !markdown.includes(`报告 ID：\`${currentPreview.reportId}\``)) throw new Error("JSON and Markdown do not represent the same report");
  if (markdown.includes("sk-abcdefghijklmnop") || !markdown.includes("## 完整脱敏 JSON") || !markdown.includes("[已按严格模式移除用户说明]")) throw new Error("Markdown did not preserve the sanitized report facts");

  const oldRow = dialog.locator(".bug-report-history > div > button").nth(1);
  page.once("dialog", (confirmation) => confirmation.accept());
  await oldRow.getByTitle("删除报告记录").click();
  await dialog.locator(".bug-report-history > header").getByText("1", { exact: true }).waitFor();
  const remaining = await store.listBugReports(member.projectId, workspace.workspaceId);
  if (remaining.length !== 1 || remaining[0].reportId !== currentPreview.reportId || remaining.some((item) => item.reportId === oldReady.reportId)) throw new Error("Report history cleanup removed the wrong record");
  await page.screenshot({ path: path.join(artifactDir, "bug-report-history-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile report overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "bug-report-history-mobile.png"), fullPage: true });

  const verification = {
    reportId: currentPreview.reportId,
    deletedReportId: oldReady.reportId,
    jsonFileName: jsonDownload.suggestedFilename(),
    markdownFileName: markdownDownload.suggestedFilename(),
    markdownHasSanitizedJson: markdown.includes("## 完整脱敏 JSON"),
    remainingReportCount: remaining.length,
    mobileMetrics,
    consoleErrors,
    failedResponses
  };
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);
  await writeFile(path.join(artifactDir, "bug-report-history-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
