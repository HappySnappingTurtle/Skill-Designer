import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-example-workspace-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/example-workspace");
const exampleRoot = path.resolve("examples/multi-skill-workspace");
const descriptor = JSON.parse(await readFile(path.join(exampleRoot, "example-workspace.json"), "utf8"));
const workflowRoot = path.join(exampleRoot, descriptor.members.find((member) => member.capability === "workflow").relativePath);
const contentRoot = path.join(exampleRoot, descriptor.members.find((member) => member.capability === "content-only").relativePath);
const trackedExampleFiles = [
  path.join(workflowRoot, "SKILL.md"),
  path.join(workflowRoot, "skill.json"),
  path.join(workflowRoot, "graph/main.json"),
  path.join(contentRoot, "SKILL.md"),
  path.join(contentRoot, "skill.json"),
  path.join(contentRoot, "graph/main.json")
];
const sourceHashBefore = await filesHash(trackedExampleFiles);
const port = 4343;
const baseUrl = `http://127.0.0.1:${port}`;
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

console.log("[example-workspace] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(25_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.waitFor();
  await createDialog.getByLabel("工作区名称").fill(descriptor.name);
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: descriptor.name, exact: true }).waitFor();

  await openInPlace(page, workflowRoot, "发布前审核");
  await openInPlace(page, contentRoot, "接口约定知识库");
  const workflowRow = page.getByRole("row", { name: /发布前审核/u });
  const contentRow = page.getByRole("row", { name: /接口约定知识库/u });
  await workflowRow.getByText("工作流", { exact: true }).waitFor();
  await workflowRow.getByText("就绪", { exact: true }).waitFor();
  await contentRow.getByText("内容型", { exact: true }).waitFor();
  await contentRow.getByText("就绪", { exact: true }).waitFor();
  if (await page.locator("tbody tr").count() !== 2) throw new Error("Example Workspace did not contain exactly two members");
  await page.screenshot({ path: path.join(artifactDir, "workspace-two-skills.png"), fullPage: true });

  await workflowRow.click();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  const workflowGraph = page.locator('.skill-force-graph[data-node-count="4"][data-edge-count="3"]');
  await workflowGraph.waitFor();
  await page.getByRole("button", { name: "2D 平面", exact: true }).click();
  await page.locator('.skill-force-graph.mode-2d.is-ready[data-render-state="settled"]').waitFor();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(900);
  const workflowPaint = await waitForGraphPaint(page, 100);
  assertGraphFraming(workflowPaint, "workflow");
  await page.screenshot({ path: path.join(artifactDir, "workflow-graph.png"), fullPage: true });

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("row", { name: /接口约定知识库/u }).click();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  const contentGraph = page.locator('.skill-force-graph[data-node-count="2"][data-edge-count="1"]');
  await contentGraph.waitFor();
  await page.getByRole("button", { name: "2D 平面", exact: true }).click();
  await page.locator('.skill-force-graph.mode-2d.is-ready[data-render-state="settled"]').waitFor();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(900);
  const contentPaint = await waitForGraphPaint(page, 60);
  assertGraphFraming(contentPaint, "content-only");
  await page.screenshot({ path: path.join(artifactDir, "content-knowledge-graph.png"), fullPage: true });

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByText("docs/versioning.md", { exact: true }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.waitFor();
  if (!(await editor.inputValue()).includes("## 兼容性")) throw new Error("Content-only example document did not load");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth) throw new Error(`Mobile document overflow: ${JSON.stringify(mobileLayout)}`);
  await page.screenshot({ path: path.join(artifactDir, "content-documents-mobile.png"), fullPage: true });

  const sourceHashAfter = await filesHash(trackedExampleFiles);
  if (sourceHashAfter !== sourceHashBefore) throw new Error("Opening the example changed its source files without a ChangeSet");
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser errors: ${JSON.stringify({ consoleErrors, failedResponses })}`);
  const report = {
    workspaceName: descriptor.name,
    members: descriptor.members,
    workflowPaint,
    contentPaint,
    mobileLayout,
    sourceUnchanged: true,
    consoleErrors,
    failedResponses
  };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}

async function openInPlace(page, rootPath, expectedName) {
  await page.getByRole("button", { name: "原地打开", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "原地打开 Git Skill" });
  await dialog.getByLabel("Skill 根目录绝对路径").fill(rootPath);
  await dialog.getByRole("button", { name: "确认并打开" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: new RegExp(expectedName, "u") }).waitFor();
}

async function waitForGraphPaint(page, minimumSamples) {
  await page.waitForFunction((minimum) => {
    const canvas = document.querySelector(".skill-force-graph.mode-2d canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d");
    if (!context || canvas.width < 100 || canvas.height < 100) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedSamples = 0;
    for (let y = 0; y < canvas.height; y += 4) {
      for (let x = 0; x < canvas.width; x += 4) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 20) paintedSamples += 1;
        if (paintedSamples >= minimum) return true;
      }
    }
    return false;
  }, minimumSamples);
  return page.locator(".skill-force-graph.mode-2d canvas").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedSamples = 0;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 4) {
      for (let x = 0; x < canvas.width; x += 4) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 20) {
          paintedSamples += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return { width: canvas.width, height: canvas.height, paintedSamples, bounds: { minX, minY, maxX, maxY } };
  });
}

function assertGraphFraming(paint, label) {
  const margin = 20;
  if (
    paint.bounds.minX < margin || paint.bounds.minY < margin ||
    paint.bounds.maxX > paint.width - margin || paint.bounds.maxY > paint.height - margin
  ) {
    throw new Error(`${label} graph is clipped after fit: ${JSON.stringify(paint)}`);
  }
}

async function filesHash(files) {
  const digest = createHash("sha256");
  for (const file of files.sort((left, right) => left.localeCompare(right))) {
    digest.update(path.relative(exampleRoot, file));
    digest.update(await readFile(file));
  }
  return `sha256:${digest.digest("hex")}`;
}
