import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-workspace-"));
const studioRoot = path.join(dataRoot, "studio");
const sourceRoot = path.join(dataRoot, "external-skill");
const relocatedRoot = path.join(dataRoot, "relocated-skill");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const reportPath = path.join(artifactDir, "workspace-lifecycle-verification.json");
const baseUrl = "http://127.0.0.1:4337";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: studioRoot });
await store.initialize();
const landing = await store.createWorkspace({ name: "保留工作区" });
await store.createManagedSkill(landing.workspaceId, { name: "保留 Skill", capability: "content-only" });
const workspace = await store.createWorkspace({ name: "Workspace 生命周期验收" });
const managed = await store.createManagedSkill(workspace.workspaceId, { name: "管理副本 Skill", capability: "workflow" });
const managedMember = managed.members[0];
const managedSource = JSON.parse(await readFile(path.join(studioRoot, "projects", managedMember.projectId, "source.json"), "utf8"));

const skillId = "skill-22222222-2222-4222-8222-222222222222";
await mkdir(path.join(sourceRoot, "graph"), { recursive: true });
await writeFile(path.join(sourceRoot, "SKILL.md"), "# 原地路径 Skill\n\n用于可见 Chrome 路径修复验收。\n", "utf8");
await writeFile(path.join(sourceRoot, "skill.json"), `${JSON.stringify({ skillId, name: "原地路径 Skill", version: "0.1.0", description: "", capability: "workflow", entry: "flow.start" }, null, 2)}\n`, "utf8");
await writeFile(path.join(sourceRoot, "graph", "main.json"), `${JSON.stringify({
  schemaVersion: "1.0",
  skillId,
  capability: "workflow",
  entry: "flow.start",
  nodes: [
    { id: "flow.start", kind: "start", title: "开始", position: { x: 0, y: 0 } },
    { id: "flow.end", kind: "end", title: "结束", position: { x: 220, y: 0 } }
  ],
  edges: [{ id: "edge.start-end", from: "flow.start", to: "flow.end", kind: "flow" }]
}, null, 2)}\n`, "utf8");
const withInPlace = await store.openInPlaceProject(workspace.workspaceId, { rootPath: sourceRoot });
const inPlaceMember = withInPlace.members.find((member) => member.skillId === skillId);
await rename(sourceRoot, relocatedRoot);
const missingWorkspace = await store.getWorkspace(workspace.workspaceId);
if (missingWorkspace.members.find((member) => member.projectId === inPlaceMember.projectId)?.status !== "missing") {
  throw new Error("Fixture did not enter missing state");
}

const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4337, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function rowNames() {
  return page.locator("tbody .skill-name-cell strong").allTextContents();
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Workspace 生命周期验收" }).waitFor();
  const managedRow = page.getByRole("row", { name: /管理副本 Skill/u });
  const missingRow = page.getByRole("row", { name: /原地路径 Skill/u });
  await managedRow.getByText("就绪", { exact: true }).waitFor();
  await missingRow.getByText("路径失联", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "workspace-mixed-status-desktop.png"), fullPage: true });

  await missingRow.getByTitle("上移").click();
  await page.waitForFunction(() => [...document.querySelectorAll("tbody .skill-name-cell strong")].map((element) => element.textContent).join("|") === "原地路径 Skill|管理副本 Skill");
  if (JSON.stringify(await rowNames()) !== JSON.stringify(["原地路径 Skill", "管理副本 Skill"])) throw new Error("Member order did not update in the page");
  await page.reload({ waitUntil: "networkidle" });
  const persistedOrder = await rowNames();
  if (JSON.stringify(persistedOrder) !== JSON.stringify(["原地路径 Skill", "管理副本 Skill"])) throw new Error("Member order did not persist after reload");

  await page.getByRole("row", { name: /原地路径 Skill/u }).getByTitle("修复项目路径").click();
  const repairDialog = page.getByRole("dialog", { name: "修复项目路径" });
  await repairDialog.getByLabel("新的 Skill 根路径").fill(relocatedRoot);
  await repairDialog.getByRole("button", { name: "校验并修复" }).click();
  await repairDialog.waitFor({ state: "hidden" });
  await page.getByRole("row", { name: /原地路径 Skill/u }).getByText("就绪", { exact: true }).waitFor();
  await page.getByRole("row", { name: /原地路径 Skill/u }).click();
  await page.locator(".detail-panel dd", { hasText: "原地打开" }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "workspace-path-repaired-desktop.png"), fullPage: true });

  await page.getByTitle("重命名工作区").click();
  const renameDialog = page.getByRole("dialog", { name: "重命名工作区" });
  await renameDialog.getByLabel("工作区名称").fill("Workspace 已修复并重命名");
  await renameDialog.getByRole("button", { name: "保存" }).click();
  await page.getByRole("heading", { name: "Workspace 已修复并重命名" }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("#workspace-picker option")].some((option) => option.textContent === "Workspace 已修复并重命名"));

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflowSources: [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((element) => ({
      tag: element.tagName,
      className: element.className,
      right: Math.round(element.getBoundingClientRect().right),
      width: Math.round(element.getBoundingClientRect().width)
    }))
  }));
  await page.screenshot({ path: path.join(artifactDir, "workspace-lifecycle-mobile.png"), fullPage: true });
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth) throw new Error(`Workspace mobile overflow: ${JSON.stringify(mobileLayout)}`);
  const mobileSummary = { viewportWidth: mobileLayout.viewportWidth, documentWidth: mobileLayout.documentWidth };

  await page.getByTitle("删除工作区").click();
  const deleteDialog = page.getByRole("alertdialog", { name: "删除工作区" });
  await deleteDialog.getByText("2 个 Skill 的源文件、Git 仓库和版本历史都会保留。", { exact: true }).waitFor();
  await deleteDialog.getByLabel("输入“Workspace 已修复并重命名”确认").fill("Workspace 已修复并重命名");
  await deleteDialog.getByRole("button", { name: "删除工作区" }).click();
  await page.getByRole("heading", { name: "保留工作区" }).waitFor();

  const filePreservation = {
    managedSource: (await stat(managedSource.root)).isDirectory(),
    inPlaceSource: (await stat(relocatedRoot)).isDirectory(),
    managedState: (await stat(path.join(studioRoot, "projects", managedMember.projectId, "state.json"))).isFile(),
    inPlaceState: (await stat(path.join(studioRoot, "projects", inPlaceMember.projectId, "state.json"))).isFile()
  };
  if (!Object.values(filePreservation).every(Boolean)) throw new Error(`Workspace deletion removed project data: ${JSON.stringify(filePreservation)}`);
  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  if (failedResponses.length) throw new Error(`Failed responses: ${failedResponses.join(" | ")}`);

  const report = {
    mixedStatus: true,
    persistedOrder,
    repairedProjectId: inPlaceMember.projectId,
    renamedWorkspace: "Workspace 已修复并重命名",
    mobileLayout: mobileSummary,
    filePreservation,
    consoleErrors,
    failedResponses
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
