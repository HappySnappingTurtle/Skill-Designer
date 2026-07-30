import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-condition-contract-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4342";
await mkdir(artifactDir, { recursive: true });
const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "条件契约 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "严格条件流程", capability: "workflow" });
const member = created.members[0];
const initial = await store.getProjectGraph(member.projectId);
const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataRoot, "runtime-dialog"),
  store,
  provider: {
    probe: async () => ({ schemaVersion: "1.0", providerId: "condition-browser", label: "Condition Browser", status: "ready", keyConfigured: true, defaultModel: "condition-model", reason: "ready", checkedAt: new Date().toISOString() }),
    invoke: async () => ({ providerId: "condition-browser", responseId: "unused", model: "condition-model", output: { action: "reply", reply: "未调用", nextNodeId: null, summary: "未调用" }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 }, durationMs: 0 })
  }
});
await runtimeDebug.initialize();

const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4342, "127.0.0.1", resolve));
console.log("[condition-contract-verify] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });

async function clickEditorTool(name) {
  await page.getByRole("button", { name: /^变更 / }).click();
  await page.getByTitle("图谱编辑工具").click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function startRun(variables) {
  const first = page.getByRole("button", { name: "启动运行", exact: true });
  if (await first.count()) await first.click();
  else await page.getByRole("button", { name: "重新运行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建运行" });
  await dialog.getByLabel("初始 skill 变量（JSON）").fill(JSON.stringify(variables, null, 2));
  await dialog.getByRole("button", { name: "启动", exact: true }).click();
  await page.locator(".runtime-summary").getByText("运行中", { exact: true }).waitFor();
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "条件契约 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("严格条件流程 图谱").waitFor();
  await page.locator('.skill-force-graph[data-node-count="3"][data-edge-count="2"]').waitFor();

  await clickEditorTool("新增边");
  const edgeDialog = page.getByRole("dialog", { name: "新增边" });
  await edgeDialog.getByLabel("边 ID").fill("edge.start-ready-end");
  await edgeDialog.getByLabel("起点").selectOption("flow.start");
  await edgeDialog.getByLabel("终点").selectOption("flow.end");
  await edgeDialog.getByLabel("边类型").selectOption("condition");
  await edgeDialog.getByLabel("边标签").fill("上下文满足");
  const unsafeCondition = {
    op: "and",
    conditions: [
      { op: "contains", container: { kind: "ref", path: "skill.tags" }, value: { kind: "literal", value: "ready" } },
      { op: "equals", left: { kind: "ref", path: "runtime.currentNodeId" }, right: { kind: "literal", value: "flow.start" } }
    ],
    script: "process.exit()"
  };
  await edgeDialog.getByLabel("条件表达式 JSON").fill(JSON.stringify(unsafeCondition, null, 2));
  await edgeDialog.getByRole("button", { name: "加入草稿" }).click();
  await edgeDialog.getByText("condition.script：字段 script 不属于该条件结构", { exact: true }).waitFor();
  const draftBeforeValid = await store.getProjectGraph(member.projectId);
  if (draftBeforeValid.activeRevision !== initial.activeRevision || draftBeforeValid.graph.edges.length !== 2) throw new Error("非法条件在页面报错前写入了项目");
  await page.screenshot({ path: path.join(artifactDir, "condition-contract-rejected-desktop.png"), fullPage: true });

  const validCondition = { ...unsafeCondition };
  delete validCondition.script;
  await edgeDialog.getByLabel("条件表达式 JSON").fill(JSON.stringify(validCondition, null, 2));
  await edgeDialog.getByRole("button", { name: "加入草稿" }).click();
  await edgeDialog.waitFor({ state: "hidden" });
  await page.getByText("形状校验通过（3 节点 / 3 边）", { exact: true }).waitFor();
  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  await page.getByRole("button", { name: "预览并保存图", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认图谱变更" });
  await confirmation.getByText("edge.start-ready-end", { exact: true }).waitFor();
  const activeBeforeConfirm = await store.getProjectGraph(member.projectId);
  if (activeBeforeConfirm.activeRevision !== initial.activeRevision || activeBeforeConfirm.graph.edges.length !== 2) throw new Error("条件草稿绕过确认写入了项目");
  await confirmation.getByRole("button", { name: "确认并应用" }).click();
  await confirmation.waitFor({ state: "hidden" });
  const applied = await store.getProjectGraph(member.projectId);
  const conditionalEdge = applied.graph.edges.find((edge) => edge.id === "edge.start-ready-end");
  if (applied.activeRevision === initial.activeRevision || conditionalEdge?.condition?.op !== "and" || "script" in conditionalEdge.condition) throw new Error("确认后的严格条件图不正确");

  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByText("创建一次可追踪运行", { exact: true }).waitFor();
  await startRun({ tags: ["draft"] });
  await page.locator(".transition-list").getByRole("button", { name: /核心步骤/u }).waitFor();
  if (await page.locator(".transition-list").getByRole("button", { name: /完成/u }).count()) throw new Error("条件为 false 时页面展示了直接结束出口");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.locator(".runtime-summary").getByText("已停止", { exact: true }).waitFor();

  await startRun({ tags: ["ready", "review"] });
  await page.locator(".transition-list").getByRole("button", { name: /核心步骤/u }).waitFor();
  const directEnd = page.locator(".transition-list").getByRole("button", { name: /完成/u });
  await directEnd.waitFor();
  await page.screenshot({ path: path.join(artifactDir, "condition-contract-allowed-desktop.png"), fullPage: true });
  await directEnd.click();
  await page.locator(".runtime-summary").getByText("已完成", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "完成", exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth) throw new Error(`条件运行移动端横向溢出：${JSON.stringify(mobileLayout)}`);
  await page.screenshot({ path: path.join(artifactDir, "condition-contract-mobile.png"), fullPage: true });

  const runs = await store.listRuns(member.projectId);
  const completed = runs.find((run) => run.state.status === "completed");
  const stopped = runs.find((run) => run.state.status === "stopped");
  if (!completed || !stopped || completed.state.currentNodeId !== "flow.end" || completed.state.step !== 1) throw new Error("条件运行结果没有按页面操作持久化");
  if (failedResponses.length) throw new Error(`Failed responses: ${JSON.stringify(failedResponses)}`);
  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);

  const report = {
    schemaVersion: "1.0",
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version(), visibleChrome: true },
    checks: { unknownFieldRejectedInEditor: true, activeGraphUnchangedBeforeConfirmation: true, skillNamespaceEvaluated: true, runtimeNamespaceEvaluated: true, falseExitHidden: true, trueExitExecuted: true, mobileHorizontalOverflow: false },
    identities: { workspaceId: workspace.workspaceId, projectId: member.projectId, skillId: member.skillId, appliedRevision: applied.activeRevision, completedRunId: completed.runId, stoppedRunId: stopped.runId },
    completedState: completed.state,
    mobileLayout,
    consoleErrors,
    failedResponses,
    screenshots: ["condition-contract-rejected-desktop.png", "condition-contract-allowed-desktop.png", "condition-contract-mobile.png"]
  };
  await writeFile(path.join(artifactDir, "condition-contract-verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
