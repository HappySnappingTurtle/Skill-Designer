import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-runtime-engine-"));
const skillRoot = path.join(dataRoot, "conditional-skill");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const reportPath = path.join(artifactDir, "runtime-engine-verification.json");
const baseUrl = "http://127.0.0.1:4338";
await mkdir(artifactDir, { recursive: true });
await mkdir(path.join(skillRoot, "graph"), { recursive: true });

const skillId = "skill-33333333-3333-4333-8333-333333333333";
const graph = {
  schemaVersion: "1.0",
  skillId,
  capability: "workflow",
  entry: "flow.start",
  nodes: [
    { id: "flow.start", kind: "start", title: "开始", position: { x: 0, y: 0 } },
    { id: "flow.review", kind: "decision", title: "检查", position: { x: 220, y: 0 } },
    { id: "flow.approved", kind: "end", title: "通过", position: { x: 440, y: -100 } },
    { id: "flow.rejected", kind: "end", title: "拒绝", position: { x: 440, y: 100 } }
  ],
  edges: [
    { id: "edge.start-review", from: "flow.start", to: "flow.review", kind: "flow" },
    { id: "edge.review-approved", from: "flow.review", to: "flow.approved", kind: "condition", label: "已批准", condition: { op: "equals", left: { kind: "ref", path: "skill.approved" }, right: { kind: "literal", value: true } } },
    { id: "edge.review-rejected", from: "flow.review", to: "flow.rejected", kind: "condition", label: "未批准", condition: { op: "notEquals", left: { kind: "ref", path: "skill.approved" }, right: { kind: "literal", value: true } } }
  ]
};
await writeFile(path.join(skillRoot, "SKILL.md"), "# 条件运行引擎\n\n验证合法出口与拒绝语义。\n", "utf8");
await writeFile(path.join(skillRoot, "skill.json"), `${JSON.stringify({ skillId, name: "条件运行引擎", version: "0.1.0", description: "", capability: "workflow", entry: "flow.start" }, null, 2)}\n`, "utf8");
await writeFile(path.join(skillRoot, "graph", "main.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "运行引擎 Chrome 验收" });
const opened = await store.openInPlaceProject(workspace.workspaceId, { rootPath: skillRoot });
const member = opened.members[0];
const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataRoot, "runtime-dialog"),
  store,
  provider: {
    probe: async () => ({ schemaVersion: "1.0", providerId: "runtime-engine-check", label: "引擎验收模型", status: "ready", keyConfigured: true, defaultModel: "runtime-check", reason: "ready", checkedAt: new Date().toISOString() }),
    invoke: async () => ({
      providerId: "runtime-engine-check",
      responseId: "runtime-engine-check-response",
      model: "runtime-check",
      output: { action: "reply", reply: "保持当前节点。", nextNodeId: null, summary: "不推进" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1
    })
  }
});
await runtimeDebug.initialize();

const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4338, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function startRun(variables) {
  const emptyStart = page.getByRole("button", { name: "启动运行", exact: true });
  if (await emptyStart.count()) await emptyStart.click();
  else await page.getByRole("button", { name: "重新运行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建运行" });
  await dialog.getByLabel("初始 skill 变量（JSON）").fill(JSON.stringify(variables, null, 2));
  await dialog.getByRole("button", { name: "启动", exact: true }).click();
  await page.locator(".runtime-summary").getByText("运行中", { exact: true }).waitFor();
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "运行引擎 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByText("创建一次可追踪运行", { exact: true }).waitFor();
  await startRun({ approved: true });
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();
  await page.locator(".transition-list").getByRole("button", { name: /检查/u }).click();
  await page.getByRole("heading", { name: "检查", exact: true }).waitFor();
  await page.locator(".transition-list").getByRole("button", { name: /通过/u }).waitFor();
  if (await page.locator(".transition-list").getByRole("button", { name: /拒绝/u }).count()) throw new Error("Condition-disabled exit was shown as legal");

  await page.getByLabel("下一节点 ID").fill("flow.rejected");
  const [rejectionResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/next")),
    page.locator(".manual-transition").getByRole("button", { name: "提交", exact: true }).click()
  ]);
  const rejectionPayload = await rejectionResponse.json();
  if (rejectionPayload.data?.commandResult?.rejection?.code !== "next_node_not_allowed") throw new Error(`Structured rejection missing: ${JSON.stringify(rejectionPayload)}`);
  await page.getByText("下一节点被拒绝，运行仍停留在当前节点", { exact: true }).waitFor();
  await page.getByText("错误码：next_node_not_allowed", { exact: false }).waitFor();
  await page.getByRole("heading", { name: "检查", exact: true }).waitFor();
  const rejectedRun = (await store.listRuns(member.projectId))[0];
  if (rejectedRun.state.currentNodeId !== "flow.review" || rejectedRun.state.step !== 1 || rejectedRun.events.at(-1)?.type !== "engine.reject") {
    throw new Error(`Rejected transition changed run state: ${JSON.stringify(rejectedRun.state)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "runtime-engine-rejection-desktop.png"), fullPage: true });

  await page.locator(".transition-list").getByRole("button", { name: /通过/u }).click();
  await page.locator(".runtime-summary").getByText("已完成", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "通过", exact: true }).waitFor();

  await startRun({ approved: false });
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.locator(".runtime-summary").getByText("已暂停", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.locator(".runtime-summary").getByText("运行中", { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.locator(".runtime-summary").getByText("已停止", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth) throw new Error(`Runtime mobile overflow: ${JSON.stringify(mobileLayout)}`);
  await page.screenshot({ path: path.join(artifactDir, "runtime-engine-controls-mobile.png"), fullPage: true });

  const runs = await store.listRuns(member.projectId);
  const stopped = runs.find((run) => run.state.status === "stopped");
  const completed = runs.find((run) => run.state.status === "completed");
  if (!stopped || !completed) throw new Error("Expected completed and stopped runs were not persisted");
  const controlEvents = stopped.events.filter((event) => ["engine.pause", "engine.resume", "engine.stop"].includes(event.type)).map((event) => event.type);
  if (JSON.stringify(controlEvents) !== JSON.stringify(["engine.pause", "engine.resume", "engine.stop"])) throw new Error(`Run controls were not persisted: ${JSON.stringify(controlEvents)}`);
  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  if (failedResponses.length) throw new Error(`Failed responses: ${failedResponses.join(" | ")}`);

  const report = {
    rejection: rejectionPayload.data.commandResult,
    rejectedState: { currentNodeId: rejectedRun.state.currentNodeId, step: rejectedRun.state.step },
    completedState: { currentNodeId: completed.state.currentNodeId, step: completed.state.step, status: completed.state.status },
    stoppedState: { currentNodeId: stopped.state.currentNodeId, step: stopped.state.step, status: stopped.state.status },
    controlEvents,
    mobileLayout,
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
