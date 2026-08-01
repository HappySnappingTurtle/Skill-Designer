import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const realSkillRoot = "/Users/hongyuwu/IdeaProjects/yds-skills/mdd-backend-extend-develop";
const exampleRoot = path.resolve("examples/multi-skill-workspace");
const exampleDescriptor = JSON.parse(await readFile(path.join(exampleRoot, "example-workspace.json"), "utf8"));
const exampleWorkflowRoot = path.join(exampleRoot, exampleDescriptor.members.find((member) => member.capability === "workflow").relativePath);
const exampleContentRoot = path.join(exampleRoot, exampleDescriptor.members.find((member) => member.capability === "content-only").relativePath);
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-mixed-workspace-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/mixed-workspace-real-skill");
const port = 4379;
const baseUrl = `http://127.0.0.1:${port}`;
await mkdir(artifactDir, { recursive: true });

const sourceBefore = {
  real: await hashTree(realSkillRoot),
  workflow: await hashTree(exampleWorkflowRoot),
  content: await hashTree(exampleContentRoot)
};

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const provider = {
  async probe() {
    return {
      schemaVersion: "1.0",
      providerId: "mixed-workspace-verification",
      label: "混合 Workspace 验收模型",
      status: "ready",
      keyConfigured: true,
      defaultModel: "mixed-workspace-verification",
      reason: "只验证手动引擎运行",
      checkedAt: new Date().toISOString()
    };
  },
  async invoke() {
    return {
      providerId: "mixed-workspace-verification",
      responseId: `mixed-workspace-${Date.now()}`,
      model: "mixed-workspace-verification",
      output: { action: "reply", reply: "本验收使用页面手动推进。", nextNodeId: null, summary: "保持当前节点" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1
    };
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const importLLMParser = {
  latest: async () => null,
  start: async () => { throw new Error("LLM parsing is outside this mixed-workspace verification"); },
  cancel: async () => null
};
const server = createApp({
  store,
  runtimeDebug,
  benchmarkRunner: { list: async () => [] },
  importLLMParser,
  allowedOrigins: [baseUrl]
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

console.log("[mixed-workspace] launching visible Google Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(60_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

let workspaceId;
let realMember;
let workflowMember;
let contentMember;
let realPath;
let workflowPath;
let realRunId;
let workflowRunId;

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("真实与示例 Skill 混合工作区");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "真实与示例 Skill 混合工作区", exact: true }).waitFor();

  const imported = await importRealSkillThroughPage();
  workspaceId = imported.workspace.workspaceId;
  realMember = (await store.getWorkspace(workspaceId)).members.find((member) => member.projectId === imported.candidate.projectId);
  if (!realMember || realMember.status !== "ready" || realMember.capability !== "workflow") throw new Error("Real MDD Skill did not become a ready workflow member");

  await openInPlaceThroughPage(exampleWorkflowRoot, "发布前审核");
  await openInPlaceThroughPage(exampleContentRoot, "接口约定知识库");
  const workspace = await store.getWorkspace(workspaceId);
  workflowMember = workspace.members.find((member) => member.skillId === "skill-11111111-1111-4111-8111-111111111111");
  contentMember = workspace.members.find((member) => member.skillId === "skill-22222222-2222-4222-8222-222222222222");
  if (!workflowMember || workflowMember.status !== "ready" || workflowMember.capability !== "workflow") throw new Error("Example workflow member is not ready");
  if (!contentMember || contentMember.status !== "ready" || contentMember.capability !== "content-only") throw new Error("Example content-only member is not ready");
  if (new Set(workspace.members.map((member) => member.skillId)).size !== 3) throw new Error("Mixed Workspace contains duplicate skillId values");

  await assertWorkspaceRows();
  await page.screenshot({ path: path.join(artifactDir, "mixed-workspace-desktop.png"), fullPage: true });

  const realGraph = (await store.getProjectGraph(realMember.projectId)).graph;
  const workflowGraph = (await store.getProjectGraph(workflowMember.projectId)).graph;
  realPath = sequentialPath(realGraph);
  workflowPath = sequentialPath(workflowGraph);
  if (realPath.length !== realGraph.nodes.length || workflowPath.length !== workflowGraph.nodes.length) throw new Error("Verification requires two complete sequential workflow graphs");

  await openMember(realMember);
  await openTests();
  realRunId = await startRun(realMember, realGraph, { lane: "real-mdd", workspaceSwitch: 0 });
  await advanceTo(realMember, realGraph, realPath[1]);
  const realSuspendedAt = await store.getRun(realMember.projectId, realRunId);

  await returnToWorkspace();
  await openMember(workflowMember);
  await openTests();
  workflowRunId = await startRun(workflowMember, workflowGraph, { lane: "example-workflow", workspaceSwitch: 0 });
  await advanceTo(workflowMember, workflowGraph, workflowPath[1]);
  const workflowSuspendedAt = await store.getRun(workflowMember.projectId, workflowRunId);
  const realWhileParallel = await store.getRun(realMember.projectId, realRunId);
  if (realWhileParallel.run.state.status !== "running" || workflowSuspendedAt.run.state.status !== "running") {
    throw new Error("Both workflow runs were not simultaneously active before project switching");
  }

  await returnToWorkspace();
  await openMember(contentMember);
  await openTests();
  await page.getByRole("heading", { name: "当前 Skill 没有可执行流程", exact: true }).waitFor();
  if (await page.getByRole("button", { name: /启动运行|新建运行/u }).count()) throw new Error("Content-only Skill exposed a runtime start action");
  if ((await store.listRuns(contentMember.projectId)).length !== 0) throw new Error("Content-only Skill unexpectedly acquired a run");
  await page.screenshot({ path: path.join(artifactDir, "content-only-runtime-boundary-desktop.png"), fullPage: true });

  await returnToWorkspace();
  await openMember(realMember);
  await openTests();
  await assertRestoredRun(realMember, realRunId, realGraph, realPath[1], realSuspendedAt.run.state.step);
  await advanceTo(realMember, realGraph, realPath[2]);

  await returnToWorkspace();
  await openMember(workflowMember);
  await openTests();
  await assertRestoredRun(workflowMember, workflowRunId, workflowGraph, workflowPath[1], workflowSuspendedAt.run.state.step);
  for (const nodeId of workflowPath.slice(2)) await advanceTo(workflowMember, workflowGraph, nodeId);
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "example-workflow-completed-desktop.png"), fullPage: true });

  await returnToWorkspace();
  await openMember(realMember);
  await openTests();
  await assertRestoredRun(realMember, realRunId, realGraph, realPath[2], 2);
  for (const nodeId of realPath.slice(3)) await advanceTo(realMember, realGraph, nodeId);
  await page.locator(".runtime-status").getByText("已完成", { exact: true }).waitFor();
  const tracePaint = await graphCanvasPixels(page.locator(".trace-graph-canvas .skill-force-graph"));
  assertPaintedCanvas(tracePaint, "Real MDD completed Trace");
  await page.screenshot({ path: path.join(artifactDir, "real-mdd-completed-trace-desktop.png"), fullPage: true });

  const finalRealRun = await store.getRun(realMember.projectId, realRunId);
  const finalWorkflowRun = await store.getRun(workflowMember.projectId, workflowRunId);
  assertRunIsolation(finalRealRun, realMember, realGraph, realPath);
  assertRunIsolation(finalWorkflowRun, workflowMember, workflowGraph, workflowPath);
  if (finalRealRun.run.artifactId === finalWorkflowRun.run.artifactId || finalRealRun.run.runId === finalWorkflowRun.run.runId) {
    throw new Error("Two Skill projects reused run or RuntimeArtifact identity");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mixed Workspace mobile overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "real-mdd-completed-trace-mobile.png"), fullPage: true });

  const sourceAfter = {
    real: await hashTree(realSkillRoot),
    workflow: await hashTree(exampleWorkflowRoot),
    content: await hashTree(exampleContentRoot)
  };
  for (const key of Object.keys(sourceBefore)) if (!sameTree(sourceBefore[key], sourceAfter[key])) throw new Error(`${key} source changed during mixed Workspace verification`);
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures: ${JSON.stringify({ consoleErrors, failedResponses })}`);

  const verification = {
    schemaVersion: "1.0",
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version(), visibleChrome: true },
    workspace: {
      workspaceId,
      memberCount: workspace.members.length,
      members: workspace.members.map(({ projectId, skillId, displayName, capability, status }) => ({ projectId, skillId, displayName, capability, status })),
      uniqueSkillIds: true
    },
    sources: {
      realMdd: { root: realSkillRoot, fileCount: sourceBefore.real.size, bytesUnchanged: true, classification: "user-provided-real-skill" },
      exampleWorkflow: { root: exampleWorkflowRoot, fileCount: sourceBefore.workflow.size, bytesUnchanged: true, classification: "repository-example" },
      exampleContentOnly: { root: exampleContentRoot, fileCount: sourceBefore.content.size, bytesUnchanged: true, classification: "repository-example" }
    },
    concurrentRuns: {
      simultaneouslyActiveBeforeCompletion: true,
      switchedProjectsWhileBothRunning: true,
      real: runFacts(finalRealRun, realPath),
      exampleWorkflow: runFacts(finalWorkflowRun, workflowPath),
      distinctRunIds: true,
      distinctArtifactIds: true,
      traceIdentityIsolated: true
    },
    contentOnlyBoundary: { runCount: 0, startActionHidden: true },
    graphCanvas: tracePaint,
    mobileMetrics,
    consoleErrors,
    failedResponses,
    screenshots: [
      "mixed-workspace-desktop.png",
      "content-only-runtime-boundary-desktop.png",
      "example-workflow-completed-desktop.png",
      "real-mdd-completed-trace-desktop.png",
      "real-mdd-completed-trace-mobile.png"
    ],
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function importRealSkillThroughPage() {
  await page.getByRole("button", { name: "导入 Skill", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入 Skill 文件夹" });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByText("选择一个 Skill 文件夹", { exact: true }).click()
  ]);
  await chooser.setFiles(realSkillRoot);
  await dialog.getByText(`${sourceBefore.real.size} 个文件`, { exact: false }).waitFor();
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === "POST" && /\/api\/workspaces\/[^/]+\/imports$/u.test(new URL(candidate.url()).pathname)),
    dialog.getByRole("button", { name: "扫描并预检", exact: true }).click()
  ]);
  const preview = (await response.json()).data;
  const blocking = [...preview.candidate.diagnostics, ...preview.candidate.parseReview.lint].filter((issue) => issue.severity === "error");
  if (blocking.length) throw new Error(`Real MDD import is blocked: ${JSON.stringify(blocking)}`);
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /mdd-backend-extend-develop/u }).waitFor();
  return preview;
}

async function openInPlaceThroughPage(rootPath, expectedName) {
  await page.getByRole("button", { name: "原地打开", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "原地打开 Git Skill" });
  await dialog.getByLabel("Skill 根目录绝对路径").fill(rootPath);
  await dialog.getByRole("button", { name: "确认并打开", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: new RegExp(escapeRegExp(expectedName), "u") }).waitFor();
}

async function assertWorkspaceRows() {
  const rows = [
    [realMember, "工作流"],
    [workflowMember, "工作流"],
    [contentMember, "内容型"]
  ];
  for (const [member, capability] of rows) {
    const row = page.getByRole("row", { name: new RegExp(escapeRegExp(member.displayName), "u") });
    await row.getByText(capability, { exact: true }).waitFor();
    await row.getByText("就绪", { exact: true }).waitFor();
    await row.getByText(`${member.skillId.slice(0, 14)}…${member.skillId.slice(-6)}`, { exact: true }).waitFor();
  }
  if (await page.locator("tbody tr").count() !== 3) throw new Error("Mixed Workspace did not display exactly three members");
}

async function openMember(member) {
  await page.getByRole("row", { name: new RegExp(escapeRegExp(member.displayName), "u") }).click();
  await page.locator(`[data-skill-id="${member.skillId}"]`).first().waitFor();
}

async function openTests() {
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "手动运行", exact: true }).waitFor();
}

async function returnToWorkspace() {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("heading", { name: "真实与示例 Skill 混合工作区", exact: true }).waitFor();
}

async function startRun(member, graph, initialVariables) {
  const emptyStart = page.getByRole("button", { name: "启动运行", exact: true });
  if (await emptyStart.count()) await emptyStart.click();
  else await page.getByRole("button", { name: "新建运行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建运行" });
  await dialog.getByLabel("初始 skill 变量（JSON）").fill(JSON.stringify(initialVariables, null, 2));
  await dialog.getByRole("button", { name: "启动", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const start = graph.nodes.find((node) => node.id === graph.entry);
  await page.locator(".current-node-block").getByRole("heading", { name: start.title, exact: true }).waitFor();
  const runs = await store.listRuns(member.projectId);
  if (runs.length !== 1 || runs[0].workspaceId !== workspaceId || runs[0].skillId !== member.skillId) throw new Error(`Run started with the wrong identity for ${member.displayName}`);
  return runs[0].runId;
}

async function advanceTo(member, graph, nodeId) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Unknown target node ${nodeId}`);
  await page.locator(".transition-list").getByRole("button", { name: new RegExp(escapeRegExp(node.title), "u") }).click();
  await page.locator(".current-node-block").getByRole("heading", { name: node.title, exact: true }).waitFor();
  const latest = (await store.listRuns(member.projectId))[0];
  if (latest.state.currentNodeId !== nodeId) throw new Error(`Page advanced to ${nodeId}, but Store remained at ${latest.state.currentNodeId}`);
}

