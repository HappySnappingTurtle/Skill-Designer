import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const originalRoot = process.env.ORIGINAL_GRAPH_VIEWER ?? "/Users/hongyuwu/Documents/graph-engine-demo/graph-viewer";
const originalHtml = await readFile(path.join(originalRoot, "index.html"), "utf8");
const originalNodes = readConstant(originalHtml, "NODES");
const originalLinks = readConstant(originalHtml, "LINKS");
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-original-graph-style-"));
const projectRoot = path.join(dataRoot, "original-graph-skill");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/original-graph-replica");
const skillId = "skill-77777777-7777-4777-8777-777777777777";
const port = 4335;
const baseUrl = `http://127.0.0.1:${port}`;

const nodes = originalNodes.map((node) => ({
  id: node.id,
  title: node.title,
  kind: normalizeNodeKind(node.kind),
  ...(node.docContent ? { description: node.docContent.slice(0, 240) } : {})
}));
const edges = originalLinks.map((edge, index) => ({
  id: `original.edge-${String(index).padStart(3, "0")}`,
  from: edge.source,
  to: edge.target,
  kind: normalizeEdgeKind(edge.rel),
  ...(edge.note ? { label: edge.note } : {})
}));

await Promise.all([
  mkdir(path.join(projectRoot, "graph"), { recursive: true }),
  mkdir(artifactDir, { recursive: true })
]);
await Promise.all([
  writeFile(path.join(projectRoot, "SKILL.md"), "# uimetadata skill\n\n原始项目图谱样式同数据验收。\n"),
  writeFile(path.join(projectRoot, "skill.json"), `${JSON.stringify({
    skillId,
    name: "uimetadata skill",
    version: "1.0.0",
    description: "原始项目 29 节点图谱样式同数据验收",
    capability: "workflow"
  }, null, 2)}\n`),
  writeFile(path.join(projectRoot, "graph", "main.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    skillId,
    capability: "workflow",
    entry: "start",
    nodes,
    edges
  }, null, 2)}\n`)
]);

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "原始图谱样式验收" });
await store.openInPlaceProject(workspace.workspaceId, { rootPath: projectRoot });
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

console.log("[original-style] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  const graph = page.locator('.skill-force-graph[data-node-count="29"][data-edge-count="48"]');
  await graph.waitFor();
  await graph.locator('canvas').waitFor();
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: path.join(artifactDir, "replica-3d-initial.png"), fullPage: true });
  const initial3dPixels = await canvasPixelBounds(page, "3d");
  if (initial3dPixels.widthRatio < 0.75 || initial3dPixels.heightRatio < 0.7 || initial3dPixels.pixelCount < 1_000) {
    throw new Error(`3D graph does not reproduce the original viewer's expanded force layout: ${JSON.stringify(initial3dPixels)}`);
  }
  await waitForSettled(page, "3d");
  await page.screenshot({ path: path.join(artifactDir, "replica-3d.png"), fullPage: true });

  const desktopMetrics = await page.evaluate(() => {
    const toolbar = document.querySelector(".graph-toolbar");
    const search = document.querySelector(".graph-search");
    const legend = document.querySelector(".graph-kind-legend");
    const surface = document.querySelector(".graph-render-surface");
    const fit = document.querySelector(".graph-fit-toolbar");
    const title = document.querySelector(".graph-original-title");
    return {
      toolbarHeight: getComputedStyle(toolbar).height,
      toolbarGap: getComputedStyle(toolbar).gap,
      searchWidth: getComputedStyle(search).width,
      searchRadius: getComputedStyle(search).borderRadius,
      legendLeft: getComputedStyle(legend).left,
      legendTop: getComputedStyle(legend).top,
      legendRadius: getComputedStyle(legend).borderRadius,
      background: getComputedStyle(surface).backgroundImage,
      fitText: fit?.textContent?.trim(),
      titleText: title?.textContent?.trim(),
      titleSkillId: title?.getAttribute("data-skill-id")
    };
  });
  const expectedMetrics = {
    toolbarHeight: "46px",
    toolbarGap: "10px",
    searchWidth: "210px",
    searchRadius: "7px",
    legendLeft: "12px",
    legendTop: "10px",
    legendRadius: "10px",
    background: desktopMetrics.background,
    fitText: "⤢ 适应",
    titleText: "uimetadata skill 知识图谱",
    titleSkillId: skillId
  };
  if (JSON.stringify(desktopMetrics) !== JSON.stringify(expectedMetrics) || !desktopMetrics.background.includes("radial-gradient")) {
    throw new Error(`Original style metrics differ: ${JSON.stringify(desktopMetrics)}`);
  }

  await page.getByRole("button", { name: "2D 平面" }).click();
  await page.locator('.skill-force-graph[data-graph-mode="2d"] canvas').waitFor();
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: path.join(artifactDir, "replica-2d-initial.png"), fullPage: true });
  const initial2dPixels = await canvasPixelBounds(page, "2d");
  if (
    initial2dPixels.widthRatio < 0.5
    || initial2dPixels.heightRatio < 0.5
    || initial2dPixels.pixelCount < 4_000
  ) {
    throw new Error(`2D graph does not reproduce the original viewer's expanded force layout: ${JSON.stringify(initial2dPixels)}`);
  }
  await waitForSettled(page, "2d");
  const settled2dPixels = await canvasPixelBounds(page, "2d");
  if (settled2dPixels.minY < 10 || settled2dPixels.maxY > settled2dPixels.canvasHeight - 10) {
    throw new Error(`Settled 2D graph is clipped by the canvas edge: ${JSON.stringify(settled2dPixels)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "replica-2d.png"), fullPage: true });

  await page.getByLabel("搜索图节点").fill("意图中枢");
  await page.getByLabel("搜索图节点").press("Enter");
  const inspector = page.locator(".graph-inspector");
  await inspector.getByRole("heading", { name: "意图中枢", exact: true }).waitFor();
  const inspectorMetrics = await inspector.evaluate((element) => ({
    top: Math.round(element.getBoundingClientRect().top),
    right: Math.round(window.innerWidth - element.getBoundingClientRect().right),
    bottom: Math.round(window.innerHeight - element.getBoundingClientRect().bottom),
    width: Math.round(element.getBoundingClientRect().width),
    radius: getComputedStyle(element).borderRadius,
    borderTop: getComputedStyle(element).borderTopWidth
  }));
  if (JSON.stringify(inspectorMetrics) !== JSON.stringify({ top: 56, right: 12, bottom: 12, width: 440, radius: "14px", borderTop: "1px" })) {
    throw new Error(`Original inspector metrics differ: ${JSON.stringify(inspectorMetrics)}`);
  }
  await page.screenshot({ path: path.join(artifactDir, "replica-2d-detail.png"), fullPage: true });

  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  if (failedResponses.length) throw new Error(`Failed responses: ${failedResponses.join(" | ")}`);
  const report = { source: path.join(originalRoot, "index.html"), nodes: nodes.length, edges: edges.length, desktopMetrics, inspectorMetrics, initial3dPixels, initial2dPixels, settled2dPixels, consoleErrors, failedResponses };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
}

function readConstant(source, name) {
  const match = source.match(new RegExp(`const ${name}=(\\[[\\s\\S]*?\\]);\\nconst `));
  if (!match) throw new Error(`Cannot read ${name} from original graph viewer`);
  return JSON.parse(match[1]);
}

function normalizeNodeKind(kind) {
  if (["start", "end", "step", "decision", "gate", "lookup", "action", "terminal"].includes(kind)) return kind;
  if (kind === "auto") return "dispatcher";
  return "knowledge";
}

function normalizeEdgeKind(kind) {
  if (kind === "back") return "back";
  if (kind === "dispatch") return "continue";
  if (kind === "seq") return "flow";
  return "knowledge";
}

async function waitForSettled(page, mode) {
  await page.locator(`.skill-force-graph[data-graph-mode="${mode}"] canvas`).waitFor();
  await page.waitForFunction(
    (expected) => document.querySelector(".skill-force-graph")?.getAttribute("data-graph-mode") === expected && document.querySelector(".skill-force-graph")?.getAttribute("data-render-state") === "settled",
    mode,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(800);
}

async function canvasPixelBounds(page, mode) {
  return page.locator(`.skill-force-graph[data-graph-mode="${mode}"] canvas`).evaluate((canvas, graphMode) => {
    const width = canvas.width;
    const height = canvas.height;
    let pixels;
    if (graphMode === "2d") {
      pixels = canvas.getContext("2d")?.getImageData(0, 0, width, height).data;
    } else {
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (gl) {
        pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
    }
    if (!pixels) throw new Error(`Cannot inspect ${graphMode} canvas pixels`);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let pixelCount = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 8) continue;
      const pixel = index / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixelCount += 1;
    }
    const contentWidth = maxX >= minX ? maxX - minX + 1 : 0;
    const contentHeight = maxY >= minY ? maxY - minY + 1 : 0;
    return {
      canvasWidth: width,
      canvasHeight: height,
      minX,
      minY,
      maxX,
      maxY,
      contentWidth,
      contentHeight,
      widthRatio: Number((contentWidth / width).toFixed(3)),
      heightRatio: Number((contentHeight / height).toFixed(3)),
      pixelCount
    };
  }, mode);
}
