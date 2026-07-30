import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchmarkRunRecord, ProjectFileMutationStep, ProjectTransactionJournal, SkillGraph } from "@skill-designer/engine";
import { WorkspaceStore } from "../src/store.js";

let root: string;
let sequence: number;
let store: WorkspaceStore;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-store-"));
  sequence = 1;
  store = new WorkspaceStore({
    dataDir: root,
    now: () => new Date("2026-07-27T08:00:00.000Z"),
    idFactory: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`
  });
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("WorkspaceStore", () => {
  it.skipIf(process.platform === "win32")("rejects a project document replaced by an external symbolic link after enrollment", async () => {
    const workspace = await store.createWorkspace({ name: "符号链接边界" });
    const detail = await store.createManagedSkill(workspace.workspaceId, { name: "符号链接 Skill", capability: "workflow" });
    const member = detail.members[0]!;
    const source = JSON.parse(await readFile(path.join(root, "projects", member.projectId, "source.json"), "utf8")) as { root: string };
    const outside = path.join(root, "outside-secret.md");
    const linked = path.join(source.root, "docs", "leak.md");
    await writeFile(outside, "# 项目外秘密\n\n不得读取。\n", "utf8");
    await mkdir(path.dirname(linked), { recursive: true });
    await symlink(outside, linked);

    await expect(store.readDocument(member.projectId, "docs/leak.md")).rejects.toMatchObject({ code: "project_symlink_unsupported" });
    await expect(store.getProjectDocumentSlice(member.projectId, "docs/leak.md", "项目外秘密")).rejects.toMatchObject({ code: "project_symlink_unsupported" });
    await expect(store.listDocuments(member.projectId)).rejects.toMatchObject({ code: "project_symlink_unsupported" });
    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: member.activeRevision,
      reason: "不允许覆盖符号链接",
      operations: [{ op: "docs.write", target: "docs/leak.md", value: "# 安全文档\n" }]
    })).rejects.toMatchObject({ code: "project_symlink_unsupported" });
  });

  it("renames, reorders, and deletes a Workspace without deleting its Skill projects", async () => {
    const created = await store.createWorkspace({ name: "生命周期工作区" });
    const withFirst = await store.createManagedSkill(created.workspaceId, { name: "第一个 Skill", capability: "workflow" });
    const withSecond = await store.createManagedSkill(created.workspaceId, { name: "第二个 Skill", capability: "content-only" });
    const first = withFirst.members[0]!;
    const second = withSecond.members.find((member) => member.projectId !== first.projectId)!;
    const sources = await Promise.all([first, second].map(async (member) => JSON.parse(
      await readFile(path.join(root, "projects", member.projectId, "source.json"), "utf8")
    ) as { root: string }));

    const renamed = await store.renameWorkspace(created.workspaceId, { name: "重命名后的工作区" });
    expect(renamed.name).toBe("重命名后的工作区");
    const reordered = await store.reorderMembers(created.workspaceId, { projectIds: [second.projectId, first.projectId] });
    expect(reordered.members.map((member) => [member.projectId, member.order])).toEqual([
      [second.projectId, 0],
      [first.projectId, 1]
    ]);

    const deleted = await store.deleteWorkspace(created.workspaceId);
    expect(deleted.preservedProjects.map((project) => project.projectId)).toEqual([second.projectId, first.projectId]);
    await expect(store.getWorkspace(created.workspaceId)).rejects.toMatchObject({ code: "workspace_not_found" });
    for (const [index, member] of [first, second].entries()) {
      expect((await stat(sources[index]!.root)).isDirectory()).toBe(true);
      expect((await stat(path.join(root, "projects", member.projectId, "state.json"))).isFile()).toBe(true);
    }
  });

  it("repairs a moved in-place project only when identity and current Revision content match", async () => {
    const workspace = await store.createWorkspace({ name: "路径修复" });
    const sourceRoot = path.join(root, "external-skill");
    const relocatedRoot = path.join(root, "relocated-skill");
    const skillId = "skill-11111111-1111-4111-8111-111111111111";
    const skillDocument = "# 路径修复 Skill\n\n验证移动目录后的安全恢复。\n";
    await mkdir(path.join(sourceRoot, "graph"), { recursive: true });
    await writeFile(path.join(sourceRoot, "SKILL.md"), skillDocument, "utf8");
    await writeFile(path.join(sourceRoot, "skill.json"), JSON.stringify({
      skillId,
      name: "路径修复 Skill",
      version: "0.1.0",
      description: "",
      capability: "workflow",
      entry: "flow.start"
    }, null, 2) + "\n", "utf8");
    await writeFile(path.join(sourceRoot, "graph", "main.json"), JSON.stringify({
      schemaVersion: "1.0",
      skillId,
      capability: "workflow",
      entry: "flow.start",
      nodes: [
        { id: "flow.start", kind: "start", title: "开始", position: { x: 0, y: 0 } },
        { id: "flow.end", kind: "end", title: "结束", position: { x: 200, y: 0 } }
      ],
      edges: [{ id: "edge.start-end", from: "flow.start", to: "flow.end", kind: "flow" }]
    }, null, 2) + "\n", "utf8");

    const opened = await store.openInPlaceProject(workspace.workspaceId, { rootPath: sourceRoot });
    const member = opened.members[0]!;
    await rename(sourceRoot, relocatedRoot);
    expect((await store.getWorkspace(workspace.workspaceId)).members[0]).toMatchObject({ status: "missing", sourcePath: member.sourcePath });

    await writeFile(path.join(relocatedRoot, "SKILL.md"), `${skillDocument}\n已被修改。\n`, "utf8");
    await expect(store.repairMemberPath(workspace.workspaceId, member.projectId, { rootPath: relocatedRoot })).rejects.toMatchObject({ code: "repair_content_mismatch" });
    await writeFile(path.join(relocatedRoot, "SKILL.md"), skillDocument, "utf8");
    const repaired = await store.repairMemberPath(workspace.workspaceId, member.projectId, { rootPath: relocatedRoot });
    expect(repaired.members[0]).toMatchObject({ status: "ready", sourcePath: expect.stringContaining("relocated-skill") });
    expect(JSON.parse(await readFile(path.join(root, "projects", member.projectId, "source.json"), "utf8"))).toMatchObject({ root: repaired.members[0]!.sourcePath });
  });

  it("generates JSON and Markdown report files, lists history, and cleans only the source report", async () => {
    const workspace = await store.createWorkspace({ name: "报告生命周期" });
    const detail = await store.createManagedSkill(workspace.workspaceId, { name: "报告 Skill", capability: "workflow" });
    const member = detail.members[0]!;
    const started = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId });
    await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.core-step" });
    await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.end" });
    const preview = await store.createBugReport(member.projectId, started.run.runId, { workspaceId: workspace.workspaceId, sanitizationMode: "default", userNote: "token sk-abcdefghijklmnop" });
    const ready = await store.confirmBugReport(preview.reportId, { digest: preview.digest });
    expect(ready).toMatchObject({ status: "ready", fileName: expect.stringMatching(/\.report\.json$/u), markdownFileName: expect.stringMatching(/\.report\.md$/u) });
    expect((await store.listBugReports(member.projectId, workspace.workspaceId)).map((item) => item.reportId)).toEqual([ready.reportId]);
    const markdown = await store.getBugReportDownload(ready.reportId, "markdown");
    expect(markdown.contentType).toBe("text/markdown; charset=utf-8");
    expect(await readFile(markdown.path, "utf8")).toContain("token [REDACTED]");
    const imported = await store.importStoredBugReport(workspace.workspaceId, ready.reportId);

    const other = await store.createWorkspace({ name: "其他报告空间" });
    await expect(store.deleteBugReport(ready.reportId, other.workspaceId)).rejects.toMatchObject({ code: "report_workspace_mismatch" });
    expect(await store.deleteBugReport(ready.reportId, workspace.workspaceId)).toEqual({ reportId: ready.reportId, projectId: member.projectId, deleted: true });
    expect(await store.listBugReports(member.projectId, workspace.workspaceId)).toEqual([]);
    await expect(store.getBugReport(ready.reportId)).rejects.toMatchObject({ code: "report_not_found" });
    expect((await store.listImportedBugReports(workspace.workspaceId)).map((item) => item.reportImportId)).toContain(imported.reportImportId);
    await store.createDiagnosis(workspace.workspaceId, imported.reportImportId);
    expect(await store.deleteImportedBugReport(workspace.workspaceId, imported.reportImportId)).toEqual({
      reportImportId: imported.reportImportId,
      workspaceId: workspace.workspaceId,
      deleted: true,
      derivedRecordsDeleted: true
    });
    expect(await store.listImportedBugReports(workspace.workspaceId)).toEqual([]);
    await expect(store.listDiagnoses(workspace.workspaceId, imported.reportImportId)).rejects.toMatchObject({ code: "report_import_not_found" });
  });

  it("persists an independent Trace log and repairs it after restart without changing the Run", async () => {
    const workspace = await store.createWorkspace({ name: "TraceStore 恢复" });
    const detail = await store.createManagedSkill(workspace.workspaceId, { name: "TraceStore Skill", capability: "workflow" });
    const member = detail.members[0]!;
    const started = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId });
    await store.commandRun(member.projectId, started.run.runId, "pause");
    await store.commandRun(member.projectId, started.run.runId, "resume");
    const traceFile = path.join(root, "traces", member.projectId, `${started.run.runId}.ndjson`);
    expect((await readFile(traceFile, "utf8")).trimEnd().split("\n")).toHaveLength(4);

    await writeFile(traceFile, `${(await readFile(traceFile, "utf8")).split("\n")[0]}\n{`, "utf8");
    const restarted = new WorkspaceStore({ dataDir: root });
    await restarted.initialize();
    const recovered = await restarted.getTraceEvents(member.projectId, started.run.runId, 0);
    expect(recovered.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(recovered.projection).toMatchObject({ latestSeq: 4, status: "running", currentNodeId: "flow.start" });
    expect((await readFile(traceFile, "utf8")).trimEnd().split("\n")).toHaveLength(4);
    expect((await restarted.getRun(member.projectId, started.run.runId)).run.events).toHaveLength(4);
  });

  it("previews an external directory as pending and preserves every imported byte after confirmation", async () => {
    const workspace = await store.createWorkspace({ name: "静态导入" });
    const marker = path.join(root, "must-not-exist");
    const files = [
      { path: "SKILL.md", content: Buffer.from("# 外部知识 Skill\n\n用于验证安全导入。\n") },
      { path: "docs/guide.md", content: Buffer.from("# 指南\n\n保留原文。\n") },
      { path: "scripts/setup.sh", content: Buffer.from(`touch ${marker}\n`) },
      { path: "assets/data.bin", content: Buffer.from([0, 1, 2, 255]) },
      { path: ".GIT/config", content: Buffer.from("must not import vcs metadata") },
      { path: ".DS_Store", content: Buffer.from("must not import os metadata") }
    ];
    const preview = await store.createSkillImport(workspace.workspaceId, {
      folderName: "external-skill",
      files: files.map((file) => ({ path: file.path, contentBase64: file.content.toString("base64") }))
    });

    expect(preview.candidate.capability).toBe("content-only");
    expect(preview.candidate.generatedFiles).toEqual(["skill.json", "graph/main.json"]);
    expect(preview.candidate.files).toHaveLength(4);
    expect(preview.workspace.members[0]?.status).toBe("pending-import");
    await expect(store.getProjectGraph(preview.candidate.projectId)).rejects.toMatchObject({ code: "project_not_found" });

    const confirmed = await store.confirmSkillImport(preview.candidate.importId, {
      workspaceId: workspace.workspaceId,
      digest: preview.candidate.digest
    });
    expect(confirmed.members[0]?.status).toBe("ready");
    expect(confirmed.selectedProjectId).toBe(preview.candidate.projectId);
    const source = JSON.parse(await readFile(path.join(root, "projects", preview.candidate.projectId, "source.json"), "utf8")) as { root: string };
    expect(await readFile(path.join(source.root, "assets/data.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(path.join(source.root, "scripts/setup.sh"), "utf8")).toContain("touch");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const graph = await store.getProjectGraph(preview.candidate.projectId);
    expect(graph.graph.capability).toBe("content-only");
    expect(graph.graph.nodes).toHaveLength(1);
    expect((await store.listRevisions(preview.candidate.projectId)).length).toBe(1);
  });

  it("persists parse review edits and requires explicit adjudication before reparse can replace them", async () => {
    const workspace = await store.createWorkspace({ name: "解析审阅" });
    const markdown = "# 发布助手\n\n## 流程\n\n### 收集需求\n记录背景。\n\n### 确认范围\n锁定边界。\n";
    const preview = await store.createSkillImport(workspace.workspaceId, {
      folderName: "release-helper",
      files: [{ path: "SKILL.md", contentBase64: Buffer.from(markdown).toString("base64") }]
    });
    expect(preview.candidate.capability).toBe("workflow");
    expect(preview.candidate.parseReview.nodes.map((item) => item.value.title)).toContain("确认范围");
    await expect(store.getProjectGraph(preview.candidate.projectId)).rejects.toMatchObject({ code: "project_not_found" });

    const editedNodes = preview.candidate.parseReview.nodes.map((item) => ({
      candidateId: item.candidateId,
      decision: item.decision,
      value: item.value.title === "确认范围" ? { ...item.value, title: "人工确认范围" } : item.value
    }));
    const rejected = await store.updateSkillImportReview(preview.candidate.importId, {
      workspaceId: workspace.workspaceId,
      reviewRevision: preview.candidate.parseReview.reviewRevision,
      entry: preview.candidate.parseReview.entry,
      nodes: editedNodes,
      edges: preview.candidate.parseReview.edges.map((item, index) => ({
        candidateId: item.candidateId,
        decision: index === 1 ? "rejected" : item.decision,
        value: item.value
      }))
    });
    expect(rejected.parseReview.manuallyEdited).toBe(true);
    expect(rejected.parseReview.lint.some((issue) => issue.severity === "error")).toBe(true);
    await expect(store.confirmSkillImport(rejected.importId, { workspaceId: workspace.workspaceId, digest: rejected.digest }))
      .rejects.toMatchObject({ code: "import_review_invalid" });

    const restored = await store.updateSkillImportReview(rejected.importId, {
      workspaceId: workspace.workspaceId,
      reviewRevision: rejected.parseReview.reviewRevision,
      entry: rejected.parseReview.entry,
      nodes: rejected.parseReview.nodes.map((item) => ({ candidateId: item.candidateId, decision: item.decision, value: item.value })),
      edges: rejected.parseReview.edges.map((item) => ({ candidateId: item.candidateId, decision: "accepted", value: item.value }))
    });
    expect(restored.parseReview.lint).toEqual([]);

    const conflicted = await store.reparseSkillImport(restored.importId, {
      workspaceId: workspace.workspaceId,
      reviewRevision: restored.parseReview.reviewRevision
    });
    expect(conflicted.parseReview.reparseConflict?.kind).toBe("manual-vs-reparse");
    expect(conflicted.parseReview.nodes.map((item) => item.value.title)).toContain("人工确认范围");
    expect(conflicted.parseReview.reparseConflict?.parsed.nodes.map((item) => item.value.title)).toContain("确认范围");
    await expect(store.confirmSkillImport(conflicted.importId, { workspaceId: workspace.workspaceId, digest: conflicted.digest }))
      .rejects.toMatchObject({ code: "import_reparse_conflict" });

    const resolved = await store.resolveSkillImportReparse(conflicted.importId, {
      workspaceId: workspace.workspaceId,
      reviewRevision: conflicted.parseReview.reviewRevision,
      choice: "manual"
    });
    expect(resolved.parseReview.reparseConflict).toBeUndefined();
    const confirmed = await store.confirmSkillImport(resolved.importId, { workspaceId: workspace.workspaceId, digest: resolved.digest });
    expect(confirmed.members[0]?.status).toBe("ready");
    const graph = await store.getProjectGraph(resolved.projectId);
    expect(graph.graph.nodes.map((node) => node.title)).toContain("人工确认范围");
    const source = JSON.parse(await readFile(path.join(root, "projects", resolved.projectId, "source.json"), "utf8")) as { root: string };
    expect(await readFile(path.join(source.root, "SKILL.md"), "utf8")).toBe(markdown);
  });

  it("persists frontmatter, relative-reference inventory, and provenance without rewriting source metadata", async () => {
    const workspace = await store.createWorkspace({ name: "资产事实" });
    const markdown = `---
name: 元数据导入助手
description: 从结构化元数据建立候选。
version: 3.1.0
allowed-tools: [Read, Search]
references:
  - docs/guide.md
metadata:
  owner: platform
custom-field:
  keep: true
---
# 备用标题

阅读 [指南](docs/guide.md#retry) 和 ![缺失图](assets/missing.png)。
`;
    const preview = await store.createSkillImport(workspace.workspaceId, {
      folderName: "metadata-skill",
      files: [
        { path: "SKILL.md", contentBase64: Buffer.from(markdown).toString("base64") },
        { path: "docs/guide.md", contentBase64: Buffer.from("# Retry\n\n重试说明。\n").toString("base64") },
        { path: "assets/data.bin", contentBase64: Buffer.from([1, 2, 3]).toString("base64") }
      ]
    });

    expect(preview.candidate.detectedFormat).toBe("frontmatter-skill");
    expect(preview.candidate.displayName).toBe("元数据导入助手");
    expect(preview.candidate.frontmatter).toMatchObject({
      dialect: "yaml",
      status: "valid",
      recognized: { version: "3.1.0", allowedTools: ["Read", "Search"] },
      data: { metadata: { owner: "platform" }, "custom-field": { keep: true } }
    });
    expect(preview.candidate.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawTarget: "docs/guide.md", kind: "frontmatter", status: "resolved" }),
      expect.objectContaining({ rawTarget: "docs/guide.md#retry", kind: "markdown-link", status: "resolved" }),
      expect.objectContaining({ rawTarget: "assets/missing.png", kind: "markdown-image", status: "missing" })
    ]));
    expect(preview.candidate.formatSignals.map((signal) => signal.code)).toEqual(["root-skill-markdown", "yaml-frontmatter"]);
    expect(preview.candidate.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "display-name", method: "frontmatter", confidence: "high" }),
      expect.objectContaining({ subject: "capability", method: "conservative-fallback", valueSummary: "content-only" })
    ]));
    expect(preview.candidate.diagnostics).toContainEqual(expect.objectContaining({ code: "missing_import_references", severity: "warning" }));

    const confirmed = await store.confirmSkillImport(preview.candidate.importId, { workspaceId: workspace.workspaceId, digest: preview.candidate.digest });
    expect(confirmed.members[0]?.status).toBe("ready");
    const source = JSON.parse(await readFile(path.join(root, "projects", preview.candidate.projectId, "source.json"), "utf8")) as { root: string };
    expect(await readFile(path.join(source.root, "SKILL.md"), "utf8")).toBe(markdown);
    const manifest = JSON.parse(await readFile(path.join(source.root, "skill.json"), "utf8")) as { name: string; description: string };
    expect(manifest).toMatchObject({ name: "元数据导入助手", description: "从结构化元数据建立候选。" });
  });

  it("rejects import paths that collide on Windows and default macOS filesystems", async () => {
    const workspace = await store.createWorkspace({ name: "路径冲突" });
    await expect(store.createSkillImport(workspace.workspaceId, {
      folderName: "collision",
      files: [
        { path: "SKILL.md", contentBase64: Buffer.from("# Collision\n").toString("base64") },
        { path: "docs/A.md", contentBase64: Buffer.from("A").toString("base64") },
        { path: "docs/a.md", contentBase64: Buffer.from("a").toString("base64") }
      ]
    })).rejects.toMatchObject({ code: "duplicate_import_path" });
  });

  it("blocks and cancels an invalid workflow import without creating an active project", async () => {
    const workspace = await store.createWorkspace({ name: "阻断导入" });
    const skillId = "skill-11111111-1111-4111-8111-111111111111";
    const preview = await store.createSkillImport(workspace.workspaceId, {
      folderName: "broken-workflow",
      files: [
        { path: "SKILL.md", contentBase64: Buffer.from("# Broken\n").toString("base64") },
        {
          path: "skill.json",
          contentBase64: Buffer.from(JSON.stringify({ skillId, name: "Broken", version: "1.0.0", description: "", capability: "workflow" })).toString("base64")
        }
      ]
    });
    expect(preview.candidate.diagnostics).toContainEqual(expect.objectContaining({ code: "workflow_graph_missing", severity: "error" }));
    await expect(store.confirmSkillImport(preview.candidate.importId, {
      workspaceId: workspace.workspaceId,
      digest: preview.candidate.digest
    })).rejects.toMatchObject({ code: "import_diagnostics_failed" });
    const cancelled = await store.cancelSkillImport(preview.candidate.importId, { workspaceId: workspace.workspaceId });
    expect(cancelled.members).toEqual([]);
    expect((await store.getSkillImport(preview.candidate.importId)).status).toBe("cancelled");
  });

  it("exports one pinned revision as a generic zip with a runnable zero-dependency CLI", async () => {
    const workspace = await store.createWorkspace({ name: "通用导出" });
    const withSkill = await store.createManagedSkill(workspace.workspaceId, { name: "可导出 Skill", capability: "workflow" });
    const member = withSkill.members[0]!;
    expect(await store.listGenericExports(member.projectId, workspace.workspaceId)).toEqual([]);
    const preview = await store.createGenericExport(member.projectId, {
      workspaceId: workspace.workspaceId,
      revisionId: member.activeRevision,
      profile: "generic/1"
    });
    expect(preview.status).toBe("proposed");
    expect(await store.listGenericExports(member.projectId, workspace.workspaceId)).toEqual([expect.objectContaining({ exportId: preview.exportId, status: "proposed" })]);
    expect(preview.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "SKILL.md",
      "engine/README.md",
      "engine/skill-engine.mjs",
      "export-manifest.json",
      "graph/main.json",
      "skill.json"
    ]));
    expect(preview.files.some((file) => file.path.includes("workspace") || file.path.includes("runtime-artifacts"))).toBe(false);
    await expect(store.confirmGenericExport(preview.exportId, { digest: "wrong", revisionId: member.activeRevision }))
      .rejects.toMatchObject({ code: "export_confirmation_mismatch" });

    const ready = await store.confirmGenericExport(preview.exportId, { digest: preview.digest, revisionId: preview.revisionId });
    expect(ready.status).toBe("ready");
    expect(await store.listGenericExports(member.projectId, workspace.workspaceId)).toEqual([expect.objectContaining({ exportId: preview.exportId, status: "ready" })]);
    expect(ready.archiveName).toMatch(/\.zip$/);
    const archive = await store.getGenericExportArchive(preview.exportId);
    const zip = new AdmZip(archive.path);
    const entries = zip.getEntries().map((entry) => entry.entryName);
    expect(entries).toEqual(expect.arrayContaining(["SKILL.md", "skill.json", "graph/main.json", "engine/README.md", "engine/skill-engine.mjs", "export-manifest.json"]));
    expect(entries.some((entry) => entry.includes("workspace.json") || entry.includes("baseline.json"))).toBe(false);

    const extracted = path.join(root, "extracted-export");
    zip.extractAllTo(extracted, true);
    const execution = await execFileAsync(process.execPath, [path.join(extracted, "engine/skill-engine.mjs"), "inspect"]);
    const inspected = JSON.parse(execution.stdout) as { skillId: string; nodes: number };
    expect(inspected.skillId).toBe(member.skillId);
    expect(inspected.nodes).toBe(3);
    const cli = path.join(extracted, "engine/skill-engine.mjs");
    const stateFile = path.join(root, "generic-cli-state", "run.json");
    const startResult = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "start", "--state", stateFile, "--variables", JSON.stringify({ requestId: "clean-cli" })])).stdout) as {
      status: string; state: { status: string; currentNodeId: string; eventSeq: number }; newEvents: unknown[];
    };
    expect(startResult).toMatchObject({ status: "ok", state: { status: "running", currentNodeId: "flow.start", eventSeq: 2 } });
    expect(startResult.newEvents).toHaveLength(2);
    await execFileAsync(process.execPath, [cli, "run", "pause", "--state", stateFile]);
    expect(JSON.parse((await execFileAsync(process.execPath, [cli, "run", "status", "--state", stateFile])).stdout)).toMatchObject({ state: { status: "paused" } });
    await execFileAsync(process.execPath, [cli, "run", "resume", "--state", stateFile]);
    const beforeReject = JSON.parse(await readFile(stateFile, "utf8")) as { currentNodeId: string; step: number; variables: Record<string, unknown>; eventSeq: number };
    const rejected = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "next", "--state", stateFile, "--to", "flow.missing"])).stdout) as { status: string; rejection: { code: string }; newEvents: Array<{ type: string }> };
    expect(rejected).toMatchObject({ status: "rejected", rejection: { code: "next_node_not_allowed" }, newEvents: [{ type: "engine.reject" }] });
    const afterReject = JSON.parse(await readFile(stateFile, "utf8")) as typeof beforeReject;
    expect(afterReject).toMatchObject({ currentNodeId: beforeReject.currentNodeId, step: beforeReject.step, variables: beforeReject.variables, eventSeq: beforeReject.eventSeq + 1 });
    const entered = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "next", "--state", stateFile, "--to", "flow.core-step", "--set", JSON.stringify({ result: "ok" })])).stdout) as { state: { currentNodeId: string; variables: Record<string, unknown> } };
    expect(entered.state).toMatchObject({ currentNodeId: "flow.core-step", variables: { requestId: "clean-cli", result: "ok" } });
    const completed = JSON.parse((await execFileAsync(process.execPath, [cli, "run", "next", "--state", stateFile, "--to", "flow.end"])).stdout) as { status: string; state: { status: string; eventSeq: number; events: Array<{ seq: number; type: string }> } };
    expect(completed).toMatchObject({ status: "done", state: { status: "completed", eventSeq: 8 } });
    expect(completed.state.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(completed.state.events.at(-1)?.type).toBe("engine.complete");
    expect(await readFile(path.join(extracted, "engine", "README.md"), "utf8")).toContain("run start --state");
    const manifest = JSON.parse(await readFile(path.join(extracted, "export-manifest.json"), "utf8")) as { revisionId: string; contentHash: string };
    expect(manifest.revisionId).toBe(member.activeRevision);
    expect(manifest.contentHash).toBe(preview.contentHash);
  });

  it("deletes only Studio-private export files and enforces Workspace ownership", async () => {
    const workspace = await store.createWorkspace({ name: "导出清理" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "导出清理 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const preview = await store.createGenericExport(member.projectId, { workspaceId: workspace.workspaceId, revisionId: member.activeRevision });
    await store.confirmGenericExport(preview.exportId, { digest: preview.digest, revisionId: preview.revisionId });
    const otherWorkspace = await store.createWorkspace({ name: "其他 Workspace" });

    await expect(store.deleteGenericExport(preview.exportId, otherWorkspace.workspaceId)).rejects.toMatchObject({ code: "export_workspace_mismatch" });
    expect((await store.getGenericExportArchive(preview.exportId)).record.status).toBe("ready");
    expect(await store.deleteGenericExport(preview.exportId, workspace.workspaceId)).toEqual({ exportId: preview.exportId, projectId: member.projectId, deleted: true });
    await expect(store.getGenericExport(preview.exportId)).rejects.toMatchObject({ code: "export_not_found" });
    expect(await store.listGenericExports(member.projectId, workspace.workspaceId)).toEqual([]);
    expect((await store.readDocument(member.projectId, "SKILL.md")).content).toContain("导出清理 Skill");
  });

  it("marks an export conflicted when the active revision changes after preview", async () => {
    const workspace = await store.createWorkspace({ name: "导出冲突" });
    const withSkill = await store.createManagedSkill(workspace.workspaceId, { name: "变化 Skill", capability: "content-only" });
    const member = withSkill.members[0]!;
    const preview = await store.createGenericExport(member.projectId, { workspaceId: workspace.workspaceId, revisionId: member.activeRevision });
    const document = await store.readDocument(member.projectId, "SKILL.md");
    const changeSet = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: document.activeRevision,
      reason: "制造导出冲突",
      operations: [{ op: "docs.write", target: "SKILL.md", value: `${document.content}\n已变化。\n` }]
    });
    await store.confirmAndApplyChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision });
    await expect(store.confirmGenericExport(preview.exportId, { digest: preview.digest, revisionId: preview.revisionId }))
      .rejects.toMatchObject({ code: "export_revision_changed" });
    expect((await store.getGenericExport(preview.exportId)).status).toBe("conflicted");
  });

  it("enumerates commit/tag refs, summarizes binary changes and scopes Git diff to the authorized project", async () => {
    const repositoryRoot = path.join(root, "external-repository");
    const projectRoot = path.join(repositoryRoot, "skills", "git-skill");
    const skillId = "skill-22222222-2222-4222-8222-222222222222";
    await mkdir(path.join(projectRoot, "graph"), { recursive: true });
    await mkdir(path.join(projectRoot, "assets"), { recursive: true });
    await writeFile(path.join(projectRoot, "SKILL.md"), "# Git Skill\n\n初始内容。\n");
    await writeFile(path.join(projectRoot, "skill.json"), JSON.stringify({ skillId, name: "Git Skill", version: "1.0.0", description: "", capability: "workflow", entry: "flow.start" }, null, 2));
    const graph = {
      schemaVersion: "1.0",
      skillId,
      capability: "workflow",
      entry: "flow.start",
      nodes: [
        { id: "flow.start", kind: "start", title: "开始" },
        { id: "flow.step", kind: "step", title: "处理" },
        { id: "flow.end", kind: "end", title: "结束" }
      ],
      edges: [
        { id: "edge.start-step", from: "flow.start", to: "flow.step", kind: "flow" },
        { id: "edge.step-end", from: "flow.step", to: "flow.end", kind: "flow" }
      ]
    };
    await writeFile(path.join(projectRoot, "graph/main.json"), JSON.stringify(graph, null, 2));
    await writeFile(path.join(projectRoot, "assets/logo.bin"), Buffer.from([0, 1, 2, 3]));
    await execFileAsync("git", ["init", "-q"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.name", "Skill Designer Test"], { cwd: repositoryRoot });
    await execFileAsync("git", ["add", "."], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: repositoryRoot });
    const initialOid = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
    await execFileAsync("git", ["tag", "v1.0"], { cwd: repositoryRoot });
    await writeFile(path.join(projectRoot, "SKILL.md"), "# Git Skill\n\n第二版提交。\n");
    await writeFile(path.join(projectRoot, "docs-after-initial.md"), "只存在于第二版提交\n");
    await execFileAsync("git", ["add", "skills/git-skill/SKILL.md"], { cwd: repositoryRoot });
    await execFileAsync("git", ["add", "skills/git-skill/docs-after-initial.md"], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "-qm", "second"], { cwd: repositoryRoot });
    await rm(path.join(projectRoot, "docs-after-initial.md"));
    await writeFile(path.join(projectRoot, "SKILL.md"), "# Git Skill\n\n工作树修改。\n");
    await writeFile(path.join(projectRoot, "assets/logo.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
    await writeFile(path.join(projectRoot, "assets/untracked.bin"), Buffer.from([0, 8, 9]));
    await mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await writeFile(path.join(projectRoot, "docs/new.md"), "# 未跟踪文档\n");
    await writeFile(path.join(repositoryRoot, "outside.txt"), "不得出现在 Skill diff 中\n");

    const workspace = await store.createWorkspace({ name: "原地 Git" });
    const opened = await store.openInPlaceProject(workspace.workspaceId, { rootPath: projectRoot });
    const member = opened.members[0]!;
    expect(member.mode).toBe("in-place");
    expect(member.skillId).toBe(skillId);
    expect(member.git).toEqual({ available: true, changedFiles: 5 });
    const revision = (await store.listRevisions(member.projectId))[0]!;
    const snapshotManifest = JSON.parse(
      await readFile(path.join(root, "projects", member.projectId, "snapshots", revision.snapshotId, "manifest.json"), "utf8")
    ) as { files: Array<{ path: string }> };
    expect(snapshotManifest.files.some((file) => file.path.startsWith(".git/"))).toBe(false);

    const inheritedGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(root, "attacker-controlled-git-dir");
    let diff: Awaited<ReturnType<WorkspaceStore["getProjectGitDiff"]>>;
    try {
      diff = await store.getProjectGitDiff(member.projectId);
    } finally {
      if (inheritedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inheritedGitDir;
    }
    expect(diff.capability.available).toBe(true);
    expect(diff.files.map((file) => [file.path, file.status])).toEqual([
      ["assets/logo.bin", "modified"],
      ["assets/untracked.bin", "untracked"],
      ["docs-after-initial.md", "deleted"],
      ["docs/new.md", "untracked"],
      ["SKILL.md", "modified"]
    ]);
    expect(diff.files.filter((file) => file.binary).map((file) => file.path)).toEqual(["assets/logo.bin", "assets/untracked.bin"]);
    expect(diff.binaryChanges).toEqual([
      { path: "assets/logo.bin", status: "modified", baseBytes: 4, currentBytes: 6 },
      { path: "assets/untracked.bin", status: "untracked", baseBytes: null, currentBytes: 3 }
    ]);
    expect(diff.patch).toContain("工作树修改");
    expect(diff.patch).not.toContain("outside.txt");

    const references = await store.getProjectGitReferences(member.projectId);
    expect(references.refs[0]).toMatchObject({ kind: "head", name: "HEAD" });
    expect(references.refs).toContainEqual(expect.objectContaining({ kind: "tag", name: "v1.0", oid: initialOid }));
    expect(references.refs.filter((item) => item.kind === "commit").map((item) => item.subject)).toEqual(["second", "initial"]);
    const fromTag = await store.getProjectGitDiff(member.projectId, initialOid);
    expect(fromTag.baseOid).toBe(initialOid);
    expect(fromTag.patch).toContain("初始内容");
    expect(fromTag.patch).toContain("工作树修改");
    expect(fromTag.files.some((file) => file.path === "docs-after-initial.md")).toBe(false);
    await expect(store.getProjectGitDiff(member.projectId, "--output=/tmp/unsafe"))
      .rejects.toMatchObject({ code: "invalid_git_base" });

    await writeFile(path.join(projectRoot, "graph/main.json"), "{}\n");
    const run = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId });
    expect(run.artifact?.graph.nodes).toHaveLength(3);
    expect(run.run.revision).toBe(revision.revisionId);
    expect(run.artifact?.contentHash).toBe(revision.contentHash);
  });

  it("reports Git unavailable for managed copies", async () => {
    const workspace = await store.createWorkspace({ name: "管理副本 Git" });
    const withSkill = await store.createManagedSkill(workspace.workspaceId, { name: "Managed", capability: "content-only" });
    const diff = await store.getProjectGitDiff(withSkill.members[0]!.projectId);
    expect(diff.capability).toMatchObject({ available: false, reason: "管理副本不关联用户 Git 仓库" });
    expect(diff.files).toEqual([]);
    expect((await store.getProjectGitReferences(withSkill.members[0]!.projectId)).refs).toEqual([]);
  });

  it("persists a workspace and multiple stable skill projects", async () => {
    const workspace = await store.createWorkspace({ name: "研发工具" });
    await store.createManagedSkill(workspace.workspaceId, { name: "需求分析", capability: "workflow" });
    const updated = await store.createManagedSkill(workspace.workspaceId, {
      name: "术语规范",
      capability: "content-only"
    });

    expect(updated.members).toHaveLength(2);
    expect(updated.selectedProjectId).toBe(updated.members[1]?.projectId);
    expect(new Set(updated.members.map((member) => member.skillId)).size).toBe(2);

    const reloaded = await store.getWorkspace(workspace.workspaceId);
    expect(reloaded.members.map((member) => member.displayName)).toEqual(["需求分析", "术语规范"]);

    const source = JSON.parse(
      await readFile(path.join(root, "projects", updated.members[0]!.projectId, "source.json"), "utf8")
    ) as { root: string };
    const manifest = JSON.parse(await readFile(path.join(source.root, "skill.json"), "utf8")) as { skillId: string };
    expect(manifest.skillId).toBe(updated.members[0]?.skillId);
    const graph = await store.getProjectGraph(updated.members[0]!.projectId);
    expect(graph.graph.entry).toBe("flow.start");
    expect(graph.lint).toEqual([]);
  });

  it("resolves exact document slices, counts node references, and blocks broken bindings", async () => {
    const workspace = await store.createWorkspace({ name: "文档绑定" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "精确切片", capability: "workflow" });
    const member = created.members[0]!;
    const markdown = [
      "# Guide",
      "",
      "## Windows",
      "",
      "### Retry",
      "",
      "windows-only",
      "",
      "## macOS",
      "",
      "### Retry",
      "",
      "mac-only",
      ""
    ].join("\n");
    const documentChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: member.activeRevision,
      reason: "创建重复标题文档",
      operations: [{ op: "docs.write", target: "docs/repeated.md", value: markdown }]
    });
    const documentApplied = await store.confirmAndApplyChangeSet(documentChange.changeSetId, {
      digest: documentChange.digest,
      baseRevision: documentChange.baseRevision
    });

    const graphView = await store.getProjectGraph(member.projectId);
    const coreNode = graphView.graph.nodes.find((node) => node.id === "flow.core-step")!;
    const graphChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documentApplied.activeRevision,
      reason: "绑定 macOS 精确标题路径",
      operations: [{
        op: "graph.node.update",
        target: coreNode.id,
        value: { ...coreNode, doc: "docs/repeated.md", docAnchor: "Guide/macOS/Retry" }
      }]
    });
    const graphApplied = await store.confirmAndApplyChangeSet(graphChange.changeSetId, {
      digest: graphChange.digest,
      baseRevision: graphChange.baseRevision
    });

    const slice = await store.getProjectDocumentSlice(member.projectId, "docs/repeated.md", "Guide/macOS/Retry");
    expect(slice.status).toBe("found");
    expect(slice.slice?.content).toContain("mac-only");
    expect(slice.slice?.content).not.toContain("windows-only");
    expect((await store.listDocuments(member.projectId)).find((entry) => entry.path === "docs/repeated.md")?.referenceCount).toBe(1);
    expect(await store.listDocumentReferences(member.projectId, "docs/repeated.md")).toEqual([expect.objectContaining({
      nodeId: "flow.core-step",
      anchor: "Guide/macOS/Retry"
    })]);

    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: graphApplied.activeRevision,
      reason: "错误删除被引用标题",
      operations: [{ op: "docs.write", target: "docs/repeated.md", value: "# Guide\n\n标题已删除。\n" }]
    })).rejects.toMatchObject({ code: "document_binding_broken" });
  });

  it("persists benchmark cases through ChangeSets and rejects impossible exact paths", async () => {
    const workspace = await store.createWorkspace({ name: "用例编写" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "用例 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const caseId = "case-33333333-3333-4333-8333-333333333333";
    const value = {
      schemaVersion: "1.0" as const,
      caseId,
      skillId: member.skillId,
      title: "核心流程完成",
      status: "ready" as const,
      intent: "从开始走到结束",
      fixture: { initialVariables: { approved: true }, userReplies: [] },
      expected: {
        path: { mode: "exact" as const, nodeIds: ["flow.start", "flow.core-step", "flow.end"] },
        terminal: { status: "completed" as const, nodeId: "flow.end" },
        variables: {},
        artifacts: [],
        toolResults: [],
        forbiddenEffects: ["不得修改 Skill 项目"]
      },
      tags: ["smoke"]
    };
    const create = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: member.activeRevision,
      reason: "创建测试用例",
      operations: [{ op: "benchmark.case.write", target: caseId, value }]
    });
    expect(create.preview[0]).toMatchObject({ kind: "benchmark-case", action: "create", caseId });
    const createdCase = await store.confirmAndApplyChangeSet(create.changeSetId, {
      digest: create.digest,
      baseRevision: create.baseRevision
    });
    expect(createdCase.benchmarkCase?.case.title).toBe("核心流程完成");
    expect(await store.listBenchmarkCases(member.projectId)).toEqual([expect.objectContaining({ caseId, valid: true })]);
    expect((await store.readBenchmarkCase(member.projectId, caseId)).case.expected.path.mode).toBe("exact");
    const prepared = await store.prepareBenchmarkExecution(member.projectId, workspace.workspaceId, caseId);
    expect(prepared).toMatchObject({
      benchmarkCase: { caseId, status: "ready" },
      runtimeArtifact: {
        workspaceId: workspace.workspaceId,
        projectId: member.projectId,
        skillId: member.skillId,
        revision: createdCase.activeRevision,
        graph: { entry: "flow.start" }
      }
    });
    expect(await readFile(path.join(prepared.snapshotRoot, "benchmarks", "cases", `${caseId}.json`), "utf8")).toContain("核心流程完成");

    const benchmarkRun: BenchmarkRunRecord = {
      schemaVersion: "1.0",
      benchmarkRunId: "benchmark-run-44444444-4444-4444-8444-444444444444",
      workspaceId: workspace.workspaceId,
      projectId: member.projectId,
      skillId: member.skillId,
      caseId,
      status: "completed",
      automaticVerdict: "failed",
      fingerprint: {
        schemaVersion: "1.0",
        providerId: "openai-responses",
        requestedModel: "gpt-5.6-terra",
        resolvedModels: ["gpt-5.6-terra"],
        reasoningEffort: "low",
        promptTemplateVersion: "benchmark-decision/1",
        runnerImage: `runner@sha256:${"d".repeat(64)}`,
        sandboxBackendId: "docker-desktop",
        sandboxPolicyHash: "sha256:policy",
        runtimeArtifactId: prepared.runtimeArtifact.artifactId,
        revision: prepared.runtimeArtifact.revision,
        contentHash: prepared.runtimeArtifact.contentHash
      },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 0, reasoningTokens: 0, cacheWriteTokens: 0 },
      modelCallCount: 1,
      sandboxHandleIds: [],
      events: [
        { seq: 1, at: "2026-07-27T08:00:00.000Z", type: "engine.start", nodeId: "flow.start", data: {} },
        { seq: 2, at: "2026-07-27T08:00:00.000Z", type: "engine.enter", nodeId: "flow.start", data: { step: 0 } },
        { seq: 3, at: "2026-07-27T08:00:00.000Z", type: "engine.enter", nodeId: "flow.core-step", data: { step: 1, viaEdgeId: "edge.start-core" } },
        { seq: 4, at: "2026-07-27T08:00:00.000Z", type: "engine.reject", nodeId: "flow.core-step", data: { requestedNodeId: "flow.start", allowedNodeIds: ["flow.end"] } },
        { seq: 5, at: "2026-07-27T08:00:00.000Z", type: "assertion.result", data: { assertionId: "assertion-path", kind: "path", status: "fail", message: "缺少 flow.end" } },
        { seq: 6, at: "2026-07-27T08:00:00.000Z", type: "benchmark.completed", data: { automaticVerdict: "failed" } }
      ],
      assertions: [{ assertionId: "assertion-path", kind: "path", status: "fail", message: "缺少 flow.end" }],
      humanReviews: [],
      createdAt: "2026-07-27T08:00:00.000Z",
      updatedAt: "2026-07-27T08:00:00.000Z",
      completedAt: "2026-07-27T08:00:00.000Z"
    };
    const benchmarkReport = await store.createBenchmarkBugReport(member.projectId, benchmarkRun, { workspaceId: workspace.workspaceId, sanitizationMode: "default", userNote: "真实断言失败" });
    expect(benchmarkReport.report.source).toMatchObject({ kind: "benchmark", benchmarkRunId: benchmarkRun.benchmarkRunId, caseId, artifactId: prepared.runtimeArtifact.artifactId });
    const confirmedReport = await store.confirmBugReport(benchmarkReport.reportId, { digest: benchmarkReport.digest });
    const importedReport = await store.importStoredBugReport(workspace.workspaceId, confirmedReport.reportId);
    expect(importedReport).toMatchObject({ match: { status: "matched", matchedProjectId: member.projectId }, report: { source: { benchmarkRunId: benchmarkRun.benchmarkRunId } } });
    expect(await store.importStoredBugReport(workspace.workspaceId, confirmedReport.reportId)).toMatchObject({ reportImportId: importedReport.reportImportId });
    const benchmarkDiagnosis = await store.createDiagnosis(workspace.workspaceId, importedReport.reportImportId);
    expect(benchmarkDiagnosis.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "invalid-transition", repair: expect.objectContaining({ kind: "graph.add-edge" }) }),
      expect.objectContaining({ category: "benchmark-assertion" })
    ]));

    const repairCandidate = benchmarkDiagnosis.candidates.find((candidate) => candidate.category === "invalid-transition")!;
    const repairProposal = await store.createDiagnosisRepair(workspace.workspaceId, importedReport.reportImportId, benchmarkDiagnosis.diagnosisId, repairCandidate.candidateId);
    expect(repairProposal.changeSet).toMatchObject({
      source: { kind: "diagnosis", sourceId: benchmarkDiagnosis.diagnosisId, label: "诊断修复建议" },
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: "diagnosis", ref: repairCandidate.candidateId }),
        expect.objectContaining({ kind: "trace", ref: expect.stringContaining("#seq-") })
      ])
    });
    const appliedRepair = await store.confirmDiagnosisRepair(workspace.workspaceId, importedReport.reportImportId, repairProposal.repair.repairId, {
      digest: repairProposal.changeSet.digest,
      baseRevision: repairProposal.changeSet.baseRevision
    });
    const postRepairContext = await store.preparePostRepairBenchmark(workspace.workspaceId, importedReport.reportImportId, appliedRepair.repair.repairId);
    expect(postRepairContext).toMatchObject({
      projectId: member.projectId,
      caseId,
      parentBenchmarkRunId: benchmarkRun.benchmarkRunId,
      changeSetId: repairProposal.changeSet.changeSetId,
      appliedRevision: appliedRepair.repair.appliedRevision
    });
    const postRepairPrepared = await store.prepareBenchmarkExecution(member.projectId, workspace.workspaceId, caseId);
    expect(postRepairPrepared.runtimeArtifact.artifactId).not.toBe(prepared.runtimeArtifact.artifactId);
    const postRepairRun: BenchmarkRunRecord = {
      ...structuredClone(benchmarkRun),
      benchmarkRunId: "benchmark-run-55555555-5555-4555-8555-555555555555",
      automaticVerdict: "passed",
      fingerprint: {
        ...benchmarkRun.fingerprint,
        runtimeArtifactId: postRepairPrepared.runtimeArtifact.artifactId,
        revision: postRepairPrepared.runtimeArtifact.revision,
        contentHash: postRepairPrepared.runtimeArtifact.contentHash
      },
      events: [
        { seq: 1, at: "2026-07-27T08:00:00.000Z", type: "engine.start", nodeId: "flow.start", data: {} },
        { seq: 2, at: "2026-07-27T08:00:00.000Z", type: "engine.enter", nodeId: "flow.core-step", data: { viaEdgeId: "edge.start-core" } },
        { seq: 3, at: "2026-07-27T08:00:00.000Z", type: "engine.enter", nodeId: "flow.start", data: { viaEdgeId: "edge.diagnosis-4" } },
        { seq: 4, at: "2026-07-27T08:00:00.000Z", type: "benchmark.completed", data: { automaticVerdict: "passed" } }
      ],
      assertions: [{ assertionId: "assertion-path", kind: "path", status: "pass", message: "修复路径通过" }],
      humanReviews: [{ reviewId: "benchmark-review-66666666-6666-4666-8666-666666666666", verdict: "passed", note: "人工确认修复行为符合预期", createdAt: "2026-07-27T08:00:00.000Z" }],
      lineage: {
        relation: "post-repair",
        parentBenchmarkRunId: benchmarkRun.benchmarkRunId,
        repairId: appliedRepair.repair.repairId,
        changeSetId: repairProposal.changeSet.changeSetId,
        appliedRevision: appliedRepair.repair.appliedRevision!
      }
    };
    const inconclusiveRun = structuredClone(postRepairRun);
    inconclusiveRun.humanReviews = [];
    await expect(store.verifyDiagnosisRepairWithBenchmark(workspace.workspaceId, importedReport.reportImportId, appliedRepair.repair.repairId, inconclusiveRun, benchmarkRun))
      .rejects.toMatchObject({ code: "benchmark_verification_inconclusive" });
    const verifiedRepair = await store.verifyDiagnosisRepairWithBenchmark(workspace.workspaceId, importedReport.reportImportId, appliedRepair.repair.repairId, postRepairRun, benchmarkRun);
    expect(verifiedRepair).toMatchObject({ status: "verified", verification: { level: "benchmark", runId: postRepairRun.benchmarkRunId } });
    expect(verifiedRepair.verification?.evidence).toEqual(expect.arrayContaining([expect.stringContaining("RuntimeArtifact"), expect.stringContaining("人工判定 passed")]));

    const impossible = structuredClone(value);
    impossible.expected.path.nodeIds = ["flow.start", "flow.end"];
    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: appliedRepair.repair.appliedRevision!,
      reason: "不可能的精确路径",
      operations: [{ op: "benchmark.case.write", target: caseId, value: impossible }]
    })).rejects.toMatchObject({ code: "benchmark_case_lint_failed" });

    const updated = structuredClone(value);
    updated.title = "核心流程完成（更新）";
    const update = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: appliedRepair.repair.appliedRevision!,
      reason: "更新测试用例",
      operations: [{ op: "benchmark.case.write", target: caseId, value: updated }]
    });
    const updatedCase = await store.confirmAndApplyChangeSet(update.changeSetId, {
      digest: update.digest,
      baseRevision: update.baseRevision
    });
    expect(updatedCase.benchmarkCase?.case.title).toBe("核心流程完成（更新）");

    const remove = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: updatedCase.activeRevision,
      reason: "删除测试用例",
      operations: [{ op: "benchmark.case.delete", target: caseId }]
    });
    expect(remove.preview[0]).toMatchObject({ kind: "benchmark-case", action: "delete" });
    const deleted = await store.confirmAndApplyChangeSet(remove.changeSetId, {
      digest: remove.digest,
      baseRevision: remove.baseRevision
    });
    expect(deleted.deletedBenchmarkCaseId).toBe(caseId);
    expect(await store.listBenchmarkCases(member.projectId)).toEqual([]);
  });

  it("indexes one hundred benchmark cases without dropping valid entries", async () => {
    const workspace = await store.createWorkspace({ name: "百用例索引" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "规模用例 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const source = JSON.parse(await readFile(path.join(root, "projects", member.projectId, "source.json"), "utf8")) as { root: string };
    const casesDir = path.join(source.root, "benchmarks", "cases");
    await mkdir(casesDir, { recursive: true });
    await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const caseId = `case-90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const value = {
        schemaVersion: "1.0",
        caseId,
        skillId: member.skillId,
        title: `规模回归 ${String(index + 1).padStart(3, "0")}`,
        status: "ready",
        intent: "验证百用例索引和页面检索",
        fixture: { initialVariables: { index }, userReplies: [] },
        expected: {
          path: { mode: "subsequence", nodeIds: ["flow.start", "flow.end"] },
          terminal: { status: "completed", nodeId: "flow.end" },
          variables: {},
          artifacts: [],
          toolResults: [],
          forbiddenEffects: []
        },
        tags: [index % 2 === 0 ? "even" : "odd", "scale"]
      };
      await writeFile(path.join(casesDir, `${caseId}.json`), `${JSON.stringify(value, null, 2)}\n`);
    }));

    const entries = await store.listBenchmarkCases(member.projectId);
    expect(entries).toHaveLength(100);
    expect(entries.every((entry) => entry.valid)).toBe(true);
    expect(entries.filter((entry) => entry.tags.includes("even"))).toHaveLength(50);
  });

  it("switches current skill and removes only the workspace reference", async () => {
    const workspace = await store.createWorkspace({ name: "切换测试" });
    const first = await store.createManagedSkill(workspace.workspaceId, { name: "Skill A", capability: "workflow" });
    const firstProjectId = first.members[0]!.projectId;
    const second = await store.createManagedSkill(workspace.workspaceId, { name: "Skill B", capability: "content-only" });

    const selected = await store.selectProject(workspace.workspaceId, firstProjectId);
    expect(selected.selectedProjectId).toBe(firstProjectId);

    const afterRemoval = await store.removeMember(workspace.workspaceId, firstProjectId);
    expect(afterRemoval.members).toHaveLength(1);
    expect(afterRemoval.selectedProjectId).toBe(second.members[1]?.projectId);

    const sourceFile = path.join(root, "projects", firstProjectId, "source.json");
    expect(await readFile(sourceFile, "utf8")).toContain(firstProjectId);
  });

  it("previews a document ChangeSet and writes only after matching confirmation", async () => {
    const workspace = await store.createWorkspace({ name: "文档变更" });
    const withSkill = await store.createManagedSkill(workspace.workspaceId, { name: "文档 Skill", capability: "workflow" });
    const member = withSkill.members[0]!;
    const original = await store.readDocument(member.projectId, "SKILL.md");
    const initialStatus = await store.getRevisionStatus(member.projectId);
    expect(initialStatus.changedFiles).toEqual([]);
    expect(await store.listRevisions(member.projectId)).toHaveLength(1);
    const nextContent = `${original.content}\n## 验收\n\n变更仅在确认后生效。\n`;
    const changeSet = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision,
      reason: "补充验收说明",
      operations: [{ op: "docs.write", target: "SKILL.md", value: nextContent }]
    });

    expect((await store.readDocument(member.projectId, "SKILL.md")).content).toBe(original.content);
    expect(changeSet.preview[0]?.addedLines).toBeGreaterThan(0);

    await expect(store.confirmAndApplyChangeSet(changeSet.changeSetId, {
      digest: "wrong",
      baseRevision: original.activeRevision
    })).rejects.toMatchObject({ code: "confirmation_mismatch" });

    const applied = await store.confirmAndApplyChangeSet(changeSet.changeSetId, {
      digest: changeSet.digest,
      baseRevision: changeSet.baseRevision
    });
    expect(applied.document.content).toBe(nextContent);
    expect(applied.document.activeRevision).not.toBe(original.activeRevision);

    const changedStatus = await store.getRevisionStatus(member.projectId);
    expect(changedStatus.changedFiles.map((file) => [file.path, file.status])).toEqual([["SKILL.md", "modified"]]);
    const revisions = await store.listRevisions(member.projectId);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.parentRevision).toBe(original.activeRevision);
    expect(revisions[0]?.changeSetId).toBe(changeSet.changeSetId);

    await expect(store.acknowledgeBaseline(member.projectId, {
      workspaceId: workspace.workspaceId,
      revisionId: changedStatus.activeRevision.revisionId,
      snapshotId: "snapshot-00000000-0000-4000-8000-999999999999"
    })).rejects.toMatchObject({ code: "baseline_target_changed" });
    const acknowledged = await store.acknowledgeBaseline(member.projectId, {
      workspaceId: workspace.workspaceId,
      revisionId: changedStatus.activeRevision.revisionId,
      snapshotId: changedStatus.currentSnapshot.snapshotId
    });
    expect(acknowledged.changedFiles).toEqual([]);
    expect(acknowledged.activeRevision.revisionId).toBe(applied.activeRevision);
  });

  it("renames and deletes documents with atomic graph reference synchronization", async () => {
    const workspace = await store.createWorkspace({ name: "文档生命周期" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "文档引用 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const originalGraph = await store.getProjectGraph(member.projectId);
    const coreNode = originalGraph.graph.nodes.find((node) => node.id === "flow.core-step")!;
    const createDocument = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: originalGraph.activeRevision,
      reason: "创建需要重命名的文档",
      operations: [{ op: "docs.write", target: "docs/guide.md", value: "# Guide\n\n## Retry\n\n保留内容。\n" }]
    });
    const documentApplied = await store.confirmAndApplyChangeSet(createDocument.changeSetId, {
      digest: createDocument.digest,
      baseRevision: createDocument.baseRevision
    });
    const bindDocument = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documentApplied.activeRevision,
      reason: "绑定文档标题",
      operations: [{
        op: "graph.node.update",
        target: coreNode.id,
        value: { ...coreNode, doc: "docs/guide.md", docAnchor: "Guide/Retry" }
      }]
    });
    const graphApplied = await store.confirmAndApplyChangeSet(bindDocument.changeSetId, {
      digest: bindDocument.digest,
      baseRevision: bindDocument.baseRevision
    });

    const renameDocument = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: graphApplied.activeRevision,
      reason: "重命名并同步节点引用",
      operations: [{ op: "docs.rename", target: "docs/guide.md", value: "docs/reference.md" }]
    });
    expect(renameDocument.preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "document", action: "rename", target: "docs/guide.md", destination: "docs/reference.md", referenceNodeIds: ["flow.core-step"] }),
      expect.objectContaining({ kind: "graph", updatedNodeIds: ["flow.core-step"] })
    ]));
    expect((await store.readDocument(member.projectId, "docs/guide.md")).content).toContain("保留内容");
    await expect(store.readDocument(member.projectId, "docs/reference.md")).rejects.toMatchObject({ code: "document_not_found" });
    expect((await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === coreNode.id)?.doc).toBe("docs/guide.md");

    const renamed = await store.confirmAndApplyChangeSet(renameDocument.changeSetId, {
      digest: renameDocument.digest,
      baseRevision: renameDocument.baseRevision
    });
    expect(renamed.document).toMatchObject({ path: "docs/reference.md", content: expect.stringContaining("保留内容") });
    await expect(store.readDocument(member.projectId, "docs/guide.md")).rejects.toMatchObject({ code: "document_not_found" });
    expect((await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === coreNode.id)).toMatchObject({
      doc: "docs/reference.md",
      docAnchor: "Guide/Retry"
    });
    expect((await store.getRevisionStatus(member.projectId)).changedFiles.map((item) => [item.path, item.status])).toEqual(expect.arrayContaining([
      ["docs/reference.md", "added"],
      ["graph/main.json", "modified"]
    ]));

    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: renamed.activeRevision,
      reason: "重命名到已有文档",
      operations: [{ op: "docs.rename", target: "docs/reference.md", value: "SKILL.md" }]
    })).rejects.toMatchObject({ code: "document_destination_exists" });
    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: renamed.activeRevision,
      reason: "错误删除根文档",
      operations: [{ op: "docs.delete", target: "SKILL.md" }]
    })).rejects.toMatchObject({ code: "skill_document_protected" });

    const deleteDocument = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: renamed.activeRevision,
      reason: "删除文档并解除节点引用",
      operations: [{ op: "docs.delete", target: "docs/reference.md" }]
    });
    expect(deleteDocument.preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "document", action: "delete", referenceNodeIds: ["flow.core-step"] }),
      expect.objectContaining({ kind: "graph", updatedNodeIds: ["flow.core-step"] })
    ]));
    const deleted = await store.confirmAndApplyChangeSet(deleteDocument.changeSetId, {
      digest: deleteDocument.digest,
      baseRevision: deleteDocument.baseRevision
    });
    expect(deleted.deletedDocumentPath).toBe("docs/reference.md");
    await expect(store.readDocument(member.projectId, "docs/reference.md")).rejects.toMatchObject({ code: "document_not_found" });
    const unboundNode = (await store.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === coreNode.id)!;
    expect(unboundNode.doc).toBeUndefined();
    expect(unboundNode.docAnchor).toBeUndefined();
  });

  it("previews graph operations, blocks invalid drafts, and applies only after confirmation", async () => {
    const workspace = await store.createWorkspace({ name: "图变更" });
    const withSkill = await store.createManagedSkill(workspace.workspaceId, { name: "流程 Skill", capability: "workflow" });
    const member = withSkill.members[0]!;
    const original = await store.getProjectGraph(member.projectId);

    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision,
      reason: "制造不可达终点",
      operations: [{ op: "graph.edge.delete", target: "edge.core-end" }]
    })).rejects.toMatchObject({ code: "graph_lint_failed" });

    const changeSet = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision,
      reason: "增加人工确认节点",
      operations: [
        { op: "graph.edge.delete", target: "edge.core-end" },
        {
          op: "graph.node.create",
          target: "flow.review",
          value: { id: "flow.review", kind: "gate", title: "人工确认", position: { x: 600, y: 180 } }
        },
        {
          op: "graph.edge.create",
          target: "edge.core-review",
          value: { id: "edge.core-review", from: "flow.core-step", to: "flow.review", kind: "flow" }
        },
        {
          op: "graph.edge.create",
          target: "edge.review-end",
          value: { id: "edge.review-end", from: "flow.review", to: "flow.end", kind: "flow" }
        }
      ]
    });
    const preview = changeSet.preview[0];
    expect(preview?.kind).toBe("graph");
    if (preview?.kind !== "graph") throw new Error("Expected graph preview");
    expect(preview.addedNodeIds).toEqual(["flow.review"]);
    expect((await store.getProjectGraph(member.projectId)).graph.nodes).toHaveLength(3);

    const applied = await store.confirmAndApplyChangeSet(changeSet.changeSetId, {
      digest: changeSet.digest,
      baseRevision: changeSet.baseRevision
    });
    expect(applied.graph?.nodes.map((node) => node.id)).toContain("flow.review");
    expect(applied.activeRevision).not.toBe(original.activeRevision);
    expect((await store.getProjectGraph(member.projectId)).graph.nodes).toHaveLength(4);
  });

  it("rejects a matching ChangeSet without changing project files or active revision", async () => {
    const workspace = await store.createWorkspace({ name: "拒绝变更" });
    const withSkill = await store.createManagedSkill(workspace.workspaceId, { name: "拒绝流程", capability: "workflow" });
    const member = withSkill.members[0]!;
    const original = await store.getProjectGraph(member.projectId);
    const proposed = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision,
      reason: "修改后由用户拒绝",
      operations: [{
        op: "graph.node.update",
        target: "flow.core-step",
        value: { id: "flow.core-step", kind: "step", title: "不会写入", position: { x: 360, y: 180 } }
      }]
    });

    await expect(store.rejectChangeSet(proposed.changeSetId, {
      digest: "not-the-preview-digest",
      baseRevision: proposed.baseRevision
    })).rejects.toMatchObject({ code: "rejection_mismatch" });
    expect((await store.getChangeSet(proposed.changeSetId)).status).toBe("proposed");

    const rejected = await store.rejectChangeSet(proposed.changeSetId, {
      digest: proposed.digest,
      baseRevision: proposed.baseRevision,
      reason: "保留草稿，调整后重新提交"
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      rejectionReason: "保留草稿，调整后重新提交",
      rejectedAt: "2026-07-27T08:00:00.000Z"
    });
    const unchanged = await store.getProjectGraph(member.projectId);
    expect(unchanged.activeRevision).toBe(original.activeRevision);
    expect(unchanged.graph).toEqual(original.graph);
    await expect(store.confirmAndApplyChangeSet(proposed.changeSetId, {
      digest: proposed.digest,
      baseRevision: proposed.baseRevision
    })).rejects.toMatchObject({ code: "changeset_not_proposed" });
    await expect(store.rejectChangeSet(proposed.changeSetId, {
      digest: proposed.digest,
      baseRevision: proposed.baseRevision
    })).rejects.toMatchObject({ code: "changeset_not_proposed" });
  });

  it("persists ChangeSet attribution and binds source evidence into its confirmation digest", async () => {
    const workspace = await store.createWorkspace({ name: "提案证据" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "证据流程", capability: "workflow" });
    const member = created.members[0]!;
    const original = await store.getProjectGraph(member.projectId);
    const input = {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision,
      reason: "根据用户请求补充说明",
      source: { kind: "assistant" as const, sourceId: "assistant-session-11111111-1111-4111-8111-111111111111", label: "设计助手" },
      operations: [{ op: "docs.write" as const, target: "docs/evidence.md", value: "# 证据\n" }]
    };
    const first = await store.createChangeSet(member.projectId, {
      ...input,
      evidence: [{ kind: "user-request", ref: input.source.sourceId, summary: "补充证据文档" }]
    });
    const second = await store.createChangeSet(member.projectId, {
      ...input,
      evidence: [{ kind: "user-request", ref: input.source.sourceId, summary: "另一条不同的请求" }]
    });

    expect(await store.getChangeSet(first.changeSetId)).toMatchObject({
      source: input.source,
      evidence: [{ kind: "user-request", ref: input.source.sourceId, summary: "补充证据文档" }]
    });
    expect(first.digest).not.toBe(second.digest);
    await expect(store.createChangeSet(member.projectId, {
      ...input,
      evidence: [{ kind: "runtime", ref: "run", summary: "x".repeat(501) }]
    })).rejects.toMatchObject({ code: "changeset_evidence_invalid" });
  });

  it("updates editable Skill manifest fields only through a confirmed ChangeSet", async () => {
    const workspace = await store.createWorkspace({ name: "Skill 信息变更" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "旧名称", description: "旧说明", capability: "workflow" });
    const member = created.members[0]!;
    const original = await store.getSkillManifest(member.projectId);
    const proposed = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision,
      reason: "更新 Skill 对外信息",
      operations: [{ op: "skill.update", target: "skill.json", value: { name: "新名称", version: "1.2.0", description: "新说明" } }]
    });

    expect(proposed.preview).toMatchObject([{
      kind: "skill-manifest",
      target: "skill.json",
      changedFields: ["name", "version", "description"],
      before: { skillId: member.skillId, name: "旧名称", capability: "workflow", entry: "flow.start" },
      after: { skillId: member.skillId, name: "新名称", version: "1.2.0", description: "新说明", capability: "workflow", entry: "flow.start" }
    }]);
    expect((await store.getSkillManifest(member.projectId)).manifest.name).toBe("旧名称");
    const applied = await store.confirmAndApplyChangeSet(proposed.changeSetId, { digest: proposed.digest, baseRevision: proposed.baseRevision });
    expect(applied.skillManifest).toMatchObject({ skillId: member.skillId, name: "新名称", version: "1.2.0", description: "新说明", capability: "workflow", entry: "flow.start" });
    expect((await store.getWorkspace(workspace.workspaceId)).members[0]).toMatchObject({ displayName: "新名称", skillId: member.skillId, capability: "workflow" });

    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: applied.activeRevision,
      reason: "试图修改受保护身份",
      operations: [{ op: "skill.update", target: "skill.json", value: { name: "越界", version: "2.0.0", description: "", capability: "content-only" } }]
    })).rejects.toMatchObject({ code: "skill_manifest_field_protected" });
  });

  it("preserves manifest, node, edge, and graph extension fields through confirmed edits", async () => {
    const workspace = await store.createWorkspace({ name: "扩展字段保真" });
    const projectRoot = path.join(root, "extension-skill");
    const skillId = "skill-33333333-3333-4333-8333-333333333333";
    await mkdir(path.join(projectRoot, "graph"), { recursive: true });
    await writeFile(path.join(projectRoot, "SKILL.md"), "# 扩展字段保真\n", "utf8");
    await writeFile(path.join(projectRoot, "skill.json"), JSON.stringify({
      skillId,
      name: "扩展字段 Skill",
      version: "0.1.0",
      description: "",
      capability: "workflow",
      entry: "flow.start",
      license: "MIT",
      vendorManifest: { owner: "platform" }
    }, null, 2) + "\n", "utf8");
    await writeFile(path.join(projectRoot, "graph/main.json"), JSON.stringify({
      schemaVersion: "1.0",
      skillId,
      capability: "workflow",
      entry: "flow.start",
      vendorGraph: { schema: 7 },
      nodes: [
        { id: "flow.start", kind: "start", title: "开始", vendorNode: { color: "green" }, extensions: { owner: "core" } },
        { id: "flow.end", kind: "end", title: "结束" }
      ],
      edges: [{ id: "edge.start-end", from: "flow.start", to: "flow.end", kind: "flow", vendorEdge: { audit: true }, extensions: { lane: 2 } }]
    }, null, 2) + "\n", "utf8");

    const opened = await store.openInPlaceProject(workspace.workspaceId, { rootPath: projectRoot });
    const member = opened.members[0]!;
    const before = await store.getProjectGraph(member.projectId);
    const node = before.graph.nodes.find((item) => item.id === "flow.start")!;
    const edge = before.graph.edges[0]!;
    const graphChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: before.activeRevision,
      reason: "只修改已知字段并保留扩展数据",
      operations: [
        { op: "graph.node.update", target: node.id, value: { ...node, title: "开始审核" } },
        { op: "graph.edge.update", target: edge.id, value: { ...edge, label: "进入" } }
      ]
    });
    const graphApplied = await store.confirmAndApplyChangeSet(graphChange.changeSetId, { digest: graphChange.digest, baseRevision: graphChange.baseRevision });
    const persistedGraph = JSON.parse(await readFile(path.join(projectRoot, "graph/main.json"), "utf8")) as SkillGraph;
    expect(persistedGraph.vendorGraph).toEqual({ schema: 7 });
    expect(persistedGraph.nodes.find((item) => item.id === node.id)).toMatchObject({
      title: "开始审核",
      vendorNode: { color: "green" },
      extensions: { owner: "core" }
    });
    expect(persistedGraph.edges[0]).toMatchObject({ label: "进入", vendorEdge: { audit: true }, extensions: { lane: 2 } });

    const manifestChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: graphApplied.activeRevision,
      reason: "修改显示信息并保留 manifest 扩展",
      operations: [{ op: "skill.update", target: "skill.json", value: { name: "扩展字段 Skill 2", version: "0.2.0", description: "保真" } }]
    });
    await store.confirmAndApplyChangeSet(manifestChange.changeSetId, { digest: manifestChange.digest, baseRevision: manifestChange.baseRevision });
    expect(JSON.parse(await readFile(path.join(projectRoot, "skill.json"), "utf8"))).toMatchObject({
      name: "扩展字段 Skill 2",
      license: "MIT",
      vendorManifest: { owner: "platform" }
    });

    const latest = await store.getProjectGraph(member.projectId);
    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: latest.activeRevision,
      reason: "拒绝无界扩展字段",
      operations: [{ op: "graph.node.update", target: node.id, value: { ...latest.graph.nodes.find((item) => item.id === node.id)!, oversizedVendorData: "x".repeat(70 * 1024) } }]
    })).rejects.toMatchObject({ code: "graph_extension_too_large" });

    await expect(store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: latest.activeRevision,
      reason: "拒绝有损扩展字段",
      operations: [{ op: "graph.node.update", target: node.id, value: { ...latest.graph.nodes.find((item) => item.id === node.id)!, invalidVendorData: { omitted: undefined } } }]
    })).rejects.toMatchObject({ code: "graph_extension_invalid" });
  });

  it("records conflict facts and creates a fresh ChangeSet when the user requests a re-preview", async () => {
    const workspace = await store.createWorkspace({ name: "冲突裁决" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "冲突重预演", capability: "workflow" });
    const member = created.members[0]!;
    const original = await store.getRevisionStatus(member.projectId);
    const stale = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision.revisionId,
      reason: "用户仍需审阅的原提案",
      operations: [{ op: "docs.write", target: "docs/user-draft.md", value: "# 用户草稿\n" }]
    });
    const competing = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision.revisionId,
      reason: "并发进入的另一项确认",
      operations: [{ op: "docs.write", target: "docs/competing.md", value: "# 当前项目事实\n" }]
    });
    const competingApplied = await store.confirmAndApplyChangeSet(competing.changeSetId, {
      digest: competing.digest,
      baseRevision: competing.baseRevision
    });

    await expect(store.confirmAndApplyChangeSet(stale.changeSetId, {
      digest: stale.digest,
      baseRevision: stale.baseRevision
    })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await store.getChangeSet(stale.changeSetId)).toMatchObject({
      status: "conflicted",
      conflict: {
        code: "revision_conflict",
        message: "项目版本已变化，原提案不能继续应用",
        detectedAt: "2026-07-27T08:00:00.000Z",
        baseRevision: stale.baseRevision,
        currentRevision: competingApplied.activeRevision
      }
    });
    await expect(store.readDocument(member.projectId, "docs/user-draft.md")).rejects.toMatchObject({ code: "document_not_found" });

    const reproposed = await store.reproposeChangeSet(stale.changeSetId, {
      digest: stale.digest,
      baseRevision: stale.baseRevision
    });
    expect(reproposed).toMatchObject({
      status: "proposed",
      baseRevision: competingApplied.activeRevision,
      reason: stale.reason
    });
    expect(reproposed.changeSetId).not.toBe(stale.changeSetId);
    expect((await store.getChangeSet(stale.changeSetId)).status).toBe("conflicted");
    await store.confirmAndApplyChangeSet(reproposed.changeSetId, {
      digest: reproposed.digest,
      baseRevision: reproposed.baseRevision
    });
    expect((await store.readDocument(member.projectId, "docs/user-draft.md")).content).toBe("# 用户草稿\n");
  });

  it("undoes the latest commit through a snapshot restore ChangeSet and creates a new revision", async () => {
    const workspace = await store.createWorkspace({ name: "快照撤销" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "可撤销流程", capability: "workflow" });
    const member = created.members[0]!;
    const initial = await store.getRevisionStatus(member.projectId);
    const documentChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: initial.activeRevision.revisionId,
      reason: "创建稍后撤销的文档",
      operations: [{ op: "docs.write", target: "docs/undo.md", value: "# Undo\n\n需要完整恢复的内容。\n" }]
    });
    const documentApplied = await store.confirmAndApplyChangeSet(documentChange.changeSetId, {
      digest: documentChange.digest,
      baseRevision: documentChange.baseRevision
    });
    const changed = await store.getRevisionStatus(member.projectId);
    expect(changed.activeRevision.parentRevision).toBe(initial.activeRevision.revisionId);

    const rejectedUndo = await store.createUndoChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documentApplied.activeRevision
    });
    expect(rejectedUndo.preview[0]).toMatchObject({
      kind: "project-restore",
      fromRevision: documentApplied.activeRevision,
      toRevision: initial.activeRevision.revisionId,
      files: [expect.objectContaining({ path: "docs/undo.md", status: "deleted" })]
    });
    await store.rejectChangeSet(rejectedUndo.changeSetId, {
      digest: rejectedUndo.digest,
      baseRevision: rejectedUndo.baseRevision,
      reason: "先检查拒绝不会恢复"
    });
    expect((await store.readDocument(member.projectId, "docs/undo.md")).content).toContain("需要完整恢复");

    const undo = await store.createUndoChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documentApplied.activeRevision
    });
    const undone = await store.confirmAndApplyChangeSet(undo.changeSetId, {
      digest: undo.digest,
      baseRevision: undo.baseRevision
    });
    expect(undone).toMatchObject({
      restoredRevision: initial.activeRevision.revisionId,
      restoredSnapshotId: initial.currentSnapshot.snapshotId
    });
    await expect(store.readDocument(member.projectId, "docs/undo.md")).rejects.toMatchObject({ code: "document_not_found" });
    const afterUndo = await store.getRevisionStatus(member.projectId);
    expect(afterUndo.activeRevision).toMatchObject({
      source: "undo",
      parentRevision: documentApplied.activeRevision,
      contentHash: initial.activeRevision.contentHash,
      changeSetId: undo.changeSetId
    });
    expect(afterUndo.currentSnapshot.contentHash).toBe(initial.currentSnapshot.contentHash);
    expect(await store.listRevisions(member.projectId)).toHaveLength(3);

    const redoByUndo = await store.createUndoChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: afterUndo.activeRevision.revisionId
    });
    expect(redoByUndo.preview[0]).toMatchObject({
      kind: "project-restore",
      toRevision: documentApplied.activeRevision,
      files: [expect.objectContaining({ path: "docs/undo.md", status: "added" })]
    });
    await store.confirmAndApplyChangeSet(redoByUndo.changeSetId, {
      digest: redoByUndo.digest,
      baseRevision: redoByUndo.baseRevision
    });
    expect((await store.readDocument(member.projectId, "docs/undo.md")).content).toContain("需要完整恢复");

    const conflictUndo = await store.createUndoChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: (await store.getRevisionStatus(member.projectId)).activeRevision.revisionId
    });
    const source = JSON.parse(await readFile(path.join(root, "projects", member.projectId, "source.json"), "utf8")) as { root: string };
    await writeFile(path.join(source.root, "external-change.txt"), "预览后出现的外部修改\n");
    await expect(store.confirmAndApplyChangeSet(conflictUndo.changeSetId, {
      digest: conflictUndo.digest,
      baseRevision: conflictUndo.baseRevision
    })).rejects.toMatchObject({ code: "project_content_changed" });
    expect((await store.getChangeSet(conflictUndo.changeSetId)).status).toBe("conflicted");
    expect((await store.readDocument(member.projectId, "docs/undo.md")).content).toContain("需要完整恢复");
  });

  it.each<ProjectFileMutationStep>([
    "document-rename-destination",
    "document-rename-source",
    "document-rename-graph"
  ])("rolls back a document rename failure after %s", async (failureStep) => {
    const workspace = await store.createWorkspace({ name: `文档重命名故障 ${failureStep}` });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "事务重命名 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const initialGraph = await store.getProjectGraph(member.projectId);
    const coreNode = initialGraph.graph.nodes.find((node) => node.id === "flow.core-step")!;
    const sourcePath = "docs/transaction-source.md";
    const destinationPath = `docs/transaction-target-${failureStep}.md`;
    const sourceContent = "# 事务源文档\n\n重命名失败后必须完整恢复。\n";

    const documentChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: initialGraph.activeRevision,
      reason: "创建事务重命名源文档",
      operations: [{ op: "docs.write", target: sourcePath, value: sourceContent }]
    });
    const documentApplied = await store.confirmAndApplyChangeSet(documentChange.changeSetId, {
      digest: documentChange.digest,
      baseRevision: documentChange.baseRevision
    });
    const bindingChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documentApplied.activeRevision,
      reason: "绑定事务源文档",
      operations: [{
        op: "graph.node.update",
        target: coreNode.id,
        value: { ...coreNode, doc: sourcePath }
      }]
    });
    const bindingApplied = await store.confirmAndApplyChangeSet(bindingChange.changeSetId, {
      digest: bindingChange.digest,
      baseRevision: bindingChange.baseRevision
    });
    const stableStatus = await store.getRevisionStatus(member.projectId);
    const stableRevisionCount = (await store.listRevisions(member.projectId)).length;
    const source = JSON.parse(await readFile(path.join(root, "projects", member.projectId, "source.json"), "utf8")) as { root: string };
    const stableGraphBytes = await readFile(path.join(source.root, "graph", "main.json"), "utf8");
    const renameChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: bindingApplied.activeRevision,
      reason: `在 ${failureStep} 后注入故障`,
      operations: [{ op: "docs.rename", target: sourcePath, value: destinationPath }]
    });
    const observedSteps: ProjectFileMutationStep[] = [];
    const faultStore = new WorkspaceStore({
      dataDir: root,
      now: () => new Date("2026-07-27T08:05:00.000Z"),
      afterFileMutation: ({ step }) => {
        observedSteps.push(step);
        if (step === failureStep) throw new Error(`injected failure after ${step}`);
      }
    });
    await faultStore.initialize();

    await expect(faultStore.confirmAndApplyChangeSet(renameChange.changeSetId, {
      digest: renameChange.digest,
      baseRevision: renameChange.baseRevision
    })).rejects.toThrow(`injected failure after ${failureStep}`);

    const orderedSteps: ProjectFileMutationStep[] = [
      "document-rename-destination",
      "document-rename-source",
      "document-rename-graph"
    ];
    expect(observedSteps).toEqual(orderedSteps.slice(0, orderedSteps.indexOf(failureStep) + 1));
    expect((await faultStore.readDocument(member.projectId, sourcePath)).content).toBe(sourceContent);
    await expect(faultStore.readDocument(member.projectId, destinationPath)).rejects.toMatchObject({ code: "document_not_found" });
    expect(await readFile(path.join(source.root, "graph", "main.json"), "utf8")).toBe(stableGraphBytes);
    expect((await faultStore.getProjectGraph(member.projectId)).graph.nodes.find((node) => node.id === coreNode.id)?.doc).toBe(sourcePath);
    expect((await faultStore.getRevisionStatus(member.projectId)).activeRevision.revisionId).toBe(stableStatus.activeRevision.revisionId);
    expect(await faultStore.listRevisions(member.projectId)).toHaveLength(stableRevisionCount);
    expect(await faultStore.getChangeSet(renameChange.changeSetId)).toMatchObject({
      status: "conflicted",
      recoveredAt: "2026-07-27T08:05:00.000Z",
      recoveryReason: expect.stringContaining("已恢复确认前状态")
    });
    expect((await faultStore.listProjectTransactions(member.projectId)).find((item) => item.changeSetId === renameChange.changeSetId)).toMatchObject({
      stage: "recovered",
      recoveredFromStage: "prepared",
      recoveredFromFileMutation: failureStep,
      recoveryAction: "rolled-back"
    });
  });

  it("restores the base Snapshot on startup when a persisted transaction stopped after file writes", async () => {
    const workspace = await store.createWorkspace({ name: "事务启动恢复" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "中断恢复 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const initial = await store.getRevisionStatus(member.projectId);
    const changeSet = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: initial.activeRevision.revisionId,
      reason: "模拟文件写入后进程退出",
      operations: [{ op: "docs.write", target: "docs/interrupted.md", value: "# 不应保留\n" }]
    });
    const source = JSON.parse(await readFile(path.join(root, "projects", member.projectId, "source.json"), "utf8")) as { root: string };
    await mkdir(path.join(source.root, "docs"), { recursive: true });
    await writeFile(path.join(source.root, "docs/interrupted.md"), "# 不应保留\n");
    const transaction: ProjectTransactionJournal = {
      schemaVersion: "1.0",
      transactionId: "transaction-10000000-0000-4000-8000-000000000001",
      projectId: member.projectId,
      skillId: member.skillId,
      changeSetId: changeSet.changeSetId,
      kind: "changeset",
      baseRevision: initial.activeRevision.revisionId,
      baseSnapshotId: initial.currentSnapshot.snapshotId,
      nextRevision: "rev-20260727080000000-crash001",
      stage: "files-written",
      createdAt: "2026-07-27T08:00:00.000Z",
      updatedAt: "2026-07-27T08:00:00.000Z"
    };
    const transactionDir = path.join(root, "projects", member.projectId, "transactions");
    await mkdir(transactionDir, { recursive: true });
    await writeFile(path.join(transactionDir, `${transaction.transactionId}.json`), JSON.stringify(transaction, null, 2) + "\n");

    const restarted = new WorkspaceStore({
      dataDir: root,
      now: () => new Date("2026-07-27T08:05:00.000Z")
    });
    await restarted.initialize();

    await expect(restarted.readDocument(member.projectId, "docs/interrupted.md")).rejects.toMatchObject({ code: "document_not_found" });
    expect((await restarted.getRevisionStatus(member.projectId)).activeRevision.revisionId).toBe(initial.activeRevision.revisionId);
    expect(await restarted.getChangeSet(changeSet.changeSetId)).toMatchObject({
      status: "conflicted",
      recoveredAt: "2026-07-27T08:05:00.000Z",
      recoveryReason: expect.stringContaining("已恢复确认前 Snapshot")
    });
    expect(await restarted.listProjectTransactions(member.projectId)).toEqual([
      expect.objectContaining({
        transactionId: transaction.transactionId,
        stage: "recovered",
        recoveredFromStage: "files-written",
        recoveryAction: "rolled-back"
      })
    ]);
  });

  it("completes a transaction journal on startup when all durable commit facts already agree", async () => {
    const workspace = await store.createWorkspace({ name: "事务提交补全" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "提交补全 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const initial = await store.getRevisionStatus(member.projectId);
    const changeSet = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: initial.activeRevision.revisionId,
      reason: "模拟提交事实完整但日志未收尾",
      operations: [{ op: "docs.write", target: "docs/committed.md", value: "# 已提交\n" }]
    });
    const applied = await store.confirmAndApplyChangeSet(changeSet.changeSetId, {
      digest: changeSet.digest,
      baseRevision: changeSet.baseRevision
    });
    const [completed] = await store.listProjectTransactions(member.projectId);
    expect(completed?.stage).toBe("completed");
    const interruptedJournal = {
      ...completed!,
      stage: "state-committed" as const,
      completedAt: undefined
    };
    await writeFile(
      path.join(root, "projects", member.projectId, "transactions", `${completed!.transactionId}.json`),
      JSON.stringify(interruptedJournal, null, 2) + "\n"
    );

    const restarted = new WorkspaceStore({ dataDir: root, now: () => new Date("2026-07-27T08:05:00.000Z") });
    await restarted.initialize();

    expect((await restarted.readDocument(member.projectId, "docs/committed.md")).content).toContain("已提交");
    expect((await restarted.getRevisionStatus(member.projectId)).activeRevision.revisionId).toBe(applied.activeRevision);
    expect(await restarted.getChangeSet(changeSet.changeSetId)).toMatchObject({ status: "applied", appliedRevision: applied.activeRevision });
    expect((await restarted.listProjectTransactions(member.projectId))[0]).toMatchObject({
      stage: "completed",
      recoveryAction: "commit-completed"
    });
  });

  it("freezes a RuntimeArtifact and persists rejected transitions without moving the run", async () => {
    const workspace = await store.createWorkspace({ name: "运行测试" });
    const withSkill = await store.createManagedSkill(workspace.workspaceId, { name: "运行 Skill", capability: "workflow" });
    const member = withSkill.members[0]!;
    const started = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { approved: true, nested: { z: 2, a: 1 } } });
    expect(started.artifact?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(started.artifact?.contentHash).toBe((await store.getRevisionStatus(member.projectId)).activeRevision.contentHash);
    expect(started.artifact).toMatchObject({
      initialVariables: { approved: true, nested: { z: 2, a: 1 } },
      fingerprint: {
        schemaVersion: "1.0",
        algorithm: "sha256",
        projectContentHash: started.artifact?.contentHash,
        inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        value: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      }
    });
    const sameInput = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { nested: { a: 1, z: 2 }, approved: true } });
    const changedInput = await store.createRun(member.projectId, { workspaceId: workspace.workspaceId, initialVariables: { approved: false, nested: { a: 1, z: 2 } } });
    expect(sameInput.run.artifactId).not.toBe(started.run.artifactId);
    expect(sameInput.artifact?.fingerprint.value).toBe(started.artifact?.fingerprint.value);
    expect(changedInput.artifact?.fingerprint.value).not.toBe(started.artifact?.fingerprint.value);
    expect(started.run.state.currentNodeId).toBe("flow.start");
    expect(started.allowedTransitions.map((item) => item.to)).toEqual(["flow.core-step"]);

    const entered = await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.core-step" });
    expect(entered.run.state.currentNodeId).toBe("flow.core-step");
    const rejected = await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.missing" });
    expect(rejected.run.state.currentNodeId).toBe("flow.core-step");
    expect(rejected.run.state.step).toBe(1);
    expect(rejected.run.events.at(-1)?.type).toBe("engine.reject");
    expect(rejected.allowedTransitions.map((item) => item.to)).toEqual(["flow.end"]);
    expect(rejected.commandResult).toEqual({
      accepted: false,
      eventSeqs: [4],
      rejection: {
        code: "next_node_not_allowed",
        message: "请求的下一节点不在当前节点合法出口中",
        requestedNodeId: "flow.missing"
      }
    });

    const reloaded = await store.getRun(member.projectId, started.run.runId);
    expect(reloaded.run.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(reloaded.run.revision).toBe(started.run.revision);

    await expect(store.createRuntimeBenchmarkCandidate(member.projectId, started.run.runId, { workspaceId: workspace.workspaceId }))
      .rejects.toMatchObject({ code: "runtime_candidate_not_terminal" });
    await store.commandRun(member.projectId, started.run.runId, "next", { nextNodeId: "flow.end" });
    const candidate = await store.createRuntimeBenchmarkCandidate(member.projectId, started.run.runId, { workspaceId: workspace.workspaceId });
    expect(candidate).toMatchObject({
      workspaceId: workspace.workspaceId,
      projectId: member.projectId,
      skillId: member.skillId,
      source: {
        runId: started.run.runId,
        artifactId: started.run.artifactId,
        revision: started.run.revision,
        status: "completed"
      },
      case: {
        status: "draft",
        fixture: { initialVariables: { approved: true, nested: { z: 2, a: 1 } } },
        expected: {
          path: { mode: "subsequence", nodeIds: ["flow.start", "flow.core-step", "flow.end"] },
          terminal: { status: "completed", nodeId: "flow.end" }
        }
      },
      issues: []
    });
    expect(candidate.case).not.toHaveProperty("source");
    expect(await store.listBenchmarkCases(member.projectId)).toEqual([]);
  });
});
