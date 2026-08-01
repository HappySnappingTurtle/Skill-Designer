import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-artifact-storage-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/runtime-artifact-storage");
const baseUrl = "http://127.0.0.1:4333";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "RuntimeArtifact 存储验收" });
const created = await store.createManagedSkill(workspace.workspaceId, {
  name: "不可变输入流程",
  capability: "workflow",
  description: "验证普通运行、Benchmark 引用和显式清理"
});
const member = created.members[0];
const started = await store.createRun(member.projectId, {
  workspaceId: workspace.workspaceId,
  initialVariables: { requestId: "artifact-storage-chrome" }
});
const runtimeArtifact = started.artifact;
if (!runtimeArtifact) throw new Error("普通运行没有 RuntimeArtifact");

const projectArtifactDir = path.join(dataRoot, "projects", member.projectId, "runtime-artifacts");
const benchmarkArtifactId = "artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orphanArtifactId = "artifact-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const oldCreatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
const writeArtifact = async (artifactId) => {
  const artifact = { ...structuredClone(runtimeArtifact), artifactId, createdAt: oldCreatedAt };
  const file = path.join(projectArtifactDir, `${artifactId}.json`);
  await writeFile(file, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return file;
};
const benchmarkArtifactFile = await writeArtifact(benchmarkArtifactId);
const orphanArtifactFile = await writeArtifact(orphanArtifactId);
const benchmarkRuns = [{
  benchmarkRunId: "benchmark-run-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  projectId: member.projectId,
  createdAt: new Date().toISOString(),
  fingerprint: { runtimeArtifactId: benchmarkArtifactId }
}];
const benchmarkRunner = {
  async list(projectId) {
    return projectId === member.projectId ? structuredClone(benchmarkRuns) : [];
  }
};
const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataRoot, "runtime-dialog"),
  store,
  provider: {
    async probe() {
      return {
        schemaVersion: "1.0",
        providerId: "artifact-storage-recorded",
        label: "Artifact 存储验收模型",
        status: "ready",
        keyConfigured: true,
        defaultModel: "artifact-storage-recorded",
        reason: "ready",
        checkedAt: new Date().toISOString()
      };
    },
    async invoke() {
      throw new Error("Artifact 存储验收不调用模型");
    }
  }
});
await runtimeDebug.initialize();

const server = createApp({ store, benchmarkRunner, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4333, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "RuntimeArtifact 存储验收" }).waitFor();
  await page.getByRole("cell", { name: /不可变输入流程/u }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();
  await page.getByRole("button", { name: "管理 RuntimeArtifact 存储" }).click();

  const dialog = page.getByRole("dialog", { name: "RuntimeArtifact 存储" });
  await dialog.waitFor();
  const summary = dialog.getByRole("region", { name: "RuntimeArtifact 存储摘要" });
  const metric = (label) => summary.locator("div").filter({ has: page.getByText(label, { exact: true }) }).first();
  await metric("全部").getByText("3", { exact: true }).waitFor();
  await metric("受保护").getByText("2", { exact: true }).waitFor();
  await metric("孤立").getByText("1", { exact: true }).waitFor();
  await metric("可清理").getByText("1", { exact: true }).waitFor();
  await dialog.getByText("显式清理 · 7 天宽限期", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "storage-before-desktop.png"), fullPage: true });

  await dialog.getByRole("button", { name: "清理 1 个", exact: true }).click();
  await dialog.getByText("已清理 1 个孤立 Artifact", { exact: true }).waitFor();
  await metric("全部").getByText("2", { exact: true }).waitFor();
  await metric("受保护").getByText("2", { exact: true }).waitFor();
  await metric("孤立").getByText("0", { exact: true }).waitFor();
  await metric("可清理").getByText("0", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "storage-after-desktop.png"), fullPage: true });

  const ordinaryRun = await store.getRun(member.projectId, started.run.runId);
  if (ordinaryRun.artifact?.artifactId !== runtimeArtifact.artifactId) throw new Error("清理后普通运行 Artifact 不可读");
  if (!(await stat(benchmarkArtifactFile)).isFile()) throw new Error("清理删除了 Benchmark 引用 Artifact");
  await expectMissing(orphanArtifactFile);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth,
    dialog: document.querySelector(".artifact-storage-modal")?.scrollWidth ?? 0
  }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport || mobileMetrics.dialog > mobileMetrics.viewport) {
    throw new Error(`移动端 RuntimeArtifact 弹窗横向溢出：${JSON.stringify(mobileMetrics)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "storage-after-mobile.png"), fullPage: true });
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();

  const verification = {
    channel: "chrome",
    headless: false,
    workspaceId: workspace.workspaceId,
    projectId: member.projectId,
    runId: started.run.runId,
    protectedArtifactIds: [runtimeArtifact.artifactId, benchmarkArtifactId],
    deletedArtifactIds: [orphanArtifactId],
    mobileMetrics,
    consoleErrors,
    failedResponses
  };
  if (consoleErrors.length || failedResponses.length) {
    throw new Error(`浏览器错误：${JSON.stringify({ consoleErrors, failedResponses })}`);
  }
  await writeFile(path.join(artifactDir, "verification.json"), JSON.stringify(verification, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function expectMissing(file) {
  try {
    await readFile(file);
    throw new Error(`预期文件已删除：${file}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("预期文件已删除")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}
