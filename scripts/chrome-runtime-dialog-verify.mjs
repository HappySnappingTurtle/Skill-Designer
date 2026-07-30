import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-runtime-dialog-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4324";
await mkdir(artifactDir, { recursive: true });
const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
let cancelAttempts = 0;
const provider = {
  async probe() {
    return { schemaVersion: "1.0", providerId: "recorded-runtime", label: "验收运行模型", status: "ready", keyConfigured: true, defaultModel: "recorded-runtime-model", reason: "页面协议验收已就绪", checkedAt: new Date().toISOString() };
  },
  async invoke(request, signal) {
    const input = request.input;
    if (input.userMessage.includes("取消") && ++cancelAttempts === 1) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("模型调用已取消"), { name: "AbortError" })); }, { once: true });
      });
    }
    const output = input.userMessage.includes("取消")
      ? { action: "reply", reply: "重试已完成，保持当前节点。", nextNodeId: null, summary: "重试后保持节点" }
      : input.userMessage.includes("非法")
      ? { action: "advance", reply: "我尝试进入一个未声明的节点。", nextNodeId: "flow.missing", summary: "提交未声明节点" }
      : input.userMessage.includes("完成")
        ? { action: "advance", reply: "提交完成节点。", nextNodeId: "flow.end", summary: "完成流程" }
        : { action: "advance", reply: "已提交核心步骤，由引擎决定是否允许。", nextNodeId: "flow.core-step", summary: "进入核心步骤" };
    return {
      providerId: "recorded-runtime",
      responseId: `runtime-${Date.now()}`,
      model: "recorded-runtime-model-1",
      output,
      usage: { inputTokens: 24, outputTokens: 8, totalTokens: 32, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 38
    };
  }
};
const runtimeDebug = new RuntimeDebugService({ dataRoot: path.join(dataRoot, "runtime-dialog"), store, provider });
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4324, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("运行对话 Chrome 验收");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "运行对话 Chrome 验收" }).waitFor();

  await page.getByRole("button", { name: "添加 Skill" }).first().click();
  await page.getByLabel("Skill 名称").fill("客户需求调试流程");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("cell", { name: /客户需求调试流程/u }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "手动运行", exact: true }).waitFor();
  await page.getByRole("button", { name: "启动运行", exact: true }).click();
  const runDialog = page.getByRole("dialog", { name: "新建运行" });
  await runDialog.getByRole("button", { name: "启动", exact: true }).click();

  const modelDialog = page.getByLabel("模型运行对话");
  await modelDialog.getByText("模型调试", { exact: true }).waitFor();
  await modelDialog.getByLabel("运行对话消息").fill("合法推进到核心步骤");
  await modelDialog.getByTitle("发送消息").click();
  await modelDialog.getByText("已提交核心步骤，由引擎决定是否允许。", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "核心步骤", exact: true }).waitFor();
  await modelDialog.getByText("32 token", { exact: false }).waitFor();

  await modelDialog.getByLabel("运行对话消息").fill("尝试非法节点");
  await modelDialog.getByTitle("发送消息").click();
  await modelDialog.getByText(/引擎拒绝了下一节点 flow\.missing/u).waitFor();
  await page.getByRole("heading", { name: "核心步骤", exact: true }).waitFor();
  await modelDialog.getByText("引擎已拒绝", { exact: false }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "runtime-dialog-rejected-desktop.png"), fullPage: true });

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("heading", { name: "核心步骤", exact: true }).waitFor();
  const restored = page.getByLabel("模型运行对话");
  await restored.getByText(/引擎拒绝了下一节点 flow\.missing/u).waitFor();

  await restored.getByLabel("运行对话消息").fill("取消这次模型生成");
  await restored.getByTitle("发送消息").click();
  await restored.getByTitle("停止模型生成").waitFor();
  await restored.getByTitle("停止模型生成").click();
  await restored.getByText("模型调用已取消", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "核心步骤", exact: true }).waitFor();
  await restored.getByRole("button", { name: "重试", exact: true }).click();
  await restored.getByText("重试已完成，保持当前节点。", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "核心步骤", exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile runtime dialog overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "runtime-dialog-mobile.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 960 });
  await restored.getByLabel("运行对话消息").fill("完成流程");
  await restored.getByTitle("发送消息").click();
  await restored.getByText("提交完成节点。", { exact: true }).waitFor();
  await page.getByText("已完成", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "生成报告", exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "runtime-dialog-completed-desktop.png"), fullPage: true });

  const verification = await page.evaluate(async () => {
    const token = (await (await fetch("/api/session")).json()).data.token;
    const headers = { "x-skill-designer-token": token };
    const workspaces = (await (await fetch("/api/workspaces", { headers })).json()).data;
    const workspace = (await (await fetch(`/api/workspaces/${workspaces[0].workspaceId}`, { headers })).json()).data;
    const projectId = workspace.members[0].projectId;
    const runs = (await (await fetch(`/api/projects/${projectId}/runs`, { headers })).json()).data;
    const run = runs[0];
    const trace = (await (await fetch(`/api/projects/${projectId}/traces/${run.runId}/events?afterSeq=0`, { headers })).json()).data;
    return { projectId, runId: run.runId, status: run.state.status, currentNodeId: run.state.currentNodeId, step: run.state.step, eventTypes: trace.events.map((event) => event.type), latestSeq: trace.latestSeq };
  });
  if (verification.status !== "completed" || verification.currentNodeId !== "flow.end" || verification.step !== 2) throw new Error(`Unexpected final run: ${JSON.stringify(verification)}`);
  if (!verification.eventTypes.includes("engine.reject") || !verification.eventTypes.includes("llm.error")) throw new Error(`Missing rejection/cancellation Trace: ${JSON.stringify(verification)}`);
  await writeFile(path.join(artifactDir, "runtime-dialog-verification.json"), JSON.stringify({ verification, mobileMetrics, consoleErrors, failedResponses }, null, 2) + "\n");
  console.log(JSON.stringify({ verification, mobileMetrics, consoleErrors, failedResponses }, null, 2));
  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
