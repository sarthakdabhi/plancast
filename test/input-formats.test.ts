import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSource, hash } from "../src/input/markdown.js";
import {
  articleUrl,
  extractArticle,
  publicAddress,
} from "../src/input/article.js";
import { dialogueComposer } from "../src/dialogue/compose.js";
import {
  groundedDialogue,
  type JsonRequester,
} from "../src/providers/grounded.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function file(name: string, content: string | Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "plancast-input-"));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}
// Tiny real PDF with a correct xref table, avoiding external fixture dependencies.
function pdf(texts: string[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  texts.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(output.length);
    output += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = output.length;
  output +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("");
  return Buffer.from(
    output +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
describe("document input", () => {
  it("reads plain text with stable normalized lines and hashes", async () => {
    const source = await readSource(
      await file("article.txt", "A finding.\r\nSupporting evidence."),
    );
    expect(source.kind).toBe("text");
    expect(source.lines).toEqual(["A finding.", "Supporting evidence."]);
    expect(source.sha256).toBe(hash(source.text));
  });
  it("extracts real PDF pages and preserves page-to-line provenance", async () => {
    const bytes = pdf([
      "The study found a measurable effect.",
      "The sample was small. More research is needed.",
    ]);
    const source = await readSource(await file("report.pdf", bytes));
    expect(source.kind).toBe("pdf");
    expect(source.lines).toEqual([
      "The study found a measurable effect.",
      "The sample was small. More research is needed.",
    ]);
    expect(source.pages).toEqual([
      { page: 1, startLine: 1, endLine: 1 },
      { page: 2, startLine: 2, endLine: 2 },
    ]);
    expect(source.originalSha256).toBe(hash(bytes));
  });
  it("rejects malformed and image-only PDFs without silently skipping pages", async () => {
    await expect(
      readSource(await file("bad.pdf", "not a PDF")),
    ).rejects.toMatchObject({ code: "INPUT_PDF" });
    await expect(readSource(await file("scan.pdf", pdf([""])))).rejects.toThrow(
      "OCR",
    );
    await expect(
      readSource(await file("mixed.pdf", pdf(["Readable page.", ""]))),
    ).rejects.toThrow("page 2");
  });
  it("extracts article paragraphs without navigation, scripts, or forms", async () => {
    const paragraph =
      "Researchers studied how teams review technical proposals. They found that shorter summaries helped participants recall the main tradeoffs, but the small sample limits confidence in the result. ";
    const article = await extractArticle(
      `<html><head><title>Reading research</title></head><body><nav>MENU ADVERT</nav><article><h1>Reading research</h1><p>${paragraph.repeat(3)}</p><p>Further evaluation is needed before drawing a broad conclusion.</p></article><script>throw new Error('executed')</script></body></html>`,
      "https://example.com/article",
    );
    expect(article.text).toContain("small sample");
    expect(article.text).not.toContain("MENU ADVERT");
    expect(article.text).not.toContain("executed");
    expect(article.text).toContain("\n");
  });
  it("rejects empty article shells and never fetches URLs during dry-run", async () => {
    await expect(
      extractArticle(
        "<html><body>Sign in</body></html>",
        "https://example.com",
      ),
    ).rejects.toThrow("article");
    await expect(
      readSource(
        "https://example.com/article",
        new AbortController().signal,
        false,
      ),
    ).rejects.toThrow("--dry-run never fetches");
  });
  it("rejects credentials, custom ports, and non-public network addresses", () => {
    for (const url of [
      "file:///etc/passwd",
      "https://user:secret@example.com",
      "https://example.com:8080",
    ])
      expect(() => articleUrl(url)).toThrow();
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "192.168.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "0.0.0.0",
      "224.0.0.1",
      "100.64.0.1",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
  });
  it("uses article questions and does not invent an obligatory next action", async () => {
    const source = await readSource(
      await file(
        "article.txt",
        "Research into summaries.\nShort summaries can aid recall.",
      ),
    );
    let prompt = "";
    let calls = 0;
    const request: JsonRequester = async (schema, _name, instructions) => {
      if (calls++ === 0) {
        prompt = instructions;
        return schema.parse({
          problem: {
            summary: "Research",
            facts: [{ claim: "Research", sourceLineId: "L1" }],
          },
          proposal: {
            summary: "Finding",
            facts: [{ claim: "Finding", sourceLineId: "L2" }],
          },
          rationale: null,
          stages: null,
          risks: null,
          uncertainty: null,
          openQuestions: null,
          nextAction: null,
        });
      }
      return schema.parse({
        problem: {
          text: "Research into summaries.",
          factId: "problem_1",
          interpretation: false,
        },
        proposal: {
          text: "Summaries can aid recall.",
          factId: "proposal_1",
          interpretation: false,
        },
        recap: {
          text: "Summaries can aid recall.",
          factId: "proposal_1",
          interpretation: false,
        },
        rationale: null,
        stages: null,
        risks: null,
        uncertainty: null,
        openQuestions: null,
        nextAction: null,
      });
    };
    const dialogue = await groundedDialogue(
      { source, targetWords: 100, signal: new AbortController().signal },
      request,
      false,
    );
    expect(prompt).toContain("Only populate nextAction");
    expect(dialogue.turns[0]!.text).toContain("what does the source say");
    expect(dialogue.turns.at(-2)!.text).toBe("What's the takeaway?");
    expect(dialogueComposer(dialogue, 100, false, true).instructions).toContain(
      "never invent an action",
    );
  });
});
