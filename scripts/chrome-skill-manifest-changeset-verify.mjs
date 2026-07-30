import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-manifest-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4343";
await mkdir(artifactDir, { recursive: true });
const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Skill 信息 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "旧版发布流程", description: "旧说明", capability: "workflow" });
const member = created.members[0];
if (!member) throw new Error("Managed Skill was not created");
const initial = await store.getSkillManifest(member.projectId);

const server = createApp({ store, benchmarkRunner: { list: async () => [] }, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4343, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Skill 信息 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "编辑 Skill 信息", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skill 信息" });
  await dialog.getByLabel("Skill 名称").fill("新版发布流程");
  await dialog.getByLabel("Skill 版本").fill("1.0.0");
  await dialog.getByLabel("Skill 说明").fill("通过 ChangeSet 确认后的新版说明");
  await dialog.getByRole("button", { name: "预览修改", exact: true }).click();
  await dialog.getByText("应用前", { exact: true }).waitFor();
  await dialog.getByText("应用后", { exact: true }).waitFor();
  const diffText = await dialog.locator(".skill-manifest-diff").innerText();
  if (!diffText.includes("新版发布流程") || !diffText.includes("1.0.0") || !diffText.includes("通过 ChangeSet 确认后的新版说明")) throw new Error(`Skill manifest diff omitted edited values: ${diffText}`);
  await dialog.locator(".skill-manifest-diff section").nth(1).scrollIntoViewIfNeeded();
  const metadata = dialog.getByTestId("changeset-metadata");
  await metadata.getByText("Studio 手工编辑", { exact: true }).waitFor();
  await metadata.getByText("更新 Skill 信息：新版发布流程", { exact: true }).waitFor();
  await metadata.getByText("未附加证据", { exact: true }).waitFor();
  const beforeConfirmation = await store.getSkillManifest(member.projectId);
  if (beforeConfirmation.manifest.name !== "旧版发布流程" || beforeConfirmation.activeRevision !== initial.activeRevision) throw new Error("Skill manifest changed before confirmation");
  await page.screenshot({ path: path.join(artifactDir, "skill-manifest-changeset-proposed.png"), fullPage: true });

  await dialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "新版发布流程", exact: true }).waitFor();
  const applied = await store.getSkillManifest(member.projectId);
  if (applied.manifest.name !== "新版发布流程" || applied.manifest.version !== "1.0.0" || applied.manifest.description !== "通过 ChangeSet 确认后的新版说明") throw new Error("Confirmed Skill manifest was not applied");
  if (applied.manifest.skillId !== member.skillId || applied.manifest.capability !== "workflow" || applied.manifest.entry !== "flow.start") throw new Error("Skill identity or capability changed");
  if (applied.activeRevision === initial.activeRevision) throw new Error("Skill manifest confirmation did not advance revision");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "编辑 Skill 信息", exact: true }).click();
  await page.getByRole("dialog", { name: "Skill 信息" }).getByLabel("Skill 名称").waitFor();
  const mobile = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  if (mobile.document > mobile.viewport) throw new Error(`Mobile Skill manifest overflow: ${mobile.document}px > ${mobile.viewport}px`);
  await page.screenshot({ path: path.join(artifactDir, "skill-manifest-editor-mobile.png"), fullPage: true });
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);

  const verification = {
    browser: "Google Chrome",
    projectId: member.projectId,
    skillId: member.skillId,
    oldRevision: initial.activeRevision,
    newRevision: applied.activeRevision,
    unchangedBeforeConfirmation: true,
    editableFieldsApplied: ["name", "version", "description"],
    protectedFieldsPreserved: ["skillId", "capability", "entry"],
    workspaceSummaryRefreshed: true,
    mobile,
    consoleErrors,
    failedResponses,
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "skill-manifest-changeset-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
