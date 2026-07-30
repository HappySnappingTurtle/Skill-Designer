import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-runtime-artifact-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4329";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "RuntimeArtifact Chrome 验收" });
const withFirst = await store.createManagedSkill(workspace.workspaceId, {
  name: "运行事实流程",
  capability: "workflow",
  description: "验证冻结输入、输出与版本漂移"
});
const first = withFirst.members.find((member) => member.displayName === "运行事实流程");
if (!first) throw new Error("First Skill was not created");
const withSecond = await store.createManagedSkill(workspace.workspaceId, {
  name: "旁路流程",
  capability: "workflow",
  description: "验证 Workspace 内切换 Skill 不串运行"
});
const second = withSecond.members.find((member) => member.displayName === "旁路流程");
if (!second) throw new Error("Second Skill was not created");

const provider = {
  async probe() {
    return { schemaVersion: "1.0", providerId: "recorded-runtime", label: "验收运行模型", status: "ready", keyConfigured: true, defaultModel: "recorded-runtime-model", reason: "RuntimeArtifact 验收已就绪", checkedAt: new Date().toISOString() };
  },
  async invoke() {
    return {
      providerId: "recorded-runtime",
      responseId: `artifact-${Date.now()}`,
      model: "recorded-runtime-model-1",
      output: { action: "advance", reply: "运行事实已记录。", nextNodeId: "flow.core-step", summary: "记录模型输出" },
      usage: { inputTokens: 18, outputTokens: 6, totalTokens: 24, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 24
    };
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4329, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

const initialVariables = { requestId: "chrome-t17", priority: 2, nested: { z: 2, a: 1 } };
const runtimeSummary = () => page.locator(".runtime-summary");
const runtimeInspector = () => page.locator(".runtime-artifact-inspector");

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "RuntimeArtifact Chrome 验收" }).waitFor();
  await page.getByRole("cell", { name: /运行事实流程/u }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "启动运行", exact: true }).click();
  const startDialog = page.getByRole("dialog", { name: "新建运行" });
  await startDialog.getByLabel("初始 skill 变量（JSON）").fill(JSON.stringify(initialVariables, null, 2));
  await startDialog.getByRole("button", { name: "启动", exact: true }).click();

  await runtimeSummary().getByText("运行中", { exact: true }).waitFor();
  await runtimeInspector().getByText("运行事实", { exact: true }).click();
  await runtimeInspector().locator("section").nth(1).getByText("chrome-t17", { exact: false }).waitFor();
  await runtimeInspector().getByText("项目内容", { exact: true }).waitFor();
  await runtimeInspector().getByText("当前输出", { exact: true }).waitFor();

  const dialog = page.getByLabel("模型运行对话");
  await dialog.getByLabel("运行对话消息").fill("记录这次模型输出");
  await dialog.getByTitle("发送消息").click();
  await dialog.getByText("运行事实已记录。", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "核心步骤", exact: true }).waitFor();
  await runtimeInspector().getByText("recorded-runtime-model-1", { exact: false }).waitFor();
  const firstRuns = await store.listRuns(first.projectId);
  const original = await store.getRun(first.projectId, firstRuns[0].runId);
  if (!original.artifact) throw new Error("Original run did not expose RuntimeArtifact");
  const originalFacts = {
    runId: original.run.runId,
    revision: original.run.revision,
    artifactId: original.run.artifactId,
    fingerprint: original.artifact.fingerprint,
    initialVariables: original.artifact.initialVariables
  };
  await page.screenshot({ path: path.join(artifactDir, "runtime-artifact-input-output-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("cell", { name: /旁路流程/u }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByText("创建一次可追踪运行", { exact: true }).waitFor();
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("cell", { name: /运行事实流程/u }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("heading", { name: "核心步骤", exact: true }).waitFor();
  const restoredArtifactId = await runtimeSummary().getByText("Artifact", { exact: true }).locator("xpath=following-sibling::code").getAttribute("title");
  if (restoredArtifactId !== originalFacts.artifactId) throw new Error("Switching Skills changed run ownership or selected Artifact");

  const graphBefore = await store.getProjectGraph(first.projectId);
  const coreNode = graphBefore.graph.nodes.find((node) => node.id === "flow.core-step");
  if (!coreNode) throw new Error("Core node is missing");
  const proposal = await store.createChangeSet(first.projectId, {
    workspaceId: workspace.workspaceId,
    baseRevision: graphBefore.activeRevision,
    operations: [{ op: "graph.node.update", target: coreNode.id, value: { ...coreNode, title: "核心步骤 v2" } }],
    reason: "RuntimeArtifact Chrome 版本漂移验证"
  });
  await store.confirmAndApplyChangeSet(proposal.changeSetId, { digest: proposal.digest, baseRevision: proposal.baseRevision });

  await page.getByTitle("刷新", { exact: true }).click();
  const drift = page.locator(".runtime-drift");
  await drift.getByText("使用新版本需要新建运行", { exact: false }).waitFor();
  await page.getByRole("heading", { name: "核心步骤", exact: true }).waitFor();
  const driftArtifactId = await runtimeSummary().getByText("Artifact", { exact: true }).locator("xpath=following-sibling::code").getAttribute("title");
  if (driftArtifactId !== originalFacts.artifactId) throw new Error("Revision drift mutated the frozen Artifact");
  await page.screenshot({ path: path.join(artifactDir, "runtime-artifact-rebuild-required.png"), fullPage: true });

  await drift.getByRole("button", { name: "新建当前版本运行", exact: true }).click();
  const rebuildDialog = page.getByRole("dialog", { name: "新建运行" });
  const rebuiltInput = JSON.parse(await rebuildDialog.getByLabel("初始 skill 变量（JSON）").inputValue());
  if (JSON.stringify(rebuiltInput) !== JSON.stringify(initialVariables)) throw new Error("Rebuild did not preserve the original frozen input");
  await rebuildDialog.getByRole("button", { name: "启动", exact: true }).click();
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();
  const rebuiltRuns = await store.listRuns(first.projectId);
  const rebuilt = await store.getRun(first.projectId, rebuiltRuns[0].runId);
  if (!rebuilt.artifact) throw new Error("Rebuilt run did not expose RuntimeArtifact");
  if (rebuilt.run.runId === originalFacts.runId || rebuilt.run.artifactId === originalFacts.artifactId) throw new Error("Rebuild reused run or Artifact identity");
  if (rebuilt.run.revision === originalFacts.revision) throw new Error("Rebuild did not bind the current revision");
  if (rebuilt.artifact.fingerprint.projectContentHash === originalFacts.fingerprint.projectContentHash || rebuilt.artifact.fingerprint.value === originalFacts.fingerprint.value) throw new Error("Rebuild did not refresh the content-bound fingerprint");
  if (JSON.stringify(rebuilt.artifact.initialVariables) !== JSON.stringify(initialVariables)) throw new Error("Rebuilt Artifact changed initial input");

  await page.locator(".runtime-buttons").getByRole("button", { name: "暂停", exact: true }).click();
  await runtimeSummary().getByText("已暂停", { exact: true }).waitFor();
  await page.locator(".runtime-buttons").getByRole("button", { name: "继续", exact: true }).click();
  await runtimeSummary().getByText("运行中", { exact: true }).waitFor();
  await page.locator(".runtime-buttons").getByRole("button", { name: "停止", exact: true }).click();
  await runtimeSummary().getByText("已停止", { exact: true }).waitFor();
  await runtimeInspector().getByText("运行事实", { exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile RuntimeArtifact overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "runtime-artifact-mobile.png"), fullPage: true });

  const finalRun = await store.getRun(first.projectId, rebuilt.run.runId);
  const verification = {
    projectIds: { first: first.projectId, second: second.projectId },
    original: originalFacts,
    rebuilt: {
      runId: finalRun.run.runId,
      revision: finalRun.run.revision,
      artifactId: finalRun.run.artifactId,
      status: finalRun.run.state.status,
      fingerprint: finalRun.artifact?.fingerprint,
      initialVariables: finalRun.artifact?.initialVariables
    },
    runCount: (await store.listRuns(first.projectId)).length,
    secondSkillRunCount: (await store.listRuns(second.projectId)).length,
    mobileMetrics,
    consoleErrors,
    failedResponses
  };
  if (verification.rebuilt.status !== "stopped" || verification.runCount !== 2 || verification.secondSkillRunCount !== 0) throw new Error(`Unexpected final facts: ${JSON.stringify(verification)}`);
  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  await writeFile(path.join(artifactDir, "runtime-artifact-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
