import { PlancastError } from "../domain/errors.js";
export function lengthProfile(length: string) {
  if (length === "2m")
    return { length, words: 280, min: 110, max: 140, target: 125 } as const;
  if (length === "5m")
    return { length, words: 700, min: 270, max: 330, target: 300 } as const;
  throw new PlancastError("ARGUMENT", "Choose --length 2m or 5m.", 2);
}
