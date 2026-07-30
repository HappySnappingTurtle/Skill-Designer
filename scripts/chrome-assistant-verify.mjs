import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { DesignAssistantService } from "../packages/server/dist/design-assistant.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-assistant-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4322";
await mkdir(artifactDir, { recursive: true });
const store = new WorkspaceStore({ dataDir: dataRoot });
await store.initialize();
const provider = {
  async probe() {
    return { schemaVersion: "1.0", providerId: "recorded-assistant", label: "验收设计模型", status: "ready", keyConfigured: true, defaultModel: "recorded-model", reason: "页面协议验收已就绪", checkedAt: new Date().toISOString() };
  },
  async invoke(request, signal) {
    const userRequest = request.input.request;
    if (userRequest.includes("取消这次生成")) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("模型调用已取消"), { name: "AbortError" }));
        }, { once: true });
      });
    }
    const isBenchmarkCase = userRequest.includes("测试用例");
    const target = request.input.target;
    const caseId = "case-77777777-7777-4777-8777-777777777777";
    return {
      providerId: "recorded-assistant",
      responseId: isBenchmarkCase ? "recorded-response-case" : "recorded-response-graph",
      model: "recorded-model-1",
      output: isBenchmarkCase ? {
        action: "propose",
        reply: "已生成核心流程回归测试用例提案；确认前不会写入项目。",
        evidence: [{ source: "schema", ref: "schema:benchmark-case", fact: "项目支持版本化 BenchmarkCase 结构" }],
        operations: [{
          op: "benchmark.case.write",
          target: caseId,
          valueJson: JSON.stringify({
            schemaVersion: "1.0",
            caseId,
            skillId: target.skillId,
            title: "核心流程回归",
            status: "ready",
            intent: "验证需求澄清后的核心流程可以完成",
            fixture: { initialVariables: {}, userReplies: [] },
            expected: {
              path: { mode: "exact", nodeIds: ["flow.start", "flow.core-step", "flow.end"] },
              terminal: { status: "completed", nodeId: "flow.end" },
              variables: {},
              artifacts: [],
              toolResults: [],
              forbiddenEffects: []
            },
            tags: ["assistant", "regression"],
            notes: "由设计助手生成，需用户确认后进入项目。"
          })
        }]
      } : {
        action: "propose",
        reply: "已根据当前图生成核心步骤重命名提案；确认前不会修改项目。",
        evidence: [{ source: "graph", ref: "flow.core-step", fact: "当前图中存在标题为核心步骤的 step 节点" }],
        operations: [{ op: "graph.node.update", target: "flow.core-step", valueJson: JSON.stringify({ id: "flow.core-step", kind: "step", title: "需求澄清", description: "整理并确认用户需求" }) }]
      },
      usage: { inputTokens: 22, outputTokens: 8, totalTokens: 30, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      durationMs: 35
    };
  }
};
const assistant = new DesignAssistantService({ dataRoot: path.join(dataRoot, "assistant"), store, provider });
await assistant.initialize();
const server = createApp({ store, designAssistant: assistant, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4322, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
const verification = {
  browser: "Google Chrome",
  viewport: { width: 1440, height: 960 },
  assistantGraphProposal: {},
  assistantBenchmarkProposal: {},
  confirmationBoundary: {},
  mobile: {}
};
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("助手 Chrome 验收");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "助手 Chrome 验收" }).waitFor();

  await page.getByRole("button", { name: "添加 Skill" }).first().click();
  await page.getByLabel("Skill 名称").fill("需求设计流程");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("cell", { name: /需求设计流程/u }).waitFor();
  await page.getByRole("button", { name: "添加 Skill" }).first().click();
  await page.getByLabel("Skill 名称").fill("旁路流程");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("cell", { name: /旁路流程/u }).waitFor();
  await page.getByRole("cell", { name: /需求设计流程/u }).click();

  await page.getByRole("button", { name: "设计助手", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "设计助手" });
  await drawer.getByText("验收设计模型", { exact: true }).waitFor();
  await drawer.getByText("会话将锁定当前 Skill", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "开始设计", exact: true }).click();
  await drawer.getByTestId("assistant-target").getByText("需求设计流程", { exact: true }).waitFor();
  await drawer.getByLabel("设计需求").fill("把核心步骤改名为需求澄清，并补充说明。");
  await drawer.getByRole("button", { name: "发送", exact: true }).click();
  const proposal = drawer.getByTestId("assistant-proposal");
  await proposal.getByText("等待确认", { exact: true }).waitFor();
  await proposal.locator(".assistant-change-preview").getByText("flow.core-step", { exact: true }).waitFor();
  const metadata = proposal.getByTestId("changeset-metadata");
  await metadata.getByText("设计助手", { exact: true }).waitFor();
  await metadata.getByText("用户请求", { exact: true }).waitFor();
  await metadata.getByText("图谱事实", { exact: true }).waitFor();
  await metadata.getByText("把核心步骤改名为需求澄清，并补充说明。", { exact: true }).waitFor();
  await metadata.getByText("当前图中存在标题为核心步骤的 step 节点", { exact: true }).waitFor();
  const assistantSourceId = await metadata.locator("header code").getAttribute("title");
  if (!assistantSourceId?.startsWith("assistant-session-")) throw new Error(`Assistant sourceId was not rendered: ${assistantSourceId}`);
  verification.assistantGraphProposal = { source: "assistant", sourceId: assistantSourceId, evidenceKinds: ["user-request", "graph"], visibleBeforeConfirmation: true };
  await drawer.getByText("依据 1", { exact: true }).click();
  await drawer.getByLabel("设计助手消息").getByText("当前图中存在标题为核心步骤的 step 节点", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "design-assistant-proposal-desktop.png"), fullPage: true });

  await drawer.getByTitle("关闭").click();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  const graphSearch = page.getByLabel("搜索图节点");
  await graphSearch.fill("核心步骤");
  await graphSearch.press("Enter");
  await page.locator(".graph-inspector").getByText("核心步骤", { exact: true }).first().waitFor();
  if ((await store.getProjectGraph((await assistant.getSession(assistantSourceId)).projectId)).graph.nodes.find((node) => node.id === "flow.core-step")?.title !== "核心步骤") throw new Error("Assistant proposal modified the graph before confirmation");
  verification.confirmationBoundary.graphUnchangedBeforeConfirmation = true;

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "设计助手", exact: true }).click();
  await drawer.getByTestId("assistant-proposal").getByRole("button", { name: "确认并应用", exact: true }).click();
  await drawer.getByTestId("assistant-proposal").getByText("已应用", { exact: true }).waitFor();
  await drawer.getByTitle("关闭").click();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await graphSearch.fill("需求澄清");
  await graphSearch.press("Enter");
  await page.locator(".graph-inspector").getByText("需求澄清", { exact: true }).first().waitFor();
  if ((await store.getProjectGraph((await assistant.getSession(assistantSourceId)).projectId)).graph.nodes.find((node) => node.id === "flow.core-step")?.title !== "需求澄清") throw new Error("Assistant proposal was not applied after confirmation");
  verification.confirmationBoundary.graphAppliedAfterConfirmation = true;
  await page.screenshot({ path: path.join(artifactDir, "design-assistant-applied-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "助手 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "设计助手", exact: true }).click();
  await drawer.getByLabel("设计助手历史会话").waitFor();
  await drawer.getByText("已根据当前图生成核心步骤重命名提案；确认前不会修改项目。", { exact: true }).waitFor();
  await drawer.getByTestId("assistant-proposal").getByText("已应用", { exact: true }).waitFor();

  await drawer.getByLabel("设计需求").fill("创建一个核心流程回归测试用例，验证从开始到结束的精确路径。");
  await drawer.getByRole("button", { name: "发送", exact: true }).click();
  await drawer.getByTestId("assistant-proposal").getByText("等待确认", { exact: true }).waitFor();
  await drawer.getByTestId("assistant-proposal").locator("pre").filter({ hasText: "核心流程回归" }).waitFor();
  const benchmarkMetadata = drawer.getByTestId("assistant-proposal").getByTestId("changeset-metadata");
  await benchmarkMetadata.getByText("设计助手", { exact: true }).waitFor();
  await benchmarkMetadata.getByText("用户请求", { exact: true }).waitFor();
  await benchmarkMetadata.getByText("项目事实", { exact: true }).waitFor();
  await benchmarkMetadata.getByText("项目支持版本化 BenchmarkCase 结构", { exact: true }).waitFor();
  verification.assistantBenchmarkProposal = { source: "assistant", evidenceKinds: ["user-request", "project-fact"], visibleBeforeConfirmation: true };
  await drawer.getByTitle("关闭").click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  await page.getByText("项目用例", { exact: true }).waitFor();
  if (await page.locator(".benchmark-case-list button").count()) throw new Error("Assistant BenchmarkCase proposal modified the project before confirmation");
  verification.confirmationBoundary.benchmarkUnchangedBeforeConfirmation = true;

  await page.getByRole("button", { name: "设计助手", exact: true }).click();
  await drawer.getByTestId("assistant-proposal").getByRole("button", { name: "确认并应用", exact: true }).click();
  await drawer.getByTestId("assistant-proposal").getByText("已应用", { exact: true }).waitFor();
  await drawer.getByTitle("关闭").click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  await page.getByRole("button", { name: /核心流程回归/u }).waitFor();
  verification.confirmationBoundary.benchmarkAppliedAfterConfirmation = true;

  await page.getByRole("button", { name: "设计助手", exact: true }).click();
  await drawer.getByLabel("设计需求").fill("取消这次生成，不要形成任何修改提案。");
  await drawer.getByRole("button", { name: "发送", exact: true }).click();
  await drawer.getByRole("button", { name: "停止生成", exact: true }).waitFor();
  await drawer.getByRole("button", { name: "停止生成", exact: true }).click();
  await drawer.getByText("已取消本次生成，未创建或应用 ChangeSet。", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "发送", exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "design-assistant-restored-cancelled-desktop.png"), fullPage: true });

  await drawer.getByTitle("关闭").click();
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("cell", { name: /旁路流程/u }).click();
  await page.getByRole("button", { name: "设计助手", exact: true }).click();
  await drawer.getByText(/当前页面已切换到 旁路流程，本会话仍锁定 需求设计流程/u).waitFor();
  await drawer.getByTestId("assistant-target").getByRole("button", { name: "为当前 Skill 新建会话", exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (overflow.document > overflow.viewport) throw new Error(`Mobile assistant horizontal overflow: ${overflow.document}px > ${overflow.viewport}px`);
  verification.mobile = { viewportWidth: overflow.viewport, documentWidth: overflow.document, noHorizontalOverflow: true };
  await page.screenshot({ path: path.join(artifactDir, "design-assistant-target-lock-mobile.png"), fullPage: true });
  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  verification.consoleErrors = consoleErrors;
  verification.failedResponses = failedResponses;
  verification.completedAt = new Date().toISOString();
  await writeFile(path.join(artifactDir, "changeset-attribution-verification.json"), JSON.stringify(verification, null, 2));
  console.log("Chrome design assistant verified: provider state, project-locked session, evidence, proposal-only graph and BenchmarkCase ChangeSets, explicit apply, reload recovery, in-flight cancellation, target lock after Skill switch, and mobile layout.");
  console.log(`Proposal screenshot: ${path.join(artifactDir, "design-assistant-proposal-desktop.png")}`);
  console.log(`Target-lock mobile screenshot: ${path.join(artifactDir, "design-assistant-target-lock-mobile.png")}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
