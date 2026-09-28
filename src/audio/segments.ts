import { PlancastError } from "../domain/errors.js";
export const SPEECH_SEGMENTATION_VERSION = "sentences-180-2400-v1";
// Keep long turns within speech-provider limits. Prefer sentence boundaries and
// preserve every word in order; segments keep the same speaker and form one turn.
export function speechSegments(text: string): string[] {
  const words = text.trim().split(/\s+/u);
  const segments: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let characters = 0;
    while (
      end < words.length &&
      end - start < 180 &&
      characters + words[end]!.length + 1 <= 2400
    ) {
      characters += words[end]!.length + 1;
      end++;
    }
    if (end === start)
      throw new PlancastError(
        "SPEECH_TEXT",
        "A spoken token is too long. Regenerate the dialogue with a shorter explanation.",
        4,
      );
    if (end < words.length) {
      for (
        let boundary = end;
        boundary > start + (end - start) / 2;
        boundary--
      ) {
        if (/[.!?]["')]*$/.test(words[boundary - 1]!)) {
          end = boundary;
          break;
        }
      }
    }
    segments.push(words.slice(start, end).join(" "));
    start = end;
  }
  return segments;
}
