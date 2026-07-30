import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-doc-lifecycle-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4323";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "文档生命周期 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "文档引用流程", capability: "workflow" });
const member = created.members[0];
const initialGraph = await store.getProjectGraph(member.projectId);
const coreNode = initialGraph.graph.nodes.find((node) => node.id === "flow.core-step");
const createDocument = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: initialGraph.activeRevision,
  reason: "Chrome 验收前置文档",
  operations: [{ op: "docs.write", target: "docs/guide.md", value: "# Guide\n\n## Retry\n\n保留这段文档内容。\n" }]
});
const documentApplied = await store.confirmAndApplyChangeSet(createDocument.changeSetId, {
  digest: createDocument.digest,
  baseRevision: createDocument.baseRevision
});
const bindDocument = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: documentApplied.activeRevision,
  reason: "Chrome 验收前置引用",
  operations: [{ op: "graph.node.update", target: coreNode.id, value: { ...coreNode, doc: "docs/guide.md", docAnchor: "Guide/Retry" } }]
});
await store.confirmAndApplyChangeSet(bindDocument.changeSetId, { digest: bindDocument.digest, baseRevision: bindDocument.baseRevision });

const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4323, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "文档生命周期 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByRole("button", { name: /docs\/guide\.md/u }).click();
  await page.getByLabel("Markdown 编辑器").waitFor();

  await page.getByLabel("搜索文档").fill("guide");
  if (await page.locator(".document-list > button").count() !== 1) throw new Error("Document path search did not narrow the visible list to one item");
  await page.getByTitle("清除搜索").click();
  if (await page.locator(".document-list > button").count() !== 2) throw new Error("Clearing document search did not restore the complete list");

  await page.getByTitle("重命名文档").click();
  const renameDialog = page.getByRole("dialog", { name: "重命名文档" });
  await renameDialog.getByText("同步更新 1 个", { exact: true }).waitFor();
  await renameDialog.getByText("flow.core-step", { exact: true }).waitFor();
  await renameDialog.getByLabel("文档新路径").fill("docs/reference.md");
  await renameDialog.getByRole("button", { name: "预览重命名", exact: true }).click();

  const changeDialog = page.getByRole("dialog", { name: "确认文档变更" });
  await changeDialog.locator(".change-summary").getByText("重命名文档", { exact: true }).waitFor();
  await changeDialog.getByText("docs/guide.md -> docs/reference.md", { exact: true }).waitFor();
  await changeDialog.getByText("1 个节点", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "document-rename-preview-desktop.png"), fullPage: true });

  if (!(await store.readDocument(member.projectId, "docs/guide.md")).content.includes("保留这段文档内容")) throw new Error("Source document changed before rename confirmation");
  await expectDocumentMissing(store, member.projectId, "docs/reference.md");
  if ((await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === coreNode.id)?.doc !== "docs/guide.md") throw new Error("Graph reference changed before rename confirmation");

  await changeDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await page.getByRole("button", { name: /docs\/reference\.md/u }).waitFor();
  await page.locator(".docs-title strong").getByText("docs/reference.md", { exact: true }).waitFor();
  await expectDocumentMissing(store, member.projectId, "docs/guide.md");
  if (!(await store.readDocument(member.projectId, "docs/reference.md")).content.includes("保留这段文档内容")) throw new Error("Renamed document content was not preserved");
  const renamedNode = (await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === coreNode.id);
  if (renamedNode?.doc !== "docs/reference.md" || renamedNode.docAnchor !== "Guide/Retry") throw new Error("Graph reference was not synchronized with rename");

  await page.getByTitle("删除文档").click();
  const deleteDialog = page.getByRole("dialog", { name: "删除文档" });
  await deleteDialog.getByText("确认后文档将从项目中删除", { exact: true }).waitFor();
  await deleteDialog.getByText("解除 1 个", { exact: true }).waitFor();
  await deleteDialog.getByText("flow.core-step", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "document-delete-warning-desktop.png"), fullPage: true });
  await deleteDialog.getByRole("button", { name: "预览删除", exact: true }).click();
  await changeDialog.locator(".change-summary").getByText("删除文档", { exact: true }).waitFor();
  await changeDialog.getByText("（文档将删除）", { exact: true }).waitFor();
  if (!(await store.readDocument(member.projectId, "docs/reference.md")).content.includes("保留这段文档内容")) throw new Error("Document changed before delete confirmation");

  await changeDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await page.locator(".docs-title strong").getByText("SKILL.md", { exact: true }).waitFor();
  await expectDocumentMissing(store, member.projectId, "docs/reference.md");
  const unboundNode = (await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === coreNode.id);
  if (unboundNode?.doc !== undefined || unboundNode?.docAnchor !== undefined) throw new Error("Deleting a referenced document left a dangling graph binding");
  await page.getByLabel("搜索文档").fill("reference");
  await page.getByText("没有匹配文档", { exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (overflow.document > overflow.viewport) throw new Error(`Mobile document lifecycle horizontal overflow: ${overflow.document}px > ${overflow.viewport}px`);
  await page.screenshot({ path: path.join(artifactDir, "document-lifecycle-mobile.png"), fullPage: true });
  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  console.log("Chrome document lifecycle verified: search, referenced rename preview, confirmation boundary, atomic path/reference update, referenced delete warning, confirmation boundary, binding cleanup, and mobile layout.");
  console.log(`Rename screenshot: ${path.join(artifactDir, "document-rename-preview-desktop.png")}`);
  console.log(`Delete warning screenshot: ${path.join(artifactDir, "document-delete-warning-desktop.png")}`);
  console.log(`Mobile screenshot: ${path.join(artifactDir, "document-lifecycle-mobile.png")}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function expectDocumentMissing(targetStore, projectId, documentPath) {
  try {
    await targetStore.readDocument(projectId, documentPath);
  } catch (error) {
    if (error?.code === "document_not_found") return;
    throw error;
  }
  throw new Error(`Expected document to be missing: ${documentPath}`);
}
