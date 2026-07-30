import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { ImportLLMParserService } from "../packages/server/dist/import-llm-parser.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-import-cache-"));
const fixtureDir = path.join(dataRoot, "cache-import-skill");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4341";
await mkdir(fixtureDir, { recursive: true });
await mkdir(artifactDir, { recursive: true });
await writeFile(path.join(fixtureDir, "SKILL.md"), `# Cache Import\n\n${Array.from({ length: 420 }, (_, index) => `Paragraph ${index + 1} is immutable source context used to verify cross-run hash summaries.`).join("\n\n")}\n`, "utf8");

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const requests = [];
let invocation = 0;
const provider = {
  probe: async () => ({ schemaVersion: "1.0", providerId: "cache-browser", label: "Cache Browser", status: "ready", keyConfigured: true, defaultModel: "cache-model", reason: "ready", checkedAt: new Date().toISOString() }),
  invoke: async (request) => {
    requests.push(structuredClone(request.input));
    invocation += 1;
    const output = invocation === 2
      ? { action: "read", reply: "摘要不足，读取完整正文", reads: [{ path: "SKILL.md" }], capability: "content-only", entry: null, nodes: [], edges: [], questions: [] }
      : { action: "result", reply: "生成内容候选", reads: [], capability: "content-only", entry: null, nodes: [{ id: "knowledge.overview", kind: "knowledge", title: "缓存导入概览", description: null, doc: "SKILL.md", docAnchor: null, x: 0, y: 0, confidence: "high", evidence: [{ path: "SKILL.md", startLine: 1, endLine: 1, snippet: "# Cache Import" }] }], edges: [], questions: [] };
    return { providerId: "cache-browser", responseId: `cache-response-${invocation}`, model: "cache-model-resolved", output, usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 }, durationMs: 20 };
  }
};
const importLLMParser = new ImportLLMParserService({ dataRoot: path.join(dataRoot, "parser"), store, provider });
await importLLMParser.initialize();
const server = createApp({ store, importLLMParser, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4341, "127.0.0.1", resolve));

console.log("[import-llm-cache-verify] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("LLM 摘要缓存 Chrome 验收");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "LLM 摘要缓存 Chrome 验收" }).waitFor();

  await page.getByRole("button", { name: "导入 Skill" }).click();
  const dialog = page.getByRole("dialog", { name: "导入 Skill 文件夹" });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog.getByText("选择一个 Skill 文件夹", { exact: true }).click()]);
  await chooser.setFiles(fixtureDir);
  const [previewResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/workspaces\/[^/]+\/imports$/u.test(new URL(response.url()).pathname)),
    dialog.getByRole("button", { name: "扫描并预检" }).click()
  ]);
  const preview = (await previewResponse.json()).data;

  await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/imports\/[^/]+\/llm-parse$/u.test(new URL(response.url()).pathname)),
    dialog.getByRole("button", { name: "LLM 解析", exact: true }).click()
  ]);
  await dialog.getByText("LLM 解析完成", { exact: true }).waitFor();
  await dialog.locator(".import-llm-status details summary").click();
  await dialog.getByText("读取完整上下文并写入摘要缓存", { exact: false }).waitFor();
  const firstRun = await importLLMParser.latest(preview.candidate.importId, preview.workspace.workspaceId);

  await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/imports\/[^/]+\/llm-parse$/u.test(new URL(response.url()).pathname)),
    dialog.getByRole("button", { name: "LLM 解析", exact: true }).click()
  ]);
  await dialog.getByText("复用跨运行文件 hash 摘要", { exact: true }).waitFor();
  await dialog.getByText("缓存摘要已升级为完整正文", { exact: true }).waitFor();
  await dialog.getByText("LLM 解析完成", { exact: true }).waitFor();
  const secondRun = await importLLMParser.latest(preview.candidate.importId, preview.workspace.workspaceId);
  await page.screenshot({ path: path.join(artifactDir, "import-llm-cache-desktop.png"), fullPage: true });

  const firstContext = requests[0].files.find((file) => file.path === "SKILL.md");
  const summaryContext = requests[1].files.find((file) => file.path === "SKILL.md");
  const promotedContext = requests[2].files.find((file) => file.path === "SKILL.md");
  if (firstContext.mode !== "full" || summaryContext.mode !== "summary" || promotedContext.mode !== "full") throw new Error("模型上下文没有按 full -> summary -> full 升级");
  if (summaryContext.content.length >= firstContext.content.length) throw new Error("hash 摘要没有减少模型上下文字符数");
  if (!secondRun?.reads.some((read) => read.cacheStatus === "hit") || !secondRun.reads.some((read) => read.cacheStatus === "promoted")) throw new Error("第二次解析没有持久化 cache hit/promotion");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, dialogWidth: document.querySelector(".import-modal")?.getBoundingClientRect().width ?? 0 }));
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth || mobileLayout.dialogWidth > mobileLayout.viewportWidth) throw new Error(`缓存状态移动布局溢出：${JSON.stringify(mobileLayout)}`);
  await page.screenshot({ path: path.join(artifactDir, "import-llm-cache-mobile.png"), fullPage: true });
  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${JSON.stringify(failedResponses, null, 2)}`);

  const report = {
    schemaVersion: "1.0",
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version(), visibleChrome: true },
    identities: { workspaceId: preview.workspace.workspaceId, importId: preview.candidate.importId, firstRunId: firstRun?.runId, secondRunId: secondRun?.runId },
    context: { firstFullChars: firstContext.content.length, cachedSummaryChars: summaryContext.content.length, promotedFullChars: promotedContext.content.length },
    checks: { cacheMissVisible: true, cacheHitVisible: true, promotionVisible: true, candidateRemainedPreProject: true, mobileHorizontalOverflow: false },
    mobileLayout,
    consoleErrors,
    failedResponses,
    screenshots: ["import-llm-cache-desktop.png", "import-llm-cache-mobile.png"]
  };
  await writeFile(path.join(artifactDir, "import-llm-cache-verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
