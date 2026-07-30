import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-assets-chrome-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/project-assets");
const fixturePath = path.join(dataRoot, "pixel.png");
const port = 4336;
const baseUrl = `http://127.0.0.1:${port}`;
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

await mkdir(artifactDir, { recursive: true });
await writeFile(fixturePath, Buffer.from(pngBase64, "base64"));
const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "项目资产 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "资产管理 Skill", capability: "workflow" });
const member = created.members[0];
const original = await store.readDocument(member.projectId, "SKILL.md");
const documentProposal = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: original.activeRevision,
  reason: "添加待验收的资产引用",
  operations: [{ op: "docs.write", target: "SKILL.md", value: `${original.content}\n## 界面\n\n![像素图](assets/ui/pixel.png)\n` }]
});
await store.confirmAndApplyChangeSet(documentProposal.changeSetId, {
  digest: documentProposal.digest,
  baseRevision: documentProposal.baseRevision
});

const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

console.log("[assets-verify] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "项目资产 Chrome 验收", exact: true }).waitFor();
  await page.getByRole("button", { name: "项目资产", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "项目资产" });
  await dialog.waitFor();
  await dialog.getByText("暂无项目资产", { exact: true }).waitFor();

  await dialog.locator('[data-testid="asset-file-input"]').setInputFiles(fixturePath);
  await dialog.locator('[data-testid="asset-target-path"]').fill("assets/ui/pixel.png");
  await dialog.getByRole("button", { name: "预览上传", exact: true }).click();
  const preview = dialog.locator('[data-testid="asset-change-preview"]');
  await preview.waitFor();
  await dialog.getByText("assets/ui/pixel.png", { exact: true }).first().waitFor();
  await dialog.getByText(/SKILL\.md:\d+/u).waitFor();
  if ((await store.listAssets(member.projectId)).length !== 0) throw new Error("Asset was written before confirmation");
  await page.screenshot({ path: path.join(artifactDir, "asset-create-preview.png"), fullPage: true });

  await dialog.getByRole("button", { name: "拒绝提案", exact: true }).click();
  await dialog.getByText("该提案已拒绝，项目资产未修改。", { exact: true }).waitFor();
  if ((await store.listAssets(member.projectId)).length !== 0) throw new Error("Rejected asset was written");
  await dialog.getByRole("button", { name: "返回资产", exact: true }).click();

  await dialog.getByRole("button", { name: "预览上传", exact: true }).click();
  await dialog.locator('[data-testid="asset-change-preview"]').waitFor();
  await dialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await dialog.getByRole("button", { name: "ui/pixel.png", exact: false }).waitFor();
  const storedAfterCreate = await store.listAssets(member.projectId);
  if (storedAfterCreate.length !== 1 || storedAfterCreate[0].path !== "assets/ui/pixel.png" || storedAfterCreate[0].referenceCount !== 1) {
    throw new Error(`Created asset facts differ: ${JSON.stringify(storedAfterCreate)}`);
  }
  const imagePreview = dialog.locator('[data-testid="asset-image-preview"]');
  await imagePreview.waitFor();
  const imagePixels = await imagePreview.evaluate((image) => ({
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight
  }));
  if (!imagePixels.complete || imagePixels.naturalWidth !== 1 || imagePixels.naturalHeight !== 1) {
    throw new Error(`Asset image preview did not render: ${JSON.stringify(imagePixels)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "asset-created.png"), fullPage: true });

  await dialog.getByRole("button", { name: "预览删除", exact: true }).click();
  await dialog.locator('[data-testid="asset-change-preview"]').waitFor();
  await dialog.getByText(/SKILL\.md:\d+/u).waitFor();
  if ((await store.listAssets(member.projectId)).length !== 1) throw new Error("Asset was deleted before confirmation");
  await page.screenshot({ path: path.join(artifactDir, "asset-delete-preview.png"), fullPage: true });
  await dialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await dialog.getByText("暂无项目资产", { exact: true }).waitFor();
  if ((await store.listAssets(member.projectId)).length !== 0) throw new Error("Confirmed asset deletion was not applied");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    dialogWidth: Math.round(document.querySelector(".project-assets-modal").getBoundingClientRect().width)
  }));
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth || mobileLayout.dialogWidth > mobileLayout.viewportWidth) {
    throw new Error(`Mobile asset dialog overflow: ${JSON.stringify(mobileLayout)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "asset-mobile.png"), fullPage: true });

  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  if (failedResponses.length) throw new Error(`Failed responses: ${failedResponses.join(" | ")}`);
  const report = {
    workspace: workspace.name,
    assetPath: "assets/ui/pixel.png",
    rejectedBeforeWrite: true,
    createdReferenceCount: storedAfterCreate[0].referenceCount,
    imagePixels,
    deletedAfterConfirmation: true,
    mobileLayout,
    consoleErrors,
    failedResponses
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
}
