import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PlancastError, interrupted } from "../domain/errors.js";
const exec = promisify(execFile);
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function playerHtml(name: string, audio: Buffer, mime: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(name)} · Plancast</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#111316;color:#f4f4f5}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(100%,640px)}.brand{font-size:13px;font-weight:700;letter-spacing:.16em;color:#d3a577;text-transform:uppercase}h1{font-size:clamp(26px,5vw,40px);line-height:1.2;letter-spacing:-.04em;overflow-wrap:anywhere;margin:22px 0 12px}.intro{color:#aaaeb6;line-height:1.6;margin-bottom:32px}.player{background:#1c2026;border:1px solid #343940;border-radius:20px;padding:24px}audio{width:100%;display:block}.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:22px}button,select{font:inherit;color:inherit;background:#2a3038;border:1px solid #515966;border-radius:9px;padding:10px 12px;cursor:pointer}button:hover{background:#363e48}button:focus-visible,select:focus-visible{outline:3px solid #d3a577;outline-offset:3px}label{margin-left:auto;font-size:14px}select{margin-left:8px}#status{font-size:14px;color:#b8bdc6;min-height:22px;margin:20px 0 0}.footer{font-size:13px;color:#9ca2ad;line-height:1.7;margin-top:24px}@media(max-width:480px){.player{padding:16px}label{margin:8px 0 0;width:100%}}
</style></head><body><main><div class="brand">Plancast / Local player</div><h1>${escape(name)}</h1><p class="intro">Your plan, at your pace.</p><section class="player" aria-label="Audio player">
<audio id="audio" controls preload="metadata" src="data:${mime};base64,${audio.toString("base64")}"></audio>
<div class="controls"><button id="back" type="button" aria-label="Back 10 seconds">−10 sec</button><button id="forward" type="button" aria-label="Forward 10 seconds">+10 sec</button><button id="restart" type="button">Restart</button><label for="speed">Speed<select id="speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select></label></div><p id="status" role="status">Press Play to listen.</p></section><p class="footer">Local playback · AI-generated voices<br>No uploads or API charges for listening. Close this tab to stop.</p></main>
<script>
const audio=document.getElementById('audio'),status=document.getElementById('status');
function seek(delta){if(Number.isFinite(audio.duration))audio.currentTime=Math.max(0,Math.min(audio.duration,audio.currentTime+delta));}
document.getElementById('back').onclick=()=>seek(-10);
document.getElementById('forward').onclick=()=>seek(10);
document.getElementById('restart').onclick=()=>{audio.currentTime=0;};
document.getElementById('speed').onchange=e=>{audio.playbackRate=Number(e.target.value);};
audio.onplay=()=>{status.textContent='Playing. Use the timeline to jump to any point.';};
audio.onpause=()=>{status.textContent=audio.ended?'Finished. Press Play to listen again.':'Paused. Press Play to continue.';};
audio.onended=()=>{status.textContent='Finished. Press Play to listen again.';};
audio.onerror=()=>{status.textContent='This browser could not decode the audio. Open the original file in QuickTime Player.';};
audio.play().catch(()=>{status.textContent='Press Play to listen. Your browser requires a click before playback.';});
</script></body></html>`;
}

export async function createPlayer(path: string): Promise<string> {
  const mime = {
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
  }[extname(path).toLowerCase()];
  if (!mime)
    throw new PlancastError(
      "PLAYBACK",
      "Choose an M4A, WAV, or MP3 audio file.",
      2,
    );
  const file = await open(path, "r").catch(() => {
    throw new PlancastError("PLAYBACK", "Could not read the audio file.", 2);
  });
  let audio: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > 50 * 1024 * 1024)
      throw new PlancastError(
        "PLAYBACK",
        "Choose a nonempty audio file up to 50 MB.",
        2,
      );
    audio = await file.readFile();
  } finally {
    await file.close();
  }
  const cache = join(homedir(), "Library", "Caches", "Plancast", "players");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(cache, "player-"));
  const page = join(directory, "index.html");
  await writeFile(page, playerHtml(basename(path), audio, mime), {
    mode: 0o600,
  });
  return page;
}
export async function playAudio(
  path: string,
  signal: AbortSignal,
): Promise<void> {
  interrupted(signal);
  const page = await createPlayer(path);
  interrupted(signal);
  // Resolve the HTTP browser rather than the user's .html editor association.
  const { stdout } = await exec(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com")).path.js',
    ],
    { signal, timeout: 10000 },
  );
  const browser = stdout.trim();
  if (!browser.startsWith("/"))
    throw new PlancastError(
      "PLAYBACK",
      "No default browser found. Open the audio file in QuickTime Player.",
      5,
    );
  await exec("/usr/bin/open", ["-a", browser, pathToFileURL(page).href], {
    signal,
    timeout: 10000,
  });
  process.stderr.write(
    "Opened local browser player. Press Play if needed; close the tab to stop.\n",
  );
}
