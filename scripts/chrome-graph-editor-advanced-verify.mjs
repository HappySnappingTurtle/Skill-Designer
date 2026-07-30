import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-graph-editor-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4326";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "高级图编辑 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "高级图编辑流程", capability: "workflow", description: "拖线、条件、批量与 Lint 页面验收" });
const member = created.members[0];
const before = await store.getProjectGraph(member.projectId);
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4326, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function clickEditorTool(name) {
  await page.getByRole("button", { name: /^变更 / }).click();
  await page.getByTitle("图谱编辑工具").click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function previewGraphChanges() {
  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  await page.getByRole("button", { name: "预览并保存图", exact: true }).click();
}

async function openEdgeDialog(sourceId, targetId) {
  await clickEditorTool("新增边");
  const dialog = page.getByRole("dialog", { name: "新增边" });
  await dialog.waitFor();
  await dialog.getByLabel("起点").selectOption(sourceId);
  await dialog.getByLabel("终点").selectOption(targetId);
  return dialog;
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "高级图编辑 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("高级图编辑流程 图谱").waitFor();
  await page.locator('.skill-force-graph[data-node-count="3"][data-edge-count="2"]').waitFor();

  await clickEditorTool("新增节点");
  const nodeDialog = page.getByRole("dialog", { name: "新增节点" });
  await nodeDialog.getByLabel("节点 ID").fill("flow.chrome-review");
  await nodeDialog.getByLabel("节点标题").fill("Chrome 人工确认");
  await nodeDialog.getByLabel("节点类型").selectOption("gate");
  await nodeDialog.getByRole("button", { name: "加入草稿" }).click();
  await page.locator(".graph-inspector").getByRole("heading", { name: "Chrome 人工确认" }).waitFor();
  await page.getByRole("button", { name: "编辑节点" }).click();

  await page.getByLabel("节点标题").fill("");
  await page.getByRole("button", { name: "1 错误" }).click();
  await page.getByText("节点标题不能为空", { exact: true }).waitFor();
  await page.getByRole("button", { name: "定位问题 nodes[3].title" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "graph-node-title");
  await page.getByLabel("节点标题").fill("Chrome 人工确认");
  await page.getByText("节点标题不能为空", { exact: true }).waitFor({ state: "hidden" });

  const conditionalDialog = await openEdgeDialog("flow.core-step", "flow.chrome-review");
  const conditionalEdgeId = await conditionalDialog.getByLabel("边 ID").inputValue();
  await conditionalDialog.getByLabel("边类型").selectOption("condition");
  await conditionalDialog.getByLabel("边标签").fill("已批准");
  await conditionalDialog.getByLabel("条件表达式 JSON").fill(JSON.stringify({ op: "equals", left: { kind: "ref", path: "skill.approved" }, right: { kind: "literal", value: true } }, null, 2));
  await conditionalDialog.getByRole("button", { name: "加入草稿" }).click();
  await page.getByRole("button", { name: "编辑关系" }).click();
  await page.locator(".graph-inspector").getByText("相等", { exact: true }).waitFor();

  await page.getByRole("button", { name: "编辑条件" }).click();
  const conditionDialog = page.getByRole("dialog", { name: "编辑边条件" });
  await conditionDialog.getByLabel("条件表达式 JSON").fill('{"op":"exec"}');
  await conditionDialog.getByRole("button", { name: "应用到草稿" }).click();
  await conditionDialog.getByText(/条件操作符不受支持/u).waitFor();
  await conditionDialog.getByLabel("条件表达式 JSON").fill(JSON.stringify({ op: "boolean", value: true }, null, 2));
  await conditionDialog.getByRole("button", { name: "应用到草稿" }).click();
  await conditionDialog.waitFor({ state: "hidden" });
  await page.locator(".graph-inspector").getByText("布尔值", { exact: true }).waitFor();

  const flowDialog = await openEdgeDialog("flow.chrome-review", "flow.end");
  const flowEdgeId = await flowDialog.getByLabel("边 ID").inputValue();
  await flowDialog.getByRole("button", { name: "加入草稿" }).click();
  await page.getByText("形状校验通过（4 节点 / 4 边）", { exact: true }).waitFor();

  await clickEditorTool("新增边");
  const selfLoopDialog = page.getByRole("dialog", { name: "新增边" });
  await selfLoopDialog.getByLabel("边 ID").fill("edge.chrome-self-loop");
  await selfLoopDialog.getByLabel("起点").selectOption("flow.chrome-review");
  await selfLoopDialog.getByLabel("终点").selectOption("flow.chrome-review");
  await selfLoopDialog.getByRole("button", { name: "加入草稿" }).click();
  await page.getByRole("button", { name: "1 警告" }).click();
  await page.getByText("边指向自身", { exact: true }).waitFor();
  await page.getByRole("button", { name: "定位问题 edges[4]" }).click();
  await page.locator(".graph-inspector").getByRole("heading", { name: "edge.chrome-self-loop" }).waitFor();
  await page.getByRole("button", { name: "1 警告" }).click();
  await page.getByRole("button", { name: "移除自环到草稿" }).click();
  await page.getByText("形状校验通过（4 节点 / 4 边）", { exact: true }).waitFor();

  await clickEditorTool("批量编辑节点");
  const batchDialog = page.getByRole("dialog", { name: "批量编辑节点" });
  await batchDialog.getByLabel("搜索批量节点").fill("核心步骤");
  await batchDialog.getByRole("button", { name: "选择搜索结果" }).click();
  await batchDialog.getByLabel("搜索批量节点").fill("Chrome 人工确认");
  await batchDialog.getByRole("button", { name: "选择搜索结果" }).click();
  await batchDialog.getByLabel("批量节点说明操作").selectOption("set");
  await batchDialog.getByRole("textbox", { name: "批量节点说明", exact: true }).fill("由 Chrome 批量编辑并等待 ChangeSet 确认");
  await batchDialog.getByRole("button", { name: "应用到草稿" }).click();
  await batchDialog.waitFor({ state: "hidden" });

  const beforeConfirmation = await store.getProjectGraph(member.projectId);
  if (beforeConfirmation.activeRevision !== before.activeRevision) throw new Error("Graph draft changed active revision before confirmation");
  if (beforeConfirmation.graph.nodes.length !== 3 || beforeConfirmation.graph.edges.length !== 2) throw new Error("Graph draft wrote project files before confirmation");

  await previewGraphChanges();
  const changeDialog = page.getByRole("dialog", { name: "确认图谱变更" });
  await changeDialog.getByText("flow.chrome-review", { exact: true }).waitFor();
  await changeDialog.getByText(conditionalEdgeId, { exact: true }).waitFor();
  await changeDialog.getByText(flowEdgeId, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "graph-editor-advanced-confirmation.png"), fullPage: true });
  await changeDialog.getByRole("button", { name: "确认并应用" }).click();
  await changeDialog.waitFor({ state: "hidden" });

  const applied = await store.getProjectGraph(member.projectId);
  if (applied.activeRevision === before.activeRevision) throw new Error("Confirmed graph did not advance revision");
  if (applied.graph.nodes.length !== 4 || applied.graph.edges.length !== 4) throw new Error(`Confirmed graph shape mismatch: ${applied.graph.nodes.length} nodes, ${applied.graph.edges.length} edges`);
  const conditionEdge = applied.graph.edges.find((edge) => edge.id === conditionalEdgeId);
  if (conditionEdge?.kind !== "condition" || conditionEdge.condition?.op !== "boolean" || conditionEdge.condition.value !== true) throw new Error("Validated condition edge was not persisted");
  for (const nodeId of ["flow.core-step", "flow.chrome-review"]) {
    if (applied.graph.nodes.find((node) => node.id === nodeId)?.description !== "由 Chrome 批量编辑并等待 ChangeSet 确认") throw new Error(`Batch description was not persisted for ${nodeId}`);
  }
  if (applied.graph.edges.some((edge) => edge.id === "edge.chrome-self-loop")) throw new Error("Lint repair self-loop leaked into confirmed graph");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator('.skill-force-graph[data-node-count="4"][data-edge-count="4"]').waitFor();
  await page.getByLabel("搜索图节点").fill("Chrome 人工确认");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "Chrome 人工确认", exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑节点" }).click();
  await page.getByLabel("节点说明").waitFor();
  if (await page.getByLabel("节点说明").inputValue() !== "由 Chrome 批量编辑并等待 ChangeSet 确认") throw new Error("Reload did not preserve batch edit");
  await page.screenshot({ path: path.join(artifactDir, "graph-editor-advanced-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await clickEditorTool("批量编辑节点");
  await page.getByRole("dialog", { name: "批量编辑节点" }).waitFor();
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (overflow.document > overflow.viewport) throw new Error(`Mobile advanced graph editor overflow: ${overflow.document}px > ${overflow.viewport}px`);
  await page.screenshot({ path: path.join(artifactDir, "graph-editor-advanced-mobile.png"), fullPage: true });
  await page.getByRole("dialog", { name: "批量编辑节点" }).getByRole("button", { name: "关闭" }).click();

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  const reportPath = path.join(artifactDir, "graph-editor-advanced.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version() },
    verified: {
      explicitEndpointConnections: 2,
      structuredConditionCreateAndEdit: true,
      invalidConditionRejected: true,
      lintFieldLocation: true,
      selfLoopDraftRepair: true,
      batchEditedNodeIds: ["flow.core-step", "flow.chrome-review"],
      noWriteBeforeConfirmation: true,
      persistedAfterConfirmationAndReload: true,
      mobileHorizontalOverflow: false
    },
    finalGraph: { nodes: applied.graph.nodes.length, edges: applied.graph.edges.length, activeRevision: applied.activeRevision },
    screenshots: ["graph-editor-advanced-confirmation.png", "graph-editor-advanced-desktop.png", "graph-editor-advanced-mobile.png"]
  }, null, 2) + "\n");
  console.log("Chrome advanced graph editor verified: explicit endpoint connections, condition validation/edit, batch update, lint location/repair, confirmation boundary, persistence and mobile layout passed.");
  console.log(`Report: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
