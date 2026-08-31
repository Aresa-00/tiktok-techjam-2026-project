import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type { TraceRecorder } from "./trace-recorder.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

/** Maps a Codex `item.completed` item type to a Trace span category. */
function spanCategoryForItem(itemType: string): "model_call" | "tool_call" | "workspace_operation" {
  if (itemType === "agent_message" || itemType === "reasoning") return "model_call";
  if (itemType === "file_change" || itemType === "patch_apply") return "workspace_operation";
  return "tool_call";
}

/**
 * Codex item payloads carry their own outcome. `command_execution`,
 * `file_change`, and `mcp_tool_call` items all use the same
 * `status: "in_progress" | "completed" | "failed"` convention (plus
 * `exit_code` for commands). A bare `item.type === "error"` item has
 * neither field but is itself always a failure - so it needs a special
 * case, not just "no status field present means it succeeded".
 */
function spanStatusForItem(itemType: string, item: Record<string, unknown>): "completed" | "failed" {
  if (itemType === "error") return "failed";
  if (item.status === "failed") return "failed";
  if (typeof item.exit_code === "number" && item.exit_code !== 0) return "failed";
  return "completed";
}

function spanErrorForItem(itemType: string, item: Record<string, unknown>): string | null {
  if (itemType === "error") {
    return typeof item.message === "string" ? item.message : "Codex reported an item-level error";
  }
  const failedByStatus = item.status === "failed";
  const failedByExitCode = typeof item.exit_code === "number" && item.exit_code !== 0;
  if (!failedByStatus && !failedByExitCode) return null;
  if (itemType === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "command";
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : "unknown";
    return `${command} exited with code ${exitCode}`;
  }
  // file_change, mcp_tool_call, etc. use status only - no exit code to report.
  return `${itemType} failed`;
}

/** Codex reuses type="error" for transient stream hiccups it's already retrying internally. */
const TRANSIENT_STREAM_NOTICE = /^reconnecting/i;

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  recorder?: TraceRecorder,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
    recorder?.recordInstant({
      name: "thread.started",
      category: "orchestration",
      status: "completed",
      output: { threadId: event.thread_id },
    });
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    const itemType = typeof item.type === "string" ? item.type : "unknown_item";
    if (itemType === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
    recorder?.recordInstant({
      name: `item.completed: ${itemType}`,
      category: spanCategoryForItem(itemType),
      status: spanStatusForItem(itemType, item),
      error: spanErrorForItem(itemType, item),
      // The full item can include command output / file contents; the store
      // redacts and length-caps it before persisting.
      output: item,
    });
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
    recorder?.recordInstant({
      name: "turn.completed",
      category: "model_call",
      status: "completed",
      output: { usage: parsed.usage },
    });
  }

  if (event.type === "turn.failed") {
    const errorDetail =
      event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : undefined;
    const message =
      typeof errorDetail?.message === "string" ? errorDetail.message : "Codex turn failed";
    // Feed the outer exitCode!==0 branch the same way a stream-level "error"
    // event does, so the Run - not just one span - actually ends up failed.
    parsed.errors.push(message);
    recorder?.recordInstant({
      name: "turn.failed",
      category: "model_call",
      status: "failed",
      error: message,
    });
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    // Codex reuses type="error" for transient, non-fatal stream hiccups too
    // (e.g. "Reconnecting... 1/5" while it retries a dropped connection
    // mid-turn). Only a genuine, non-transient error should fail a span -
    // otherwise "jump to failing step" would point at network noise instead
    // of the actual problem.
    if (TRANSIENT_STREAM_NOTICE.test(message)) {
      recorder?.recordInstant({
        name: "codex.stream-notice",
        category: "orchestration",
        status: "completed",
        output: { message },
      });
      return;
    }
    parsed.errors.push(message);
    recorder?.recordInstant({
      name: "codex.error",
      category: "orchestration",
      status: "failed",
      error: message,
    });
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const recorder = request.recorder;
    const execSpanId = recorder
      ? await recorder.startSpan({
          name: "codex exec",
          category: "sandbox_execution",
          input: { prompt: request.prompt, resumingThreadId: request.threadId },
          metadata: { sandboxMode: this.config.codexSandboxMode, provider: "local-process" },
        })
      : null;
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed, recorder);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed, recorder);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      const result: RunnerResult = {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
      if (execSpanId && recorder) {
        recorder.endSpan(execSpanId, {
          status: "completed",
          output: { threadId: result.threadId, usage: result.usage, exitCode },
        });
      }
      return result;
    } catch (error) {
      if (execSpanId && recorder) {
        const cancelled = error instanceof RunCancelledError;
        recorder.endSpan(execSpanId, {
          status: cancelled ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
      if (recorder) await recorder.flush();
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