async function assertRestoredRun(member, runId, graph, nodeId, step) {
  await page.locator(".runtime-summary").getByText("运行中", { exact: true }).waitFor();
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  await page.locator(".current-node-block").getByRole("heading", { name: node.title, exact: true }).waitFor();
  const restored = await store.getRun(member.projectId, runId);
  if (restored.run.state.currentNodeId !== nodeId || restored.run.state.step !== step) throw new Error(`Workspace switch changed ${member.displayName} run state`);
}

function assertRunIsolation(view, member, graph, expectedPath) {
  if (!view.artifact) throw new Error(`${member.displayName} run has no RuntimeArtifact`);
  if (view.run.workspaceId !== workspaceId || view.run.projectId !== member.projectId || view.run.skillId !== member.skillId) throw new Error(`${member.displayName} run identity drifted`);
  if (view.artifact.workspaceId !== workspaceId || view.artifact.projectId !== member.projectId || view.artifact.skillId !== member.skillId) throw new Error(`${member.displayName} Artifact identity drifted`);
  if (view.run.state.status !== "completed" || JSON.stringify(view.run.state.visitedNodeIds) !== JSON.stringify(expectedPath)) throw new Error(`${member.displayName} did not complete its own path`);
  const ownNodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const event of view.run.events) {
    if (event.workspaceId !== workspaceId || event.projectId !== member.projectId || event.skillId !== member.skillId || event.artifactId !== view.run.artifactId) throw new Error(`${member.displayName} Trace contains a foreign identity`);
    if (event.nodeId && !ownNodeIds.has(event.nodeId)) throw new Error(`${member.displayName} Trace contains foreign node ${event.nodeId}`);
  }
}

