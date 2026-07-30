import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const execFileAsync = promisify(execFile);
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-git-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const fixtureSource = path.resolve("scripts/fixtures/git-skill");
const repositoryRoot = path.join(dataRoot, "repository");
const projectRoot = path.join(repositoryRoot, "skills", "git-skill");
const baseUrl = "http://127.0.0.1:4327";
await mkdir(artifactDir, { recursive: true });
await mkdir(path.dirname(projectRoot), { recursive: true });
await cp(fixtureSource, projectRoot, { recursive: true });
await mkdir(path.join(projectRoot, "assets"), { recursive: true });
await writeFile(path.join(projectRoot, "assets", "logo.bin"), Buffer.from([0, 1, 2, 3]));
await writeFile(path.join(repositoryRoot, "outside.txt"), "仓库外层初始内容\n");
await execFileAsync("git", ["init", "-q"], { cwd: repositoryRoot });
await execFileAsync("git", ["config", "user.email", "chrome@example.invalid"], { cwd: repositoryRoot });
await execFileAsync("git", ["config", "user.name", "Chrome Git Verification"], { cwd: repositoryRoot });
await execFileAsync("git", ["add", "."], { cwd: repositoryRoot });
await execFileAsync("git", ["commit", "-qm", "initial skill"], { cwd: repositoryRoot });
const initialOid = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
await execFileAsync("git", ["tag", "v1.0"], { cwd: repositoryRoot });
await writeFile(path.join(projectRoot, "SKILL.md"), "# Chrome Git Skill\n\n第二版提交。\n");
await execFileAsync("git", ["add", "skills/git-skill/SKILL.md"], { cwd: repositoryRoot });
await execFileAsync("git", ["commit", "-qm", "second skill"], { cwd: repositoryRoot });
await writeFile(path.join(projectRoot, "SKILL.md"), "# Chrome Git Skill\n\nChrome 工作树修改。\n");
await writeFile(path.join(projectRoot, "assets", "logo.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
await writeFile(path.join(projectRoot, "assets", "untracked.bin"), Buffer.from([0, 8, 9]));
await mkdir(path.join(projectRoot, "docs"), { recursive: true });
await writeFile(path.join(projectRoot, "docs", "untracked.md"), "# Chrome 未跟踪文档\n");
await writeFile(path.join(repositoryRoot, "outside.txt"), "项目外修改不得显示\n");

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "Git Ref Chrome 验收" });
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4327, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  console.log("[git-reference] opening workspace");
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: workspace.name }).waitFor();
  await page.getByRole("button", { name: "原地打开" }).click();
  const openDialog = page.getByRole("dialog", { name: "原地打开 Git Skill" });
  await openDialog.getByLabel("Skill 根目录绝对路径").fill(projectRoot);
  await openDialog.getByRole("button", { name: "确认并打开" }).click();
  await openDialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /Chrome Git Skill/u }).waitFor();

  console.log("[git-reference] loading HEAD comparison and refs");
  await page.getByRole("button", { name: "Git 对比" }).click();
  const dialog = page.getByRole("dialog", { name: "Git 对比" });
  await dialog.getByText("仓库事实只读对比，不是待确认的 ChangeSet 提案", { exact: true }).waitFor();
  const baseSelect = dialog.getByLabel("Git 比较基准");
  await baseSelect.waitFor();
  const tagOption = baseSelect.locator("option").filter({ hasText: "v1.0" });
  const tagValue = await tagOption.getAttribute("value");
  if (tagValue !== initialOid) throw new Error(`Tag option did not resolve to its commit OID: ${tagValue}`);
  if ((await dialog.locator(".git-file-section li").count()) !== 4) throw new Error("HEAD comparison did not show four in-scope changes");
  await dialog.locator(".git-file-section li").filter({ hasText: "assets/logo.bin" }).getByText("二进制", { exact: true }).waitFor();
  await dialog.locator(".git-binary-section li").filter({ hasText: "assets/logo.bin" }).getByText("4 B → 6 B", { exact: true }).waitFor();
  await dialog.locator(".git-binary-section li").filter({ hasText: "assets/untracked.bin" }).getByText("不存在 → 3 B", { exact: true }).waitFor();
  await dialog.locator(".git-patch-section pre").getByText(/Chrome 工作树修改/u).waitFor();
  if ((await dialog.getByText(/outside\.txt|项目外修改/u).count()) !== 0) throw new Error("Git comparison exposed repository content outside the Skill root");
  await page.screenshot({ path: path.join(artifactDir, "git-reference-head-desktop.png"), fullPage: true });

  console.log("[git-reference] switching to v1.0 tag");
  await baseSelect.selectOption(initialOid);
  await dialog.locator(`code[title="${initialOid}"]`).waitFor();
  await dialog.locator(".git-patch-section pre").getByText(/这是提交到 HEAD 的初始文档/u).waitFor();
  await dialog.locator(".git-patch-section pre").getByText(/Chrome 工作树修改/u).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "git-reference-tag-desktop.png"), fullPage: true });
  console.log("[git-reference] refreshing selected base");
  await dialog.getByRole("button", { name: "刷新 Git 对比" }).click();
  await dialog.locator(`code[title="${initialOid}"]`).waitFor();

  console.log("[git-reference] checking mobile layout");
  await page.setViewportSize({ width: 390, height: 844 });
  await baseSelect.waitFor();
  const mobileFacts = await dialog.locator(".git-facts").evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns,
    children: [...element.children].map((child) => {
      const box = child.getBoundingClientRect();
      return { text: child.textContent?.trim(), display: getComputedStyle(child).display, x: box.x, y: box.y, width: box.width, height: box.height };
    })
  }));
  if (mobileFacts.children.length !== 4 || mobileFacts.children.some((item) => item.display === "none" || item.width < 1 || item.height < 1)) {
    throw new Error(`Mobile Git facts are not all rendered: ${JSON.stringify(mobileFacts)}`);
  }
  const factsBox = await dialog.locator(".git-facts").boundingBox();
  const filesBox = await dialog.locator(".git-file-section").boundingBox();
  if (!factsBox || !filesBox || factsBox.y + factsBox.height > filesBox.y) throw new Error(`Mobile Git sections overlap: ${JSON.stringify({ factsBox, filesBox })}`);
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  if (overflow.document > overflow.viewport) throw new Error(`Mobile Git dialog overflow: ${overflow.document}px > ${overflow.viewport}px`);
  const dialogBox = await dialog.boundingBox();
  if (!dialogBox || dialogBox.y < 0 || dialogBox.y + dialogBox.height > 844) throw new Error(`Mobile Git dialog escaped viewport: ${JSON.stringify(dialogBox)}`);
  const footerClose = dialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true });
  await footerClose.waitFor();
  const closeIsTopmost = await footerClose.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === element || element.contains(hit);
  });
  if (!closeIsTopmost) throw new Error("Mobile Git close button is covered by another layer");
  await dialog.locator(".git-diff-body").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(artifactDir, "git-reference-mobile.png"), fullPage: false });
  await dialog.locator(".git-diff-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await dialog.locator(".git-binary-section").waitFor();
  await page.screenshot({ path: path.join(artifactDir, "git-reference-mobile-binary.png"), fullPage: false });

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  const report = {
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version() },
    verified: {
      headAndTagSelection: true,
      tagResolvedToCommitOid: initialOid,
      textPatchChangedWithBase: true,
      binarySummaries: 2,
      projectBoundaryIsolated: true,
      readonlyExplanationVisible: true,
      refreshPreservedBase: true,
      mobileHorizontalOverflow: false
    },
    screenshots: ["git-reference-head-desktop.png", "git-reference-tag-desktop.png", "git-reference-mobile.png", "git-reference-mobile-binary.png"]
  };
  await writeFile(path.join(artifactDir, "git-reference-verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("Chrome Git reference verification passed: HEAD/tag selection, text patch, binary summaries, path isolation, refresh and mobile layout.");
  console.log(`Report: ${path.join(artifactDir, "git-reference-verification.json")}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
