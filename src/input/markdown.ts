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
  path: string;
  text: string;
  lines: string[];
  sha256: string;
  sections: { type: string; start: number; end: number }[];
}
export async function readSource(file: string): Promise<Source> {
  const path = resolve(file);
  if (![".md", ".markdown"].includes(extname(path).toLowerCase()))
    throw new PlancastError(
      "INPUT",
      "Choose a UTF-8 Markdown (.md or .markdown) file.",
      2,
    );
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
    if (!before.isFile() || before.size > 2 * 1024 * 1024)
      throw new PlancastError(
        "INPUT",
        "Source must be a regular file no larger than 2 MB.",
        2,
      );
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      size > 2 * 1024 * 1024 ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    )
      throw new PlancastError(
        "INPUT",
        "Source changed while reading. Save it and retry.",
        2,
      );
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
    const tree = unified().use(remarkParse).use(remarkGfm).parse(text);
    return {
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
  } finally {
    await handle.close();
  }
}
