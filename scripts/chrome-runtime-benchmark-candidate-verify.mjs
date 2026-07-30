import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-runtime-candidate-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4330";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Trace 候选 Chrome 验收" });
const skillId = "skill-73000000-0000-4000-8000-000000000001";
const graph = {
  schemaVersion: "1.0",
  skillId,
  capability: "workflow",
  entry: "flow.start",
  nodes: [
    { id: "flow.start", kind: "start", title: "开始" },
    { id: "flow.core-step", kind: "step", title: "核心步骤" },
    { id: "flow.end", kind: "end", title: "完成" }
  ],
  edges: [
    { id: "edge.start-core", from: "flow.start", to: "flow.core-step", kind: "flow" },
    { id: "edge.core-end", from: "flow.core-step", to: "flow.end", kind: "flow" }
  ]
};
const manifest = { skillId, name: "百用例回归 Skill", version: "1.0.0", description: "验证普通 Trace 候选和规模检索", capability: "workflow", entry: "flow.start" };
const files = [
  { path: "SKILL.md", content: "# 百用例回归 Skill\n\n用于 Trace 候选验收。\n" },
  { path: "skill.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
  { path: "graph/main.json", content: `${JSON.stringify(graph, null, 2)}\n` }
];
for (let index = 1; index <= 100; index++) {
  const caseId = `case-73000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  files.push({
    path: `benchmarks/cases/${caseId}.json`,
    content: `${JSON.stringify({
      schemaVersion: "1.0",
      caseId,
      skillId,
      title: `规模回归 ${String(index).padStart(3, "0")}`,
      status: "ready",
      intent: "验证规模列表和搜索",
      fixture: { initialVariables: { index }, userReplies: [] },
      expected: {
        path: { mode: "subsequence", nodeIds: ["flow.start", "flow.end"] },
        terminal: { status: "completed", nodeId: "flow.end" },
        variables: {}, artifacts: [], toolResults: [], forbiddenEffects: []
      },
      tags: [index % 2 === 0 ? "even" : "odd", "scale"]
    }, null, 2)}\n`
  });
}
const preview = await store.createSkillImport(workspace.workspaceId, {
  folderName: "hundred-case-skill",
  files: files.map((file) => ({ path: file.path, contentBase64: Buffer.from(file.content).toString("base64") }))
});
const confirmed = await store.confirmSkillImport(preview.candidate.importId, { workspaceId: workspace.workspaceId, digest: preview.candidate.digest });
const member = confirmed.members.find((item) => item.skillId === skillId);
if (!member) throw new Error("Imported Skill is missing");
const started = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { requestId: "trace-candidate-101", priority: 3 } });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.core-step" });
await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.end" });

const provider = {
  async probe() {
    return { schemaVersion: "1.0", providerId: "recorded-runtime", label: "候选验收模型", status: "ready", keyConfigured: true, defaultModel: "recorded-runtime-model", reason: "候选验收已就绪", checkedAt: new Date().toISOString() };
  },
  async invoke() {
    throw new Error("Candidate verification must not invoke the model");
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4330, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Trace 候选 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();

  const casePanel = page.locator(".benchmark-case-list-panel");
  await casePanel.getByText("100", { exact: true }).waitFor();
  const search = casePanel.getByLabel("搜索测试用例");
  await search.fill("规模回归 073");
  await casePanel.getByText("规模回归 073", { exact: true }).waitFor();
  if (await casePanel.locator(".benchmark-case-list > button").count() !== 1) throw new Error("Hundred-case search did not narrow to one result");
  await search.fill("");

  await page.getByTitle("从运行生成测试用例").click();
  const candidateDialog = page.getByRole("dialog", { name: "从运行生成测试用例" });
  await candidateDialog.getByText("已完成", { exact: true }).waitFor();
  await candidateDialog.getByText("2 步", { exact: false }).waitFor();
  await candidateDialog.getByRole("button", { name: "生成候选", exact: true }).click();

  await page.getByText("从运行观察生成", { exact: true }).waitFor();
  await page.getByText("观察结果，不是自动认定的正确答案", { exact: false }).waitFor();
  await page.getByLabel("测试用例标题").fill("运行回归 101");
  await page.getByLabel("测试用例状态").selectOption("ready");
  if (!(await page.getByLabel("用例初始变量").inputValue()).includes("trace-candidate-101")) throw new Error("Frozen run input was not copied into candidate");
  if ((await page.getByLabel("期望路径节点").inputValue()).trim() !== "flow.start\nflow.core-step\nflow.end") throw new Error("Observed Trace path was not copied into candidate");
  if (await page.getByLabel("期望终态", { exact: true }).inputValue() !== "completed") throw new Error("Observed terminal status was not copied into candidate");
  await page.getByText("校验通过", { exact: true }).waitFor();
  await page.getByRole("button", { name: "预览并保存用例", exact: true }).click();
  const changeDialog = page.getByRole("dialog", { name: "确认测试用例变更" });
  await changeDialog.getByText("创建测试用例 运行回归 101", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "runtime-benchmark-candidate-preview.png"), fullPage: true });
  await changeDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await changeDialog.waitFor({ state: "hidden" });
  await casePanel.getByText("101", { exact: true }).waitFor();
  await casePanel.getByText("运行回归 101", { exact: true }).waitFor();
  const desktopScaleMetrics = await page.evaluate(() => {
    const panel = document.querySelector(".benchmark-case-list-panel");
    const list = document.querySelector(".benchmark-case-list");
    const editor = document.querySelector(".benchmark-editor");
    const panelRect = panel?.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      panelTop: panelRect?.top ?? 0,
      panelBottom: panelRect?.bottom ?? 0,
      listClientHeight: list?.clientHeight ?? 0,
      listScrollHeight: list?.scrollHeight ?? 0,
      editorClientHeight: editor?.clientHeight ?? 0,
      editorScrollHeight: editor?.scrollHeight ?? 0
    };
  });
  if (desktopScaleMetrics.panelBottom > desktopScaleMetrics.viewportHeight + 1 || desktopScaleMetrics.listScrollHeight <= desktopScaleMetrics.listClientHeight) {
    throw new Error(`Hundred-case sidebar is not independently scrollable: ${JSON.stringify(desktopScaleMetrics)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "runtime-benchmark-candidate-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await search.fill("运行回归 101");
  await casePanel.getByText("1/101", { exact: true }).waitFor();
  await casePanel.getByText("运行回归 101", { exact: true }).waitFor();
  const mobileMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile candidate overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "runtime-benchmark-candidate-mobile.png"), fullPage: true });

  const entries = await store.listBenchmarkCases(member.projectId);
  const createdEntry = entries.find((entry) => entry.title === "运行回归 101");
  if (!createdEntry) throw new Error("Confirmed runtime candidate was not persisted");
  const createdCase = await store.readBenchmarkCase(member.projectId, createdEntry.caseId);
  const serialized = JSON.stringify(createdCase.case);
  const verification = {
    projectId: member.projectId,
    sourceRunId: started.run.runId,
    sourceArtifactId: started.run.artifactId,
    totalCases: entries.length,
    createdCase: createdCase.case,
    privateIdentityLeaked: serialized.includes(started.run.runId) || serialized.includes(started.run.artifactId),
    desktopScaleMetrics,
    mobileMetrics,
    consoleErrors,
    failedResponses
  };
  if (verification.totalCases !== 101 || verification.privateIdentityLeaked || createdCase.case.status !== "ready") throw new Error(`Unexpected candidate result: ${JSON.stringify(verification)}`);
  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  await writeFile(path.join(artifactDir, "runtime-benchmark-candidate-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify({ totalCases: verification.totalCases, createdCaseId: createdEntry.caseId, privateIdentityLeaked: verification.privateIdentityLeaked, desktopScaleMetrics, mobileMetrics, consoleErrors, failedResponses }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
