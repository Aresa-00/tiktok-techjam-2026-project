import { describe, expect, it, vi } from "vitest";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import type { TraceRecorder } from "./trace-recorder.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("records a failed tool_call span when a command_execution item exits non-zero", () => {
    const parsed = { messages: [] as string[], threadId: null as string | null, usage: null, errors: [] as string[] };
    const recordInstant = vi.fn();
    const fakeRecorder = { recordInstant } as unknown as TraceRecorder;

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "1 failing",
          exit_code: 1,
          status: "failed",
        },
      }),
      parsed,
      fakeRecorder,
    );

    expect(recordInstant).toHaveBeenCalledTimes(1);
    const [call] = recordInstant.mock.calls[0];
    expect(call.status).toBe("failed");
    expect(call.category).toBe("tool_call");
    expect(call.error).toContain("npm test");
    expect(call.error).toContain("code 1");
  });

  it("records a completed tool_call span when a command exits zero", () => {
    const parsed = { messages: [] as string[], threadId: null as string | null, usage: null, errors: [] as string[] };
    const recordInstant = vi.fn();
    const fakeRecorder = { recordInstant } as unknown as TraceRecorder;

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_2",
          type: "command_execution",
          command: "npm run build",
          aggregated_output: "build ok",
          exit_code: 0,
          status: "completed",
        },
      }),
      parsed,
      fakeRecorder,
    );

    const [call] = recordInstant.mock.calls[0];
    expect(call.status).toBe("completed");
    expect(call.error).toBeNull();
  });

  it("records a failed model_call span on turn.failed and feeds it into the run's error detail", () => {
    const parsed = { messages: [] as string[], threadId: null as string | null, usage: null, errors: [] as string[] };
    const recordInstant = vi.fn();
    const fakeRecorder = { recordInstant } as unknown as TraceRecorder;

    parseCodexEventLine(
      JSON.stringify({ type: "turn.failed", error: { message: "context window exceeded" } }),
      parsed,
      fakeRecorder,
    );

    expect(parsed.errors).toEqual(["context window exceeded"]);
    const [call] = recordInstant.mock.calls[0];
    expect(call.status).toBe("failed");
    expect(call.category).toBe("model_call");
    expect(call.error).toBe("context window exceeded");
  });

  it("treats an item.type === 'error' item as failed even without status/exit_code fields", () => {
    const parsed = { messages: [] as string[], threadId: null as string | null, usage: null, errors: [] as string[] };
    const recordInstant = vi.fn();
    const fakeRecorder = { recordInstant } as unknown as TraceRecorder;

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_9", type: "error", message: "MCP server unavailable" },
      }),
      parsed,
      fakeRecorder,
    );

    const [call] = recordInstant.mock.calls[0];
    expect(call.status).toBe("failed");
    expect(call.error).toBe("MCP server unavailable");
  });

  it("describes a failed file_change item without a misleading exit-code phrase", () => {
    const parsed = { messages: [] as string[], threadId: null as string | null, usage: null, errors: [] as string[] };
    const recordInstant = vi.fn();
    const fakeRecorder = { recordInstant } as unknown as TraceRecorder;

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_10", type: "file_change", status: "failed" },
      }),
      parsed,
      fakeRecorder,
    );

    const [call] = recordInstant.mock.calls[0];
    expect(call.status).toBe("failed");
    expect(call.error).toBe("file_change failed");
    expect(call.error).not.toContain("exited with code");
  });
});
