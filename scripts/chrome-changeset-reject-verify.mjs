import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createApp } from "../packages/server/dist/http.js";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-designer-chrome-reject-"));
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts");
const baseUrl = "http://127.0.0.1:4327";
await mkdir(artifactDir, { recursive: true });

const store = new WorkspaceStore({ dataDir: path.join(dataRoot, "studio") });
await store.initialize();
const workspace = await store.createWorkspace({ name: "ChangeSet 拒绝 Chrome 验收" });
const created = await store.createManagedSkill(workspace.workspaceId, {
  name: "拒绝后重提交流程",
  capability: "workflow",
  description: "验证明确拒绝不写文件并保留页面草稿"
});
const member = created.members[0];
const server = createApp({ store, allowedOrigins: [baseUrl] });
await new Promise((resolve) => server.listen(4327, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

async function proposeWith(button) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === "POST" && /\/api\/projects\/[^/]+\/changesets$/u.test(new URL(candidate.url()).pathname)),
    button.click()
  ]);
  const payload = await response.json();
  if (!payload.ok) throw new Error(`ChangeSet proposal failed: ${JSON.stringify(payload.error)}`);
  return payload.data;
}

async function rejectFrom(dialog, proposal) {
  await dialog.getByRole("button", { name: "拒绝提案", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const rejected = await store.getChangeSet(proposal.changeSetId);
  if (rejected.status !== "rejected" || !rejected.rejectedAt || !rejected.rejectionReason) {
    throw new Error(`Rejected ChangeSet was not persisted: ${proposal.changeSetId}`);
  }
  try {
    await store.confirmAndApplyChangeSet(proposal.changeSetId, { digest: proposal.digest, baseRevision: proposal.baseRevision });
  } catch (error) {
    if (error?.code === "changeset_not_proposed") return rejected;
    throw error;
  }
  throw new Error(`Rejected ChangeSet was still applicable: ${proposal.changeSetId}`);
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "ChangeSet 拒绝 Chrome 验收" }).waitFor();

  await page.getByRole("button", { name: "图谱", exact: true }).click();
  await page.getByLabel("拒绝后重提交流程 图谱").getByText("核心步骤", { exact: true }).click();
  await page.getByRole("button", { name: "编辑节点" }).click();
  const graphBefore = await store.getProjectGraph(member.projectId);
  await page.getByLabel("节点标题").fill("拒绝后保留的图标题");
  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  const graphFirst = await proposeWith(page.getByRole("button", { name: "预览并保存图" }));
  const graphDialog = page.getByRole("dialog", { name: "确认图谱变更" });
  await graphDialog.getByText("flow.core-step", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "changeset-reject-graph-preview.png"), fullPage: true });
  const rejectedGraph = await rejectFrom(graphDialog, graphFirst);
  const graphAfterReject = await store.getProjectGraph(member.projectId);
  if (graphAfterReject.activeRevision !== graphBefore.activeRevision || graphAfterReject.graph.nodes.find((node) => node.id === "flow.core-step")?.title !== "核心步骤") {
    throw new Error("Rejecting the graph proposal changed project state");
  }
  if (await page.getByLabel("节点标题").inputValue() !== "拒绝后保留的图标题") throw new Error("Graph draft was lost after rejection");
  await page.getByTitle("查看当前草稿与已确认版本的差异").click();
  const graphSecond = await proposeWith(page.getByRole("button", { name: "预览并保存图" }));
  if (graphSecond.changeSetId === graphFirst.changeSetId) throw new Error("Graph re-proposal reused the rejected ChangeSet");
  await graphDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await graphDialog.waitFor({ state: "hidden" });
  const graphApplied = await store.getProjectGraph(member.projectId);
  if (graphApplied.activeRevision === graphBefore.activeRevision || graphApplied.graph.nodes.find((node) => node.id === "flow.core-step")?.title !== "拒绝后保留的图标题") {
    throw new Error("Graph re-proposal was not applied");
  }

  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "文档", exact: true }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.waitFor();
  const documentBefore = await store.readDocument(member.projectId, "SKILL.md");
  const documentDraft = `${await editor.inputValue()}\n## Chrome 拒绝验证\n\n拒绝后仍保留的文档草稿。\n`;
  await editor.fill(documentDraft);
  const documentFirst = await proposeWith(page.getByRole("button", { name: "预览并保存", exact: true }));
  const documentDialog = page.getByRole("dialog", { name: "确认文档变更" });
  await documentDialog.getByText("SKILL.md", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "changeset-reject-document-preview.png"), fullPage: true });
  const rejectedDocument = await rejectFrom(documentDialog, documentFirst);
  const documentAfterReject = await store.readDocument(member.projectId, "SKILL.md");
  if (documentAfterReject.activeRevision !== documentBefore.activeRevision || documentAfterReject.content !== documentBefore.content) {
    throw new Error("Rejecting the document proposal changed project state");
  }
  if (await editor.inputValue() !== documentDraft) throw new Error("Document draft was lost after rejection");
  const documentSecond = await proposeWith(page.getByRole("button", { name: "预览并保存", exact: true }));
  if (documentSecond.changeSetId === documentFirst.changeSetId) throw new Error("Document re-proposal reused the rejected ChangeSet");
  await documentDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await documentDialog.waitFor({ state: "hidden" });
  if ((await store.readDocument(member.projectId, "SKILL.md")).content !== documentDraft) throw new Error("Document re-proposal was not applied");

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: "用例编写", exact: true }).click();
  const benchmarkEmpty = page.locator(".runtime-empty");
  await benchmarkEmpty.getByRole("button", { name: "新建测试用例" }).click();
  await page.getByLabel("测试用例标题").fill("拒绝后重提的 Chrome 用例");
  await page.getByLabel("测试用例状态").selectOption("ready");
  await page.getByLabel("测试意图").fill("验证用例提案被明确拒绝后仍可调整并重新提交");
  await page.getByLabel("期望路径模式").selectOption("exact");
  await page.getByLabel("期望路径节点").fill("flow.start\nflow.core-step\nflow.end");
  await page.getByLabel("期望终态", { exact: true }).selectOption("completed");
  await page.getByLabel("期望终态节点", { exact: true }).selectOption("flow.end");
  await page.getByText("校验通过", { exact: true }).waitFor();
  const benchmarkBefore = await store.getProjectGraph(member.projectId);
  const benchmarkFirst = await proposeWith(page.getByRole("button", { name: "预览并保存用例" }));
  const benchmarkDialog = page.getByRole("dialog", { name: "确认测试用例变更" });
  await benchmarkDialog.getByText("新建用例", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactDir, "changeset-reject-benchmark-preview.png"), fullPage: true });
  const rejectedBenchmark = await rejectFrom(benchmarkDialog, benchmarkFirst);
  if ((await store.listBenchmarkCases(member.projectId)).length !== 0) throw new Error("Rejected Benchmark case was written");
  if ((await store.getProjectGraph(member.projectId)).activeRevision !== benchmarkBefore.activeRevision) throw new Error("Rejected Benchmark case advanced revision");
  if (await page.getByLabel("测试用例标题").inputValue() !== "拒绝后重提的 Chrome 用例") throw new Error("Benchmark draft was lost after rejection");
  const benchmarkSecond = await proposeWith(page.getByRole("button", { name: "预览并保存用例" }));
  if (benchmarkSecond.changeSetId === benchmarkFirst.changeSetId) throw new Error("Benchmark re-proposal reused the rejected ChangeSet");
  await benchmarkDialog.getByRole("button", { name: "确认并应用", exact: true }).click();
  await benchmarkDialog.waitFor({ state: "hidden" });
  await page.locator(".benchmark-case-list").getByText("拒绝后重提的 Chrome 用例", { exact: true }).waitFor();
  if ((await store.listBenchmarkCases(member.projectId)).length !== 1) throw new Error("Benchmark re-proposal was not applied");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("测试用例标题").fill("移动端拒绝按钮布局");
  const mobileProposal = await proposeWith(page.getByRole("button", { name: "预览并保存用例" }));
  await benchmarkDialog.waitFor();
  const mobileLayout = await page.evaluate(() => {
    const actions = document.querySelector(".proposal-actions");
    const buttons = [...(actions?.querySelectorAll("button") ?? [])];
    return {
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      actionWidth: actions?.getBoundingClientRect().width ?? 0,
      buttons: buttons.map((button) => ({ text: button.textContent?.trim(), width: button.getBoundingClientRect().width, right: button.getBoundingClientRect().right })),
      offenders: [...document.querySelectorAll("body *")]
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.right > window.innerWidth + 1 || rect.width > window.innerWidth + 1)
        .slice(0, 12)
        .map(({ element, rect }) => ({ tag: element.tagName, className: element.className, width: rect.width, right: rect.right }))
    };
  });
  await page.screenshot({ path: path.join(artifactDir, "changeset-reject-mobile.png"), fullPage: true });
  if (mobileLayout.documentWidth > mobileLayout.viewport || mobileLayout.buttons.length !== 3 || mobileLayout.buttons.some((button) => button.right > mobileLayout.viewport || button.width < 100)) {
    throw new Error(`Mobile rejection actions overflowed: ${JSON.stringify(mobileLayout)}`);
  }
  const rejectedMobile = await rejectFrom(benchmarkDialog, mobileProposal);

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  if (failedResponses.length) throw new Error(`Failed responses:\n${failedResponses.join("\n")}`);
  const reportPath = path.join(artifactDir, "changeset-reject.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    checkedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, browser: await browser.version() },
    verified: {
      identityBoundRejection: true,
      rejectedProposalCannotApply: true,
      projectUnchangedAfterReject: true,
      graphDraftRetainedAndReproposed: true,
      documentDraftRetainedAndReproposed: true,
      benchmarkDraftRetainedAndReproposed: true,
      mobileHorizontalOverflow: false
    },
    rejectedChangeSets: [rejectedGraph, rejectedDocument, rejectedBenchmark, rejectedMobile].map((item) => ({
      changeSetId: item.changeSetId,
      status: item.status,
      rejectedAt: item.rejectedAt,
      rejectionReason: item.rejectionReason
    })),
    screenshots: [
      "changeset-reject-graph-preview.png",
      "changeset-reject-document-preview.png",
      "changeset-reject-benchmark-preview.png",
      "changeset-reject-mobile.png"
    ]
  }, null, 2) + "\n");
  console.log("Chrome ChangeSet rejection verified for graph, document and Benchmark drafts, including re-proposal and mobile layout.");
  console.log(`Report: ${reportPath}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
}
