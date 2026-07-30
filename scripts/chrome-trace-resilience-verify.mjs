import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import WebSocket from "ws";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-trace-resilience-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4332";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Trace 韧性 Chrome 验收" });
const skills = [];
for (const name of ["并行流程 Alpha", "并行流程 Beta", "并行流程 Gamma"]) {
  const detail = await store.createManagedSkill(workspace.workspaceId, { name, capability: "workflow", description: `${name} 的独立实时流` });
  const member = detail.members.find((item) => item.displayName === name);
  if (!member) throw new Error(`Missing managed Skill ${name}`);
  const view = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { stream: name } });
  skills.push({ name, member, runId: view.run.runId });
}
await store.selectProject(workspace.workspaceId, skills[0].member.projectId);

const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataRoot, "runtime-dialog"),
  store,
  provider: {
    probe: async () => ({ schemaVersion: "1.0", providerId: "trace-verification", label: "Trace 验收模型", status: "ready", keyConfigured: true, defaultModel: "trace-verification", reason: "ready", checkedAt: new Date().toISOString() }),
    invoke: async () => { throw new Error("Trace 韧性验收不调用模型"); }
  }
});
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4332, "127.0.0.1", resolve));
const session = await fetch(`${baseUrl}/api/session`, { headers: { Origin: baseUrl } }).then((response) => response.json());
const token = session.data.token;
const streams = await Promise.all(skills.map((skill) => openTraceSocket(skill.member.projectId, skill.runId, token)));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Trace 韧性 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();
  await page.locator(".runtime-summary").getByText("运行中", { exact: true }).waitFor();
  const beforeSeq = await page.locator(".runtime-events li").count();

  await context.setOffline(true);
  await page.waitForTimeout(1_000);
  for (let cycle = 0; cycle < 5; cycle++) {
    await Promise.all(skills.map((skill) => store.commandRun(skill.member.projectId, skill.runId, "pause")));
    await Promise.all(skills.map((skill) => store.commandRun(skill.member.projectId, skill.runId, "resume")));
  }
  await Promise.all(skills.map((skill) => store.commandRun(skill.member.projectId, skill.runId, "next", { nextNodeId: "flow.core-step" })));
  await Promise.all(skills.map((skill) => store.commandRun(skill.member.projectId, skill.runId, "next", { nextNodeId: "flow.end" })));
  const disconnectedFacts = await Promise.all(skills.map((skill) => store.getTraceEvents(skill.member.projectId, skill.runId, 2)));
  if (disconnectedFacts.some((trace) => trace.latestSeq !== 15 || trace.projection.status !== "completed")) {
    throw new Error(`Unexpected disconnected Trace facts: ${JSON.stringify(disconnectedFacts.map((trace) => ({ latestSeq: trace.latestSeq, status: trace.projection.status })))}`);
  }

  await context.setOffline(false);
  await page.locator(".runtime-summary").getByText("已完成", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("heading", { name: "完成", exact: true }).waitFor();
  await page.locator(".trace-flow-node.completed").filter({ hasText: "完成" }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "trace-disconnect-recovered-desktop.png"), fullPage: true });

  for (const skill of skills.slice(1)) {
    await page.getByRole("button", { name: "工作区", exact: true }).click();
    await page.getByRole("cell", { name: new RegExp(skill.name) }).click();
    await page.getByRole("button", { name: "测试", exact: true }).click();
    await page.locator(".test-title").getByText(skill.name, { exact: true }).waitFor();
    await page.locator(".runtime-summary").getByText("已完成", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "完成", exact: true }).waitFor();
  }

  await Promise.all(streams.map((stream) => waitFor(() => stream.messages.some((message) => message.data?.latestSeq === 15), 5_000)));
  const streamFacts = streams.map((stream, index) => {
    const expected = skills[index];
    const events = stream.messages.flatMap((message) => message.data?.events ?? []);
    const unique = new Map(events.map((event) => [event.seq, event]));
    const seqs = [...unique.keys()].sort((left, right) => left - right);
    if (JSON.stringify(seqs) !== JSON.stringify(Array.from({ length: 13 }, (_, offset) => offset + 3))) throw new Error(`${expected.name} sequence gap: ${JSON.stringify(seqs)}`);
    if ([...unique.values()].some((event) => event.projectId !== expected.member.projectId || event.skillId !== expected.member.skillId || event.runId !== expected.runId)) throw new Error(`${expected.name} received a foreign Trace event`);
    return { name: expected.name, projectId: expected.member.projectId, skillId: expected.member.skillId, runId: expected.runId, seqs };
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile Trace overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "trace-resilience-mobile.png"), fullPage: true });

  const expectedTransportErrors = consoleErrors.filter((message) => /WebSocket|ERR_INTERNET_DISCONNECTED|network error/iu.test(message));
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !expectedTransportErrors.includes(message));
  const verification = {
    beforeSeq,
    recoveredLatestSeq: disconnectedFacts[0].latestSeq,
    recoveredStatus: disconnectedFacts[0].projection.status,
    streamFacts,
    mobileMetrics,
    expectedTransportErrors,
    unexpectedConsoleErrors,
    failedResponses
  };
  if (unexpectedConsoleErrors.length || failedResponses.length) throw new Error(`Unexpected browser failures:\n${[...unexpectedConsoleErrors, ...failedResponses].join("\n")}`);
  await writeFile(path.join(artifactDir, "trace-resilience-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
} finally {
  for (const stream of streams) stream.socket.close(1000);
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function openTraceSocket(projectId, runId, token) {
  const messages = [];
  const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/projects/${projectId}/traces/${runId}/stream?afterSeq=2`, ["skill-designer.trace.v1", token], { headers: { Origin: baseUrl } });
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for Trace stream");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
