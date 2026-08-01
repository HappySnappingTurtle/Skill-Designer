import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { BenchmarkRunnerService } from "../packages/server/dist/benchmark-runner.js";
import { createApp } from "../packages/server/dist/http.js";
import { ModelSettingsService } from "../packages/server/dist/model-settings.js";
import { SandboxControlService } from "../packages/server/dist/sandbox-control.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const skillRoot = "/Users/hongyuwu/IdeaProjects/yds-skills/mdd-backend-extend-develop";
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-real-mdd-benchmark-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/real-skill-mdd-benchmark-preflight");
const baseUrl = "http://127.0.0.1:4350";
const sourceBefore = await hashTree(skillRoot);
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const sandboxControl = new SandboxControlService({ dataRoot: path.join(dataRoot, "sandbox") });
const credentialStore = {
  capability: () => ({ backend: "unavailable", status: "unavailable", label: "隔离验收凭据", reason: "验收不读取宿主凭据" }),
  get: async () => null,
  set: async () => { throw new Error("Benchmark preflight verification does not accept credentials"); },
  delete: async () => {}
};
const provider = new ModelSettingsService({ dataDir: dataRoot, environment: {}, credentialStore });
await provider.initialize();
const benchmarkRunner = new BenchmarkRunnerService({
  dataRoot: path.join(dataRoot, "benchmark"),
  store,
  sandboxCapabilities: sandboxControl,
  provider
});
await benchmarkRunner.initialize();
const importLLMParser = {
  latest: async () => null,
  start: async () => { throw new Error("LLM parsing is outside this verification"); },
  cancel: async () => null
};
const server = createApp({
  store,
  sandboxControl,
  benchmarkRunner,
  modelSettings: provider,
  importLLMParser,
  allowedOrigins: [baseUrl]
});
await new Promise((resolve) => server.listen(4350, "127.0.0.1", resolve));

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(45_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("真实 MDD Skill Benchmark 预检");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "真实 MDD Skill Benchmark 预检" }).waitFor();

  await page.getByRole("button", { name: "导入 Skill", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "导入 Skill 文件夹" });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    importDialog.getByText("选择一个 Skill 文件夹", { exact: true }).click()
  ]);
  await chooser.setFiles(skillRoot);
  await importDialog.getByText(`${sourceBefore.size} 个文件`, { exact: false }).waitFor();
  const [previewResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/workspaces\/[^/]+\/imports$/u.test(new URL(response.url()).pathname)),
    importDialog.getByRole("button", { name: "扫描并预检", exact: true }).click()
  ]);
  const preview = (await previewResponse.json()).data;
  const candidate = preview.candidate;
  await importDialog.getByText("0 待检查", { exact: false }).waitFor();
  await importDialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await importDialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /mdd-backend-extend-develop/u }).waitFor();

  const workspace = await store.getWorkspace(preview.workspace.workspaceId);
  const member = workspace.members.find((item) => item.projectId === candidate.projectId);
  if (!member || member.status !== "ready") throw new Error("Real Skill import did not become ready");
  const graphRecord = await store.getProjectGraph(candidate.projectId);
  const startNode = graphRecord.graph.nodes.find((node) => node.id === graphRecord.graph.entry);
  const endNode = graphRecord.graph.nodes.find((node) => node.kind === "end");
  if (!startNode || !endNode) throw new Error("Real Skill graph is missing an entry or end node");
  const expectedPath = sequentialPath(graphRecord.graph, startNode.id, endNode.id);
  if (expectedPath.length !== graphRecord.graph.nodes.length) throw new Error(`Expected the real workflow to cover all nodes: ${expectedPath.length}/${graphRecord.graph.nodes.length}`);

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  await page.getByRole("button", { name: "新建测试用例" }).click();
  await page.getByLabel("测试用例标题").fill("真实 MDD Skill 全路径回归");
  await page.getByLabel("测试用例状态").selectOption("ready");
  await page.getByLabel("测试意图").fill("验证真实 MDD Skill 沿已确认图谱从入口到终点完成全路径执行");
  await page.getByLabel("测试用例标签").fill("real-skill, mdd, full-path");
  await page.getByLabel("用例初始变量").fill("{}");
  await page.getByLabel("预设用户回答").fill("[]");
  await page.getByLabel("期望路径模式").selectOption("exact");
  await page.getByLabel("期望路径节点").fill(expectedPath.join("\n"));
  await page.getByLabel("期望终态", { exact: true }).selectOption("completed");
  await page.getByLabel("期望终态节点", { exact: true }).selectOption(endNode.id);
  await page.getByLabel("禁止副作用").fill("不得修改 Skill 源仓库\n不得访问项目与沙箱授权范围外路径");
  await page.getByText("校验通过", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "benchmark-case-editor-desktop.png"), fullPage: true });

  if ((await store.listBenchmarkCases(candidate.projectId)).length !== 0) throw new Error("Benchmark case was persisted before ChangeSet confirmation");
  await page.getByRole("button", { name: "预览并保存用例" }).click();
  const caseDialog = page.getByRole("dialog", { name: "确认测试用例变更" });
  await caseDialog.getByText("创建测试用例 真实 MDD Skill 全路径回归", { exact: true }).waitFor();
  await caseDialog.getByText(expectedPath[0], { exact: false }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "benchmark-case-changeset-desktop.png"), fullPage: true });
  if ((await store.listBenchmarkCases(candidate.projectId)).length !== 0) throw new Error("Benchmark case was persisted while its ChangeSet was only previewed");
  await caseDialog.getByRole("button", { name: "确认并应用" }).click();
  await caseDialog.waitFor({ state: "hidden" });
  await page.locator(".benchmark-case-list").getByText("真实 MDD Skill 全路径回归", { exact: true }).waitFor();
  const cases = await store.listBenchmarkCases(candidate.projectId);
  if (cases.length !== 1 || cases[0].status !== "ready" || !cases[0].valid) throw new Error(`Confirmed Benchmark case is not ready: ${JSON.stringify(cases)}`);

  await page.getByLabel("查看沙箱能力").click();
  const sandboxDialog = page.getByRole("dialog", { name: "沙箱能力" });
  await sandboxDialog.getByText("当前机器没有可用沙箱", { exact: true }).waitFor();
  await sandboxDialog.locator(".sandbox-backends article").first().getByText("未安装 Docker CLI", { exact: true }).waitFor();
  await page.getByTestId("run-sandbox-self-test").click();
  const selfTest = page.getByTestId("sandbox-self-test");
  await selfTest.getByText("无法运行", { exact: true }).waitFor();
  await selfTest.getByText("未检测到可用的本机 Docker Desktop", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "sandbox-unavailable-desktop.png"), fullPage: true });
  await sandboxDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "真实测试", exact: true }).click();
  const preflight = page.getByTestId("benchmark-preflight");
  await preflight.getByText("OpenAI Responses API", { exact: true }).waitFor();
  await preflight.locator("small").getByText("API Key 未配置", { exact: true }).waitFor();
  await preflight.getByText("真实沙箱未就绪", { exact: true }).waitFor();
  await preflight.getByText("运行将记录为 blocked", { exact: true }).waitFor();
  await preflight.getByText("真实沙箱生命周期自检未通过", { exact: true }).waitFor();
  await preflight.getByText("未配置固定 digest 的 runner 镜像", { exact: true }).waitFor();
  await page.getByLabel("Benchmark 用例").selectOption(cases[0].caseId);
  await page.getByTestId("start-real-benchmark").click();
  await page.locator(".benchmark-run-list .run-status-dot.blocked").waitFor();
  await page.locator(".benchmark-run-failure").getByText("模型 Provider 不可用", { exact: true }).waitFor();
  await page.locator(".benchmark-run-summary").getByText("未运行", { exact: true }).waitFor();
  const summary = page.locator(".benchmark-run-summary");
  if ((await summary.locator("div").filter({ hasText: /^模型调用0$/u }).count()) !== 1) throw new Error("Blocked Benchmark recorded a model call");
  if ((await summary.locator("div").filter({ hasText: /^Token0$/u }).count()) !== 1) throw new Error("Blocked Benchmark recorded token usage");
  await page.locator(".benchmark-fingerprint").getByText("preflight 前阻断，未冻结", { exact: true }).waitFor();
  const reviews = page.getByTestId("benchmark-reviews");
  await reviews.getByText("只有技术执行完成的运行可以人工判定；条件阻断或技术失败不能手工改成通过。", { exact: true }).waitFor();
  if (await page.getByTestId("save-benchmark-review").isEnabled()) throw new Error("Blocked Benchmark allowed a human verdict");
  if (await page.getByLabel("人工判定备注").isEnabled()) throw new Error("Blocked Benchmark enabled the review editor");
  await page.screenshot({ path: path.join(artifactDir, "benchmark-blocked-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile Benchmark overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "benchmark-blocked-mobile.png"), fullPage: true });

  const runs = await benchmarkRunner.list(candidate.projectId);
  if (runs.length !== 1) throw new Error(`Expected one Benchmark run, received ${runs.length}`);
  const run = runs[0];
  if (run.status !== "blocked" || run.automaticVerdict !== "not-run") throw new Error(`Unexpected blocked run status: ${run.status}/${run.automaticVerdict}`);
  if (run.modelCallCount !== 0 || run.usage.totalTokens !== 0) throw new Error("Blocked run consumed model calls or tokens");
  if (run.fingerprint.runtimeArtifactId || run.sandboxHandleIds.length !== 0) throw new Error("Blocked run froze an Artifact or created a sandbox handle");
  const sourceAfter = await hashTree(skillRoot);
  if (!sameTree(sourceBefore, sourceAfter)) throw new Error("Benchmark preflight verification modified the source Skill repository");
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);

  const verification = {
    browser: "Google Chrome",
    platform: `${process.platform}-${process.arch}`,
    source: { root: skillRoot, fileCount: sourceBefore.size, bytesUnchanged: true },
    graph: { nodeCount: graphRecord.graph.nodes.length, edgeCount: graphRecord.graph.edges.length, exactPath: expectedPath },
    benchmarkCase: { caseId: cases[0].caseId, status: cases[0].status, valid: cases[0].valid, confirmedBeforePersistence: true },
    sandbox: { dockerAvailable: false, selfTestStatus: "unavailable", runnerImageConfigured: false },
    benchmarkRun: {
      benchmarkRunId: run.benchmarkRunId,
      status: run.status,
      automaticVerdict: run.automaticVerdict,
      failureCategory: run.failure?.category,
      modelCallCount: run.modelCallCount,
      totalTokens: run.usage.totalTokens,
      runtimeArtifactFrozen: Boolean(run.fingerprint.runtimeArtifactId),
      sandboxHandleCount: run.sandboxHandleIds.length,
      humanReviewEnabled: false
    },
    mobileMetrics,
    consoleErrors,
    failedResponses,
    scope: "BenchmarkCase confirmation and real environment preflight only; no sandboxed model Benchmark executed",
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

function sequentialPath(graph, startNodeId, endNodeId) {
  const result = [startNodeId];
  const seen = new Set(result);
  let current = startNodeId;
  while (current !== endNodeId) {
    const outgoing = graph.edges.filter((edge) => edge.from === current && edge.kind !== "knowledge");
    if (outgoing.length !== 1) throw new Error(`Expected one sequential exit from ${current}, received ${outgoing.length}`);
    current = outgoing[0].to;
    if (seen.has(current)) throw new Error(`Sequential graph contains a cycle at ${current}`);
    seen.add(current);
    result.push(current);
  }
  return result;
}

async function hashTree(root) {
  const result = new Map();
  async function walk(relative = "") {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.set(next, createHash("sha256").update(await readFile(path.join(root, next))).digest("hex"));
      else throw new Error(`Unsupported source entry: ${next}`);
    }
  }
  await walk();
  return result;
}

function sameTree(left, right) {
  return left.size === right.size && [...left].every(([file, digest]) => right.get(file) === digest);
}
