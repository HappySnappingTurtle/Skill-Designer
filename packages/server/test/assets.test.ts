import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/store.js";

let root: string;
let sequence: number;
let store: WorkspaceStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skill-designer-assets-"));
  sequence = 1;
  store = new WorkspaceStore({
    dataDir: root,
    now: () => new Date("2026-07-30T02:00:00.000Z"),
    idFactory: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`
  });
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project assets", () => {
  it("rejects paths that are not portable across Windows, macOS, and Linux", async () => {
    const workspace = await store.createWorkspace({ name: "资产路径" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "路径 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const invalidPaths = [
      "image.png",
      "assets\\image.png",
      "assets/../image.png",
      "assets/CON.png",
      "assets/name?.png",
      "assets/trailing."
    ];
    for (const target of invalidPaths) {
      await expect(store.createChangeSet(member.projectId, {
        workspaceId: workspace.workspaceId,
        baseRevision: member.activeRevision,
        reason: "无效资产路径",
        operations: [{ op: "asset.copy", target, value: { contentBase64: "YQ==" } }]
      })).rejects.toMatchObject({ code: "asset_path_invalid" });
    }
  });

  it("keeps rejected assets off disk and applies create, replace, and delete with reference impact", async () => {
    const workspace = await store.createWorkspace({ name: "资产生命周期" });
    const created = await store.createManagedSkill(workspace.workspaceId, { name: "资产 Skill", capability: "workflow" });
    const member = created.members[0]!;
    const original = await store.readDocument(member.projectId, "SKILL.md");
    const documentChange = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: original.activeRevision,
      reason: "添加资产引用",
      operations: [{ op: "docs.write", target: "SKILL.md", value: `${original.content}\n## 界面\n\n![像素图](assets/ui/pixel.png)\n` }]
    });
    const documented = await store.confirmAndApplyChangeSet(documentChange.changeSetId, {
      digest: documentChange.digest,
      baseRevision: documentChange.baseRevision
    });
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

    const rejectedProposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documented.activeRevision,
      reason: "先预览再拒绝",
      operations: [{ op: "asset.copy", target: "assets/ui/pixel.png", value: { contentBase64: pngBase64 } }]
    });
    expect(rejectedProposal.preview).toEqual([expect.objectContaining({
      kind: "asset",
      action: "create",
      target: "assets/ui/pixel.png",
      existed: false,
      references: [expect.objectContaining({ sourcePath: "SKILL.md", kind: "markdown-image", rawTarget: "assets/ui/pixel.png" })]
    })]);
    expect(await store.listAssets(member.projectId)).toEqual([]);
    await store.rejectChangeSet(rejectedProposal.changeSetId, {
      digest: rejectedProposal.digest,
      baseRevision: rejectedProposal.baseRevision,
      reason: "验证拒绝不写入"
    });
    expect(await store.listAssets(member.projectId)).toEqual([]);

    const createProposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: documented.activeRevision,
      reason: "添加像素图",
      operations: [{ op: "asset.copy", target: "assets/ui/pixel.png", value: { contentBase64: pngBase64 } }]
    });
    const createdAsset = await store.confirmAndApplyChangeSet(createProposal.changeSetId, {
      digest: createProposal.digest,
      baseRevision: createProposal.baseRevision
    });
    expect(createdAsset.asset).toMatchObject({ path: "assets/ui/pixel.png", mimeType: "image/png", referenceCount: 1 });
    expect((await store.readAsset(member.projectId, "assets/ui/pixel.png")).contentBase64).toBe(pngBase64);
    expect(await store.listAssets(member.projectId)).toEqual([expect.objectContaining({ path: "assets/ui/pixel.png", referenceCount: 1 })]);

    const replacementBase64 = Buffer.from("replacement").toString("base64");
    const replaceProposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: createdAsset.activeRevision,
      reason: "替换像素图",
      operations: [{ op: "asset.copy", target: "assets/ui/pixel.png", value: { contentBase64: replacementBase64 } }]
    });
    expect(replaceProposal.preview[0]).toMatchObject({ kind: "asset", action: "replace", existed: true });
    const replaced = await store.confirmAndApplyChangeSet(replaceProposal.changeSetId, {
      digest: replaceProposal.digest,
      baseRevision: replaceProposal.baseRevision
    });
    expect((await store.readAsset(member.projectId, "assets/ui/pixel.png")).contentBase64).toBe(replacementBase64);

    const deleteProposal = await store.createChangeSet(member.projectId, {
      workspaceId: workspace.workspaceId,
      baseRevision: replaced.activeRevision,
      reason: "删除像素图",
      operations: [{ op: "asset.delete", target: "assets/ui/pixel.png" }]
    });
    expect(deleteProposal.preview[0]).toMatchObject({
      kind: "asset",
      action: "delete",
      references: [expect.objectContaining({ sourcePath: "SKILL.md" })]
    });
    expect(await store.listAssets(member.projectId)).toHaveLength(1);
    const deleted = await store.confirmAndApplyChangeSet(deleteProposal.changeSetId, {
      digest: deleteProposal.digest,
      baseRevision: deleteProposal.baseRevision
    });
    expect(deleted.deletedAssetPath).toBe("assets/ui/pixel.png");
    expect(await store.listAssets(member.projectId)).toEqual([]);
    await expect(store.readAsset(member.projectId, "assets/ui/pixel.png")).rejects.toMatchObject({ code: "asset_not_found" });
  });
});
