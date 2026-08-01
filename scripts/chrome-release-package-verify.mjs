import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const repositoryPackage = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const releaseSource = path.resolve(`dist/releases/skill-designer-${repositoryPackage.version}-macos`);
const skillRoot = "/Users/hongyuwu/IdeaProjects/yds-skills/mdd-backend-extend-develop";
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-release-chrome-"));
const installedRoot = path.join(temporaryRoot, "installed", "Skill Designer");
const dataRoot = path.join(temporaryRoot, "user-data");
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/release-package");
const port = await availablePort(4358, 4378);
const baseUrl = `http://127.0.0.1:${port}`;
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

const sourceBefore = await hashTree(skillRoot);
const installResult = JSON.parse((await execFileAsync(process.execPath, [path.join(releaseSource, "bin", "install.mjs"), "--target", installedRoot])).stdout);
if (!installResult.installed || installResult.target !== installedRoot || !installResult.dataPreserved || !installResult.platformMatchesRuntime) throw new Error(`Release installation failed: ${JSON.stringify(installResult)}`);
const doctor = JSON.parse((await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "doctor.mjs"), "--data-dir", dataRoot], { maxBuffer: 16 * 1024 * 1024 })).stdout);
if (!doctor.integrity.valid || doctor.integrity.checkedFiles < 1 || !doctor.runtime.nodeSupported || !doctor.package?.platformMatchesRuntime || !doctor.dataDirectory.writable || !doctor.chrome.found) {
  throw new Error(`Installed release doctor failed: ${JSON.stringify(doctor)}`);
}
const installedManifest = JSON.parse(await readFile(path.join(installedRoot, "release-manifest.json"), "utf8"));
assertDevelopmentPreviewTrust(installedManifest, doctor);
const entrypointFacts = await verifyEntrypoints();

