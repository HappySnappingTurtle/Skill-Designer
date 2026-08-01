import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const execFileAsync = promisify(execFile);
const skillRoot = "/Users/hongyuwu/IdeaProjects/yds-skills/mdd-backend-extend-develop";
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-real-mdd-external-export-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/real-skill-mdd-generic-export");
const baseUrl = "http://127.0.0.1:4351";
const sourceBefore = await hashTree(skillRoot);
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const importLLMParser = {
  latest: async () => null,
  start: async () => { throw new Error("LLM parsing is outside this export verification"); },
  cancel: async () => null
};
const server = createApp({ store, importLLMParser, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4351, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, acceptDownloads: true });
page.setDefaultTimeout(45_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const createDialog = page.getByRole("dialog", { name: "新建工作区" });
  await createDialog.getByLabel("工作区名称").fill("真实 MDD Skill 外部 Agent 验收");
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "真实 MDD Skill 外部 Agent 验收" }).waitFor();

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
  const preview = (await previewResponse.json()).data;
  const candidate = preview.candidate;
  await importDialog.getByText("0 待检查", { exact: false }).waitFor();
  await importDialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await importDialog.waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /mdd-backend-extend-develop/u }).waitFor();

  const workspace = await store.getWorkspace(preview.workspace.workspaceId);
  const member = workspace.members.find((item) => item.projectId === candidate.projectId);
  if (!member || member.status !== "ready") throw new Error("Real Skill import did not become ready");
  const graphRecord = await store.getProjectGraph(member.projectId);
  const startNode = graphRecord.graph.nodes.find((node) => node.id === graphRecord.graph.entry);
  const endNode = graphRecord.graph.nodes.find((node) => node.kind === "end");
  if (!startNode || !endNode) throw new Error("Real Skill graph is missing an entry or end node");
  const orderedPath = sequentialPath(graphRecord.graph, startNode.id, endNode.id);

  await page.getByRole("button", { name: "导出通用包", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出通用 Skill 包" });
  await exportDialog.getByText("generic/1", { exact: true }).waitFor();
  await exportDialog.locator(".export-file-section code").filter({ hasText: "engine/skill-engine.mjs" }).waitFor();
  await exportDialog.locator(".export-file-section code").filter({ hasText: "engine/README.md" }).waitFor();
  await exportDialog.getByText("包内包含 16 个脚本文件；通用引擎不会自动执行它们", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "generic-export-preview-desktop.png"), fullPage: true });
  await exportDialog.getByRole("button", { name: "确认并生成", exact: true }).click();
  await exportDialog.getByRole("button", { name: "下载 ZIP", exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "generic-export-ready-desktop.png"), fullPage: true });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportDialog.getByRole("button", { name: "下载 ZIP", exact: true }).click()
  ]);
  const zipPath = path.join(artifactDir, "real-mdd-generic-external-agent.zip");
  await download.saveAs(zipPath);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, html: document.documentElement.scrollWidth }));
  if (mobileMetrics.body > mobileMetrics.viewport || mobileMetrics.html > mobileMetrics.viewport) throw new Error(`Mobile export overflow: ${JSON.stringify(mobileMetrics)}`);
  await page.screenshot({ path: path.join(artifactDir, "generic-export-ready-mobile.png"), fullPage: true });

  const externalRoot = path.join(dataRoot, "external-agent-clean-room");
  const packageRoot = path.join(externalRoot, "package");
  const stateRoot = path.join(externalRoot, "state");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const zip = new AdmZip(zipPath);
  const archiveEntries = zip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName);
  zip.extractAllTo(packageRoot, true);
  const packageManifest = JSON.parse(await readFile(path.join(packageRoot, "export-manifest.json"), "utf8"));
  if (packageManifest.files.length !== archiveEntries.length - 1) throw new Error(`Export manifest coverage mismatch: ${packageManifest.files.length}/${archiveEntries.length - 1}`);
  for (const sourcePath of sourceBefore.keys()) if (!archiveEntries.includes(sourcePath)) throw new Error(`Generic Export lost real source file: ${sourcePath}`);
  for (const required of ["skill.json", "graph/main.json", "engine/skill-engine.mjs", "engine/README.md", "export-manifest.json"]) {
    if (!archiveEntries.includes(required)) throw new Error(`Generic Export is missing ${required}`);
  }
  if (archiveEntries.some((entry) => /(?:^|\/)(?:workspace\.json|runtime-artifact|baseline\.json|trace|reports?)(?:\/|$)/u.test(entry))) throw new Error("Generic Export leaked Studio-private files");

  const cli = path.join(packageRoot, "engine", "skill-engine.mjs");
  const cliSource = await readFile(cli, "utf8");
  const cliImports = [...cliSource.matchAll(/from '([^']+)'/gu)].map((match) => match[1]);
  if (cliImports.some((specifier) => !specifier.startsWith("node:"))) throw new Error(`Generic CLI imports a non-built-in dependency: ${JSON.stringify(cliImports)}`);
  if (/\b(?:fetch|XMLHttpRequest|child_process|spawn|execFile|node:https|node:http|node:net)\b/u.test(cliSource)) throw new Error("Generic CLI contains network or child-process execution capability");
  const readme = await readFile(path.join(packageRoot, "engine", "README.md"), "utf8");
  if (!readme.includes("skill-engine.mjs verify")) throw new Error("Generic Engine README does not document package verification");

  const cleanEnvironment = { LANG: "C.UTF-8", NODE_PATH: "" };
  const runCli = async (args) => JSON.parse((await execFileAsync(process.execPath, [cli, ...args], { cwd: externalRoot, env: cleanEnvironment })).stdout);
  const integrityBefore = await runCli(["verify"]);
  if (!integrityBefore.valid || integrityBefore.checkedFiles !== packageManifest.files.length) throw new Error(`CLI did not verify the complete package: ${JSON.stringify(integrityBefore)}`);
  const packageBeforeRun = await hashTree(packageRoot);

  const tamperPath = "SKILL.md";
  const tamperTarget = path.join(packageRoot, tamperPath);
  const originalTamperBytes = await readFile(tamperTarget);
  await writeFile(tamperTarget, Buffer.concat([originalTamperBytes, Buffer.from("\nT41 tamper probe\n")]));
  const tamperFailure = await expectCliFailure(cli, ["verify"], externalRoot, cleanEnvironment, "package_integrity_failed");
  if (!tamperFailure.error.details.mismatches.some((item) => item.path === tamperPath && item.code === "mismatch")) throw new Error(`Tampered file was not identified: ${JSON.stringify(tamperFailure)}`);
  await writeFile(tamperTarget, originalTamperBytes);
  const integrityRestored = await runCli(["verify"]);
  if (!integrityRestored.valid) throw new Error("Restored package did not pass integrity verification");

  const inspected = await runCli(["inspect"]);
  if (inspected.nodes !== graphRecord.graph.nodes.length || inspected.edges !== graphRecord.graph.edges.length || inspected.skillId !== member.skillId) throw new Error(`CLI inspect identity mismatch: ${JSON.stringify(inspected)}`);
  const transitions = await runCli(["transitions", startNode.id, "--variables", "{}"]);
  if (transitions.length !== 1 || transitions[0].to !== orderedPath[1]) throw new Error(`CLI returned unexpected entry transitions: ${JSON.stringify(transitions)}`);

  const runState = path.join(stateRoot, "completed-run.json");
  const started = await runCli(["run", "start", "--state", runState, "--variables", JSON.stringify({ acceptance: "t41-real-skill" })]);
  const paused = await runCli(["run", "pause", "--state", runState]);
  const resumed = await runCli(["run", "resume", "--state", runState]);
  const rejected = await runCli(["run", "next", "--state", runState, "--to", endNode.id]);
  if (started.state.currentNodeId !== startNode.id || paused.state.status !== "paused" || resumed.state.status !== "running") throw new Error("CLI start/pause/resume lifecycle failed");
  if (rejected.status !== "rejected" || rejected.rejection.code !== "next_node_not_allowed" || rejected.state.currentNodeId !== startNode.id || rejected.state.step !== 0) throw new Error(`CLI illegal transition changed state: ${JSON.stringify(rejected)}`);
  let latest = rejected;
  for (const nodeId of orderedPath.slice(1)) latest = await runCli(["run", "next", "--state", runState, "--to", nodeId]);
  const completed = await runCli(["run", "status", "--state", runState]);
  if (latest.status !== "done" || completed.state.status !== "completed" || completed.state.currentNodeId !== endNode.id || completed.state.step !== orderedPath.length - 1) throw new Error(`CLI did not complete the real workflow: ${JSON.stringify(completed)}`);
  if (!completed.state.events.some((event) => event.type === "engine.reject") || completed.state.events.at(-1)?.type !== "engine.complete") throw new Error("CLI completed Trace did not preserve rejection and completion facts");

  const stoppedState = path.join(stateRoot, "stopped-run.json");
  await runCli(["run", "start", "--state", stoppedState]);
  const stopped = await runCli(["run", "stop", "--state", stoppedState]);
  if (stopped.state.status !== "stopped" || stopped.newEvents.at(-1)?.type !== "engine.stop") throw new Error(`CLI stop lifecycle failed: ${JSON.stringify(stopped)}`);

  const integrityAfter = await runCli(["verify"]);
  const packageAfterRun = await hashTree(packageRoot);
  if (!sameTree(packageBeforeRun, packageAfterRun)) throw new Error("External CLI execution modified the exported package");
  const sourceAfter = await hashTree(skillRoot);
  if (!sameTree(sourceBefore, sourceAfter)) throw new Error("Generic Export verification modified the user-provided source Skill");
  if (consoleErrors.length || failedResponses.length) throw new Error(`Browser failures:\n${[...consoleErrors, ...failedResponses].join("\n")}`);

  const verification = {
    browser: "Google Chrome",
    platform: `${process.platform}-${process.arch}`,
    source: { root: skillRoot, fileCount: sourceBefore.size, bytesUnchanged: true },
    export: {
      profile: packageManifest.profile,
      archiveEntryCount: archiveEntries.length,
      declaredFileCount: packageManifest.files.length,
      originalPathsPreserved: sourceBefore.size,
      studioPrivateFiles: 0
    },
    externalAgent: {
      npmInstallPerformed: false,
      imports: cliImports,
      integrityBefore,
      tamperDetected: { path: tamperPath, code: tamperFailure.error.code },
      integrityAfter,
      inspected,
      exactPath: orderedPath,
      completedStatus: completed.state.status,
      completedStep: completed.state.step,
      completedEventTypes: completed.state.events.map((event) => event.type),
      stoppedStatus: stopped.state.status,
      stateStoredOutsidePackage: true,
      packageBytesUnchangedAfterRuns: true
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

async function expectCliFailure(cli, args, cwd, env, code) {
  try {
    await execFileAsync(process.execPath, [cli, ...args], { cwd, env });
  } catch (error) {
    const parsed = JSON.parse(error.stderr);
    if (parsed.error?.code !== code) throw new Error(`Expected CLI error ${code}, received ${error.stderr}`);
    return parsed;
  }
  throw new Error(`Expected CLI command to fail with ${code}`);
}

function sequentialPath(graph, startNodeId, endNodeId) {
  const result = [startNodeId];
  const seen = new Set(result);
  let current = startNodeId;
  while (current !== endNodeId) {
    const outgoing = graph.edges.filter((edge) => edge.from === current && edge.kind !== "knowledge");
    if (outgoing.length !== 1) throw new Error(`Expected one sequential exit from ${current}, received ${outgoing.length}`);
    current = outgoing[0].to;
    if (seen.has(current)) throw new Error(`Sequential graph contains a cycle at ${current}`);
    seen.add(current);
    result.push(current);
  }
  return result;
}

async function hashTree(root) {
  const result = new Map();
  async function walk(relative = "") {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.set(next, createHash("sha256").update(await readFile(path.join(root, next))).digest("hex"));
      else throw new Error(`Unsupported entry: ${next}`);
    }
  }
  await walk();
  return result;
}

function sameTree(left, right) {
  return left.size === right.size && [...left].every(([file, digest]) => right.get(file) === digest);
}
