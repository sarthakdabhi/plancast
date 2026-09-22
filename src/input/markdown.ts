import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { PlancastError } from "../domain/errors.js";
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export interface Source {
  kind?: "markdown" | "text" | "article" | "pdf";
  title?: string;
  pages?: { page: number; startLine: number; endLine: number }[];
  originalSha256?: string;
  path: string;
  text: string;
  lines: string[];
  sha256: string;
  sections: { type: string; start: number; end: number }[];
}
export function normalizedSource(
  text: string,
  path: string,
  metadata: Partial<Source> = {},
): Source {
  text = text.replace(/\r\n?/g, "\n");
  if (
    !text.trim() ||
    text.includes("\0") ||
    Buffer.byteLength(text) > 2 * 1024 * 1024
  )
    throw new PlancastError(
      "INPUT",
      "Source text must be nonempty, contain no binary data, and fit within 2 MB.",
      2,
    );
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text);
  return {
    ...metadata,
    path,
    text,
    lines: text.split("\n"),
    sha256: hash(text),
    sections: tree.children.map((n) => ({
      type: n.type,
      start: n.position!.start.line,
      end: n.position!.end.line,
    })),
  };
}
export async function readSource(
  file: string,
  signal: AbortSignal = new AbortController().signal,
  allowNetwork = true,
): Promise<Source> {
  if (/^https?:\/\//i.test(file)) {
    const { articleUrl, fetchArticle, extractArticle } =
      await import("./article.js");
    articleUrl(file);
    if (!allowNetwork)
      throw new PlancastError(
        "INPUT_URL",
        "URL extraction requires network access. --dry-run never fetches URLs; save the article as a local .txt file to inspect it offline.",
        2,
      );
    const downloaded = await fetchArticle(file, signal);
    const article = await extractArticle(downloaded.html, downloaded.url);
    return normalizedSource(article.text, downloaded.url, {
      kind: "article",
      title: article.title,
    });
  }
  const path = resolve(file);
  if (
    ![".md", ".markdown", ".txt", ".pdf"].includes(extname(path).toLowerCase())
  )
    throw new PlancastError(
      "INPUT",
      "Choose a UTF-8 .md, .markdown, or .txt file, a text-based .pdf, or a public article URL.",
      2,
    );
  const pdf = extname(path).toLowerCase() === ".pdf";
  const limit = (pdf ? 20 : 2) * 1024 * 1024;
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK,
  ).catch(() => {
    throw new PlancastError(
      "INPUT",
      "Cannot read source. Check the path and permissions.",
      2,
    );
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit)
      throw new PlancastError(
        "INPUT",
        `Source must be a regular file no larger than ${pdf ? 20 : 2} MB.`,
        2,
      );
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      size > limit ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    )
      throw new PlancastError(
        "INPUT",
        "Source changed while reading. Save it and retry.",
        2,
      );
    if (pdf) {
      const { extractPdf } = await import("./pdf.js");
      const extracted = await extractPdf(bytes.subarray(0, size), signal);
      return normalizedSource(extracted.text, path, {
        kind: "pdf",
        pages: extracted.pages,
        originalSha256: hash(bytes.subarray(0, size)),
      });
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(0, size))
        .replace(/\r\n?/g, "\n");
    } catch {
      throw new PlancastError(
        "INPUT",
        "Source must contain valid UTF-8 text.",
        2,
      );
    }
    if (!text.trim() || text.includes("\0"))
      throw new PlancastError(
        "INPUT",
        "Source is empty or contains binary content.",
        2,
      );
    return normalizedSource(text, path, {
      kind: extname(path).toLowerCase() === ".txt" ? "text" : "markdown",
    });
  } finally {
    await handle.close();
  }
}
