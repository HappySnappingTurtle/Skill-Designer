import { describe, expect, it } from "vitest";
import { analyzeImportAssets, parseImportFrontmatter } from "../src/ingest-inventory.js";

describe("import asset inventory", () => {
  it("parses YAML metadata without dropping unknown fields and resolves Markdown references", () => {
    const analysis = analyzeImportAssets([
      {
        path: "SKILL.md",
        content: `---
name: 发布审阅助手
description: |
  生成发布前的检查计划。
version: 1.2.0
allowed-tools:
  - Read
  - Search
references:
  - docs/context.md
metadata:
  owner: platform
custom-policy:
  retries: 2
---
# 这个标题不是名称来源

[上下文](docs/context.md#target)
![缺失图片](assets/missing.png)
[外部规范](https://example.com/spec)
\`docs/context.md\`
\`../outside.md\`
`
      },
      { path: "docs/context.md", content: "# Target\n\n已有内容。\n" },
      { path: "assets/checklist.txt", content: "asset" }
    ]);

    expect(analysis.frontmatter).toMatchObject({
      dialect: "yaml",
      status: "valid",
      recognized: { name: "发布审阅助手", description: "生成发布前的检查计划。", version: "1.2.0", allowedTools: ["Read", "Search"] },
      unknownKeys: ["custom-policy", "metadata", "references"]
    });
    expect(analysis.frontmatter?.data).toMatchObject({ metadata: { owner: "platform" }, "custom-policy": { retries: 2 } });
    expect(analysis.identity.name?.method).toBe("frontmatter");
    expect(analysis.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "frontmatter", rawTarget: "docs/context.md", status: "resolved" }),
      expect.objectContaining({ kind: "markdown-link", rawTarget: "docs/context.md#target", status: "resolved", fragment: "target" }),
      expect.objectContaining({ kind: "markdown-image", rawTarget: "assets/missing.png", status: "missing" }),
      expect.objectContaining({ kind: "markdown-link", rawTarget: "https://example.com/spec", status: "external" }),
      expect.objectContaining({ kind: "inline-code", rawTarget: "../outside.md", status: "escaped" })
    ]));
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_import_references", severity: "warning" }),
      expect.objectContaining({ code: "escaped_import_references", severity: "warning" })
    ]));
  });

  it("supports TOML and JSON frontmatter through structured parsers", () => {
    expect(parseImportFrontmatter(`+++
name = "TOML Skill"
version = "2.0.0"
tools = ["Read", "Write"]
[metadata]
owner = "team"
+++
# Body
`)).toMatchObject({
      dialect: "toml",
      status: "valid",
      recognized: { name: "TOML Skill", version: "2.0.0", allowedTools: ["Read", "Write"] },
      data: { metadata: { owner: "team" } }
    });

    expect(parseImportFrontmatter(`{
  "title": "JSON Skill",
  "description": "JSON metadata",
  "metadata": { "owner": "team" }
}

# Body
`)).toMatchObject({
      dialect: "json",
      status: "valid",
      recognized: { name: "JSON Skill", description: "JSON metadata" },
      unknownKeys: ["metadata"]
    });
  });

  it("keeps malformed frontmatter diagnosable without reading outside the import", () => {
    const analysis = analyzeImportAssets([{ path: "SKILL.md", content: "---\nname: [broken\n# Body\n" }]);
    expect(analysis.frontmatter).toMatchObject({ dialect: "yaml", status: "unterminated" });
    expect(analysis.diagnostics).toContainEqual(expect.objectContaining({ code: "frontmatter_unterminated", severity: "warning" }));
    expect(analysis.references).toEqual([]);
  });
});
