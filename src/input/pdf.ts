import { PlancastError, interrupted } from "../domain/errors.js";
export interface PageRange {
  page: number;
  startLine: number;
  endLine: number;
}
export async function extractPdf(bytes: Uint8Array, signal: AbortSignal) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const stop = () => {
    void task.destroy();
  };
  bounded.addEventListener("abort", stop, { once: true });
  const lines: string[] = [];
  const pages: PageRange[] = [];
  try {
    bounded.throwIfAborted();
    const pdf = await task.promise;
    if (pdf.numPages > 200)
      throw new PlancastError(
        "INPUT_PDF",
        "PDF exceeds 200 pages. Split it into a smaller document.",
        2,
      );
    for (let page = 1; page <= pdf.numPages; page++) {
      bounded.throwIfAborted();
      const content = await (await pdf.getPage(page)).getTextContent();
      let text = "";
      for (const item of content.items)
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
      const pageLines = text
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (!pageLines.length)
        throw new PlancastError(
          "INPUT_PDF",
          `PDF page ${page} has no extractable text. Scanned or mixed image-only pages need OCR, which is not supported yet.`,
          2,
        );
      const startLine = lines.length + 1;
      lines.push(...pageLines);
      pages.push({ page, startLine, endLine: lines.length });
      if (lines.join("\n").length > 2 * 1024 * 1024)
        throw new PlancastError(
          "INPUT_PDF",
          "Extracted PDF text exceeds 2 MB. Split the document.",
          2,
        );
    }
    return { text: lines.join("\n"), pages };
  } catch (error) {
    interrupted(signal);
    if (error instanceof PlancastError) throw error;
    throw new PlancastError(
      "INPUT_PDF",
      bounded.aborted
        ? "PDF extraction timed out. Split the document."
        : "Cannot extract PDF text. Use an unencrypted text-based PDF; damaged files and password-protected PDFs are not supported.",
      2,
    );
  } finally {
    bounded.removeEventListener("abort", stop);
    await task.destroy();
  }
}
