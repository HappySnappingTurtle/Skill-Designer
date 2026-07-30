import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.SKILL_DESIGNER_URL ?? "http://127.0.0.1:4310";
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
let workspaceName = `2D 3D 图谱验收 ${Date.now().toString().slice(-6)}`;
let skillName = `三维需求分析图谱 ${Date.now().toString().slice(-4)}`;
const reportPath = path.join(artifactDir, "force-graph-verification.json");
await mkdir(artifactDir, { recursive: true });

console.log("[graph-verify] launching visible Chrome");
const browser = await chromium.launch({ channel: "chrome", headless: false });
console.log("[graph-verify] Chrome connected");
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function canvasPixels() {
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
      if (!gl) throw new Error("Graph canvas has neither a 2D nor WebGL context");
      pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      renderer = gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
    }
    const colors = new Set();
    let opaqueSamples = 0;
    let variedSamples = 0;
    const sampleStep = Math.max(1, Math.floor((width * height) / 24_000));
    const base = [pixels[0], pixels[1], pixels[2]];
    for (let pixel = 0; pixel < width * height; pixel += sampleStep) {
      const offset = pixel * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha > 0) opaqueSamples += 1;
      if (Math.abs(red - base[0]) + Math.abs(green - base[1]) + Math.abs(blue - base[2]) > 24) variedSamples += 1;
      colors.add(`${red >> 4}-${green >> 4}-${blue >> 4}-${alpha >> 5}`);
    }
    return { renderer, width, height, opaqueSamples, variedSamples, uniqueColorBuckets: colors.size };
  });
}

async function waitForPaint(mode) {
  const graph = page.locator(".skill-force-graph");
  await graph.waitFor();
  await page.waitForFunction((expectedMode) => document.querySelector(".skill-force-graph")?.getAttribute("data-graph-mode") === expectedMode, mode);
  await graph.locator("canvas").waitFor();
  await page.waitForFunction(() => document.querySelector(".skill-force-graph")?.getAttribute("data-render-state") === "settled", undefined, { timeout: 15_000 });
  let pixels;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(300);
    pixels = await canvasPixels();
    if (pixels.uniqueColorBuckets >= 4 && pixels.variedSamples > 10) return pixels;
  }
  throw new Error(`${mode.toUpperCase()} graph canvas remained blank: ${JSON.stringify(pixels)}`);
}

