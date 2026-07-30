import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-doc-scale-"));
const projectRoot = path.join(dataRoot, "hundred-document-skill");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4324";
const skillId = "skill-99999999-9999-4999-8999-999999999999";
await Promise.all([
  mkdir(path.join(projectRoot, "graph"), { recursive: true }),
  mkdir(path.join(projectRoot, "docs"), { recursive: true }),
  mkdir(artifactDir, { recursive: true })
]);
await Promise.all([
  writeFile(path.join(projectRoot, "SKILL.md"), "# 百篇文档 Skill\n\n用于页面规模验收。\n"),
  writeFile(path.join(projectRoot, "skill.json"), JSON.stringify({
    skillId,
    name: "百篇文档 Skill",
    version: "1.0.0",
    description: "100 篇文档页面规模验收",
    capability: "content-only"
  }, null, 2) + "\n"),
  writeFile(path.join(projectRoot, "graph", "main.json"), JSON.stringify({
    schemaVersion: "1.0",
    skillId,
    capability: "content-only",
    nodes: [{ id: "knowledge.skill", kind: "knowledge", title: "SKILL.md", doc: "SKILL.md", position: { x: 260, y: 180 } }],
    edges: []
  }, null, 2) + "\n"),
  ...Array.from({ length: 100 }, (_, index) => {
    const sequence = String(index + 1).padStart(3, "0");
    return writeFile(path.join(projectRoot, "docs", `topic-${sequence}.md`), `# Topic ${sequence}\n\n规模验收文档 ${sequence} 的唯一内容。\n`);
  })
]);

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "100 文档 Chrome 验收" });
const opened = await store.openInPlaceProject(workspace.workspaceId, { rootPath: projectRoot });
const member = opened.members[0];
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4324, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "100 文档 Chrome 验收" }).waitFor();
  const loadStarted = Date.now();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".document-list > button").length === 101);
  const loadMs = Date.now() - loadStarted;
  if (loadMs > 5_000) throw new Error(`101-document tree exceeded 5000 ms: ${loadMs} ms`);
  if ((await store.listDocuments(member.projectId)).length !== 101) throw new Error("Store did not enumerate SKILL.md plus 100 associated documents");

  const searchMeasurements = [];
  for (const target of ["topic-001", "topic-050", "topic-100"]) {
    const started = Date.now();
    await page.getByLabel("搜索文档").fill(target);
    await page.waitForFunction((expected) => {
      const buttons = [...document.querySelectorAll(".document-list > button")];
      return buttons.length === 1 && buttons[0]?.textContent?.includes(expected);
    }, target);
    const durationMs = Date.now() - started;
    if (durationMs > 1_000) throw new Error(`Document search ${target} exceeded 1000 ms: ${durationMs} ms`);
    searchMeasurements.push({ target, durationMs });
  }

  const openStarted = Date.now();
  await page.getByRole("button", { name: /docs\/topic-100\.md/u }).click();
  await page.waitForFunction(() => document.querySelector("textarea[aria-label='Markdown 编辑器']")?.value.includes("唯一内容"));
  const openMs = Date.now() - openStarted;
  if (openMs > 2_000) throw new Error(`Opening the 100th document exceeded 2000 ms: ${openMs} ms`);
  await page.locator(".docs-title strong").getByText("docs/topic-100.md", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "document-scale-100-desktop.png"), fullPage: true });

  await page.getByTitle("清除搜索").click();
  await page.waitForFunction(() => document.querySelectorAll(".document-list > button").length === 101);
  await page.getByLabel("搜索文档").fill("topic");
  await page.waitForFunction(() => document.querySelectorAll(".document-list > button").length === 100);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("搜索文档").fill("topic-050");
  await page.waitForFunction(() => document.querySelectorAll(".document-list > button").length === 1);
  await page.getByRole("button", { name: /docs\/topic-050\.md/u }).click();
  await page.waitForFunction(() => document.querySelector("textarea[aria-label='Markdown 编辑器']")?.value.includes("文档 050"));
  await page.locator(".docs-title strong").getByText("docs/topic-050.md", { exact: true }).waitFor();
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (overflow.document > overflow.viewport) throw new Error(`Mobile 100-document view overflow: ${overflow.document}px > ${overflow.viewport}px`);
  await page.screenshot({ path: path.join(artifactDir, "document-scale-100-mobile.png"), fullPage: true });

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  const reportPath = path.join(artifactDir, "document-scale-100.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version() },
    fixture: { associatedDocuments: 100, renderedDocumentsIncludingSkill: 101 },
    thresholdsMs: { treeLoad: 5_000, search: 1_000, documentOpen: 2_000 },
    observedMs: { treeLoad: loadMs, searches: searchMeasurements, documentOpen: openMs },
    mobile: { viewport: { width: 390, height: 844 }, horizontalOverflow: false },
    screenshots: ["document-scale-100-desktop.png", "document-scale-100-mobile.png"]
  }, null, 2) + "\n");
  console.log(`Chrome 100-document scale verified: 101-item tree ${loadMs} ms; searches ${searchMeasurements.map((item) => `${item.target}=${item.durationMs}ms`).join(", ")}; open topic-100=${openMs}ms; mobile layout passed.`);
  console.log(`Desktop screenshot: ${path.join(artifactDir, "document-scale-100-desktop.png")}`);
  console.log(`Mobile screenshot: ${path.join(artifactDir, "document-scale-100-mobile.png")}`);
  console.log(`Scale report: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
