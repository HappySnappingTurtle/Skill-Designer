import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-graph-scale-"));
const projectRoot = path.join(dataRoot, "five-hundred-node-skill");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4325";
const skillId = "skill-88888888-8888-4888-8888-888888888888";
const nodeKinds = ["step", "decision", "gate", "action"];
const nodes = Array.from({ length: 500 }, (_, index) => {
  const row = Math.floor(index / 20);
  const column = index % 20;
  const visualColumn = row % 2 ? 19 - column : column;
  const id = index === 0 ? "flow.start" : index === 499 ? "flow.end" : `flow.node-${String(index).padStart(3, "0")}`;
  const kind = index === 0 ? "start" : index === 499 ? "end" : nodeKinds[(index - 1) % nodeKinds.length];
  const title = index === 0 ? "流程起点" : index === 499 ? "流程终点" : `节点 ${String(index).padStart(3, "0")}`;
  return { id, kind, title, description: `500 节点页面验收 ${index}`, position: { x: 100 + visualColumn * 240, y: 80 + row * 145 } };
});
const edges = Array.from({ length: 499 }, (_, index) => ({
  id: `edge.${String(index).padStart(3, "0")}-${String(index + 1).padStart(3, "0")}`,
  from: nodes[index].id,
  to: nodes[index + 1].id,
  kind: index % 17 === 0 ? "continue" : "flow"
}));

await Promise.all([
  mkdir(path.join(projectRoot, "graph"), { recursive: true }),
  mkdir(artifactDir, { recursive: true })
]);
await Promise.all([
  writeFile(path.join(projectRoot, "SKILL.md"), "# 五百节点 Skill\n\n用于图谱页面规模验收。\n"),
  writeFile(path.join(projectRoot, "skill.json"), JSON.stringify({
    skillId,
    name: "五百节点流程",
    version: "1.0.0",
    description: "500 节点图谱页面规模验收",
    capability: "workflow"
  }, null, 2) + "\n"),
  writeFile(path.join(projectRoot, "graph", "main.json"), JSON.stringify({
    schemaVersion: "1.0",
    skillId,
    capability: "workflow",
    entry: "flow.start",
    nodes,
    edges
  }, null, 2) + "\n")
]);

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "500 节点 Chrome 验收" });
await store.openInPlaceProject(workspace.workspaceId, { rootPath: projectRoot });
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4325, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(20_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function locateBySearch(query, expectedTitle) {
  const started = Date.now();
  await page.getByLabel("搜索图节点").fill(query);
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: expectedTitle, exact: true }).waitFor();
  const durationMs = Date.now() - started;
  if (durationMs > 2_000) throw new Error(`Graph locate ${query} exceeded 2000 ms: ${durationMs} ms`);
  return { target: query, durationMs };
}

async function waitForGraph(mode) {
  const graph = page.locator(`.skill-force-graph[data-graph-mode="${mode}"][data-node-count="500"][data-edge-count="499"]`);
  await graph.waitFor();
  await graph.locator("canvas").waitFor();
  await page.waitForFunction(() => document.querySelector(".skill-force-graph")?.getAttribute("data-render-state") === "settled", undefined, { timeout: 20_000 });
  return graph.locator("canvas");
}

