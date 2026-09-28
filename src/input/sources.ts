import { basename } from "node:path";
import { PlancastError } from "../domain/errors.js";
import { normalizedSource, readSource, type Source } from "./markdown.js";
export async function readSources(
  paths: string[],
  signal: AbortSignal,
  allowNetwork: boolean,
): Promise<Source> {
  if (!paths.length || paths.length > 10)
    throw new PlancastError(
      "INPUT",
      "Provide between one and ten source documents.",
      2,
    );
  if (paths.length === 1) return readSource(paths[0]!, signal, allowNetwork);
  const documents: Source[] = [];
  let bytes = 0;
  for (const path of paths) {
    const source = await readSource(path, signal, allowNetwork);
    bytes += Buffer.byteLength(source.text);
    if (bytes > 2 * 1024 * 1024)
      throw new PlancastError(
        "INPUT",
        "Combined extracted sources exceed 2 MB. Choose a smaller source set.",
        2,
      );
    documents.push(source);
  }
  const lines: string[] = [];
  const sources = documents.map((source, index) => {
    const id = `S${index + 1}`;
    lines.push(`# Source ${id}: ${source.title ?? basename(source.path)}`);
    const startLine = lines.length + 1;
    lines.push(...source.lines);
    const endLine = lines.length;
    lines.push("");
    return {
      id,
      path: source.path,
      kind: source.kind ?? "markdown",
      sha256: source.sha256,
      text: source.text,
      startLine,
      endLine,
      ...(source.pages ? { pages: source.pages } : {}),
      ...(source.originalSha256
        ? { originalSha256: source.originalSha256 }
        : {}),
    };
  });
  return normalizedSource(lines.join("\n"), documents[0]!.path, {
    kind: "bundle",
    sources,
  });
}
export function factOrigin(source: Source, start: number, end: number) {
  const member = source.sources?.find(
    (item) => start >= item.startLine && end <= item.endLine,
  );
  if (source.sources && !member)
    throw new PlancastError(
      "DIALOGUE_GROUNDING",
      "Evidence must cite document content, not a source boundary or heading.",
      4,
    );
  const localStart = member ? start - member.startLine + 1 : start;
  const localEnd = member ? end - member.startLine + 1 : end;
  const pages = member?.pages ?? source.pages;
  return {
    sourceId: member?.id ?? "S1",
    sourceLocation: member?.path ?? source.path,
    sourceStartLine: localStart,
    sourceEndLine: localEnd,
    ...(pages
      ? {
          sourcePages: pages
            .filter((p) => p.endLine >= localStart && p.startLine <= localEnd)
            .map((p) => p.page),
        }
      : {}),
  };
}