function runFacts(view, expectedPath) {
  return {
    runId: view.run.runId,
    artifactId: view.run.artifactId,
    projectId: view.run.projectId,
    skillId: view.run.skillId,
    status: view.run.state.status,
    visitedNodeIds: view.run.state.visitedNodeIds,
    expectedPath,
    traceEventCount: view.run.events.length
  };
}

function sequentialPath(graph) {
  const start = graph.nodes.find((node) => node.id === graph.entry || node.kind === "start");
  if (!start) throw new Error("Workflow has no start node");
  const result = [start.id];
  const seen = new Set(result);
  let current = start.id;
  while (true) {
    const outgoing = graph.edges.filter((edge) => edge.from === current && edge.kind !== "knowledge");
    if (outgoing.length === 0) break;
    if (outgoing.length !== 1) throw new Error(`Workflow ${graph.skillId} is not sequential at ${current}`);
    current = outgoing[0].to;
    if (seen.has(current)) throw new Error(`Workflow ${graph.skillId} contains a cycle`);
    seen.add(current);
    result.push(current);
  }
  return result;
}

async function graphCanvasPixels(graphLocator) {
  await graphLocator.waitFor();
  await graphLocator.locator("canvas").waitFor();
  await page.waitForTimeout(700);
  return graphLocator.locator("canvas").evaluate((canvas) => {
    const width = canvas.width;
    const height = canvas.height;
    const context2d = canvas.getContext("2d");
    let pixels;
    let renderer;
    if (context2d) {
      pixels = context2d.getImageData(0, 0, width, height).data;
      renderer = "canvas-2d";
    } else {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) throw new Error("Trace graph canvas has no rendering context");
      pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      renderer = gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
    }
    let variedSamples = 0;
    const colors = new Set();
    const base = [pixels[0], pixels[1], pixels[2]];
    const sampleStep = Math.max(1, Math.floor((width * height) / 24_000));
    for (let pixel = 0; pixel < width * height; pixel += sampleStep) {
      const offset = pixel * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (Math.abs(red - base[0]) + Math.abs(green - base[1]) + Math.abs(blue - base[2]) > 24) variedSamples++;
      colors.add(`${red >> 4}-${green >> 4}-${blue >> 4}-${alpha >> 5}`);
    }
    return { renderer, width, height, variedSamples, uniqueColorBuckets: colors.size };
  });
}

function assertPaintedCanvas(canvas, label) {
  if (canvas.width < 300 || canvas.height < 240 || canvas.variedSamples <= 10 || canvas.uniqueColorBuckets < 4) throw new Error(`${label} is blank: ${JSON.stringify(canvas)}`);
}

async function hashTree(root) {
  const result = new Map();
  async function walk(relative = "") {
    const directory = path.join(root, relative);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === ".DS_Store") continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.set(next, createHash("sha256").update(await readFile(path.join(root, next))).digest("hex"));
      else throw new Error(`Unsupported source entry: ${path.join(root, next)}`);
    }
  }
  await walk();
  return result;
}

function sameTree(left, right) {
  return left.size === right.size && [...left].every(([file, digest]) => right.get(file) === digest);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
