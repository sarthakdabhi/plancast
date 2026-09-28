import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSources, factOrigin } from "../src/input/sources.js";
import {
  groundedDialogue,
  type JsonRequester,
} from "../src/providers/grounded.js";
import { categories } from "../src/dialogue/validate.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it.each([true, false])(
  "keeps source identities and discovers conflicts (existing uncertainty: %s)",
  async (hasUncertainty) => {
    const dir = await mkdtemp(join(tmpdir(), "source-bundle-"));
    dirs.push(dir);
    const a = join(dir, "plan.md"),
      b = join(dir, "review.txt");
    await writeFile(a, "Search is slow.\nThe plan proposes SQLite.\n");
    await writeFile(b, "Search is slow.\nThe review proposes Postgres.\n");
    const source = await readSources(
      [a, b],
      new AbortController().signal,
      false,
    );
    expect(source.sources?.map((item) => item.id)).toEqual(["S1", "S2"]);
    expect(
      factOrigin(
        source,
        source.sources![1]!.startLine + 1,
        source.sources![1]!.startLine + 1,
      ),
    ).toMatchObject({ sourceId: "S2", sourceStartLine: 2, sourceLocation: b });
    let calls = 0;
    const requester: JsonRequester = async (schema, name, prompt, data) => {
      calls++;
      if (name === "plancast_evidence") {
        const { sourceLines } = data as {
          sourceLines: { id: string; text: string; sourceId: string }[];
        };
        expect(new Set(sourceLines.map((line) => line.sourceId)).size).toBe(1);
        const line = sourceLines[1]!;
        return schema.parse(
          Object.fromEntries(
            categories.map((category) => [
              category,
              [
                "problem",
                "proposal",
                ...(hasUncertainty ? ["uncertainty"] : []),
              ].includes(category)
                ? {
                    summary: line.text,
                    facts: [{ claim: line.text, sourceLineId: line.id }],
                  }
                : null,
            ]),
          ),
        );
      }
      if (name === "plancast_consolidation") {
        expect(prompt).toContain("disagreement");
        const { evidence } = data as {
          evidence: { facts: { id: string; category: string }[] }[];
        };
        return schema.parse(
          Object.fromEntries(
            categories.map((category) => {
              const ids = evidence.flatMap((item) =>
                item.facts
                  .filter(
                    (fact) =>
                      fact.category ===
                      (category === "uncertainty" && !hasUncertainty
                        ? "proposal"
                        : category),
                  )
                  .map((fact) => fact.id),
              );
              return [
                category,
                ids.length
                  ? {
                      summary:
                        "The plan proposes SQLite, while the review proposes Postgres.",
                      factIds: ids,
                    }
                  : null,
              ];
            }),
          ),
        );
      }
      const { facts } = data as { facts: { id: string; category: string }[] };
      const passage = (category: string) => ({
        text: "The plan proposes SQLite, while the review proposes Postgres.",
        factId: facts.find((fact) => fact.category === category)!.id,
        supportingFactIds: facts
          .filter((fact) => fact.category === category)
          .map((fact) => fact.id),
        interpretation: false,
      });
      return schema.parse({
        ...Object.fromEntries(
          categories.map((category) => [
            category,
            facts.some((fact) => fact.category === category)
              ? passage(category)
              : null,
          ]),
        ),
        questions: {
          opening: "What do the two sources propose?",
          details: null,
          uncertainty: "Where do the sources disagree?",
          recap: "What should listeners take away?",
        },
        recap: passage("proposal"),
      });
    };
    const result = await groundedDialogue(
      {
        source,
        targetWords: 280,
        audience: "technical",
        signal: new AbortController().signal,
      },
      requester,
      false,
    );
    expect(calls).toBe(4);
    expect(new Set(result.facts.map((fact) => fact.sourceId))).toEqual(
      new Set(["S1", "S2"]),
    );
    const uncertainty = result.turns.find(
      (turn) =>
        turn.speaker === "HOST_B" &&
        turn.factIds.some((id) => id.startsWith("uncertainty")),
    )!;
    expect(
      uncertainty.factIds.filter((id) => id.startsWith("uncertainty")),
    ).toHaveLength(2);
  },
);
