import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Source } from "../input/markdown.js";
import { PlancastError } from "../domain/errors.js";

function lowerBound(values: Uint32Array | number[], value: number): number {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Collapse whitespace only. Keep an offset for every normalized character so
// accepted quotes and line references can be restored from the original source.
function indexWhitespace(text: string) {
  const offsets = new Uint32Array(text.length);
  const parts: string[] = [];
  let cursor = 0,
    length = 0;
  for (const match of text.matchAll(/\s+/gu)) {
    parts.push(text.slice(cursor, match.index), " ");
    while (cursor < match.index) offsets[length++] = cursor++;
    offsets[length++] = cursor;
    cursor += match[0].length;
  }
  parts.push(text.slice(cursor));
  while (cursor < text.length) offsets[length++] = cursor++;
  return { text: parts.join(""), offsets: offsets.subarray(0, length) };
}

type SyntaxNode = {
  type: string;
  position?:
    | {
        start: { offset?: number | undefined };
        end: { offset?: number | undefined };
      }
    | undefined;
  children?: SyntaxNode[] | undefined;
};

// Remove only parser-recognized emphasis delimiters. Literal asterisks inside
// code, strikethrough, links, numbers, and punctuation remain meaningful text.
function indexEmphasis(text: string) {
  const ignored = new Uint8Array(text.length);
  const visit = (node: SyntaxNode) => {
    if (node.type === "strong" || node.type === "emphasis") {
      const first = node.children?.[0]?.position?.start.offset;
      const last = node.children?.at(-1)?.position?.end.offset;
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start !== undefined && first !== undefined)
        ignored.fill(1, start, first);
      if (last !== undefined && end !== undefined) ignored.fill(1, last, end);
    }
    node.children?.forEach(visit);
  };
  visit(unified().use(remarkParse).use(remarkGfm).parse(text));
  const parts: string[] = [];
  const rawOffsets = new Uint32Array(text.length);
  let cursor = 0,
    length = 0;
  while (cursor < text.length) {
    if (ignored[cursor]) {
      cursor++;
      continue;
    }
    const start = cursor;
    while (cursor < text.length && !ignored[cursor])
      rawOffsets[length++] = cursor++;
    parts.push(text.slice(start, cursor));
  }
  const indexed = indexWhitespace(parts.join(""));
  for (let i = 0; i < indexed.offsets.length; i++)
    indexed.offsets[i] = rawOffsets[indexed.offsets[i]!]!;
  return indexed;
}

export function sourceQuoteResolver(source: Source) {
  const rawIndex = indexWhitespace(source.text);
  let emphasisIndex: ReturnType<typeof indexEmphasis> | undefined;
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of source.lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  return (quote: string, startLine: number, endLine: number) => {
    let indexed = rawIndex;
    let needle = quote.replace(/\s+/gu, " ").trim();
    if (!needle)
      throw new PlancastError(
        "DIALOGUE_GROUNDING",
        "Script contains an empty source quotation.",
        4,
      );
    const findUnique = (start: number, end: number): number => {
      const first = indexed.text.indexOf(needle, start);
      if (first < 0 || first + needle.length > end) return -1;
      const second = indexed.text.indexOf(needle, first + 1);
      return second >= 0 && second + needle.length <= end ? -1 : first;
    };
    const locate = () => {
      if (
        startLine >= 1 &&
        endLine >= startLine &&
        endLine <= source.lines.length
      ) {
        const start = lowerBound(indexed.offsets, lineStarts[startLine - 1]!);
        const end = lowerBound(
          indexed.offsets,
          lineStarts[endLine] ?? source.text.length,
        );
        const local = findUnique(start, end);
        if (local >= 0) return local;
      }
      return findUnique(0, indexed.text.length);
    };
    let match = locate();
    if (match < 0) {
      emphasisIndex ??= indexEmphasis(source.text);
      indexed = emphasisIndex;
      needle = indexEmphasis(quote).text.trim();
      if (needle) match = locate();
    }
    if (match < 0)
      throw new PlancastError(
        "DIALOGUE_GROUNDING",
        "A script quotation is absent from the source or has ambiguous line references. No speech was requested.",
        4,
      );
    const originalStart = indexed.offsets[match]!;
    const originalEnd = indexed.offsets[match + needle.length - 1]! + 1;
    return {
      quote: source.text.slice(originalStart, originalEnd),
      startLine: lowerBound(lineStarts, originalStart + 1),
      endLine: lowerBound(lineStarts, originalEnd),
    };
  };
}
