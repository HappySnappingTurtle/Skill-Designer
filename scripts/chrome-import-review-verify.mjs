import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-import-review-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const fixtureDir = path.resolve("scripts/fixtures/reparse-skill");
const baseUrl = "http://127.0.0.1:4331";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const importLLMParser = {
  latest: async () => null,
  start: async () => { throw new Error("LLM parsing is outside this visual review scenario"); },
  cancel: async () => null
};
const server = createApp({ store, importLLMParser, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4331, "127.0.0.1", resolve));

console.log("[import-review-verify] launching visible Chrome");
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
  await createDialog.getByLabel("工作区名称").fill("解析审阅 Chrome 验收");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "解析审阅 Chrome 验收" }).waitFor();

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
  const editedNode = candidate.parseReview.nodes.find((node) => node.value.title === "确认范围");
  if (!editedNode) throw new Error("Expected the explicit workflow heading to become a node candidate");

  await dialog.getByText("发布审阅助手", { exact: true }).first().waitFor();
  await dialog.getByText("工作流", { exact: true }).waitFor();
  await dialog.getByText("当前有向边按文档中的出现顺序生成；请确认是否存在条件分支、回退或并行关系。", { exact: true }).waitFor();
  await dialog.getByText("SKILL.md:L7", { exact: true }).first().waitFor();
  const graphCanvas = dialog.locator('.skill-force-graph[data-node-count="5"][data-edge-count="4"]');
  await graphCanvas.waitFor();
  await graphCanvas.locator("canvas").waitFor();
  const embeddedStyle = await graphCanvas.evaluate((root) => {
    const toolbar = root.querySelector(".graph-embedded-toolbar");
    const search = toolbar?.querySelector("input");
    const surface = root.querySelector(".graph-render-surface");
    if (!toolbar || !search || !surface) throw new Error("Original embedded graph structure is missing");
    return {
      toolbarHeight: getComputedStyle(toolbar).height,
      searchWidth: getComputedStyle(search).width,
      surfaceTop: getComputedStyle(surface).top,
      title: toolbar.querySelector("strong")?.textContent?.trim(),
      legacyFloatingControls: root.querySelectorAll(".graph-mode-control, .graph-fit-button").length
    };
  });
  if (JSON.stringify(embeddedStyle) !== JSON.stringify({ toolbarHeight: "46px", searchWidth: "210px", surfaceTop: "46px", title: "解析候选 知识图谱", legacyFloatingControls: 0 })) {
    throw new Error(`Embedded graph did not replicate the original toolbar: ${JSON.stringify(embeddedStyle)}`);
  }
  await dialog.getByRole("button", { name: "深浅主题切换", exact: true }).click();
  await graphCanvas.locator(".graph-render-surface").evaluate((surface) => {
    if (!getComputedStyle(surface).backgroundImage.includes("radial-gradient")) throw new Error("Dark graph surface lost the original radial background");
  });
  await dialog.getByRole("button", { name: "深浅主题切换", exact: true }).click();
  await dialog.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.locator('.skill-force-graph[data-render-state="settled"]').waitFor();
  await dialog.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(750);
  const threeCanvas = await graphCanvas.locator("canvas").evaluate((canvas) => ({ width: canvas.width, height: canvas.height, dataLength: canvas.toDataURL("image/png").length }));
  if (threeCanvas.width < 400 || threeCanvas.height < 250 || threeCanvas.dataLength < 2000) {
    throw new Error(`3D candidate graph canvas is blank or incorrectly framed: ${JSON.stringify(threeCanvas)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "import-review-3d-desktop.png"), fullPage: true });

  await dialog.getByRole("button", { name: "2D 平面", exact: true }).click();
  await page.locator('.skill-force-graph[data-graph-mode="2d"][data-render-state="settled"]').waitFor();
  await dialog.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(550);
  const twoCanvas = await graphCanvas.locator("canvas").evaluate((canvas) => ({ width: canvas.width, height: canvas.height, dataLength: canvas.toDataURL("image/png").length }));
  if (twoCanvas.dataLength < 2000) throw new Error(`2D candidate graph canvas is blank: ${JSON.stringify(twoCanvas)}`);
  await expectProjectMissing(store, candidate.projectId);

  const titleInput = dialog.getByLabel(`${editedNode.value.id} 节点标题`);
  await titleInput.fill("人工确认范围");
  await dialog.getByRole("button", { name: "保存审阅", exact: true }).click();
  await dialog.getByText("第 2 版", { exact: false }).waitFor();
  await expectProjectMissing(store, candidate.projectId);

  await dialog.getByRole("button", { name: "重新解析", exact: true }).click();
  await dialog.getByText("人工审阅与重新解析结果冲突", { exact: true }).waitFor();
  const conflicted = await store.getSkillImport(candidate.importId);
  if (!conflicted.parseReview.reparseConflict || !conflicted.parseReview.nodes.some((node) => node.value.title === "人工确认范围")) {
    throw new Error("Reparse conflict did not preserve the manual review as the effective version");
  }
  await page.screenshot({ path: path.join(artifactDir, "import-review-conflict-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    dialogWidth: document.querySelector(".import-modal")?.getBoundingClientRect().width ?? 0,
    conflictWidth: document.querySelector(".import-reparse-conflict")?.getBoundingClientRect().width ?? 0
  }));
  await page.screenshot({ path: path.join(artifactDir, "import-review-conflict-mobile.png"), fullPage: true });
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth || mobileLayout.dialogWidth > mobileLayout.viewportWidth || mobileLayout.conflictWidth > mobileLayout.viewportWidth) {
    throw new Error(`Mobile import review overflowed: ${JSON.stringify(mobileLayout)}`);
  }

  await page.setViewportSize({ width: 1440, height: 960 });
  await dialog.getByRole("button", { name: "保留人工修改", exact: true }).click();
  await dialog.getByText("人工审阅与重新解析结果冲突", { exact: true }).waitFor({ state: "hidden" });
  if (await titleInput.inputValue() !== "人工确认范围") throw new Error("Manual resolution did not keep the edited node title");
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  const finalGraph = await store.getProjectGraph(candidate.projectId);
  if (!finalGraph.graph.nodes.some((node) => node.title === "人工确认范围")) throw new Error("Confirmed project graph lost the adjudicated manual title");
  const sourceDocument = await store.readDocument(candidate.projectId, "SKILL.md");
  if (!sourceDocument.content.includes("### 确认范围") || sourceDocument.content.includes("人工确认范围")) {
    throw new Error("Import review mutated the frozen source Markdown");
  }

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}\nFailed responses:\n${JSON.stringify(failedResponses, null, 2)}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${JSON.stringify(failedResponses, null, 2)}`);
  const reportPath = path.join(artifactDir, "import-review.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version(), visibleChrome: true },
    verified: {
      explicitWorkflowParsed: true,
      sourceEvidenceVisible: true,
      threeDimensionalGraphRendered: true,
      twoDimensionalGraphRendered: true,
      originalEmbeddedToolbarReplicated: true,
      pendingCandidateDidNotCreateProject: true,
      manualEditPersisted: true,
      reparseConflictRequiredAdjudication: true,
      manualResolutionPreserved: true,
      confirmedGraphMatchesReview: true,
      sourceMarkdownPreserved: true,
      mobileHorizontalOverflow: false
    },
    identities: { workspaceId, importId: candidate.importId, projectId: candidate.projectId, editedNodeId: editedNode.value.id },
    canvas: { threeDimensional: threeCanvas, twoDimensional: twoCanvas },
    embeddedStyle,
    mobileLayout,
    screenshots: ["import-review-3d-desktop.png", "import-review-conflict-desktop.png", "import-review-conflict-mobile.png"]
  }, null, 2) + "\n");
  console.log("Visible Chrome verified import parsing, 2D/3D graph review, manual edit protection, conflict adjudication, confirmation, and mobile layout.");
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
  throw new Error("Import candidate created an active project before confirmation");
}
