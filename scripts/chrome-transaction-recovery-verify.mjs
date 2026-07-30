import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-recovery-"));
process.once("exit", () => rmSync(dataRoot, { recursive: true, force: true }));
const dataDir = path.join(dataRoot, "studio");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4331";
await mkdir(artifactDir, { recursive: true });

const setupStore = new WorkspaceStore({ dataDir });
await setupStore.initialize();
const workspace = await setupStore.createWorkspace({ name: "事务恢复 Chrome 验收" });
const created = await setupStore.createManagedSkill(workspace.workspaceId, { name: "进程中断恢复流程", capability: "workflow" });
const member = created.members[0];
const source = JSON.parse(await readFile(path.join(dataDir, "projects", member.projectId, "source.json"), "utf8"));
const assetDir = path.join(source.root, "assets", "recovery-load");
await mkdir(assetDir, { recursive: true });
const payload = Buffer.alloc(128 * 1024, 0x5a);
await Promise.all(Array.from({ length: 450 }, (_, index) =>
  writeFile(path.join(assetDir, `fixture-${String(index).padStart(4, "0")}.bin`), payload)
));

const initial = await setupStore.getRevisionStatus(member.projectId);
const baselineChange = await setupStore.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: initial.activeRevision.revisionId,
  reason: "把恢复压力文件纳入稳定 Snapshot",
  operations: [{ op: "docs.write", target: "docs/stable-before-crash.md", value: "# 稳定基线\n\n该文档必须在恢复后保留。\n" }]
});
const baselineApplied = await setupStore.confirmAndApplyChangeSet(baselineChange.changeSetId, {
  digest: baselineChange.digest,
  baseRevision: baselineChange.baseRevision
});
const crashChange = await setupStore.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: baselineApplied.activeRevision,
  reason: "写入后强制终止进程，验证启动恢复",
  operations: [{ op: "docs.write", target: "docs/interrupted-write.md", value: "# 半完成写入\n\n进程退出后不能残留。\n" }]
});

const worker = spawn(process.execPath, [
  path.resolve("scripts/transaction-crash-worker.mjs"),
  dataDir,
  crashChange.changeSetId,
  crashChange.digest,
  crashChange.baseRevision
], { stdio: ["ignore", "pipe", "pipe"] });
let workerError = "";
worker.stderr.on("data", (chunk) => { workerError += chunk.toString(); });

const transactionDir = path.join(dataDir, "projects", member.projectId, "transactions");
const deadline = Date.now() + 30_000;
let interruptedJournal;
while (Date.now() < deadline) {
  const entries = await readdir(transactionDir).catch(() => []);
  for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
    const content = await readFile(path.join(transactionDir, entry), "utf8").catch(() => null);
    if (!content) continue;
    const journal = JSON.parse(content);
    if (journal.changeSetId === crashChange.changeSetId && journal.stage === "files-written") {
      interruptedJournal = journal;
      break;
    }
  }
  if (interruptedJournal) break;
  if (worker.exitCode !== null) break;
  await new Promise((resolve) => setTimeout(resolve, 2));
}
if (!interruptedJournal) {
  if (worker.exitCode === null) worker.kill("SIGKILL");
  throw new Error(`Did not observe files-written before worker exit. ${workerError}`);
}
worker.kill("SIGKILL");
await new Promise((resolve) => worker.once("exit", resolve));
const interruptedFile = await readFile(path.join(source.root, "docs/interrupted-write.md"), "utf8");
if (!interruptedFile.includes("半完成写入")) throw new Error("Worker was killed before the project file became durable");

const recoveredStore = new WorkspaceStore({ dataDir });
await recoveredStore.initialize();
const recoveredStatus = await recoveredStore.getRevisionStatus(member.projectId);
const recoveredChange = await recoveredStore.getChangeSet(crashChange.changeSetId);
const recoveredTransactions = await recoveredStore.listProjectTransactions(member.projectId);
const recovery = recoveredTransactions.find((transaction) => transaction.changeSetId === crashChange.changeSetId);
if (recoveredStatus.activeRevision.revisionId !== baselineApplied.activeRevision) throw new Error("Startup recovery advanced or rewound to the wrong revision");
if (recoveredChange.status !== "conflicted") throw new Error("Interrupted ChangeSet was not marked conflicted");
if (recovery?.stage !== "recovered" || recovery.recoveredFromStage !== "files-written" || recovery.recoveryAction !== "rolled-back") {
  throw new Error(`Unexpected recovery journal: ${JSON.stringify(recovery)}`);
}
try {
  await recoveredStore.readDocument(member.projectId, "docs/interrupted-write.md");
  throw new Error("Interrupted document survived startup recovery");
} catch (error) {
  if (error?.code !== "document_not_found") throw error;
}
if (!(await recoveredStore.readDocument(member.projectId, "docs/stable-before-crash.md")).content.includes("恢复后保留")) {
  throw new Error("Startup recovery lost stable base content");
}

const server = createApp({ store: recoveredStore, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4331, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "事务恢复 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "版本与基线" }).click();
  const historyDialog = page.getByRole("dialog", { name: "版本与基线" });
  await historyDialog.getByRole("region", { name: "异常恢复记录" }).waitFor();
  await historyDialog.getByText("1 次事务已安全回滚", { exact: true }).waitFor();
  await historyDialog.getByText(/中断阶段：文件已写入/u).waitFor();
  await historyDialog.getByText(/已恢复确认前 Snapshot/u).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "transaction-recovery-history.png"), fullPage: true });

  await historyDialog.locator("footer.modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill("interrupted-write");
  await page.getByText("没有匹配文档", { exact: true }).waitFor();
  await page.getByLabel("搜索文档").fill("stable-before-crash");
  await page.getByText("docs/stable-before-crash.md", { exact: true }).waitFor();

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("button", { name: "版本与基线" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await historyDialog.getByText(/中断阶段：文件已写入/u).waitFor();
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    dialogWidth: document.querySelector(".revision-modal")?.getBoundingClientRect().width ?? 0
  }));
  if (layout.documentWidth > layout.viewport || layout.dialogWidth > layout.viewport) {
    throw new Error(`Mobile recovery layout overflow: ${JSON.stringify(layout)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "transaction-recovery-mobile.png"), fullPage: true });

  const result = {
    workspaceId: workspace.workspaceId,
    projectId: member.projectId,
    changeSetId: crashChange.changeSetId,
    killedAtStage: interruptedJournal.stage,
    recovery: {
      stage: recovery.stage,
      recoveredFromStage: recovery.recoveredFromStage,
      action: recovery.recoveryAction
    },
    activeRevision: recoveredStatus.activeRevision.revisionId,
    stableRevision: baselineApplied.activeRevision,
    interruptedDocumentRemoved: true,
    stableDocumentPreserved: true,
    layout,
    consoleErrors,
    failedResponses
  };
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser errors: ${JSON.stringify(result)}`);
  await writeFile(path.join(artifactDir, "transaction-recovery.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
