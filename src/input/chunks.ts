import type { Source } from "./markdown.js";
export interface SourceLine {
  id: string;
  text: string;
  line: number;
}
// Bound serialized input, including escaping and IDs. Split exceptional long lines
// into exact substrings; their citations still resolve against the original line.
export function evidenceChunks(source: Source, limit = 24000): SourceLine[][] {
  const chunks: SourceLine[][] = [];
  let current: SourceLine[] = [];
  let size = 32;
  for (const [index, text] of source.lines.entries()) {
    if (!text.trim()) continue;
    const member = source.sources?.find(
      (item) => index + 1 >= item.startLine && index + 1 <= item.endLine,
    );
    if (source.sources && !member) continue;
    if (member?.startLine === index + 1 && current.length) {
      chunks.push(current);
      current = [];
      size = 32;
    }
    let offset = 0;
    let part = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + 1000);
      if (end < text.length) {
        const space = text.lastIndexOf(" ", end);
        if (space > offset + 500) end = space;
        // Do not split a UTF-16 surrogate pair.
        if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
      }
      const line = {
        id: `L${index + 1}${part ? `P${part}` : ""}`,
        text: text.slice(offset, end),
        line: index + 1,
      };
      const bytes =
        JSON.stringify({
          id: line.id,
          text: line.text,
          ...(member ? { sourceId: member.id } : {}),
        }).length + 1;
      if (
        current.length &&
        (size + bytes > limit || (text.startsWith("#") && size > limit / 2))
      ) {
        chunks.push(current);
        current = [];
        size = 32;
      }
      current.push(line);
      size += bytes;
      offset = end;
      part++;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}
