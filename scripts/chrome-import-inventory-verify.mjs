import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-import-inventory-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const fixtureDir = path.resolve("scripts/fixtures/inventory-skill");
const sourceMarkdown = await readFile(path.join(fixtureDir, "SKILL.md"), "utf8");
const baseUrl = "http://127.0.0.1:4332";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4332, "127.0.0.1", resolve));

console.log("[import-inventory-verify] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
const networkRequests = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });
page.on("request", (request) => networkRequests.push(request.url()));

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("导入事实 Chrome 验收");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "导入事实 Chrome 验收" }).waitFor();

  await page.getByRole("button", { name: "导入 Skill" }).click();
  const dialog = page.getByRole("dialog", { name: "导入 Skill 文件夹" });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByText("选择一个 Skill 文件夹", { exact: true }).click()
  ]);
  await chooser.setFiles(fixtureDir);
  const [previewResponse] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/workspaces\/[^/]+\/imports$/u.test(new URL(response.url()).pathname)),
    dialog.getByRole("button", { name: "扫描并预检" }).click()
  ]);
  const preview = (await previewResponse.json()).data;
  const candidate = preview.candidate;
  const workspaceId = preview.workspace.workspaceId;

  await dialog.locator(".import-identity strong").filter({ hasText: "资产事实审阅助手" }).waitFor();
  await dialog.getByText("Frontmatter Skill", { exact: true }).waitFor();
  const facts = dialog.locator(".import-inventory-facts");
  await facts.scrollIntoViewIfNeeded();
  await facts.getByText("YAML · 有效", { exact: true }).waitFor();
  await facts.getByText(`${candidate.references.filter((item) => item.status === "resolved").length} 已解析 · ${candidate.references.filter((item) => !["resolved", "external"].includes(item.status)).length} 待检查`, { exact: true }).waitFor();
  await facts.getByText("metadata", { exact: true }).waitFor();
  await facts.getByText("x-review-policy", { exact: true }).waitFor();
  await facts.getByText("docs/context.md#context", { exact: true }).waitFor();
  await facts.getByRole("code").filter({ hasText: "assets/missing-preview.png" }).first().waitFor();
  await facts.getByText("../outside.md", { exact: true }).waitFor();
  const fallbackProvenance = facts.getByText(/保守降级/u).first();
  await fallbackProvenance.scrollIntoViewIfNeeded();
  await fallbackProvenance.waitFor();
  await dialog.getByText("发现 1 个相对引用找不到目标文件", { exact: true }).waitFor();
  await dialog.getByText("发现 1 个引用指向导入目录之外；工具不会读取目录外内容", { exact: true }).waitFor();
  await dialog.locator(".import-assets code").filter({ hasText: "config/policy.toml" }).getByText("配置", { exact: true }).waitFor();
  await dialog.locator(".import-assets code").filter({ hasText: "assets/checklist.txt" }).getByText("文本", { exact: true }).waitFor();
  if (candidate.frontmatter.data["x-review-policy"].preserveUnknownFields !== true) throw new Error("Unknown frontmatter data was not preserved in the candidate");
  if (!candidate.provenance.some((record) => record.subject === "display-name" && record.method === "frontmatter")) throw new Error("Display-name provenance is missing");
  if (!candidate.references.some((reference) => reference.rawTarget === "../outside.md" && reference.status === "escaped")) throw new Error("Escaping reference was not isolated");
  if (networkRequests.some((url) => new URL(url).hostname === "example.com")) throw new Error("Static reference inventory fetched an external URL");
  await expectProjectMissing(store, candidate.projectId);
  await page.screenshot({ path: path.join(artifactDir, "import-inventory-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await facts.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    dialogWidth: document.querySelector(".import-modal")?.getBoundingClientRect().width ?? 0,
    factsWidth: document.querySelector(".import-inventory-facts")?.getBoundingClientRect().width ?? 0,
    referenceRows: [...document.querySelectorAll(".import-reference-list > div")].map((row) => ({ left: row.getBoundingClientRect().left, right: row.getBoundingClientRect().right }))
  }));
  await page.screenshot({ path: path.join(artifactDir, "import-inventory-mobile.png"), fullPage: true });
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth || mobileLayout.dialogWidth > mobileLayout.viewportWidth || mobileLayout.factsWidth > mobileLayout.viewportWidth || mobileLayout.referenceRows.some((row) => row.left < 0 || row.right > mobileLayout.viewportWidth)) {
    throw new Error(`Mobile inventory UI overflowed: ${JSON.stringify(mobileLayout)}`);
  }

  await page.setViewportSize({ width: 1440, height: 960 });
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const confirmedGraph = await store.getProjectGraph(candidate.projectId);
  if (confirmedGraph.graph.capability !== "content-only") throw new Error("Metadata-only import invented an executable workflow");
  const confirmedDocument = await store.readDocument(candidate.projectId, "SKILL.md");
  if (confirmedDocument.content !== sourceMarkdown) throw new Error("Confirmation rewrote source frontmatter or Markdown");
  const source = JSON.parse(await readFile(path.join(dataRoot, "studio", "projects", candidate.projectId, "source.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(source.root, "skill.json"), "utf8"));
  if (manifest.name !== "资产事实审阅助手" || manifest.description !== "在导入前检查元数据、引用和判断来源。") throw new Error("Generated identity did not use parsed frontmatter");

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${JSON.stringify(failedResponses, null, 2)}`);
  const reportPath = path.join(artifactDir, "import-inventory.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version(), visibleChrome: true },
    verified: {
      yamlFrontmatterParsed: true,
      unknownMetadataPreserved: true,
      relativeReferencesResolved: true,
      missingReferenceDiagnosed: true,
      escapingReferenceIsolated: true,
      externalReferenceDidNotFetch: true,
      provenanceVisible: true,
      configAndTextFormatsRecognized: true,
      pendingCandidateDidNotCreateProject: true,
      contentOnlyFallbackPreserved: true,
      sourceBytesPreserved: true,
      mobileHorizontalOverflow: false
    },
    identities: { workspaceId, importId: candidate.importId, projectId: candidate.projectId },
    observed: {
      frontmatterDialect: candidate.frontmatter.dialect,
      frontmatterUnknownKeys: candidate.frontmatter.unknownKeys,
      referenceStatuses: Object.fromEntries(candidate.references.map((reference) => [reference.rawTarget, reference.status])),
      provenanceCount: candidate.provenance.length,
      formatSignals: candidate.formatSignals.map((signal) => signal.code),
      externalReferenceRequestCount: networkRequests.filter((url) => new URL(url).hostname === "example.com").length
    },
    mobileLayout,
    screenshots: ["import-inventory-desktop.png", "import-inventory-mobile.png"]
  }, null, 2) + "\n");
  console.log("Visible Chrome verified frontmatter, reference inventory, provenance, asset kinds, confirmation boundary, source preservation, and mobile layout.");
  console.log(`Report: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function expectProjectMissing(store, projectId) {
  try {
    await store.getProjectGraph(projectId);
  } catch (error) {
    if (error?.code === "project_not_found") return;
    throw error;
  }
  throw new Error("Import inventory created an active project before confirmation");
}
