import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-conflict-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4330";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "ChangeSet 冲突裁决 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, {
  name: "冲突后重新预演流程",
  capability: "workflow",
  description: "验证冲突不会覆盖当前项目，且新提案仍需人工确认"
});
const member = created.members[0];
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4330, "127.0.0.1", resolve));

console.log("[conflict-verify] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "ChangeSet 冲突裁决 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.waitFor();
  const original = await store.readDocument(member.projectId, "SKILL.md");
  const desiredContent = `${original.content}\n## 冲突裁决结果\n\n这段内容只能在重新预演并再次确认后写入。\n`;
  await editor.fill(desiredContent);

  const [proposalResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/projects\/[^/]+\/changesets$/u.test(new URL(response.url()).pathname)),
    page.getByRole("button", { name: "预览并保存", exact: true }).click()
  ]);
  const proposalPayload = await proposalResponse.json();
  const stale = proposalPayload.data;
  const dialog = page.locator(".change-preview-modal");
  await dialog.waitFor();
  await dialog.getByRole("heading", { name: "确认文档变更", exact: true }).waitFor();

  const competing = await store.createChangeSet(member.projectId, {
    workspaceId: workspace.workspaceId,
    baseRevision: original.activeRevision,
    reason: "模拟另一入口先完成确认",
    operations: [{ op: "docs.write", target: "docs/competing.md", value: "# 当前项目中的并发修改\n" }]
  });
  const competingApplied = await store.confirmAndApplyChangeSet(competing.changeSetId, {
    digest: competing.digest,
    baseRevision: competing.baseRevision
  });

  const [conflictResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === `/api/changesets/${stale.changeSetId}/confirm-and-apply`),
    dialog.getByRole("button", { name: "确认并应用", exact: true }).click()
  ]);
  if (conflictResponse.status() !== 409) throw new Error(`Expected a 409 conflict, got ${conflictResponse.status()}`);
  const conflictPanel = page.getByTestId("changeset-conflict-panel");
  await conflictPanel.getByText("原提案已与当前项目冲突", { exact: true }).waitFor();
  await conflictPanel.getByText("revision_conflict", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "基于当前版本重新预演", exact: true }).waitFor();
  const persistedConflict = await store.getChangeSet(stale.changeSetId);
  if (persistedConflict.status !== "conflicted" || persistedConflict.conflict?.currentRevision !== competingApplied.activeRevision) {
    throw new Error(`Conflict facts were not persisted: ${JSON.stringify(persistedConflict.conflict)}`);
  }
  if ((await store.readDocument(member.projectId, "SKILL.md")).content !== original.content) {
    throw new Error("The stale proposal overwrote the current project");
  }
  await page.screenshot({ path: path.join(artifactDir, "changeset-conflict-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    panelWidth: document.querySelector("[data-testid='changeset-conflict-panel']")?.getBoundingClientRect().width ?? 0,
    actionButtons: [...document.querySelectorAll(".modal-actions button")].map((button) => ({
      text: button.textContent?.trim(),
      left: button.getBoundingClientRect().left,
      right: button.getBoundingClientRect().right,
      width: button.getBoundingClientRect().width
    }))
  }));
  await page.screenshot({ path: path.join(artifactDir, "changeset-conflict-mobile.png"), fullPage: true });
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth || mobileLayout.panelWidth > mobileLayout.viewportWidth || mobileLayout.actionButtons.some((button) => button.left < 0 || button.right > mobileLayout.viewportWidth)) {
    throw new Error(`Mobile conflict UI overflowed: ${JSON.stringify(mobileLayout)}`);
  }

  await page.setViewportSize({ width: 1440, height: 960 });
  const [reproposalResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === `/api/changesets/${stale.changeSetId}/repropose`),
    dialog.getByRole("button", { name: "基于当前版本重新预演", exact: true }).click()
  ]);
  if (reproposalResponse.status() !== 201) throw new Error(`Reproposal failed with ${reproposalResponse.status()}`);
  const reproposalPayload = await reproposalResponse.json();
  const reproposed = reproposalPayload.data;
  if (reproposed.changeSetId === stale.changeSetId || reproposed.status !== "proposed" || reproposed.baseRevision !== competingApplied.activeRevision) {
    throw new Error(`Reproposal did not create a fresh review boundary: ${JSON.stringify(reproposed)}`);
  }
  await page.getByTestId("changeset-conflict-panel").waitFor({ state: "hidden" });
  await dialog.getByRole("heading", { name: "确认文档变更", exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "changeset-conflict-repreview-desktop.png"), fullPage: true });
  if ((await store.readDocument(member.projectId, "SKILL.md")).content !== original.content) {
    throw new Error("Re-preview wrote the project before confirmation");
  }

  await dialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  if ((await store.readDocument(member.projectId, "SKILL.md")).content !== desiredContent) {
    throw new Error("The fresh ChangeSet was not applied after the second confirmation");
  }
  if (!(await store.readDocument(member.projectId, "docs/competing.md")).content.includes("并发修改")) {
    throw new Error("Conflict adjudication lost the already-applied competing change");
  }
  if ((await store.getChangeSet(stale.changeSetId)).status !== "conflicted") {
    throw new Error("The original conflicted ChangeSet audit record was overwritten");
  }

  const unexpectedResponses = failedResponses.filter((response) => !(response.status === 409 && response.url.endsWith(`/api/changesets/${stale.changeSetId}/confirm-and-apply`)));
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.includes("409 (Conflict)"));
  if (unexpectedConsoleErrors.length) throw new Error(`Console errors:\n${unexpectedConsoleErrors.join("\n")}`);
  if (unexpectedResponses.length) throw new Error(`Unexpected failed responses:\n${JSON.stringify(unexpectedResponses, null, 2)}`);
  const reportPath = path.join(artifactDir, "changeset-conflict.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version(), visibleChrome: true },
    verified: {
      staleProposalBlocked: true,
      conflictFactsPersisted: true,
      currentProjectPreserved: true,
      mobileHorizontalOverflow: false,
      reproposalCreatedNewChangeSet: true,
      reproposalRequiredSecondConfirmation: true,
      competingChangePreserved: true,
      originalConflictAuditPreserved: true
    },
    identities: {
      staleChangeSetId: stale.changeSetId,
      competingChangeSetId: competing.changeSetId,
      reproposedChangeSetId: reproposed.changeSetId,
      staleBaseRevision: stale.baseRevision,
      currentRevisionAtConflict: competingApplied.activeRevision,
      reproposedBaseRevision: reproposed.baseRevision
    },
    expectedFailedResponses: failedResponses,
    expectedConsoleErrors: consoleErrors,
    mobileLayout,
    screenshots: [
      "changeset-conflict-desktop.png",
      "changeset-conflict-mobile.png",
      "changeset-conflict-repreview-desktop.png"
    ]
  }, null, 2) + "\n");
  console.log("Visible Chrome verified ChangeSet conflict detection, adjudication, re-preview, second confirmation, and mobile layout.");
  console.log(`Report: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
