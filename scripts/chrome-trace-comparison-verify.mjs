import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-trace-comparison-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4333";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Trace 对比 Chrome 验收" });
const detail = await store.createManagedSkill(workspace.workspaceId, { name: "双路径运行 Skill", capability: "workflow", description: "验证状态、变量和事件域对比" });
const member = detail.members[0];
if (!member) throw new Error("Managed Skill was not created");
const graphView = await store.getProjectGraph(member.projectId);
const startCore = graphView.graph.edges.find((edge) => edge.id === "edge.start-core");
if (!startCore) throw new Error("Default start edge is missing");
const graphChange = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: graphView.activeRevision,
  reason: "为 Trace 对比建立两条明确条件路径",
  operations: [
    {
      op: "graph.edge.update",
      target: startCore.id,
      value: { ...startCore, kind: "condition", condition: { op: "equals", left: { kind: "ref", path: "skill.route" }, right: { kind: "literal", value: "model" } } }
    },
    {
      op: "graph.node.create",
      target: "flow.alternate",
      value: { id: "flow.alternate", kind: "action", title: "备用步骤", description: "手工运行路径", position: { x: 430, y: 330 } }
    },
    {
      op: "graph.edge.create",
      target: "edge.start-alternate",
      value: { id: "edge.start-alternate", from: "flow.start", to: "flow.alternate", kind: "condition", condition: { op: "equals", left: { kind: "ref", path: "skill.route" }, right: { kind: "literal", value: "manual" } } }
    },
    {
      op: "graph.edge.create",
      target: "edge.alternate-end",
      value: { id: "edge.alternate-end", from: "flow.alternate", to: "flow.end", kind: "flow" }
    }
  ]
});
await store.confirmAndApplyChangeSet(graphChange.changeSetId, { digest: graphChange.digest, baseRevision: graphChange.baseRevision });

const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataRoot, "runtime-dialog"),
  store,
  provider: {
    probe: async () => ({ schemaVersion: "1.0", providerId: "comparison-model", label: "对比验收模型", status: "ready", keyConfigured: true, defaultModel: "comparison-model", reason: "ready", checkedAt: new Date().toISOString() }),
    invoke: async () => ({
      providerId: "comparison-model",
      responseId: "comparison-response",
      model: "comparison-model-resolved",
      output: { action: "advance", reply: "沿模型路径推进。", nextNodeId: "flow.core-step", summary: "模型路径" },
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 17
    })
  }
});
await runtimeDebug.initialize();

const modelRun = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { route: "model", shared: { a: 1, b: 2 } } });
await runtimeDebug.message(member.projectId, modelRun.run.runId, { workspaceId: workspace.workspaceId, content: "按模型路径运行" });
await store.commandRun(member.projectId, modelRun.run.runId, "next", { nextNodeId: "flow.end" });
const manualRun = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { route: "manual", shared: { b: 2, a: 1 }, onlyRight: true } });
await store.commandRun(member.projectId, manualRun.run.runId, "next", { nextNodeId: "flow.alternate" });
await store.commandRun(member.projectId, manualRun.run.runId, "next", { nextNodeId: "flow.end" });
const beforeRemoval = await store.getProjectGraph(member.projectId);
const removeCore = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: beforeRemoval.activeRevision,
  reason: "验证旧运行节点在新 revision 中缺失时的降级展示",
  operations: [
    { op: "graph.edge.delete", target: "edge.start-core" },
    { op: "graph.edge.delete", target: "edge.core-end" },
    { op: "graph.node.delete", target: "flow.core-step" },
    {
      op: "graph.edge.create",
      target: "edge.start-end-new",
      value: { id: "edge.start-end-new", from: "flow.start", to: "flow.end", kind: "condition", condition: { op: "equals", left: { kind: "ref", path: "skill.route" }, right: { kind: "literal", value: "new" } } }
    }
  ]
});
await store.confirmAndApplyChangeSet(removeCore.changeSetId, { digest: removeCore.digest, baseRevision: removeCore.baseRevision });
const currentRun = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { route: "new", shared: { b: 2, a: 1 }, onlyRight: true } });
await store.commandRun(member.projectId, currentRun.run.runId, "next", { nextNodeId: "flow.end" });

const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4333, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Trace 对比 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.locator(".runtime-summary").getByText("已完成", { exact: true }).waitFor();
  await page.getByLabel("对比运行").selectOption(modelRun.run.runId);

  const comparison = page.getByLabel("运行状态对比");
  await comparison.getByText("运行事实对比", { exact: true }).waitFor();
  await page.getByText(/首个路径偏差 #2：flow\.end \/ flow\.core-step/u).waitFor();
  await comparison.getByText("route", { exact: true }).waitFor();
  await comparison.getByText("onlyRight", { exact: true }).waitFor();
  if (await comparison.getByText("shared", { exact: true }).count()) throw new Error("Equivalent nested variables were reported as different");
  await comparison.getByText("llm.request", { exact: true }).waitFor();
  await comparison.getByText("llm.response", { exact: true }).waitFor();
  await comparison.getByText("conversation.user", { exact: true }).waitFor();
  await comparison.getByText("conversation.assistant", { exact: true }).waitFor();
  const comparisonText = await comparison.innerText();
  if (!comparisonText.includes("1 / 4") || !comparisonText.includes("2 / 9")) throw new Error(`Snapshot seq facts are missing: ${comparisonText}`);
  await page.locator(".trace-flow-node.missing").filter({ hasText: "flow.core-step" }).getByText("对比图缺失", { exact: true }).waitFor();

  await page.getByRole("group", { name: "Trace 图谱显示模式" }).getByRole("button", { name: "2D", exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole("group", { name: "Trace 图谱显示模式" }).getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(artifactDir, "trace-comparison-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile comparison overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "trace-comparison-mobile.png"), fullPage: true });

  const verification = {
    currentRunId: currentRun.run.runId,
    comparisonRunId: modelRun.run.runId,
    summary: await page.locator(".trace-comparison-summary").innerText(),
    comparisonText,
    mobileMetrics,
    consoleErrors,
    failedResponses
  };
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);
  await writeFile(path.join(artifactDir, "trace-comparison-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
