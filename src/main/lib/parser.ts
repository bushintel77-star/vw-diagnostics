import { spawn } from "node:child_process";
import parserScript from "../../../resources/parser.py?asset&asarUnpack";
import { ParserResult, RunParserFn } from "@shared/types";

const RUN_TIMEOUT_MS = 30_000;

interface PythonCandidate {
  command: string;
  args: string[];
}

// Tries PARSER_PYTHON first, then the usual interpreter names per platform.
function pythonCandidates(): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  if (process.env.PARSER_PYTHON) {
    candidates.push({ command: process.env.PARSER_PYTHON, args: [] });
  }
  if (process.platform === "win32") {
    candidates.push(
      { command: "python", args: [] },
      { command: "py", args: ["-3"] }
    );
  } else {
    candidates.push(
      { command: "python3", args: [] },
      { command: "python", args: [] }
    );
  }
  return candidates;
}

interface Attempt {
  /** True when the executable could not be run, so the next candidate applies. */
  missing: boolean;
  result: ParserResult;
}

function runOnce(
  candidate: PythonCandidate,
  input: string,
  args: string[]
): Promise<Attempt> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      candidate.command,
      [...candidate.args, parserScript, ...args],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    let missing = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RUN_TIMEOUT_MS);

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      // Windows machines without Python ship a Store stub that prints this
      // and exits instead of failing with ENOENT.
      if (/Python was not found/i.test(stderr)) {
        missing = true;
      }
      let result: unknown = null;
      if (!missing && !timedOut && exitCode === 0) {
        try {
          result = JSON.parse(stdout);
        } catch {
          result = null;
        }
      }
      resolve({
        missing,
        result: {
          ok: !missing && !timedOut && exitCode === 0,
          result,
          stdout,
          stderr: timedOut
            ? `Parser timed out after ${RUN_TIMEOUT_MS / 1000}s. ${stderr}`.trim()
            : stderr,
          exitCode,
          durationMs: Date.now() - started,
        },
      });
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        missing = true;
      } else {
        stderr += String(error);
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => finish(code));

    // EPIPE fires if the script exits before consuming all input.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export const runParser: RunParserFn = async (input, args = []) => {
  for (const candidate of pythonCandidates()) {
    const attempt = await runOnce(candidate, input, args);
    if (!attempt.missing) {
      return attempt.result;
    }
  }
  return {
    ok: false,
    result: null,
    stdout: "",
    stderr:
      "No Python interpreter found. Install Python 3 or set PARSER_PYTHON to the interpreter path.",
    exitCode: null,
    durationMs: 0,
  };
};
