import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";
import { ModelSettingsService } from "../packages/server/dist/model-settings.js";
import { SandboxControlService } from "../packages/server/dist/sandbox-control.js";
import { BenchmarkRunnerService } from "../packages/server/dist/benchmark-runner.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-shell-identity-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/shell-identity");
const port = 4337;
const baseUrl = `http://127.0.0.1:${port}`;
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "工作台身份验收" });
const withWorkflow = await store.createManagedSkill(workspace.workspaceId, { name: "订单审核流程", capability: "workflow" });
const workflow = withWorkflow.members[0];
const withContent = await store.createManagedSkill(workspace.workspaceId, { name: "接口规范知识库", capability: "content-only" });
const content = withContent.members.find((member) => member.displayName === "接口规范知识库");
const withMissing = await store.createManagedSkill(workspace.workspaceId, { name: "已迁移旧 Skill", capability: "workflow" });
const missing = withMissing.members.find((member) => member.displayName === "已迁移旧 Skill");
const missingSource = JSON.parse(await readFile(path.join(dataRoot, "studio", "projects", missing.projectId, "source.json"), "utf8"));
await rm(missingSource.root, { recursive: true, force: false });
await store.selectProject(workspace.workspaceId, workflow.projectId);

const provider = new ModelSettingsService({ dataDir: path.join(dataRoot, "studio") });
await provider.initialize();
const sandboxControl = new SandboxControlService({ dataRoot: path.join(dataRoot, "studio", "sandbox") });
const benchmarkRunner = new BenchmarkRunnerService({
  dataRoot: path.join(dataRoot, "studio", "benchmark"),
  store,
  sandboxCapabilities: sandboxControl,
  provider
});
await benchmarkRunner.initialize();
const server = createApp({ store, sandboxControl, benchmarkRunner, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

console.log("[shell-identity] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: workspace.name, exact: true }).waitFor();
  await assertVisibleIdentity(page, workflow.skillId, "workspace-topbar");
  const missingRow = page.getByRole("row", { name: new RegExp(missing.displayName, "u") });
  await missingRow.getByText("路径失联", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "workspace-multi-skill.png"), fullPage: true });

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator('.skill-force-graph[data-node-count="3"]').waitFor();
  await assertVisibleIdentity(page, workflow.skillId, "graph");
  await page.getByRole("button", { name: "2D 平面", exact: true }).click();
  await page.locator('.skill-force-graph.mode-2d.is-ready[data-render-state="settled"]').waitFor();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  const graphPaint = await waitForGraphPaint(page);
  await page.screenshot({ path: path.join(artifactDir, "graph-identity.png"), fullPage: true });
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();

  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("Markdown 编辑器").waitFor();
  await assertVisibleIdentity(page, workflow.skillId, "documents");

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await assertVisibleIdentity(page, workflow.skillId, "tests-runtime");
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  await page.getByText("测试用例", { exact: true }).waitFor();
  await assertVisibleIdentity(page, workflow.skillId, "tests-cases");
  await page.getByRole("button", { name: "真实测试", exact: true }).click();
  await page.getByText("真实模型与沙箱", { exact: true }).waitFor();
  await assertVisibleIdentity(page, workflow.skillId, "tests-benchmark");

  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await page.getByText("Bug Report 导入与复现", { exact: true }).waitFor();
  await assertVisibleIdentity(page, workflow.skillId, "diagnosis");
  await page.screenshot({ path: path.join(artifactDir, "diagnosis-identity.png"), fullPage: true });

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("row", { name: new RegExp(content.displayName, "u") }).click();
  await page.getByRole("status").filter({ hasText: "当前 Skill 已切换" }).waitFor();
  await assertVisibleIdentity(page, content.skillId, "content-workspace");
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByText("当前 Skill 没有可执行流程", { exact: true }).waitFor();
  await assertVisibleIdentity(page, content.skillId, "content-tests-empty");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("Markdown 编辑器").waitFor();
  await assertVisibleIdentity(page, content.skillId, "mobile-documents");
  const mobileDocuments = await layoutFacts(page);
  if (mobileDocuments.documentWidth > mobileDocuments.viewportWidth) throw new Error(`Mobile documents overflow: ${JSON.stringify(mobileDocuments)}`);
  await page.screenshot({ path: path.join(artifactDir, "mobile-documents-identity.png"), fullPage: true });

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await assertVisibleIdentity(page, content.skillId, "mobile-content-tests");
  const mobileTests = await layoutFacts(page);
  if (mobileTests.documentWidth > mobileTests.viewportWidth) throw new Error(`Mobile tests overflow: ${JSON.stringify(mobileTests)}`);
  await page.screenshot({ path: path.join(artifactDir, "mobile-tests-identity.png"), fullPage: true });

  if (consoleErrors.length || failedResponses.length) {
    throw new Error(`Browser errors: ${JSON.stringify({ consoleErrors, failedResponses })}`);
  }
  const report = {
    workspaceId: workspace.workspaceId,
    workflow: { projectId: workflow.projectId, skillId: workflow.skillId },
    content: { projectId: content.projectId, skillId: content.skillId },
    missing: { projectId: missing.projectId, skillId: missing.skillId, status: "missing" },
    graphPaint,
    verifiedSurfaces: ["workspace", "graph", "documents", "tests-runtime", "tests-cases", "tests-benchmark", "diagnosis", "content-tests-empty"],
    mobileDocuments,
    mobileTests,
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

async function assertVisibleIdentity(page, skillId, surface) {
  const identity = page.locator(`[data-skill-id="${skillId}"]:visible`).first();
  await identity.waitFor();
  const facts = await identity.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      text: element.textContent?.trim(),
      title: element.getAttribute("title"),
      width: rect.width,
      height: rect.height,
      inViewport: rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight
    };
  });
  if (!facts.text?.startsWith("skill-") || facts.title !== skillId || facts.width < 20 || facts.height < 5 || !facts.inViewport) {
    throw new Error(`${surface} identity is not visibly usable: ${JSON.stringify(facts)}`);
  }
}

async function layoutFacts(page) {
  return page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
}

async function waitForGraphPaint(page) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".skill-force-graph.mode-2d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d");
    if (!context || canvas.width < 100 || canvas.height < 100) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedSamples = 0;
    for (let y = 0; y < canvas.height; y += 4) {
      for (let x = 0; x < canvas.width; x += 4) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 20) paintedSamples += 1;
        if (paintedSamples >= 80) return true;
      }
    }
    return false;
  });
  return page.locator(".skill-force-graph.mode-2d canvas").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedSamples = 0;
    for (let y = 0; y < canvas.height; y += 4) {
      for (let x = 0; x < canvas.width; x += 4) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 20) paintedSamples += 1;
      }
    }
    return { width: canvas.width, height: canvas.height, paintedSamples };
  });
}
