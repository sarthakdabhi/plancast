// This process owns llama-server. A closed stdin means the CLI disappeared,
// including SIGKILL; terminate the server instead of leaving a daemon behind.
import { spawn } from "node:child_process";
const [binary, ...args] = process.argv.slice(2);
const child = spawn(binary, args, { stdio: "ignore", env: process.env });
let timer;
const stop = () => {
  if (timer) return;
  child.kill("SIGTERM");
  timer = setTimeout(() => child.kill("SIGKILL"), 2000);
};
process.stdin.resume();
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", () => process.exit(1));
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