try {
  console.log(`[graph-verify] opening ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  console.log("[graph-verify] page probe", JSON.stringify({
    url: page.url(),
    title: await page.title(),
    body: (await page.locator("body").innerText()).slice(0, 500),
    consoleErrors,
    failedResponses
  }));
  console.log("[graph-verify] selecting a reusable workspace and creating a Skill through UI");
  const reusableOption = page.locator("#workspace-picker option").filter({ hasText: /^2D 3D 图谱验收 / }).first();
  if (await reusableOption.count()) {
    workspaceName = (await reusableOption.textContent())?.trim() ?? workspaceName;
    await page.locator("#workspace-picker").selectOption(await reusableOption.getAttribute("value") ?? "");
    await page.getByRole("heading", { name: workspaceName }).waitFor();
  } else {
    const createDialog = page.getByRole("dialog", { name: "新建工作区" });
    if (!(await createDialog.isVisible())) await page.getByRole("button", { name: "新建工作区" }).first().click();
    await createDialog.waitFor();
    await createDialog.getByLabel("工作区名称").fill(workspaceName);
    await createDialog.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("heading", { name: workspaceName }).waitFor();
  }
  console.log("[graph-verify] workspace ready");

  const existingSkillCell = page.getByRole("cell", { name: /^三维需求分析图谱(?: |$)/ }).first();
  if (await existingSkillCell.count()) {
    skillName = (await existingSkillCell.locator("strong").textContent())?.trim() ?? "三维需求分析图谱";
    await existingSkillCell.click();
  } else {
    await page.getByRole("button", { name: "添加 Skill" }).first().click();
    console.log("[graph-verify] add Skill dialog ready");
    await page.getByLabel("Skill 名称").fill(skillName);
    await page.getByLabel("说明").fill("验证同一语义图在二维与三维视图之间切换");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page.getByRole("cell", { name: skillName }).click();
  }
  console.log("[graph-verify] Skill created and selected");
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator(".graph-original-title", { hasText: `${skillName} 知识图谱` }).waitFor();
  if (await page.locator(".sidebar").isVisible()) throw new Error("Graph view did not enter the original immersive layout");

  console.log("[graph-verify] checking desktop 3D pixels");
  const graph = page.locator(".skill-force-graph");
  await graph.waitFor();
  if (await graph.getAttribute("data-node-count") !== "3") throw new Error("Default workflow graph did not project 3 nodes");
  if (await graph.getAttribute("data-edge-count") !== "2") throw new Error("Default workflow graph did not project 2 edges");
  if (await graph.getAttribute("data-graph-mode") !== "3d") throw new Error("Desktop graph did not default to 3D");
  const desktop3d = await waitForPaint("3d");
  await page.screenshot({ path: path.join(artifactDir, "force-graph-3d-desktop.png"), fullPage: true });

  await page.getByLabel("搜索图节点").fill("核心");
  await page.getByLabel("搜索图节点").press("Enter");
  await page.locator(".graph-inspector").getByRole("heading", { name: "核心步骤", exact: true }).waitFor();
  await page.locator(".graph-detail-tag", { hasText: "连接 2" }).waitFor();
  await page.getByText("入边（谁指向我）", { exact: true }).waitFor();
  await page.getByText("本节点无独立文档（步骤节点，信息全在图数据中）。", { exact: true }).waitFor();
  await page.waitForTimeout(1_000);
  const focused3d = await canvasPixels();
  if (focused3d.uniqueColorBuckets < 4 || focused3d.variedSamples <= 10) {
    throw new Error(`Focused 3D graph canvas became blank: ${JSON.stringify(focused3d)}`);
  }
  const originalStyle = await page.evaluate(() => {
    const toolbar = getComputedStyle(document.querySelector(".graph-toolbar"));
    const search = getComputedStyle(document.querySelector(".graph-search"));
    const graph = getComputedStyle(document.querySelector(".graph-render-surface"));
    const inspectorElement = document.querySelector(".graph-inspector");
    const inspector = getComputedStyle(inspectorElement);
    const hint = getComputedStyle(document.querySelector(".graph-interaction-hint"));
    const title = getComputedStyle(document.querySelector(".graph-original-title"));
    return {
      toolbarHeight: toolbar.height,
      toolbarGap: toolbar.gap,
      searchWidth: search.width,
      searchRadius: search.borderRadius,
      graphBackground: graph.backgroundImage,
      graphOpacity: graph.opacity,
      inspectorWidth: inspector.width,
      inspectorRadius: inspector.borderRadius,
      inspectorBorderTop: inspector.borderTopWidth,
      inspectorTop: `${Math.round(inspectorElement.getBoundingClientRect().top)}px`,
      hintFontSize: hint.fontSize,
      hintBottom: hint.bottom,
      titleMaxWidth: title.maxWidth,
      fitText: document.querySelector(".graph-fit-toolbar")?.textContent?.trim(),
      titleIsFirstControl: document.querySelector(".graph-toolbar")?.firstElementChild?.classList.contains("graph-original-title") ?? false,
      searchHasDecorativeIcon: Boolean(document.querySelector(".graph-find svg"))
    };
  });
  if (JSON.stringify(originalStyle) !== JSON.stringify({
    toolbarHeight: "46px",
    toolbarGap: "10px",
    searchWidth: "210px",
    searchRadius: "7px",
    graphBackground: originalStyle.graphBackground,
    graphOpacity: "1",
    inspectorWidth: "440px",
    inspectorRadius: "14px",
    inspectorBorderTop: "1px",
    inspectorTop: "56px",
    hintFontSize: "11px",
    hintBottom: "12px",
    titleMaxWidth: "none",
    fitText: "⤢ 适应",
    titleIsFirstControl: true,
    searchHasDecorativeIcon: false
  })) throw new Error(`Original graph style metrics changed: ${JSON.stringify(originalStyle)}`);
  if (!originalStyle.graphBackground.includes("radial-gradient")) throw new Error("Graph did not preserve the original radial canvas background");
  if (await page.locator('.graph-toolbar [title="图谱编辑工具"]').count()) throw new Error("Studio editor leaked back into the original top toolbar");
  const relationButton = page.getByRole("button", { name: /^关系 / });
  await relationButton.click();
  const relationPanel = page.getByLabel("关系类型筛选");
  await relationPanel.waitFor();
  const [relationButtonBox, relationPanelBox] = await Promise.all([relationButton.boundingBox(), relationPanel.boundingBox()]);
  if (!relationButtonBox || !relationPanelBox || Math.abs(relationButtonBox.x - relationPanelBox.x) > 1) {
    throw new Error(`Relation panel is not aligned with its button: ${JSON.stringify({ relationButtonBox, relationPanelBox })}`);
  }
  await relationButton.click();
  await page.getByRole("button", { name: /^变更 / }).click();
  await page.locator(".graph-changes-panel").waitFor();
  await page.getByTitle("图谱编辑工具").click();
  await page.locator(".graph-editor-menu").waitFor();
  await page.getByRole("button", { name: /^变更 / }).click();
  await page.locator(".graph-changes-panel").waitFor();
  await page.getByRole("button", { name: /^变更 / }).click();
  await page.screenshot({ path: path.join(artifactDir, "force-graph-3d-detail-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "深浅主题切换" }).click();
  await page.locator(".skill-force-graph.theme-dark").waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(artifactDir, "force-graph-3d-dark-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "深浅主题切换" }).click();
  await page.locator(".skill-force-graph.theme-light").waitFor();
  await page.locator(".graph-relation-chip .relation-kind").first().click();
  await page.locator(".graph-inspector .graph-detail-head > code").waitFor();

  console.log("[graph-verify] switching to desktop 2D");
  await page.getByRole("button", { name: "2D 平面" }).click();
  const desktop2d = await waitForPaint("2d");
  await page.screenshot({ path: path.join(artifactDir, "force-graph-2d-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "适应全图" }).click();

  await page.reload({ waitUntil: "networkidle" });
  console.log("[graph-verify] checking desktop mode persistence");
  await page.locator("#workspace-picker").selectOption({ label: workspaceName });
  await page.getByRole("heading", { name: workspaceName }).waitFor();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator('.skill-force-graph[data-graph-mode="2d"]').waitFor();
  const persistedDesktop2d = await waitForPaint("2d");

  await page.getByRole("button", { name: "3D 立体" }).click();
  await waitForPaint("3d");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  console.log("[graph-verify] checking mobile 2D default and layout");
  await page.locator("#workspace-picker").selectOption({ label: workspaceName });
  await page.getByRole("heading", { name: workspaceName }).waitFor();
  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.locator('.skill-force-graph[data-graph-mode="2d"]').waitFor();
  const mobile2d = await waitForPaint("2d");
  const mobileLayout = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth) throw new Error(`Mobile graph overflow: ${mobileLayout.documentWidth} > ${mobileLayout.viewportWidth}`);
  await page.screenshot({ path: path.join(artifactDir, "force-graph-2d-mobile.png"), fullPage: true });

  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  if (failedResponses.length) throw new Error(`Failed responses: ${failedResponses.join(" | ")}`);
  const report = { workspaceName, originalStyle, desktop3d, focused3d, desktop2d, persistedDesktop2d, mobile2d, mobileLayout, consoleErrors, failedResponses };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
