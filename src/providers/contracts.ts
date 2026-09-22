import type { Source } from "../input/markdown.js";
export type Framing = "auto" | "plan" | "document";
export interface DialogueRequest {
  framing?: Framing;
  source: Source;
  targetWords: number;
  feedback?: string;
  signal: AbortSignal;
}
export interface ScriptProvider {
  readonly runtimeVersion?: string;
  readonly modelSha256?: string;
  dispose?(): Promise<void>;
  readonly id: string;
  readonly model: string;
  generateDialogue(request: DialogueRequest): Promise<unknown>;
}
export interface SpeechProvider {
  dispose?(): Promise<void>;
  readonly id: string;
  readonly model: string;
  synthesize(request: {
    text: string;
    voice: string;
    signal: AbortSignal;
  }): Promise<Buffer>;
}