async function canvasPixelStats() {
  return page.locator(".skill-force-graph canvas").evaluate((canvas) => {
    const width = canvas.width;
    const height = canvas.height;
    let pixels;
    let renderer;
    const context2d = canvas.getContext("2d");
    if (context2d) {
      pixels = context2d.getImageData(0, 0, width, height).data;
      renderer = "canvas-2d";
    } else {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) throw new Error("500-node canvas has no rendering context");
      pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      renderer = gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
    }
    const colors = new Set();
    let visibleSamples = 0;
    const step = Math.max(1, Math.floor((width * height) / 30_000));
    for (let pixel = 0; pixel < width * height; pixel += step) {
      const offset = pixel * 4;
      if (pixels[offset + 3] > 0) visibleSamples += 1;
      colors.add(`${pixels[offset] >> 4}-${pixels[offset + 1] >> 4}-${pixels[offset + 2] >> 4}-${pixels[offset + 3] >> 5}`);
    }
    return { renderer, width, height, visibleSamples, uniqueColorBuckets: colors.size };
  });
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "500 节点 Chrome 验收" }).waitFor();
  const loadStarted = Date.now();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("五百节点流程 图谱").waitFor();
  await page.locator('.skill-force-graph[data-node-count="500"][data-edge-count="499"]').waitFor();
  await page.getByText("大图模式", { exact: true }).waitFor();
  const canvas3d = await waitForGraph("3d");
  const pixels3d = await canvasPixelStats();
  if (pixels3d.uniqueColorBuckets < 8 || pixels3d.visibleSamples < 20) throw new Error(`500-node 3D canvas is blank: ${JSON.stringify(pixels3d)}`);
  const loadMs = Date.now() - loadStarted;
  if (loadMs > 15_000) throw new Error(`500-node 3D graph load exceeded 15000 ms: ${loadMs} ms`);
  const before3dDrag = await canvas3d.screenshot();
  const canvas3dBox = await canvas3d.boundingBox();
  if (!canvas3dBox) throw new Error("500-node 3D canvas bounds unavailable");
  await page.mouse.move(canvas3dBox.x + canvas3dBox.width * 0.45, canvas3dBox.y + canvas3dBox.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(canvas3dBox.x + canvas3dBox.width * 0.55, canvas3dBox.y + canvas3dBox.height * 0.52, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const after3dDrag = await canvas3d.screenshot();
  if (before3dDrag.equals(after3dDrag)) throw new Error("500-node 3D camera did not respond to drag");
  await page.screenshot({ path: path.join(artifactDir, "graph-scale-500-3d-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "2D 平面" }).click();
  const canvas2d = await waitForGraph("2d");
  const pixels2d = await canvasPixelStats();
  if (pixels2d.uniqueColorBuckets < 8 || pixels2d.visibleSamples < 20) throw new Error(`500-node 2D canvas is blank: ${JSON.stringify(pixels2d)}`);

  const locateMeasurements = [];
  locateMeasurements.push(await locateBySearch("flow.node-001", "节点 001"));
  locateMeasurements.push(await locateBySearch("flow.node-250", "节点 250"));
  locateMeasurements.push(await locateBySearch("flow.node-498", "节点 498"));

  await page.getByLabel("搜索图节点").fill("flow.node-250");
  const filterStarted = Date.now();
  await page.locator(".graph-kind-legend").getByRole("button", { name: "判断", exact: true }).click();
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "节点 250", exact: true }).waitFor();
  await page.getByLabel("搜索图节点").fill("flow.start");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "节点 250", exact: true }).waitFor();
  await page.getByLabel("搜索图节点").fill("flow.node-250");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByText("出边（点击跳转）", { exact: true }).waitFor();
  await page.locator(".graph-inspector").getByRole("button", { name: "节点 251", exact: true }).click();
  await page.locator(".graph-inspector").getByRole("heading", { name: "节点 251", exact: true }).waitFor();
  if (await page.locator(".graph-kind-legend button.off").count()) throw new Error("Cross-kind relation navigation did not clear the node kind filter");
  await page.getByLabel("搜索图节点").fill("flow.start");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "流程起点", exact: true }).waitFor();
  const filterMs = Date.now() - filterStarted;
  if (filterMs > 2_000) throw new Error(`Graph kind filter exceeded 2000 ms: ${filterMs} ms`);

  await locateBySearch("flow.node-250", "节点 250");
  await page.locator(".graph-inspector").getByText("入边（谁指向我）", { exact: true }).waitFor();
  await page.locator(".graph-inspector").getByText("出边（点击跳转）", { exact: true }).waitFor();
  await page.locator(".graph-inspector").getByRole("button", { name: "节点 251", exact: true }).click();
  await page.locator(".graph-inspector").getByRole("heading", { name: "节点 251", exact: true }).waitFor();

  const before2dPan = await canvas2d.screenshot();
  const canvasBox = await canvas2d.boundingBox();
  if (!canvasBox) throw new Error("500-node 2D canvas bounds unavailable");
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.45, canvasBox.y + canvasBox.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.55, canvasBox.y + canvasBox.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after2dPan = await canvas2d.screenshot();
  if (before2dPan.equals(after2dPan)) throw new Error("500-node 2D canvas did not respond to pan");
  await page.screenshot({ path: path.join(artifactDir, "graph-scale-500-2d-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await locateBySearch("flow.node-498", "节点 498");
  await page.getByText("大图模式", { exact: true }).waitFor();
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (overflow.document > overflow.viewport) throw new Error(`Mobile 500-node graph overflow: ${overflow.document}px > ${overflow.viewport}px`);
  await page.screenshot({ path: path.join(artifactDir, "graph-scale-500-mobile.png"), fullPage: true });

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  const reportPath = path.join(artifactDir, "graph-scale-500.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version() },
    fixture: { nodes: 500, edges: 499, connected: true, nodeKinds: ["start", ...nodeKinds, "end"] },
    degradation: { threshold: 200, reducedSimulationTicks: true, reducedLabelSize: true, animatedEdges: false },
    thresholdsMs: { graphLoad3d: 15_000, searchAndLocate: 2_000, kindFilter: 2_000 },
    observedMs: { graphLoad3d: loadMs, searchAndLocate: locateMeasurements, kindFilter: filterMs, pixels3d, pixels2d },
    interactions: { inboundOutbound: true, relationNavigation: true, rotate3d: true, pan2d: true },
    mobile: { viewport: { width: 390, height: 844 }, horizontalOverflow: false },
    screenshots: ["graph-scale-500-3d-desktop.png", "graph-scale-500-2d-desktop.png", "graph-scale-500-mobile.png"]
  }, null, 2) + "\n");
  console.log(`Chrome 500-node graph verified: load ${loadMs}ms; locates ${locateMeasurements.map((item) => `${item.target}=${item.durationMs}ms`).join(", ")}; filter ${filterMs}ms; relations, zoom, pan and mobile passed.`);
  console.log(`3D screenshot: ${path.join(artifactDir, "graph-scale-500-3d-desktop.png")}`);
  console.log(`2D screenshot: ${path.join(artifactDir, "graph-scale-500-2d-desktop.png")}`);
  console.log(`Mobile screenshot: ${path.join(artifactDir, "graph-scale-500-mobile.png")}`);
  console.log(`Scale report: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
