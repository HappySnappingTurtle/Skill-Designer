import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { defaultSandboxPolicy } from "../packages/engine/dist/index.js";
import { BenchmarkRunnerService } from "../packages/server/dist/benchmark-runner.js";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-benchmark-deep-comparison-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/benchmark-deep-comparison");
const baseUrl = "http://127.0.0.1:4351";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Benchmark 深度对比 Chrome 验收" });
const detail = await store.createManagedSkill(workspace.workspaceId, { name: "修复前后对比流程", capability: "workflow" });
const member = detail.members[0];
if (!member) throw new Error("Managed Skill was not created");

const parentRunId = "benchmark-run-11111111-1111-4111-8111-111111111111";
const childRunId = "benchmark-run-22222222-2222-4222-8222-222222222222";
const caseId = "case-33333333-3333-4333-8333-333333333333";
const parent = benchmarkRun({
  benchmarkRunId: parentRunId,
  workspaceId: workspace.workspaceId,
  projectId: member.projectId,
  skillId: member.skillId,
  caseId,
  automaticVerdict: "failed",
  artifactId: "artifact-11111111-1111-4111-8111-111111111111",
  revision: "rev-before-fix",
  contentHash: "sha256:before-fix",
  usage: { inputTokens: 90, outputTokens: 24, totalTokens: 114, cachedInputTokens: 8, reasoningTokens: 7, cacheWriteTokens: 0 },
  modelCallCount: 2,
  events: [
    event(1, "benchmark.queued"),
    event(2, "engine.enter", "flow.start"),
    event(3, "engine.enter", "flow.core-step"),
    event(4, "engine.reject", "flow.core-step"),
    event(5, "model.response", "flow.core-step"),
    event(6, "assertion.result"),
    event(7, "assertion.result"),
    event(8, "benchmark.completed")
  ],
  assertions: [
    { assertionId: "path", kind: "path", status: "fail", message: "路径没有到达完成节点", expected: ["flow.start", "flow.core-step", "flow.end"], actual: ["flow.start", "flow.core-step"] },
    { assertionId: "terminal", kind: "terminal", status: "fail", message: "终态没有完成", expected: { status: "completed", nodeId: "flow.end" }, actual: { status: "stopped", nodeId: "flow.core-step" } },
    { assertionId: "obsolete-check", kind: "variable", status: "inconclusive", message: "旧变量没有证据" }
  ],
  humanReviews: [{ reviewId: "benchmark-review-11111111-1111-4111-8111-111111111111", verdict: "failed", note: "修复前确认失败", createdAt: "2026-07-30T10:00:30.000Z" }],
  createdAt: "2026-07-30T10:00:00.000Z",
  completedAt: "2026-07-30T10:00:30.000Z"
});
const child = benchmarkRun({
  benchmarkRunId: childRunId,
  workspaceId: workspace.workspaceId,
  projectId: member.projectId,
  skillId: member.skillId,
  caseId,
  automaticVerdict: "passed",
  artifactId: "artifact-22222222-2222-4222-8222-222222222222",
  revision: "rev-after-fix",
  contentHash: "sha256:after-fix",
  usage: { inputTokens: 76, outputTokens: 18, totalTokens: 94, cachedInputTokens: 26, reasoningTokens: 3, cacheWriteTokens: 4 },
  modelCallCount: 3,
  events: [
    event(1, "benchmark.queued"),
    event(2, "engine.enter", "flow.start"),
    event(3, "engine.enter", "flow.core-step"),
    event(4, "engine.enter", "flow.end"),
    event(5, "model.response", "flow.end"),
    event(6, "model.response", "flow.end"),
    event(7, "assertion.result"),
    event(8, "assertion.result"),
    event(9, "assertion.result"),
    event(10, "benchmark.completed")
  ],
  assertions: [
    { assertionId: "path", kind: "path", status: "pass", message: "节点路径符合预期", expected: ["flow.start", "flow.core-step", "flow.end"], actual: ["flow.start", "flow.core-step", "flow.end"] },
    { assertionId: "terminal", kind: "terminal", status: "pass", message: "终态符合预期", expected: { status: "completed", nodeId: "flow.end" }, actual: { status: "completed", nodeId: "flow.end" } },
    { assertionId: "result-variable", kind: "variable", status: "pass", message: "结果变量符合预期", expected: "done", actual: "done" }
  ],
  humanReviews: [{ reviewId: "benchmark-review-22222222-2222-4222-8222-222222222222", verdict: "passed", note: "修复后人工确认通过", createdAt: "2026-07-30T10:05:35.000Z" }],
  lineage: {
    parentBenchmarkRunId: parentRunId,
    relation: "post-repair",
    repairId: "repair-44444444-4444-4444-8444-444444444444",
    changeSetId: "changeset-55555555-5555-4555-8555-555555555555",
    appliedRevision: "rev-after-fix"
  },
  createdAt: "2026-07-30T10:05:00.000Z",
  completedAt: "2026-07-30T10:05:35.000Z"
});

const benchmarkRoot = path.join(dataRoot, "benchmark");
const runDir = path.join(benchmarkRoot, "runs", member.projectId);
await mkdir(runDir, { recursive: true });
await Promise.all([
  writeFile(path.join(runDir, `${parentRunId}.json`), `${JSON.stringify(parent, null, 2)}\n`),
  writeFile(path.join(runDir, `${childRunId}.json`), `${JSON.stringify(child, null, 2)}\n`)
]);

