import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { RuntimeDebugService } from "../packages/server/dist/runtime-debug.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-context-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4339";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "声明上下文 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "声明上下文流程", capability: "workflow" });
const member = created.members[0];
const initial = await store.getProjectGraph(member.projectId);
const documentProposal = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: initial.activeRevision,
  reason: "准备 Chrome 查询文档",
  operations: [{ op: "docs.write", target: "docs/platform.md", value: "# Guide\n\n## Windows\n\n### Retry\n\nWindows content.\n\n## macOS\n\n### Retry\n\nmacOS exact content.\n\n## Support\n\nSupport fallback content.\n" }]
});
await store.confirmAndApplyChangeSet(documentProposal.changeSetId, { digest: documentProposal.digest, baseRevision: documentProposal.baseRevision });

const runtimeDebug = new RuntimeDebugService({
  dataRoot: path.join(dataRoot, "runtime-dialog"),
  store,
  provider: {
    probe: async () => ({ schemaVersion: "1.0", providerId: "context-check", label: "上下文验收模型", status: "ready", keyConfigured: true, defaultModel: "context-check", reason: "ready", checkedAt: new Date().toISOString() }),
    invoke: async (request) => {
      const facts = request.input.projectFacts;
      if (!Array.isArray(facts) || facts.length !== 7) throw new Error("模型没有收到 7 条声明式项目事实");
      return {
        providerId: "context-check", responseId: "context-check-response", model: "context-check",
        output: { action: "reply", reply: "已读取声明式上下文。", nextNodeId: null, summary: "读取上下文" },
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 }, durationMs: 1
      };
    }
  }
});
await runtimeDebug.initialize();
const server = createApp({ store, runtimeDebug, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4339, "127.0.0.1", resolve));

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function addQuery(kind) {
  await page.getByLabel("新增查询类型").selectOption(kind);
  return page.locator(".node-lookup-editor article").last();
}

async function setDocumentQuery(article, queryId, pathValue, anchor, fallback) {
  await article.getByLabel(/查询 \d+ ID/u).fill(queryId);
  const inputs = article.locator('input:not([type="checkbox"])');
  await inputs.nth(1).fill(pathValue);
  await inputs.nth(2).fill(anchor);
  if (fallback) await article.getByRole("checkbox").check();
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "声明上下文 Chrome 验收" }).waitFor();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("声明上下文流程 图谱").waitFor();
  await page.getByLabel("搜索图节点").fill("开始");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "开始", exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑节点", exact: true }).click();

  let article = await addQuery("graph.node");
  await article.getByLabel("查询 1 ID").fill("fact.node");
  await article.locator("select").selectOption("flow.core-step");

  article = await addQuery("graph.neighborhood");
  await article.getByLabel("查询 2 ID").fill("fact.neighborhood");
  await article.locator("select").nth(0).selectOption("flow.start");
  await article.locator("select").nth(1).selectOption("both");

  article = await addQuery("graph.search");
  await article.getByLabel("查询 3 ID").fill("fact.search");
  await article.locator('input:not([type="checkbox"])').nth(1).fill("核心步骤");
  await article.locator('input[type="number"]').fill("5");

  await setDocumentQuery(await addQuery("document.slice"), "doc.exact", "docs/platform.md", "Guide/macOS/Retry", false);
  await setDocumentQuery(await addQuery("document.slice"), "doc.degraded", "docs/platform.md", "Support", true);
  await setDocumentQuery(await addQuery("document.slice"), "doc.ambiguous", "docs/platform.md", "Retry", true);
  await setDocumentQuery(await addQuery("document.slice"), "doc.missing", "docs/missing.md", "Guide", false);

  await page.getByText("形状校验通过（3 节点 / 2 边）", { exact: true }).waitFor();
  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  await page.getByRole("button", { name: "预览并保存图", exact: true }).click();
  const confirmDialog = page.getByRole("dialog", { name: "确认图谱变更" });
  await confirmDialog.getByText("flow.start", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "declarative-context-confirmation.png"), fullPage: true });
  await confirmDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await confirmDialog.waitFor({ state: "hidden" });

  const applied = await store.getProjectGraph(member.projectId);
  const lookup = applied.graph.nodes.find((node) => node.id === "flow.start")?.lookup;
  if (lookup?.length !== 7) throw new Error(`页面未持久化 7 条查询：${lookup?.length ?? 0}`);

  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "启动运行", exact: true }).click();
  await page.getByRole("dialog", { name: "新建运行" }).getByRole("button", { name: "启动", exact: true }).click();
  await page.getByRole("heading", { name: "开始", exact: true }).waitFor();
  const facts = page.locator(".runtime-context-facts");
  await facts.getByText("命中", { exact: true }).first().waitFor();
  await facts.getByText("已降级", { exact: true }).waitFor();
  await facts.getByText("歧义", { exact: true }).waitFor();
  await facts.getByText("缺失", { exact: true }).waitFor();
  await facts.locator("summary code").filter({ hasText: "doc.exact" }).click();
  await facts.getByText("macOS exact content.", { exact: false }).waitFor();
  await facts.locator("summary code").filter({ hasText: "doc.ambiguous" }).click();
  await facts.getByText("Guide/Windows/Retry", { exact: true }).waitFor();
  await facts.getByText("Guide/macOS/Retry", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "declarative-context-runtime-desktop.png"), fullPage: true });

  await page.getByLabel("运行对话消息").fill("读取声明式上下文");
  await page.getByTitle("发送消息").click();
  await page.getByText("已读取声明式上下文。", { exact: true }).waitFor();
  await page.locator(".runtime-events").getByText("项目事实查询", { exact: true }).waitFor();
  const run = (await store.listRuns(member.projectId))[0];
  const runView = await store.getRun(member.projectId, run.runId);
  const contextEvent = run.events.find((event) => event.type === "context.queried");
  if (!contextEvent || JSON.stringify(contextEvent.data).includes("macOS exact content")) throw new Error("Trace 缺失或泄漏文档正文");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth) throw new Error(`声明式上下文移动端横向溢出：${JSON.stringify(mobileLayout)}`);
  await page.screenshot({ path: path.join(artifactDir, "declarative-context-runtime-mobile.png"), fullPage: true });

  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  if (failedResponses.length) throw new Error(`Failed responses: ${failedResponses.join(" | ")}`);
  const report = {
    schemaVersion: "1.0",
    browser: await browser.version(),
    configuredThroughUi: lookup.map((query) => ({ queryId: query.queryId, kind: query.kind })),
    runtimeStatuses: runView.contextFacts?.map((fact) => ({ queryId: fact.queryId, status: fact.status })) ?? [],
    trace: contextEvent.data,
    traceContainsDocumentContent: false,
    mobileLayout,
    consoleErrors,
    failedResponses,
    screenshots: ["declarative-context-confirmation.png", "declarative-context-runtime-desktop.png", "declarative-context-runtime-mobile.png"]
  };
  await writeFile(path.join(artifactDir, "declarative-context-verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
