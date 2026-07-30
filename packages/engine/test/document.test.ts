import { describe, expect, it } from "vitest";
import { indexDocument, sliceDocument, splitHeadingPath } from "../src/index.js";

const markdown = `---
name: slicing
---

# Guide

## Windows

### Retry

Windows retry content.

\`\`\`md
# Fake heading
### Retry
\`\`\`

## macOS

### Retry

macOS retry content.

Reference Title
---------------

Reference content.
`;

describe("Markdown document slicing", () => {
  it("indexes full heading paths while ignoring frontmatter and fenced pseudo-headings", () => {
    const headings = indexDocument(markdown);
    expect(headings.map((heading) => heading.path)).toEqual([
      "Guide",
      "Guide/Windows",
      "Guide/Windows/Retry",
      "Guide/macOS",
      "Guide/macOS/Retry",
      "Guide/Reference Title"
    ]);
    expect(headings.some((heading) => heading.title === "Fake heading")).toBe(false);
    expect(headings.filter((heading) => heading.title === "Retry").map((heading) => heading.anchor)).toEqual(["retry", "retry-1"]);
  });

  it("returns only the exact full-path section and supports generated anchors", () => {
    const exact = sliceDocument(markdown, "Guide/macOS/Retry");
    expect(exact.status).toBe("found");
    expect(exact.slice?.content).toContain("macOS retry content");
    expect(exact.slice?.content).not.toContain("Windows retry content");

    const anchored = sliceDocument(markdown, "#retry-1");
    expect(anchored.status).toBe("found");
    expect(anchored.slice?.heading.path).toBe("Guide/macOS/Retry");
  });

  it("reports ambiguous title fallback and missing paths instead of selecting the first heading", () => {
    const ambiguous = sliceDocument(markdown, "Retry", true);
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.candidates.map((heading) => heading.path)).toEqual(["Guide/Windows/Retry", "Guide/macOS/Retry"]);
    expect(sliceDocument(markdown, "Guide/Linux/Retry").status).toBe("missing");
  });

  it("parses escaped slashes in heading paths", () => {
    expect(splitHeadingPath("Guide/API\\/HTTP/Retry")).toEqual(["Guide", "API/HTTP", "Retry"]);
  });
});
