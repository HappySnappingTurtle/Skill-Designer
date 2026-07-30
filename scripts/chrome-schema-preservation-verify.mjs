import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const fixtureRoot = path.resolve("examples/multi-skill-workspace/skills/release-review");
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-schema-preservation-"));
const projectRoot = path.join(dataRoot, "release-review");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/schema-preservation");
const port = 4336;
const baseUrl = `http://127.0.0.1:${port}`;

await Promise.all([
  cp(fixtureRoot, projectRoot, { recursive: true }),
  mkdir(artifactDir, { recursive: true })
]);

const beforeGraph = JSON.parse(await readFile(path.join(projectRoot, "graph/main.json"), "utf8"));
const beforeManifest = JSON.parse(await readFile(path.join(projectRoot, "skill.json"), "utf8"));
const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Schema 保真验收" });
const opened = await store.openInPlaceProject(workspace.workspaceId, { rootPath: projectRoot });
const member = opened.members[0];
if (!member) throw new Error("Schema preservation fixture did not create a workspace member");

const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
console.log("[schema-preservation] launching visible Chrome");
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
  await page.locator('.skill-force-graph[data-node-count="4"][data-edge-count="3"]').waitFor();
  await page.getByRole("button", { name: "2D 平面", exact: true }).click();
  await page.locator('.skill-force-graph[data-graph-mode="2d"] canvas').waitFor();

  await page.getByLabel("搜索图节点").fill("读取检查清单");
  await page.getByLabel("搜索图节点").press("Enter");
  const inspector = page.locator(".graph-inspector");
  await inspector.getByRole("heading", { name: "读取检查清单", exact: true }).waitFor();
  await inspector.getByRole("button", { name: "编辑节点", exact: true }).click();
  await page.locator("#graph-node-title").fill("读取发布清单");

  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  await page.getByRole("button", { name: "预览并保存图", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认图谱变更" });
  await dialog.waitFor();
  await page.screenshot({ path: path.join(artifactDir, "schema-preservation-confirmation.png"), fullPage: true });
  await dialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  const persistedGraph = JSON.parse(await readFile(path.join(projectRoot, "graph/main.json"), "utf8"));
  const persistedManifest = JSON.parse(await readFile(path.join(projectRoot, "skill.json"), "utf8"));
  const persistedNode = persistedGraph.nodes.find((node) => node.id === "flow.checklist");
  const persistedEdge = persistedGraph.edges.find((edge) => edge.id === "edge.decision-end");
  assertEqual(persistedGraph.vendorGraphMetadata, beforeGraph.vendorGraphMetadata, "graph top-level extension");
  assertEqual(persistedNode?.vendorNodeMetadata, beforeGraph.nodes.find((node) => node.id === "flow.checklist")?.vendorNodeMetadata, "node unknown field");
  assertEqual(persistedNode?.extensions, beforeGraph.nodes.find((node) => node.id === "flow.checklist")?.extensions, "node extensions");
  assertEqual(persistedEdge?.vendorEdgeMetadata, beforeGraph.edges.find((edge) => edge.id === "edge.decision-end")?.vendorEdgeMetadata, "edge unknown field");
  assertEqual(persistedEdge?.extensions, beforeGraph.edges.find((edge) => edge.id === "edge.decision-end")?.extensions, "edge extensions");
  assertEqual(persistedManifest.license, beforeManifest.license, "manifest unknown field");
  if (persistedNode?.title !== "读取发布清单") throw new Error(`Edited node title was not persisted: ${persistedNode?.title}`);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByRole("button", { name: "2D 平面", exact: true }).click();
  await page.getByLabel("搜索图节点").fill("读取发布清单");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "读取发布清单", exact: true }).waitFor();
  await page.waitForTimeout(900);
  const canvasPixels = await visibleCanvasPixels(page);
  if (canvasPixels < 100) throw new Error(`Reloaded graph canvas is blank: ${canvasPixels} visible pixels`);
  await page.screenshot({ path: path.join(artifactDir, "schema-preservation-reloaded.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (overflow.document > overflow.viewport) throw new Error(`Schema preservation mobile page overflows: ${overflow.document}px > ${overflow.viewport}px`);
  await page.screenshot({ path: path.join(artifactDir, "schema-preservation-mobile.png"), fullPage: true });

  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  if (failedResponses.length) throw new Error(`Failed responses: ${failedResponses.join(" | ")}`);
  const report = {
    fixture: fixtureRoot,
    workspaceId: workspace.workspaceId,
    projectId: member.projectId,
    skillId: member.skillId,
    editedNode: { id: "flow.checklist", title: persistedNode.title },
    preserved: {
      manifest: ["license"],
      graph: ["vendorGraphMetadata"],
      node: ["extensions", "vendorNodeMetadata"],
      edge: ["extensions", "vendorEdgeMetadata"]
    },
    canvasPixels,
    mobile: { ...overflow, horizontalOverflow: false },
    consoleErrors,
    failedResponses,
    screenshots: ["schema-preservation-confirmation.png", "schema-preservation-reloaded.png", "schema-preservation-mobile.png"]
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} was not preserved: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function visibleCanvasPixels(page) {
  return page.locator('.skill-force-graph[data-graph-mode="2d"] canvas').evaluate((canvas) => {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D graph canvas context is unavailable");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) visible += 1;
    }
    return visible;
  });
}
