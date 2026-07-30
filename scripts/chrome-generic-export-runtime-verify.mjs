import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const execFileAsync = promisify(execFile);
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-generic-export-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4331";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "通用导出 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "可移植运行 Skill", capability: "workflow", description: "验证通用导出历史和完整 CLI" });
const member = created.members[0];
if (!member) throw new Error("Managed Skill was not created");
const oldPreview = await store.createGenericExport(member.projectId, { workspaceId: workspace.workspaceId, revisionId: member.activeRevision, profile: "generic/1" });
const oldReady = await store.confirmGenericExport(oldPreview.exportId, { digest: oldPreview.digest, revisionId: oldPreview.revisionId });
const document = await store.readDocument(member.projectId, "SKILL.md");
const changeSet = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: document.activeRevision,
  reason: "为当前版本导出增加接入说明",
  operations: [{ op: "docs.write", target: "SKILL.md", value: `${document.content}\n## 当前版本\n\n用于完整通用 CLI 验收。\n` }]
});
const applied = await store.confirmAndApplyChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision });

const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4331, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "通用导出 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "导出通用包", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出通用 Skill 包" });
  await exportDialog.getByText("generic/1", { exact: true }).waitFor();
  await exportDialog.locator(".export-file-section code").filter({ hasText: "engine/skill-engine.mjs" }).waitFor();
  await exportDialog.locator(".export-file-section code").filter({ hasText: "engine/README.md" }).waitFor();
  const history = exportDialog.locator(".export-history-section");
  await history.getByText("导出记录", { exact: true }).waitFor();
  await history.getByText("2", { exact: true }).waitFor();
  await history.getByText("当前版本", { exact: true }).waitFor();
  await history.getByText("可下载", { exact: true }).waitFor();
  await history.getByText("待确认", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "generic-export-history-preview.png") });

  await exportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await exportDialog.getByRole("button", { name: "下载 ZIP", exact: true }).waitFor();
  const currentRecords = await store.listGenericExports(member.projectId, workspace.workspaceId);
  const currentReady = currentRecords.find((item) => item.revisionId === applied.activeRevision && item.status === "ready");
  if (!currentReady) throw new Error("Current revision export was not generated");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportDialog.getByRole("button", { name: "下载 ZIP", exact: true }).click()
  ]);
  const downloadedZip = path.join(artifactDir, "generic-runtime-export.zip");
  await download.saveAs(downloadedZip);

  const oldRow = history.locator(":scope > div > div").filter({ hasText: oldReady.archiveName });
  page.once("dialog", (dialog) => dialog.accept());
  await oldRow.getByTitle("删除导出记录").click();
  await history.getByText("1", { exact: true }).waitFor();
  if ((await store.listGenericExports(member.projectId, workspace.workspaceId)).some((item) => item.exportId === oldReady.exportId)) throw new Error("Old export record was not deleted");
  await page.screenshot({ path: path.join(artifactDir, "generic-export-history-cleaned.png") });

  const extracted = path.join(artifactDir, "generic-runtime-export-extracted");
  await rm(extracted, { recursive: true, force: true });
  const zip = new AdmZip(downloadedZip);
  const entries = zip.getEntries().map((entry) => entry.entryName);
  for (const required of ["SKILL.md", "skill.json", "graph/main.json", "engine/skill-engine.mjs", "engine/README.md", "export-manifest.json"]) {
    if (!entries.includes(required)) throw new Error(`Export is missing ${required}`);
  }
  if (entries.some((entry) => entry.includes("workspace") || entry.includes("runtime-artifact") || entry.includes("baseline"))) throw new Error("Export leaked Studio-private files");
  zip.extractAllTo(extracted, true);
  const cli = path.join(extracted, "engine", "skill-engine.mjs");
  const stateFile = path.join(artifactDir, "generic-runtime-state.json");
  await rm(stateFile, { force: true });
  const inspected = JSON.parse((await execFileAsync(process.execPath, [cli, "inspect"])).stdout);
  const started = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "start", "--state", stateFile, "--variables", JSON.stringify({ requestId: "chrome-generic" })])).stdout);
  await execFileAsync(process.execPath, [cli, "run", "pause", "--state", stateFile]);
  await execFileAsync(process.execPath, [cli, "run", "resume", "--state", stateFile]);
  const rejected = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "next", "--state", stateFile, "--to", "flow.missing"])).stdout);
  const entered = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "next", "--state", stateFile, "--to", "flow.core-step", "--set", JSON.stringify({ result: "ok" })])).stdout);
  const completed = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "next", "--state", stateFile, "--to", "flow.end"])).stdout);
  if (started.state.currentNodeId !== "flow.start" || rejected.status !== "rejected" || rejected.state.currentNodeId !== "flow.start" || entered.state.currentNodeId !== "flow.core-step" || completed.status !== "done" || completed.state.status !== "completed") {
    throw new Error(`Unexpected CLI flow: ${JSON.stringify({ started, rejected, entered, completed })}`);
  }
  if (!completed.state.events.some((event) => event.type === "engine.reject") || completed.state.events.at(-1)?.type !== "engine.complete") throw new Error("CLI Trace is incomplete");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile export overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "generic-export-history-mobile.png"), fullPage: true });

  const verification = {
    projectId: member.projectId,
    oldExportDeleted: oldReady.exportId,
    currentExportId: currentReady.exportId,
    currentRevision: applied.activeRevision,
    archiveEntries: entries,
    cli: { inspected, startedStatus: started.state.status, rejectedCode: rejected.rejection.code, completedStatus: completed.state.status, eventTypes: completed.state.events.map((event) => event.type) },
    mobileMetrics,
    consoleErrors,
    failedResponses
  };
  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  await writeFile(path.join(artifactDir, "generic-export-runtime-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify({ exportCount: (await store.listGenericExports(member.projectId, workspace.workspaceId)).length, cli: verification.cli, mobileMetrics, consoleErrors, failedResponses }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