const sandboxCapabilities = { probe: async () => ({
  schemaVersion: "1.0",
  platform: "macos",
  arch: process.arch,
  status: "unavailable",
  readyForBenchmark: false,
  policy: defaultSandboxPolicy(),
  backends: [],
  checkedAt: new Date().toISOString()
}) };
const provider = {
  async probe() {
    return { schemaVersion: "1.0", providerId: "comparison-fixture", label: "对比记录 Provider", status: "ready", keyConfigured: true, defaultModel: "comparison-model", reason: "仅加载已持久化记录", checkedAt: new Date().toISOString() };
  },
  async invoke() { throw new Error("Comparison verification must not invoke a model"); }
};
const benchmarkRunner = new BenchmarkRunnerService({ dataRoot: benchmarkRoot, store, sandboxCapabilities, provider });
await benchmarkRunner.initialize();
const server = createApp({ store, benchmarkRunner, sandboxCapabilities, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4351, "127.0.0.1", resolve));

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(30_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Benchmark 深度对比 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "真实测试", exact: true }).click();

  const runList = page.locator(".benchmark-run-list");
  await runList.locator("button").filter({ hasText: /111111/u }).click();
  if (await page.getByTestId("benchmark-comparison").count()) throw new Error("Parent run unexpectedly displayed a child comparison");
  await runList.locator("button").filter({ hasText: /222222/u }).click();

  const comparison = page.getByTestId("benchmark-comparison");
  await comparison.getByText("关联运行深度对比", { exact: true }).waitFor();
  await comparison.getByText("修复前后", { exact: true }).waitFor();
  await comparison.getByText("已完成 -> 已完成", { exact: true }).waitFor();
  await comparison.getByText("失败 -> 通过", { exact: true }).first().waitFor();
  await comparison.getByText("失败 -> 成功", { exact: true }).waitFor();
  await comparison.getByText("不同", { exact: false }).waitFor();
  await comparison.getByText("rev-before-fix", { exact: true }).waitFor();
  await comparison.getByText("rev-after-fix", { exact: true }).waitFor();
  await comparison.getByText("首个偏差 · 第 3 个节点", { exact: true }).waitFor();
  await comparison.getByText("flow.start -> flow.core-step -> flow.end", { exact: true }).waitFor();

  const assertionRows = comparison.locator(".benchmark-assertion-comparison");
  const pathRow = assertionRows.locator("div.changed").filter({ hasText: "path" });
  await pathRow.getByText("失败", { exact: true }).waitFor();
  await pathRow.getByText("通过", { exact: true }).waitFor();
  await pathRow.getByText("结果变化", { exact: true }).waitFor();
  await assertionRows.getByText("新增", { exact: true }).waitFor();
  await assertionRows.getByText("移除", { exact: true }).waitFor();

  const usage = comparison.locator(".benchmark-usage-comparison");
  await usage.locator("div").filter({ hasText: /^总量11494-20$/u }).waitFor();
  await usage.locator("div").filter({ hasText: /^缓存输入826\+18$/u }).waitFor();
  const events = comparison.locator(".benchmark-event-comparison");
  await events.locator("div").filter({ hasText: /^engine\.enter23\+1$/u }).waitFor();
  await events.locator("div").filter({ hasText: /^model\.response12\+1$/u }).waitFor();
  await comparison.getByText("差异本身不等于根因或修复成功", { exact: false }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "benchmark-deep-comparison-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile Benchmark comparison overflow: ${JSON.stringify(mobileMetrics)}`);
  await comparison.getByText("关联运行深度对比", { exact: true }).waitFor();
  await pathRow.getByText("结果变化", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "benchmark-deep-comparison-mobile.png"), fullPage: true });

  const persistedRuns = await benchmarkRunner.list(member.projectId);
  if (persistedRuns.length !== 2 || persistedRuns[0].benchmarkRunId !== childRunId || persistedRuns[1].benchmarkRunId !== parentRunId) throw new Error("Benchmark persisted lineage records were not loaded in order");
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);
  const verification = {
    browser: "Google Chrome",
    workspaceId: workspace.workspaceId,
    projectId: member.projectId,
    parentRunId,
    childRunId,
    lineage: child.lineage,
    compared: {
      technicalStatus: true,
      automaticVerdict: true,
      humanVerdict: true,
      artifactIdentityRevisionAndHash: true,
      actualPath: true,
      assertionIdentityChanges: true,
      tokenDimensions: true,
      traceEventCounts: true,
      evidenceBoundary: true
    },
    mobileMetrics,
    consoleErrors,
    failedResponses,
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

function benchmarkRun(input) {
  return {
    schemaVersion: "1.0",
    benchmarkRunId: input.benchmarkRunId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    skillId: input.skillId,
    caseId: input.caseId,
    status: "completed",
    automaticVerdict: input.automaticVerdict,
    fingerprint: {
      schemaVersion: "1.0",
      providerId: "comparison-fixture",
      requestedModel: "comparison-model",
      resolvedModels: ["comparison-model-resolved"],
      reasoningEffort: "low",
      promptTemplateVersion: "benchmark-decision/1",
      runnerImage: `comparison/runner@sha256:${"d".repeat(64)}`,
      sandboxBackendId: "docker-desktop",
      sandboxPolicyHash: "sha256:comparison-policy",
      runtimeArtifactId: input.artifactId,
      revision: input.revision,
      contentHash: input.contentHash
    },
    usage: input.usage,
    modelCallCount: input.modelCallCount,
    sandboxHandleIds: ["sandbox-comparison-fixture"],
    events: input.events,
    assertions: input.assertions,
    humanReviews: input.humanReviews,
    ...(input.lineage ? { lineage: input.lineage } : {}),
    createdAt: input.createdAt,
    updatedAt: input.completedAt,
    startedAt: input.createdAt,
    completedAt: input.completedAt
  };
}

function event(seq, type, nodeId) {
  return { seq, at: `2026-07-30T10:00:${String(seq).padStart(2, "0")}.000Z`, type, ...(nodeId ? { nodeId } : {}), data: {} };
}