const launcher = spawn(process.execPath, [path.join(installedRoot, "bin", "skill-designer.mjs"), "--no-open", "--port", String(port), "--data-dir", dataRoot], {
  cwd: installedRoot,
  stdio: ["ignore", "pipe", "pipe"]
});
const launcherOutput = [];
launcher.stdout.on("data", (chunk) => launcherOutput.push(String(chunk)));
launcher.stderr.on("data", (chunk) => launcherOutput.push(String(chunk)));
await waitForUrl(`${baseUrl}/api/session`, launcher, launcherOutput);

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(60_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

let preview;
let exportFacts;
let desktopGraphPixels;
let mobileMetrics;
let browserCloseCompleted = false;
try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("发布包首个项目闭环");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "发布包首个项目闭环" }).waitFor();

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
  preview = (await previewResponse.json()).data;
  const blocking = [...preview.candidate.diagnostics, ...preview.candidate.parseReview.lint].filter((issue) => issue.severity === "error");
  if (blocking.length) throw new Error(`Release import preview is blocked: ${JSON.stringify(blocking)}`);
  await importDialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await importDialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /mdd-backend-extend-develop/u }).waitFor();

  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill("routing-table");
  await page.getByRole("button", { name: /references\/routing-table\.md/u }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  const original = await editor.inputValue();
  await editor.fill(`${original}\n## 发布包页面验收\n\n该内容只写入发布包的临时管理副本。\n`);
  await page.getByRole("button", { name: "预览并保存", exact: true }).click();
  const changeDialog = page.getByRole("dialog", { name: "确认文档变更" });
  await changeDialog.getByText("references/routing-table.md", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "release-package-changeset-desktop.png"), fullPage: true });
  await changeDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await changeDialog.waitFor({ state: "hidden" });
  if (!(await editor.inputValue()).includes("发布包页面验收")) throw new Error("Confirmed release document edit did not remain visible");

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  const graph = page.locator(`.skill-force-graph[data-node-count="${preview.candidate.parseReview.nodes.length}"]`);
  await graph.waitFor();
  await page.getByRole("button", { name: "2D 平面", exact: true }).click();
  const settled = page.locator('.skill-force-graph[data-graph-mode="2d"][data-render-state="settled"]');
  await settled.waitFor();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  await page.waitForTimeout(600);
  desktopGraphPixels = await canvasPixels(settled);
  if (desktopGraphPixels.nonBackgroundPixels < 100) throw new Error(`Release graph canvas is blank: ${JSON.stringify(desktopGraphPixels)}`);
  await page.screenshot({ path: path.join(artifactDir, "release-package-graph-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "导出通用包", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出通用 Skill 包" });
  await exportDialog.locator(".export-file-section code").filter({ hasText: "references/routing-table.md" }).waitFor();
  await exportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await exportDialog.getByRole("button", { name: "下载 ZIP", exact: true }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportDialog.getByRole("button", { name: "下载 ZIP", exact: true }).click()
  ]);
  const exportedZip = path.join(artifactDir, "release-package-first-project.zip");
  await download.saveAs(exportedZip);
  const zip = new AdmZip(exportedZip);
  const entries = zip.getEntries().map((entry) => entry.entryName);
  for (const required of ["SKILL.md", "skill.json", "graph/main.json", "engine/skill-engine.mjs", "export-manifest.json"]) {
    if (!entries.includes(required)) throw new Error(`Release package export is missing ${required}`);
  }
  const exportedDocument = zip.readAsText("references/routing-table.md");
  if (!exportedDocument.includes("发布包页面验收")) throw new Error("Generic export did not use the confirmed release revision");
  exportFacts = { zipEntries: entries.length, requiredFilesPresent: true, confirmedEditPresent: true };
  await exportDialog.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await page.getByLabel("搜索文档").fill("routing-table");
  await page.getByRole("button", { name: /references\/routing-table\.md/u }).click();
  mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Release mobile overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "release-package-mobile.png"), fullPage: true });
  if (consoleErrors.length || failedResponses.length) throw new Error(`Release browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);
} finally {
  browserCloseCompleted = await closeBrowser(browser, page);
  launcher.kill("SIGTERM");
  await waitForExit(launcher, 10_000);
}

const sourceAfter = await hashTree(skillRoot);
if (!sameTree(sourceBefore, sourceAfter)) throw new Error("Release verification modified the source Skill repository");
const workspaceFilesBeforeUninstall = await countFiles(dataRoot);
const uninstallResult = JSON.parse((await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "uninstall.mjs"), "--yes", "--data-dir", dataRoot])).stdout);
if (!uninstallResult.uninstalled || uninstallResult.dataRemoved || await exists(installedRoot) || !await exists(dataRoot)) {
  throw new Error(`Release uninstall did not preserve data: ${JSON.stringify(uninstallResult)}`);
}
const workspaceFilesAfterUninstall = await countFiles(dataRoot);
if (workspaceFilesAfterUninstall !== workspaceFilesBeforeUninstall || workspaceFilesAfterUninstall < 1) throw new Error("Uninstall changed the user data directory");

const verification = {
  browser: "Google Chrome",
  release: {
    version: doctor.package.version,
    targetPlatform: doctor.package.targetPlatform,
    releaseChannel: doctor.package.releaseChannel,
    signingStatus: doctor.releaseTrust.signingStatus,
    trustLevel: doctor.releaseTrust.trustLevel,
    platformMatchesRuntime: doctor.package.platformMatchesRuntime,
    installed: true,
    coreStartedFromInstalledPackage: true
  },
  doctor: {
    node: doctor.runtime.node,
    integrityValid: doctor.integrity.valid,
    checkedFiles: doctor.integrity.checkedFiles,
    platformMatchesRuntime: doctor.package.platformMatchesRuntime,
    chromeFound: doctor.chrome.found,
    dataWritable: doctor.dataDirectory.writable,
    releaseTrust: doctor.releaseTrust
  },
  entrypoints: entrypointFacts,
  firstProject: {
    workspaceId: preview.workspace.workspaceId,
    projectId: preview.candidate.projectId,
    sourceFileCount: sourceBefore.size,
    nodeCount: preview.candidate.parseReview.nodes.length,
    edgeCount: preview.candidate.parseReview.edges.length,
    importedThroughPage: true,
    documentChangeSetConfirmedThroughPage: true,
    graphCanvas: desktopGraphPixels,
    genericExport: exportFacts,
    sourceBytesUnchanged: true
  },
  uninstall: { programRemoved: true, userDataPreserved: true, userDataFileCount: workspaceFilesAfterUninstall },
  harnessCleanup: { browserCloseCompleted, launcherStopped: true },
  mobileMetrics,
  consoleErrors,
  failedResponses,
  completedAt: new Date().toISOString()
};
await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
console.log(JSON.stringify(verification, null, 2));
await rm(temporaryRoot, { recursive: true, force: true });
if (!browserCloseCompleted) throw new Error("Visible Chrome did not close cleanly after release verification");
process.exit(0);

async function verifyEntrypoints() {
  const windowsRoot = path.resolve(`dist/releases/skill-designer-${repositoryPackage.version}-windows`);
  const windowsManifest = JSON.parse(await readFile(path.join(windowsRoot, "release-manifest.json"), "utf8"));
  assertDevelopmentPreviewTrust(windowsManifest);
  const oneShot = new Set(["diagnose", "install", "uninstall"]);
  const staticChecks = [];
  for (const id of ["start", "diagnose", "install", "uninstall"]) {
    const shell = await readFile(path.join(installedRoot, `${id}.command`), "utf8");
    if (/^\s*set\s+-\S*e/mu.test(shell)) throw new Error(`${id}.command enables errexit, so the node exit code and close prompt would be skipped`);
    const shellNode = shell.indexOf('node "bin/');
    if (shellNode < 0 || shell.indexOf("status=$?") < shellNode) throw new Error(`${id}.command does not capture the node exit code right after node`);
    if (!shell.trimEnd().endsWith("exit $status")) throw new Error(`${id}.command does not return the captured node exit code`);
    const shellAlwaysPauses = !shell.includes("if [ $status -ne 0 ]; then");
    if (shellAlwaysPauses !== oneShot.has(id)) throw new Error(`${id}.command pause policy is wrong (alwaysPauses=${shellAlwaysPauses})`);

    const batch = await readFile(path.join(windowsRoot, `${id}.cmd`), "utf8");
    const batchNode = batch.indexOf('node "bin\\');
    const batchSave = batch.indexOf('set "status=%errorlevel%"');
    if (batchNode < 0 || batchSave < batchNode) throw new Error(`${id}.cmd does not save errorlevel immediately after node`);
    if (batch.indexOf("pause", batchSave) < batchSave) throw new Error(`${id}.cmd never pauses after saving errorlevel`);
    if (batch.slice(batchSave).includes("exit /b %errorlevel%")) throw new Error(`${id}.cmd returns %errorlevel% after pause, losing the node exit code`);
    if (!batch.trimEnd().endsWith("exit /b %status%")) throw new Error(`${id}.cmd does not return the saved node exit code`);
    const batchAlwaysPauses = !batch.includes('if not "%status%"=="0" pause');
    if (batchAlwaysPauses !== oneShot.has(id)) throw new Error(`${id}.cmd pause policy is wrong (alwaysPauses=${batchAlwaysPauses})`);
    staticChecks.push({ id, macAlwaysPauses: shellAlwaysPauses, windowsAlwaysPauses: batchAlwaysPauses, errexit: false, savesExitCodeBeforePause: true });
  }

  const successRun = await runShortcut(path.join(installedRoot, "diagnose.command"), ["--data-dir", dataRoot]);
  if (successRun.code !== 0) throw new Error(`diagnose.command failed on a healthy package: ${JSON.stringify(successRun)}`);
  if (!successRun.stdout.includes('"product": "Skill Designer"')) throw new Error("diagnose.command did not emit the doctor report");
  if (!successRun.stdout.includes('"releaseChannel": "development-preview"') || !successRun.stdout.includes('"publisherTrustEstablished": false')) {
    throw new Error("diagnose.command did not report the unsigned development-preview trust boundary");
  }
  if (!successRun.stdout.includes("按回车键关闭")) throw new Error("diagnose.command closed without letting the user read a successful result");

  const readOnlyParent = path.join(temporaryRoot, "read-only-parent");
  await mkdir(readOnlyParent, { recursive: true });
  await chmod(readOnlyParent, 0o500);
  let failureRun;
  try {
    failureRun = await runShortcut(path.join(installedRoot, "diagnose.command"), ["--data-dir", path.join(readOnlyParent, "blocked-data")]);
  } finally {
    await chmod(readOnlyParent, 0o700);
  }
  if (failureRun.code !== 1) throw new Error(`diagnose.command lost the real doctor exit code: ${JSON.stringify(failureRun)}`);
  if (!failureRun.stdout.includes('"writable": false')) throw new Error("diagnose.command did not report the unwritable data directory as a structured check");
  if (!failureRun.stdout.includes("按回车键关闭")) throw new Error("diagnose.command closed without showing the failure reason");

  const startShell = await readFile(path.join(installedRoot, "start.command"), "utf8");
  const startSuccess = await runShortcut(path.join(installedRoot, "start.command"), ["--diagnose", "--data-dir", dataRoot]);
  if (startSuccess.code !== 0) throw new Error(`start.command failed while delegating to the launcher: ${JSON.stringify(startSuccess)}`);
  if (startSuccess.stdout.includes("按回车键关闭")) throw new Error("start.command paused on success, which would block the service entrypoint");

  return {
    checkedThroughInstalledPackage: true,
    scripts: staticChecks,
    executedDiagnoseSuccess: { exitCode: successRun.code, pausedForUser: true },
    executedDiagnoseFailure: { exitCode: failureRun.code, pausedForUser: true, reportedUnwritableDataDirectory: true },
    executedStartSuccess: { exitCode: startSuccess.code, pausedForUser: false },
    macosUsesErrexit: /^\s*set\s+-\S*e/mu.test(startShell)
  };
}

function assertDevelopmentPreviewTrust(manifest, doctorReport) {
  const validManifest = manifest.releaseChannel === "development-preview"
    && manifest.signing?.status === "unsigned"
    && manifest.signing?.trustLevel === "integrity-only"
    && manifest.signing?.distribution === "local-development"
    && manifest.signing?.macos?.appleCodeSigned === false
    && manifest.signing?.macos?.notarized === false
    && manifest.signing?.windows?.authenticodeSigned === false;
  if (!validManifest) throw new Error(`Release manifest does not declare the supported development-preview trust contract: ${JSON.stringify(manifest.signing)}`);
  if (!doctorReport) return;
  const validDoctor = doctorReport.package?.releaseChannel === manifest.releaseChannel
    && doctorReport.package?.platformMatchesRuntime === true
    && doctorReport.releaseTrust?.releaseChannel === manifest.releaseChannel
    && doctorReport.releaseTrust?.signingStatus === manifest.signing.status
    && doctorReport.releaseTrust?.trustLevel === manifest.signing.trustLevel
    && doctorReport.releaseTrust?.distribution === manifest.signing.distribution
    && doctorReport.releaseTrust?.publisherTrustEstablished === false
    && doctorReport.releaseTrust?.integrityOnly === true
    && doctorReport.releaseTrust?.platforms?.macos?.appleCodeSigned === false
    && doctorReport.releaseTrust?.platforms?.macos?.notarized === false
    && doctorReport.releaseTrust?.platforms?.windows?.authenticodeSigned === false
    && Array.isArray(doctorReport.releaseTrust?.warnings)
    && doctorReport.releaseTrust.warnings.length >= 2;
  if (!validDoctor) throw new Error(`Doctor and release manifest disagree about trust: ${JSON.stringify(doctorReport.releaseTrust)}`);
}

async function runShortcut(script, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [script, ...args], {
      cwd: path.dirname(script),
      // 空 stdin 让 `read` 立即返回 EOF，暂停提示仍然写入 stdout，可被断言。
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForUrl(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Release launcher exited early (${child.exitCode}): ${output.join("").slice(-3000)}`);
    try {
      const response = await fetch(url, { headers: { Origin: baseUrl } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Release launcher did not serve ${url}`);
}

async function waitForExit(child, timeout) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Release launcher did not stop")), timeout))
  ]);
}

async function closeBrowser(target, activePage) {
  // 页面关闭只是释放 Canvas/WebGL 与下载句柄的准备动作；即使它超时，也必须继续关闭浏览器。
  // 最终只以 Playwright 连接已断开作为清理成功证据，避免 context 延迟造成假失败。
  if (!activePage.isClosed()) await completesWithin(activePage.close({ runBeforeUnload: false }), 20_000);
  if (!target.isConnected()) return true;
  await completesWithin(target.close({ reason: "release package verification completed" }), 60_000);
  return !target.isConnected();
}

async function completesWithin(promise, timeout) {
  let completed = false;
  try {
    await Promise.race([
      promise.then(() => { completed = true; }),
      new Promise((resolve) => setTimeout(resolve, timeout))
    ]);
  } catch {
    return false;
  }
  return completed;
}

async function availablePort(first, last) {
  for (let port = first; port <= last; port++) if (await canListen(port)) return port;
  throw new Error(`No free release verification port in ${first}-${last}`);
}

async function canListen(port) {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function hashTree(root) {
  const result = new Map();
  async function walk(relative = "") {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
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

async function countFiles(root) {
  let count = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
      else if (entry.isFile()) count++;
    }
  }
  await walk(root);
  return count;
}

async function exists(target) {
  return await stat(target).then(() => true, () => false);
}

async function canvasPixels(graphLocator) {
  return await graphLocator.locator("canvas").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    if (!context) return { renderer: "unknown", width: canvas.width, height: canvas.height, nonBackgroundPixels: 0 };
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBackgroundPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0 && (pixels[index] < 235 || pixels[index + 1] < 235 || pixels[index + 2] < 235)) nonBackgroundPixels++;
    }
    return { renderer: "canvas-2d", width: canvas.width, height: canvas.height, nonBackgroundPixels };
  });
}
