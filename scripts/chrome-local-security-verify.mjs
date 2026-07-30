import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-security-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4340";
await mkdir(artifactDir, { recursive: true });
const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "本地安全 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, { name: "路径边界 Skill", capability: "workflow" });
const member = created.members[0];
const graph = await store.getProjectGraph(member.projectId);
const proposal = await store.createChangeSet(member.projectId, {
  workspaceId: workspace.workspaceId,
  baseRevision: graph.activeRevision,
  reason: "准备安全验收文档",
  operations: [{ op: "docs.write", target: "docs/guide.md", value: "# 安全指南\n\n项目内正文。\n" }]
});
await store.confirmAndApplyChangeSet(proposal.changeSetId, { digest: proposal.digest, baseRevision: proposal.baseRevision });
const source = JSON.parse(await readFile(path.join(dataRoot, "studio", "projects", member.projectId, "source.json"), "utf8"));
const outside = path.join(dataRoot, "outside-secret.md");
const linked = path.join(source.root, "docs", "guide.md");
await writeFile(outside, "# 项目外秘密\n\nSYMLINK_SECRET_MUST_NOT_RENDER\n", "utf8");

const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4340, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15_000);
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => {
  if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
});

function requestWithHost(host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: 4340, path: "/api/session", headers: { Host: host, Origin: baseUrl } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "本地安全 Chrome 验收" }).waitFor();
  await unlink(linked);
  await symlink(outside, linked);

  await page.getByRole("button", { name: "文档", exact: true }).click();
  const alert = page.getByRole("alert");
  await alert.getByText("文档目录不接受符号链接", { exact: false }).waitFor();
  if ((await page.locator("body").innerText()).includes("SYMLINK_SECRET_MUST_NOT_RENDER")) throw new Error("项目外 symlink 正文出现在页面");
  await page.screenshot({ path: path.join(artifactDir, "local-security-symlink-desktop.png"), fullPage: true });

  const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { Origin: baseUrl } });
  const token = (await sessionResponse.json()).data.token;
  const badOriginStatus = (await fetch(`${baseUrl}/api/session`, { headers: { Origin: "https://attacker.example" } })).status;
  const missingTokenStatus = (await fetch(`${baseUrl}/api/workspaces`, { headers: { Origin: baseUrl } })).status;
  const badHostStatus = await requestWithHost("attacker.example");
  const oversizedStatus = (await fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { Origin: baseUrl, "x-skill-designer-token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) })
  })).status;
  for (const [name, actual, expected] of [["badOrigin", badOriginStatus, 403], ["missingToken", missingTokenStatus, 401], ["badHost", badHostStatus, 403], ["oversized", oversizedStatus, 413]]) {
    if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`);
  }
  await store.readDocument(member.projectId, "docs/guide.md").then(
    () => { throw new Error("Store followed an external symlink"); },
    (error) => { if (error.code !== "project_symlink_unsupported") throw error; }
  );

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  if (mobileLayout.documentWidth > mobileLayout.viewportWidth) throw new Error(`安全错误页横向溢出：${JSON.stringify(mobileLayout)}`);
  await page.screenshot({ path: path.join(artifactDir, "local-security-symlink-mobile.png"), fullPage: true });
  const expectedDocumentFailure = failedResponses.find(({ status, url }) => status === 403 && url.endsWith(`/api/projects/${member.projectId}/docs`));
  if (!expectedDocumentFailure) throw new Error(`未观察到预期的文档目录 403：${JSON.stringify(failedResponses)}`);
  const unexpectedFailedResponses = failedResponses.filter((response) => response !== expectedDocumentFailure);
  if (unexpectedFailedResponses.length) throw new Error(`Unexpected failed responses: ${JSON.stringify(unexpectedFailedResponses)}`);
  const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes("403 (Forbidden)"));
  if (unexpectedConsoleErrors.length) throw new Error(`Console errors: ${unexpectedConsoleErrors.join(" | ")}`);

  const report = {
    schemaVersion: "1.0",
    browser: await browser.version(),
    checks: { symlinkRead: "rejected", outsideContentRendered: false, badOriginStatus, missingTokenStatus, badHostStatus, oversizedStatus },
    mobileLayout,
    expectedDocumentFailure,
    unexpectedFailedResponses,
    unexpectedConsoleErrors,
    screenshots: ["local-security-symlink-desktop.png", "local-security-symlink-mobile.png"]
  };
  await writeFile(path.join(artifactDir, "local-security-verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
