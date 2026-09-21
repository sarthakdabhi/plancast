export class PlancastError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "PlancastError";
  }
}
export function interrupted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new PlancastError("INTERRUPTED", "Interrupted.", 130);
}
