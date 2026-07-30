import type { DocumentHeading, DocumentSliceResult } from "./types.js";

interface ParsedHeading {
  title: string;
  level: number;
  explicitAnchor?: string;
  startLine: number;
}

export function indexDocument(markdown: string): DocumentHeading[] {
  const lines = normalizeMarkdown(markdown).split("\n");
  const parsed: ParsedHeading[] = [];
  let fence: { character: "`" | "~"; length: number } | undefined;
  let frontmatter = lines[0]?.trim() === "---";

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (frontmatter) {
      if (index > 0 && (line.trim() === "---" || line.trim() === "...")) frontmatter = false;
      continue;
    }
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
    if (fenceMatch) {
      const character = fenceMatch[0] as "`" | "~";
      if (!fence) fence = { character, length: fenceMatch.length };
      else if (fence.character === character && fenceMatch.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;

    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/u);
    if (atx) {
      const extracted = extractHeadingText(atx[2]!.replace(/\s+#+\s*$/u, ""));
      if (extracted.title) parsed.push({ title: extracted.title, level: atx[1]!.length, ...(extracted.anchor ? { explicitAnchor: extracted.anchor } : {}), startLine: index + 1 });
      continue;
    }

    const setext = line.match(/^\s{0,3}(=+|-+)\s*$/u);
    const previous = index > 0 ? lines[index - 1]!.trim() : "";
    if (setext && previous && !/^\s{0,3}(?:>|[-+*]\s|\d+[.)]\s)/u.test(previous)) {
      const extracted = extractHeadingText(previous);
      if (extracted.title) parsed.push({ title: extracted.title, level: setext[1]![0] === "=" ? 1 : 2, ...(extracted.anchor ? { explicitAnchor: extracted.anchor } : {}), startLine: index });
    }
  }

  const stack: Array<{ level: number; title: string }> = [];
  const generatedAnchorCounts = new Map<string, number>();
  return parsed.map((heading, index) => {
    while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
    stack.push({ level: heading.level, title: heading.title });
    const baseAnchor = heading.explicitAnchor ?? slugifyHeading(heading.title);
    let anchor = baseAnchor;
    if (!heading.explicitAnchor) {
      const count = generatedAnchorCounts.get(baseAnchor) ?? 0;
      generatedAnchorCounts.set(baseAnchor, count + 1);
      if (count) anchor = `${baseAnchor}-${count}`;
    }
    const nextBoundary = parsed.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    return {
      title: heading.title,
      level: heading.level,
      path: stack.map((item) => escapePathSegment(item.title)).join("/"),
      anchor,
      startLine: heading.startLine,
      endLine: nextBoundary ? nextBoundary.startLine - 1 : lines.length
    };
  });
}

export function sliceDocument(markdown: string, query: string, allowTitleFallback = false): DocumentSliceResult {
  const normalizedMarkdown = normalizeMarkdown(markdown);
  const headings = indexDocument(normalizedMarkdown);
  const trimmedQuery = query.trim().normalize("NFC");
  if (!trimmedQuery) {
    return { status: "whole-document", query: "", content: normalizedMarkdown, candidates: [] };
  }

  let candidates: DocumentHeading[];
  if (trimmedQuery.startsWith("#")) {
    const anchor = trimmedQuery.slice(1);
    candidates = headings.filter((heading) => normalizeKey(heading.anchor) === normalizeKey(anchor));
  } else {
    const pathSegments = splitHeadingPath(trimmedQuery);
    candidates = headings.filter((heading) => samePath(splitHeadingPath(heading.path), pathSegments));
    if (!candidates.length && allowTitleFallback && pathSegments.length) {
      const title = pathSegments.at(-1)!;
      candidates = headings.filter((heading) => normalizeKey(heading.title) === normalizeKey(title));
    }
  }

  if (!candidates.length) return { status: "missing", query: trimmedQuery, candidates: [] };
  if (candidates.length > 1) return { status: "ambiguous", query: trimmedQuery, candidates };
  const heading = candidates[0]!;
  const lines = normalizedMarkdown.split("\n");
  return {
    status: "found",
    query: trimmedQuery,
    slice: {
      heading,
      content: lines.slice(heading.startLine - 1, heading.endLine).join("\n")
    },
    candidates
  };
}

export function splitHeadingPath(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") escaped = true;
    else if (character === "/") {
      segments.push(current.trim());
      current = "";
    } else current += character;
  }
  if (escaped) current += "\\";
  segments.push(current.trim());
  return segments.filter(Boolean);
}

function extractHeadingText(raw: string): { title: string; anchor?: string } {
  const explicit = raw.match(/\s+\{#([A-Za-z][A-Za-z0-9_.:-]*)\}\s*$/u);
  const title = (explicit ? raw.slice(0, explicit.index) : raw).trim().replace(/\s+/gu, " ").normalize("NFC");
  return { title, ...(explicit?.[1] ? { anchor: explicit[1] } : {}) };
}

function slugifyHeading(value: string): string {
  const slug = value
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/[\s_-]+/gu, "-");
  return slug || "section";
}

function escapePathSegment(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\//gu, "\\/");
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => normalizeKey(segment) === normalizeKey(right[index] ?? ""));
}

function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ").normalize("NFC").toLocaleLowerCase("en-US");
}

function normalizeMarkdown(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").normalize("NFC");
}
