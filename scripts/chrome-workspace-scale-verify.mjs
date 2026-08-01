import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-workspace-scale-"));
const externalRoot = path.join(dataRoot, "external-workflow");
const relocatedRoot = path.join(dataRoot, "external-workflow-moved");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/workspace-scale-50");
const baseUrl = "http://127.0.0.1:4348";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "50 Skill Workspace 压力验收" });
for (let index = 1; index <= 48; index += 1) {
  await store.createManagedSkill(workspace.workspaceId, {
    name: `压力 Skill ${String(index).padStart(3, "0")}`,
    capability: index % 2 === 1 ? "workflow" : "content-only"
  });
}

const missingSkillId = "skill-50505050-5050-4050-8050-505050505050";
await mkdir(path.join(externalRoot, "graph"), { recursive: true });
await writeFile(path.join(externalRoot, "SKILL.md"), "# 压力失联 Skill\n\n用于多成员异常隔离。\n", "utf8");
await writeFile(path.join(externalRoot, "skill.json"), `${JSON.stringify({
  skillId: missingSkillId,
  name: "压力失联 Skill",
  version: "0.1.0",
  description: "多成员异常隔离",
  capability: "workflow",
  entry: "flow.start"
}, null, 2)}\n`, "utf8");
await writeFile(path.join(externalRoot, "graph", "main.json"), `${JSON.stringify({
  schemaVersion: "1.0",
  skillId: missingSkillId,
  capability: "workflow",
  entry: "flow.start",
  nodes: [
    { id: "flow.start", kind: "start", title: "开始" },
    { id: "flow.end", kind: "end", title: "结束" }
  ],
  edges: [{ id: "edge.start-end", from: "flow.start", to: "flow.end", kind: "flow" }]
}, null, 2)}\n`, "utf8");
await store.openInPlaceProject(workspace.workspaceId, { rootPath: externalRoot });
await rename(externalRoot, relocatedRoot);
await store.createManagedSkill(workspace.workspaceId, { name: "压力末尾 Skill", capability: "content-only" });

const prepared = await store.getWorkspace(workspace.workspaceId);
if (prepared.members.length !== 50 || prepared.members.filter((member) => member.capability === "workflow").length !== 25
  || prepared.members.filter((member) => member.capability === "content-only").length !== 25
  || prepared.members.filter((member) => member.status === "missing").length !== 1) {
  throw new Error("Workspace scale fixture does not match the 50-member matrix");
}
const first = prepared.members.find((member) => member.displayName === "压力 Skill 001");
const middle = prepared.members.find((member) => member.displayName === "压力 Skill 024");
const last = prepared.members.find((member) => member.displayName === "压力末尾 Skill");
if (!first || !middle || !last) throw new Error("Scale fixture identities are incomplete");

const server = createApp({ store, benchmarkRunner: { list: async () => [] }, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4348, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(30_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function metric(label, value) {
  const item = page.getByLabel("工作区摘要").locator(".metric").filter({ hasText: label });
  await item.getByText(String(value), { exact: true }).waitFor();
}

async function searchMember(query, expectedName) {
  const startedAt = performance.now();
  await page.getByLabel("搜索 Skill").fill(query);
  const rows = page.locator("tbody tr");
  await rows.filter({ hasText: expectedName }).waitFor();
  if (await rows.count() !== 1) throw new Error(`Search ${query} did not isolate one member`);
  return Math.round(performance.now() - startedAt);
}

async function clearSearch() {
  await page.getByLabel("搜索 Skill").fill("");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 50);
}

async function selectMember(member) {
  const startedAt = performance.now();
  await page.getByRole("row", { name: new RegExp(member.displayName, "u") }).click();
  await page.locator(".detail-panel").getByRole("heading", { name: member.displayName, exact: true }).waitFor();
  await page.locator(`[data-skill-id="${member.skillId}"]:visible`).first().waitFor();
  return Math.round(performance.now() - startedAt);
}

try {
  const loadStartedAt = performance.now();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "50 Skill Workspace 压力验收" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 50);
  const initialLoadMs = Math.round(performance.now() - loadStartedAt);
  await metric("Skill 总数", 50);
  await metric("工作流", 25);
  await metric("内容型", 25);
  await page.getByRole("row", { name: /压力失联 Skill/u }).getByText("路径失联", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "workspace-scale-desktop.png"), fullPage: true });

  const searchMs = {
    first: await searchMember("压力 Skill 001", first.displayName),
    middle: 0,
    last: 0
  };
  await clearSearch();
  searchMs.middle = await searchMember("压力 Skill 024", middle.displayName);
  await clearSearch();
  searchMs.last = await searchMember("压力末尾", last.displayName);
  await clearSearch();

  const switchMs = {
    first: await selectMember(first),
    middle: await selectMember(middle),
    last: await selectMember(last)
  };
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".detail-panel").getByRole("heading", { name: last.displayName, exact: true }).waitFor();
  await page.locator(`[data-skill-id="${last.skillId}"]:visible`).first().waitFor();

  await page.getByRole("row", { name: new RegExp(first.displayName, "u") }).click();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator(`[data-skill-id="${first.skillId}"]:visible`).first().waitFor();
  await page.locator("canvas").first().waitFor();
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("row", { name: new RegExp(middle.displayName, "u") }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.locator(`[data-skill-id="${middle.skillId}"]:visible`).first().waitFor();
  await page.getByRole("button", { name: "工作区", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth
  }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) {
    throw new Error(`Workspace scale mobile overflow: ${JSON.stringify(mobileMetrics)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "workspace-scale-mobile.png"), fullPage: true });
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);

  const verification = {
    browser: "Google Chrome",
    platform: `${process.platform}-${process.arch}`,
    memberCount: 50,
    workflowCount: 25,
    contentOnlyCount: 25,
    readyCount: 49,
    missingCount: 1,
    initialLoadMs,
    searchMs,
    switchMs,
    selectedProjectPersistedAfterReload: true,
    crossPageSkillIdentityVerified: [first.skillId, middle.skillId],
    thresholdsMs: { initialLoad: 10_000, search: 1_000, switch: 3_000 },
    mobileMetrics,
    consoleErrors,
    failedResponses,
    completedAt: new Date().toISOString()
  };
  if (initialLoadMs > verification.thresholdsMs.initialLoad
    || Object.values(searchMs).some((value) => value > verification.thresholdsMs.search)
    || Object.values(switchMs).some((value) => value > verification.thresholdsMs.switch)) {
    throw new Error(`Workspace scale thresholds exceeded: ${JSON.stringify(verification)}`);
  }
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
