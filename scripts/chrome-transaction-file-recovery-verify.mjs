import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const mutationSteps = [
  "document-rename-destination",
  "document-rename-source",
  "document-rename-graph"
];
const mutationLabels = {
  "document-rename-destination": "写入重命名目标文档",
  "document-rename-source": "移除重命名源文档",
  "document-rename-graph": "更新文档图引用"
};
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-file-recovery-"));
const dataDir = path.join(dataRoot, "studio");
const signalDir = path.join(dataRoot, "signals");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/transaction-file-recovery");
const baseUrl = "http://127.0.0.1:4332";
process.once("exit", () => rmSync(dataRoot, { recursive: true, force: true }));
await Promise.all([
  mkdir(signalDir, { recursive: true }),
  mkdir(artifactDir, { recursive: true })
]);

let server;
let browser;

try {
  let store = new WorkspaceStore({ dataDir });
  await store.initialize();
  const workspace = await store.createWorkspace({ name: "逐文件事务恢复 Chrome 验收" });
  const created = await store.createManagedSkill(workspace.workspaceId, {
    name: "文档重命名恢复流程",
    capability: "workflow"
  });
  const member = created.members[0];
  const initialGraph = await store.getProjectGraph(member.projectId);
  const coreNode = initialGraph.graph.nodes.find((node) => node.id === "flow.core-step");
  if (!coreNode) throw new Error("Managed workflow does not contain flow.core-step");

  const sourcePath = "docs/transaction-source.md";
  const sourceContent = "# 事务源文档\n\n三个文件步骤被强制终止后都必须恢复这份内容。\n";
  const documentChange = await store.createChangeSet(member.projectId, {
    workspaceId: workspace.workspaceId,
    baseRevision: initialGraph.activeRevision,
    reason: "创建逐文件恢复的稳定源文档",
    operations: [{ op: "docs.write", target: sourcePath, value: sourceContent }]
  });
  const documentApplied = await store.confirmAndApplyChangeSet(documentChange.changeSetId, {
    digest: documentChange.digest,
    baseRevision: documentChange.baseRevision
  });
  const bindingChange = await store.createChangeSet(member.projectId, {
    workspaceId: workspace.workspaceId,
    baseRevision: documentApplied.activeRevision,
    reason: "把稳定源文档绑定到核心节点",
    operations: [{
      op: "graph.node.update",
      target: coreNode.id,
      value: { ...coreNode, doc: sourcePath }
    }]
  });
  await store.confirmAndApplyChangeSet(bindingChange.changeSetId, {
    digest: bindingChange.digest,
    baseRevision: bindingChange.baseRevision
  });

  const stableStatus = await store.getRevisionStatus(member.projectId);
  const stableRevision = stableStatus.activeRevision.revisionId;
  const stableRevisionCount = (await store.listRevisions(member.projectId)).length;
  const sourceDescriptor = JSON.parse(await readFile(path.join(dataDir, "projects", member.projectId, "source.json"), "utf8"));
  const projectRoot = sourceDescriptor.root;
  const graphFile = path.join(projectRoot, "graph", "main.json");
  const stableGraphBytes = await readFile(graphFile, "utf8");
  const results = [];

  for (const step of mutationSteps) {
    const suffix = step.replace("document-rename-", "");
    const destinationPath = `docs/transaction-target-${suffix}.md`;
    const renameChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: stableRevision,
      reason: `在 ${mutationLabels[step]} 后强制终止进程`,
      operations: [{ op: "docs.rename", target: sourcePath, value: destinationPath }]
    });
    const signalFile = path.join(signalDir, `${suffix}.json`);
    const child = spawn(process.execPath, [
      path.resolve("scripts/transaction-crash-worker.mjs"),
      dataDir,
      renameChange.changeSetId,
      renameChange.digest,
      renameChange.baseRevision,
      step,
      signalFile
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const marker = await waitForJson(signalFile, child, 30_000, stderr);
    const exit = await exited;
    if (exit.code !== null || exit.signal !== "SIGKILL") {
      throw new Error(`Worker did not exit through SIGKILL at ${step}: ${JSON.stringify({ exit, stdout, stderr })}`);
    }
    if (marker.changeSetId !== renameChange.changeSetId || marker.step !== step || marker.stage !== "prepared") {
      throw new Error(`Unexpected crash marker at ${step}: ${JSON.stringify(marker)}`);
    }

    const sourceFile = path.join(projectRoot, ...sourcePath.split("/"));
    const destinationFile = path.join(projectRoot, ...destinationPath.split("/"));
    const partialSource = await readOptional(sourceFile);
    const partialDestination = await readOptional(destinationFile);
    const partialGraphBytes = await readFile(graphFile, "utf8");
    const partialGraph = JSON.parse(partialGraphBytes);
    const partialReference = partialGraph.nodes.find((node) => node.id === coreNode.id)?.doc;
    const expectedSourceExists = step === "document-rename-destination";
    const expectedReference = step === "document-rename-graph" ? destinationPath : sourcePath;
    if ((partialSource !== null) !== expectedSourceExists) {
      throw new Error(`Unexpected source durability at ${step}: expected exists=${expectedSourceExists}`);
    }
    if (partialDestination !== sourceContent) {
      throw new Error(`Destination bytes were not durable at ${step}`);
    }
    if (partialReference !== expectedReference) {
      throw new Error(`Unexpected graph reference at ${step}: ${String(partialReference)}`);
    }

    const interruptedJournal = JSON.parse(await readFile(
      path.join(dataDir, "projects", member.projectId, "transactions", `${marker.transactionId}.json`),
      "utf8"
    ));
    if (interruptedJournal.stage !== "prepared" || interruptedJournal.fileMutation !== step) {
      throw new Error(`Interrupted journal did not preserve ${step}: ${JSON.stringify(interruptedJournal)}`);
    }

    store = new WorkspaceStore({ dataDir });
    await store.initialize();
    const recoveredStatus = await store.getRevisionStatus(member.projectId);
    const recoveredRevisions = await store.listRevisions(member.projectId);
    const recoveredChange = await store.getChangeSet(renameChange.changeSetId);
    const recoveredJournal = (await store.listProjectTransactions(member.projectId))
      .find((transaction) => transaction.changeSetId === renameChange.changeSetId);
    const recoveredGraphBytes = await readFile(graphFile, "utf8");
    const recoveredGraph = await store.getProjectGraph(member.projectId);

    if (recoveredStatus.activeRevision.revisionId !== stableRevision) {
      throw new Error(`Recovery changed active revision at ${step}`);
    }
    if (recoveredRevisions.length !== stableRevisionCount) {
      throw new Error(`Recovery changed revision count at ${step}: ${recoveredRevisions.length}`);
    }
    if ((await store.readDocument(member.projectId, sourcePath)).content !== sourceContent) {
      throw new Error(`Recovery did not restore source bytes at ${step}`);
    }
    await expectDocumentMissing(store, member.projectId, destinationPath);
    if (recoveredGraphBytes !== stableGraphBytes) {
      throw new Error(`Recovery did not restore exact graph bytes at ${step}`);
    }
    if (recoveredGraph.graph.nodes.find((node) => node.id === coreNode.id)?.doc !== sourcePath) {
      throw new Error(`Recovery did not restore graph binding at ${step}`);
    }
    if (recoveredChange.status !== "conflicted") {
      throw new Error(`Interrupted ChangeSet was not conflicted at ${step}`);
    }
    if (
      recoveredJournal?.stage !== "recovered" ||
      recoveredJournal.recoveredFromStage !== "prepared" ||
      recoveredJournal.recoveredFromFileMutation !== step ||
      recoveredJournal.recoveryAction !== "rolled-back"
    ) {
      throw new Error(`Unexpected recovered journal at ${step}: ${JSON.stringify(recoveredJournal)}`);
    }

    results.push({
      step,
      label: mutationLabels[step],
      changeSetId: renameChange.changeSetId,
      transactionId: marker.transactionId,
      exitSignal: exit.signal,
      partialDisk: {
        sourceExists: partialSource !== null,
        destinationExists: partialDestination !== null,
        graphReference: partialReference
      },
      recovery: {
        stage: recoveredJournal.stage,
        recoveredFromStage: recoveredJournal.recoveredFromStage,
        recoveredFromFileMutation: recoveredJournal.recoveredFromFileMutation,
        action: recoveredJournal.recoveryAction,
        activeRevision: recoveredStatus.activeRevision.revisionId,
        revisionCount: recoveredRevisions.length,
        sourceRestored: true,
        destinationRemoved: true,
        graphBytesRestored: true
      }
    });
  }

  server = createApp({ store, allowedOrigins: [baseUrl] });
  await new Promise((resolve) => server.listen(4332, "127.0.0.1", resolve));
  browser = await chromium.launch({ channel: "chrome", headless: false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const consoleErrors = [];
  const failedResponses = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "逐文件事务恢复 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "版本与基线" }).click();
  const historyDialog = page.getByRole("dialog", { name: "版本与基线" });
  const recoveryRegion = historyDialog.getByRole("region", { name: "异常恢复记录" });
  await recoveryRegion.getByText("3 次事务已安全回滚", { exact: true }).waitFor();
  if (await recoveryRegion.locator(".transaction-recovery-list > li").count() !== 3) {
    throw new Error("Version history did not render exactly three recovery records");
  }
  for (const label of Object.values(mutationLabels)) {
    await recoveryRegion.getByText(new RegExp(`文件步骤：${label}`)).waitFor();
  }
  await page.screenshot({ path: path.join(artifactDir, "transaction-file-recovery-desktop.png"), fullPage: true });

  await historyDialog.locator("footer.modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill("transaction-source");
  const sourceButton = page.getByRole("button", { name: /docs\/transaction-source\.md/u });
  await sourceButton.waitFor();
  if (await page.locator(".document-list > button").count() !== 1) {
    throw new Error("Document page did not show exactly the restored source document");
  }
  await sourceButton.click();
  await page.getByText("三个文件步骤被强制终止后都必须恢复这份内容。", { exact: true }).waitFor();
  await page.getByLabel("搜索文档").fill("transaction-target");
  await page.getByText("没有匹配文档", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "transaction-file-recovery-documents.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("button", { name: "版本与基线" }).click();
  await recoveryRegion.getByText("3 次事务已安全回滚", { exact: true }).waitFor();
  for (const label of Object.values(mutationLabels)) {
    await recoveryRegion.getByText(new RegExp(`文件步骤：${label}`)).waitFor();
  }
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    dialogWidth: document.querySelector(".revision-modal")?.getBoundingClientRect().width ?? 0,
    recoveryRegionWidth: document.querySelector(".transaction-recovery-section")?.getBoundingClientRect().width ?? 0
  }));
  if (
    layout.documentWidth > layout.viewportWidth ||
    layout.dialogWidth > layout.viewportWidth ||
    layout.recoveryRegionWidth > layout.viewportWidth
  ) {
    throw new Error(`Mobile transaction recovery layout overflow: ${JSON.stringify(layout)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "transaction-file-recovery-mobile.png"), fullPage: true });

  const report = {
    workspaceId: workspace.workspaceId,
    projectId: member.projectId,
    stableRevision,
    stableRevisionCount,
    results,
    browser: {
      channel: "chrome",
      headless: false,
      recoveryCount: 3,
      sourceDocumentVisible: true,
      targetDocumentsAbsent: true,
      layout,
      consoleErrors,
      failedResponses
    }
  };
  if (consoleErrors.length || failedResponses.length) {
    throw new Error(`Browser errors: ${JSON.stringify(report.browser)}`);
  }
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function waitForJson(file, child, timeoutMs, stderr) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Worker exited before writing its crash marker: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  child.kill("SIGKILL");
  throw new Error(`Timed out waiting for crash marker ${file}: ${stderr}`);
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function expectDocumentMissing(store, projectId, documentPath) {
  try {
    await store.readDocument(projectId, documentPath);
  } catch (error) {
    if (error?.code === "document_not_found") return;
    throw error;
  }
  throw new Error(`Expected document to be missing: ${documentPath}`);
}
