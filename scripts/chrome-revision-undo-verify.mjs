import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-undo-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4328";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Revision 撤销 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "完整快照撤销流程", capability: "workflow" });
const member = created.members[0];
const initialGraph = await store.getProjectGraph(member.projectId);
const core = initialGraph.graph.nodes.find((node) => node.id === "flow.core-step");
const graphChange = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: initialGraph.activeRevision,
  reason: "创建撤销目标之前应保留的图变更",
  operations: [{ op: "graph.node.update", target: core.id, value: { ...core, title: "撤销后仍保留的图标题" } }]
});
const graphApplied = await store.confirmAndApplyChangeSet(graphChange.changeSetId, { digest: graphChange.digest, baseRevision: graphChange.baseRevision });
const documentChange = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: graphApplied.activeRevision,
  reason: "创建需要由最近一次撤销删除的文档",
  operations: [{ op: "docs.write", target: "docs/remove-on-undo.md", value: "# Undo target\n\n确认撤销后该文件应消失。\n" }]
});
const documentApplied = await store.confirmAndApplyChangeSet(documentChange.changeSetId, { digest: documentChange.digest, baseRevision: documentChange.baseRevision });
const beforeUndo = await store.getRevisionStatus(member.projectId);

const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4328, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function proposeUndo(button) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === "POST" && new URL(candidate.url()).pathname.endsWith("/undo-changesets")),
    button.click()
  ]);
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Undo proposal failed: ${JSON.stringify(payload.error)}`);
  return payload.data;
}

async function expectDocumentMissing() {
  try {
    await store.readDocument(member.projectId, "docs/remove-on-undo.md");
  } catch (error) {
    if (error?.code === "document_not_found") return;
    throw error;
  }
  throw new Error("Undo target document still exists");
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Revision 撤销 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "版本与基线" }).click();
  const historyDialog = page.getByRole("dialog", { name: "版本与基线" });
  await historyDialog.getByText("3 个不可变版本", { exact: true }).waitFor();

  const rejectedProposal = await proposeUndo(historyDialog.getByRole("button", { name: "撤销最近提交" }));
  const undoDialog = page.getByRole("dialog", { name: "确认撤销最近提交" });
  await undoDialog.getByText("docs/remove-on-undo.md", { exact: true }).waitFor();
  await undoDialog.getByText("删除", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "revision-undo-rejected-preview.png"), fullPage: true });
  if ((await store.getRevisionStatus(member.projectId)).activeRevision.revisionId !== documentApplied.activeRevision) throw new Error("Undo preview advanced revision");
  if (!(await store.readDocument(member.projectId, "docs/remove-on-undo.md")).content.includes("确认撤销后")) throw new Error("Undo preview changed project files");
  await undoDialog.getByRole("button", { name: "拒绝撤销", exact: true }).click();
  await undoDialog.waitFor({ state: "hidden" });
  if ((await store.getChangeSet(rejectedProposal.changeSetId)).status !== "rejected") throw new Error("Rejected undo proposal was not persisted");
  if ((await store.getRevisionStatus(member.projectId)).activeRevision.revisionId !== documentApplied.activeRevision) throw new Error("Rejecting undo advanced revision");

  const acceptedProposal = await proposeUndo(historyDialog.getByRole("button", { name: "撤销最近提交" }));
  if (acceptedProposal.changeSetId === rejectedProposal.changeSetId) throw new Error("Undo re-proposal reused rejected ChangeSet");
  await undoDialog.getByText("恢复父 Snapshot 的完整项目内容", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "revision-undo-confirmation.png"), fullPage: true });
  await undoDialog.getByRole("button", { name: "确认撤销", exact: true }).click();
  await undoDialog.waitFor({ state: "hidden" });
  await historyDialog.getByText("4 个不可变版本", { exact: true }).waitFor();
  await historyDialog.getByText(/撤销提交/u).waitFor();

  const afterUndo = await store.getRevisionStatus(member.projectId);
  if (afterUndo.activeRevision.source !== "undo") throw new Error("Confirmed undo did not create an undo revision");
  if (afterUndo.activeRevision.parentRevision !== documentApplied.activeRevision) throw new Error("Undo revision did not preserve immutable parent chain");
  if (afterUndo.activeRevision.contentHash !== (await store.listRevisions(member.projectId)).find((revision) => revision.revisionId === graphApplied.activeRevision)?.contentHash) {
    throw new Error("Undo revision content does not match restored parent Snapshot");
  }
  await expectDocumentMissing();
  if ((await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === "flow.core-step")?.title !== "撤销后仍保留的图标题") {
    throw new Error("Undo restored too far and lost the preceding graph commit");
  }
  await page.screenshot({ path: path.join(artifactDir, "revision-undo-history.png"), fullPage: true });

  await historyDialog.locator("footer.modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill("remove-on-undo");
  await page.getByText("没有匹配文档", { exact: true }).waitFor();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("完整快照撤销流程 图谱").getByText("撤销后仍保留的图标题", { exact: true }).waitFor();

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("button", { name: "版本与基线" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileProposal = await proposeUndo(historyDialog.getByRole("button", { name: "撤销最近提交" }));
  await undoDialog.waitFor();
  const layout = await page.evaluate(() => ({ viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth, dialogWidth: document.querySelector(".undo-change-modal")?.getBoundingClientRect().width ?? 0 }));
  if (layout.documentWidth > layout.viewport || layout.dialogWidth > layout.viewport) throw new Error(`Mobile undo layout overflow: ${JSON.stringify(layout)}`);
  await page.screenshot({ path: path.join(artifactDir, "revision-undo-mobile.png"), fullPage: true });
  await undoDialog.getByRole("button", { name: "拒绝撤销", exact: true }).click();
  await undoDialog.waitFor({ state: "hidden" });
  if ((await store.getChangeSet(mobileProposal.changeSetId)).status !== "rejected") throw new Error("Mobile undo rejection was not persisted");

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  const reportPath = path.join(artifactDir, "revision-undo.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version() },
    verified: {
      previewDidNotWrite: true,
      rejectionDidNotWrite: true,
      rejectedProposalNotReused: true,
      completeParentSnapshotRestored: true,
      precedingCommitPreserved: true,
      newUndoRevisionCreated: true,
      immutableParentChainPreserved: true,
      pageReloadedProjectState: true,
      mobileHorizontalOverflow: false
    },
    revisions: { before: beforeUndo.activeRevision.revisionId, restored: graphApplied.activeRevision, after: afterUndo.activeRevision.revisionId },
    screenshots: ["revision-undo-rejected-preview.png", "revision-undo-confirmation.png", "revision-undo-history.png", "revision-undo-mobile.png"]
  }, null, 2) + "\n");
  console.log("Chrome revision undo verified: reject, re-propose, full parent Snapshot restore, new immutable undo revision, page refresh and mobile layout passed.");
  console.log(`Report: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
