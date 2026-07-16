import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Generic `claude -p` headless runner — the $0 subscription transport,
 * ported from scout-dashboard/lib/llm-cli.ts. There are zero API credits on
 * this machine: never swap this for @anthropic-ai/sdk or ANTHROPIC_API_KEY.
 * Returns the model's text from the CLI's JSON envelope; throws on spawn
 * failure, timeout, or CLI-reported error.
 */

const DEFAULT_TIMEOUT_MS = 300_000;

export function runClaudeCli(
  args: string[],
  stdinInput: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // argv array, never a shell string; the prompt rides on STDIN.
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(cliErrorMessage(code, err, out)));
      else resolve(out);
    });
    child.stdin.write(stdinInput);
    child.stdin.end();
  });
}

/** Human-readable failure: unwrap the CLI's JSON error envelope when present
 * (e.g. subscription session limits come back as a 429 envelope with a plain
 * "resets at …" message in .result). */
function cliErrorMessage(code: number | null, stderr: string, stdout: string): string {
  try {
    const envelope = JSON.parse(stdout) as { is_error?: boolean; result?: string };
    if (envelope.is_error && typeof envelope.result === "string" && envelope.result.trim()) {
      return `Claude CLI: ${envelope.result.trim()}`;
    }
  } catch {
    // not an envelope — fall through to the raw output
  }
  return `claude -p exited ${code}: ${stderr || stdout}`;
}

function unwrapEnvelope(stdout: string): string {
  let envelope: { is_error?: boolean; subtype?: string; result?: string };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error("CLI stdout was not JSON");
  }
  if (envelope.is_error || typeof envelope.result !== "string") {
    throw new Error(`CLI error: ${envelope.subtype ?? "no result"}`);
  }
  return envelope.result;
}

export interface ClaudeVisionOptions {
  model: string;
  prompt: string;
  timeoutMs?: number;
}

/** Vision-by-tool: headless Claude reads the ledger photo itself via the Read
 * tool (the prompt references the absolute image path under data/uploads). */
export async function claudeVision({
  model,
  prompt,
  timeoutMs,
}: ClaudeVisionOptions): Promise<string> {
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--allowedTools",
    "Read",
    "--add-dir",
    path.join(process.cwd(), "data", "uploads"),
  ];
  const stdout = await runClaudeCli(args, prompt, timeoutMs);
  return unwrapEnvelope(stdout);
}
