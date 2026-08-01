import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const skillRoot = "/Users/hongyuwu/IdeaProjects/yds-skills/mdd-backend-extend-develop";
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-real-mdd-import-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/real-skill-mdd-import");
const baseUrl = "http://127.0.0.1:4349";
await mkdir(artifactDir, { recursive: true });
await rm(path.join(artifactDir, "blocked-preview.json"), { force: true });
const sourceBefore = await hashTree(skillRoot);
const sourceMarkdownPaths = [...sourceBefore.keys()].filter((file) => file.toLowerCase().endsWith(".md"));

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const importLLMParser = {
  latest: async () => null,
  start: async () => { throw new Error("LLM parsing is outside this import verification"); },
  cancel: async () => null
};
const server = createApp({ store, benchmarkRunner: { list: async () => [] }, importLLMParser, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4349, "127.0.0.1", resolve));
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
  await createDialog.getByLabel("工作区名称").fill("用户真实 MDD Skill 验收");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "用户真实 MDD Skill 验收" }).waitFor();

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
  const responseBody = await previewResponse.json();
  const preview = responseBody.data;
  const candidate = preview.candidate;
  const scriptCount = candidate.files.filter((file) => file.kind === "script").length;
  const resolvedReferenceCount = candidate.references.filter((reference) => reference.status === "resolved").length;
  const candidateReferences = candidate.references.filter((reference) => reference.status === "candidate");
  const unresolvedReferences = candidate.references.filter((reference) => !["resolved", "candidate", "external"].includes(reference.status));
  if (candidate.files.length !== sourceBefore.size) throw new Error(`Import preview lost files: ${candidate.files.length}/${sourceBefore.size}`);
  await importDialog.locator(".import-identity strong").filter({ hasText: "mdd-backend-extend-develop" }).waitFor();
  await importDialog.getByText(`${candidate.files.length} 个原文件`, { exact: false }).waitFor();
  if (scriptCount > 0) await importDialog.getByText(new RegExp(`保留 ${scriptCount} 个脚本文件`, "u")).waitFor();
  await importDialog.getByText("解析审阅", { exact: true }).waitFor();
  await importDialog.getByText(`${resolvedReferenceCount} 已解析 · ${candidateReferences.length} 候选 · ${unresolvedReferences.length} 待检查`, { exact: true }).waitFor();
  if (candidateReferences.length > 0) await importDialog.locator(".import-reference-list .candidate .reference-status").getByText("候选", { exact: true }).first().waitFor();
  const previewGraph = importDialog.locator('.skill-force-graph[data-graph-mode="3d"][data-render-state="settled"]');
  await previewGraph.waitFor();
  await importDialog.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(750);
  const preview3dCanvas = await graphCanvasPixels(previewGraph);
  assertPaintedCanvas(preview3dCanvas, "Real Skill import 3D preview");
  await page.screenshot({ path: path.join(artifactDir, "real-skill-import-preview-desktop.png"), fullPage: true });
  const referenceFacts = importDialog.locator(".import-inventory-facts");
  await referenceFacts.scrollIntoViewIfNeeded();
  if (candidateReferences.length > 0) await importDialog.locator(".import-reference-list .candidate").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifactDir, "real-skill-reference-candidates-desktop.png"), fullPage: true });

  const blockingDiagnostics = [
    ...candidate.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ...candidate.parseReview.lint.filter((diagnostic) => diagnostic.severity === "error")
  ];
  if (blockingDiagnostics.length > 0) {
    const blockedPreview = {
      sourceFileCount: sourceBefore.size,
      candidateFileCount: candidate.files.length,
      capability: candidate.capability,
      nodeCount: candidate.parseReview.nodes.length,
      edgeCount: candidate.parseReview.edges.length,
      diagnostics: candidate.diagnostics,
      reviewLint: candidate.parseReview.lint
    };
    await writeFile(path.join(artifactDir, "blocked-preview.json"), `${JSON.stringify(blockedPreview, null, 2)}\n`, "utf8");
    throw new Error(`Real Skill import is blocked: ${JSON.stringify(blockingDiagnostics)}`);
  }

  await importDialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await importDialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /mdd-backend-extend-develop/u }).waitFor();
  const importedMember = (await store.getWorkspace(preview.workspace.workspaceId)).members.find((member) => member.projectId === candidate.projectId);
  if (!importedMember || importedMember.status !== "ready") throw new Error("Confirmed real Skill did not become ready");
  const sourceDescriptor = JSON.parse(await readFile(path.join(dataRoot, "studio", "projects", candidate.projectId, "source.json"), "utf8"));
  const managedFiles = await hashTree(sourceDescriptor.root);
  for (const [file, digest] of sourceBefore) {
    if (managedFiles.get(file) !== digest) throw new Error(`Managed copy did not preserve source bytes: ${file}`);
  }
  const sourceAfter = await hashTree(skillRoot);
  if (!sameTree(sourceBefore, sourceAfter)) throw new Error("Import modified the user-provided Skill source repository");

  const graph = await store.getProjectGraph(candidate.projectId);
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator(`.skill-force-graph[data-node-count="${graph.graph.nodes.length}"]`).waitFor();
  await page.getByRole("button", { name: "3D 立体", exact: true }).click();
  const graph3d = page.locator('.skill-force-graph[data-graph-mode="3d"][data-render-state="settled"]');
  await graph3d.waitFor();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(750);
  const graph3dCanvas = await graphCanvasPixels(graph3d);
  assertPaintedCanvas(graph3dCanvas, "Real Skill 3D graph");
  await page.screenshot({ path: path.join(artifactDir, "real-skill-graph-3d-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "2D 平面", exact: true }).click();
  const graph2d = page.locator('.skill-force-graph[data-graph-mode="2d"][data-render-state="settled"]');
  await graph2d.waitFor();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(550);
  const graph2dCanvas = await graphCanvasPixels(graph2d);
  assertPaintedCanvas(graph2dCanvas, "Real Skill 2D graph");
  await page.screenshot({ path: path.join(artifactDir, "real-skill-graph-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill("SKILL.md");
  await page.getByRole("button", { name: /SKILL\.md/u }).click();
  await page.getByText("MDD 本地后端开发", { exact: true }).waitFor();
  const managedDocuments = await store.listDocuments(candidate.projectId);
  await page.getByLabel("搜索文档").fill("routing-table");
  const routingVisible = await page.getByRole("button", { name: /routing-table\.md/u }).count() > 0;
  if (!routingVisible) await page.getByText("没有匹配文档", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "real-skill-document-coverage-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) {
    throw new Error(`Real Skill mobile overflow: ${JSON.stringify(mobileMetrics)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "real-skill-document-coverage-mobile.png"), fullPage: true });
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);

  const managedDocumentPaths = managedDocuments.map((document) => document.path);
  const missingFromDocumentManager = sourceMarkdownPaths.filter((file) => !managedDocumentPaths.includes(file));
  const referenceStatusCounts = Object.fromEntries(candidate.references.reduce((counts, reference) => {
    counts.set(reference.status, (counts.get(reference.status) ?? 0) + 1);
    return counts;
  }, new Map()));
  const verification = {
    browser: "Google Chrome",
    platform: `${process.platform}-${process.arch}`,
    source: {
      root: skillRoot,
      fileCount: sourceBefore.size,
      markdownCount: sourceMarkdownPaths.length,
      bytesUnchanged: true
    },
    import: {
      workspaceId: preview.workspace.workspaceId,
      projectId: candidate.projectId,
      skillId: importedMember.skillId,
      originalFileCount: candidate.files.length,
      generatedFileCount: candidate.generatedFiles.length,
      scriptCount,
      capability: graph.graph.capability,
      nodeCount: graph.graph.nodes.length,
      edgeCount: graph.graph.edges.length,
      allOriginalBytesPreservedInManagedCopy: true,
      diagnostics: candidate.diagnostics,
      parseReviewLint: candidate.parseReview.lint,
      referenceStatusCounts,
      candidateReferenceCount: candidateReferences.length,
      unresolvedReferenceCount: unresolvedReferences.length,
      unresolvedReferenceExamples: unresolvedReferences.slice(0, 20)
    },
    documentCoverage: {
      managedCount: managedDocumentPaths.length,
      sourceMarkdownCount: sourceMarkdownPaths.length,
      fullCoverage: missingFromDocumentManager.length === 0,
      routingTableVisible: routingVisible,
      missingCount: missingFromDocumentManager.length,
      missingExamples: missingFromDocumentManager.slice(0, 20)
    },
    graphCanvas: {
      importPreview3d: preview3dCanvas,
      project3d: graph3dCanvas,
      project2d: graph2dCanvas
    },
    mobileMetrics,
    consoleErrors,
    failedResponses,
    completedAt: new Date().toISOString()
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function hashTree(root) {
  const result = new Map();
  async function walk(relative = "") {
    const directory = path.join(root, relative);
    const entries = await readdir(directory, { withFileTypes: true });
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

async function graphCanvasPixels(graphLocator) {
  return graphLocator.locator("canvas").evaluate((canvas) => {
    const width = canvas.width;
    const height = canvas.height;
    const context2d = canvas.getContext("2d");
    let pixels;
    let renderer;
    if (context2d) {
      pixels = context2d.getImageData(0, 0, width, height).data;
      renderer = "canvas-2d";
    } else {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) throw new Error("Graph canvas has neither a 2D nor WebGL context");
      pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      renderer = gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
    }
    const colors = new Set();
    let variedSamples = 0;
    const sampleStep = Math.max(1, Math.floor((width * height) / 24_000));
    const base = [pixels[0], pixels[1], pixels[2]];
    for (let pixel = 0; pixel < width * height; pixel += sampleStep) {
      const offset = pixel * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (Math.abs(red - base[0]) + Math.abs(green - base[1]) + Math.abs(blue - base[2]) > 24) variedSamples += 1;
      colors.add(`${red >> 4}-${green >> 4}-${blue >> 4}-${alpha >> 5}`);
    }
    return { renderer, width, height, variedSamples, uniqueColorBuckets: colors.size };
  });
}

function assertPaintedCanvas(canvas, label) {
  if (canvas.width < 300 || canvas.height < 240 || canvas.uniqueColorBuckets < 4 || canvas.variedSamples <= 10) {
    throw new Error(`${label} is blank or incorrectly framed: ${JSON.stringify(canvas)}`);
  }
}
