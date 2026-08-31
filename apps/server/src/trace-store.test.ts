import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactAndSummarize } from "./trace-types.js";
import { TraceStore } from "./trace-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeStore(maxTraces = 300): Promise<{ store: TraceStore; filePath: string; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-trace-test-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "data", "traces.json");
  const store = new TraceStore(filePath, maxTraces);
  await store.initialize();
  return { store, filePath, root };
}

describe("redactAndSummarize", () => {
  it("masks common secret shapes and never returns them verbatim", () => {
    const text = redactAndSummarize(
      "Authorization: Bearer sk-abcdEFGH12345678 and token=\"super-secret-value\"",
    );
    expect(text).not.toBeNull();
    expect(text).not.toContain("sk-abcdEFGH12345678");
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("[REDACTED]");
  });

  it("truncates payloads past the max length instead of storing them whole", () => {
    const long = "x".repeat(5_000);
    const text = redactAndSummarize(long, 100);
    expect(text!.length).toBeLessThan(200);
    expect(text).toContain("truncated");
  });

  it("returns null for null/undefined instead of the string 'null'", () => {
    expect(redactAndSummarize(null)).toBeNull();
    expect(redactAndSummarize(undefined)).toBeNull();
  });
});

describe("TraceStore span lifecycle", () => {
  it("records a trace with nested spans and closes them with correct status/duration", async () => {
    const { store } = await makeStore();
    const trace = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "2024-01-01T00:00:00.000Z",
      runId: "run-1",
      sessionId: "thread-1",
      actorType: "user",
    });
    expect(trace.status).toBe("running");
    expect(trace.cause).toBeNull();

    const root = await store.startSpan(trace.id, {
      name: "Agent Run",
      category: "orchestration",
      input: { prompt: "hello" },
    });
    const child = await store.startSpan(trace.id, {
      parentSpanId: root.id,
      name: "codex exec",
      category: "sandbox_execution",
    });
    await store.endSpan(trace.id, child.id, { status: "completed", output: { exitCode: 0 } });
    await store.endSpan(trace.id, root.id, { status: "completed" });
    await store.endTrace(trace.id, { status: "completed", cause: "completed", usage: { inputTokens: 10 } });

    const stored = store.getTrace(trace.id);
    expect(stored.status).toBe("completed");
    expect(stored.cause).toBe("completed");
    expect(stored.usage).toEqual({ inputTokens: 10 });
    expect(stored.spans).toHaveLength(2);

    const storedChild = stored.spans.find((span) => span.id === child.id)!;
    expect(storedChild.status).toBe("completed");
    expect(storedChild.parentSpanId).toBe(root.id);
    expect(storedChild.durationMs).not.toBeNull();
    expect(storedChild.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("redacts span input/output before it is ever persisted", async () => {
    const { store } = await makeStore();
    const trace = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-1",
      sessionId: null,
      actorType: "user",
    });
    const span = await store.startSpan(trace.id, {
      name: "tool call",
      category: "tool_call",
      input: "Authorization: Bearer sk-thisisasecretkey1234",
    });
    await store.endSpan(trace.id, span.id, {
      status: "completed",
      output: "token=\"another-secret\"",
    });

    const stored = store.getTrace(trace.id);
    const storedSpan = stored.spans[0];
    expect(storedSpan.input).not.toContain("sk-thisisasecretkey1234");
    expect(storedSpan.output).not.toContain("another-secret");
  });

  it("records a single-event audit entry via recordInstant", async () => {
    const { store } = await makeStore();
    const trace = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-1",
      sessionId: null,
      actorType: "system",
    });
    await store.recordInstant(trace.id, {
      name: "thread.started",
      category: "orchestration",
      status: "completed",
      output: { threadId: "abc" },
    });
    const stored = store.getTrace(trace.id);
    expect(stored.spans).toHaveLength(1);
    expect(stored.spans[0].status).toBe("completed");
    expect(stored.spans[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws a 404-style error for an unknown trace id", async () => {
    const { store } = await makeStore();
    expect(() => store.getTrace("does-not-exist")).toThrow();
  });
});

describe("TraceStore listing and filtering", () => {
  it("filters by agentId and status and respects limit", async () => {
    const { store } = await makeStore();
    const a = await store.createTrace({
      agentId: "agent-a",
      agentVersion: "v1",
      runId: "run-a",
      sessionId: null,
      actorType: "user",
    });
    await store.endTrace(a.id, { status: "failed", cause: "runtime_error" });

    const b = await store.createTrace({
      agentId: "agent-b",
      agentVersion: "v1",
      runId: "run-b",
      sessionId: null,
      actorType: "user",
    });
    await store.endTrace(b.id, { status: "completed", cause: "completed" });

    expect(store.listTraces({ agentId: "agent-a" }).map((t) => t.id)).toEqual([a.id]);
    expect(store.listTraces({ status: "failed" }).map((t) => t.id)).toEqual([a.id]);
    expect(store.listTraces({}).length).toBe(2);
    expect(store.listTraces({ limit: 1 }).length).toBe(1);
  });

  it("counts failed spans in the summary", async () => {
    const { store } = await makeStore();
    const trace = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-1",
      sessionId: null,
      actorType: "user",
    });
    const span = await store.startSpan(trace.id, { name: "tool", category: "tool_call" });
    await store.endSpan(trace.id, span.id, { status: "failed", error: "boom" });

    const [summary] = store.listTraces({ agentId: "agent-1" });
    expect(summary.errorSpanCount).toBe(1);
    expect(summary.spanCount).toBe(1);
  });
});

describe("TraceStore retention", () => {
  it("prunes the oldest traces once the cap is exceeded", async () => {
    const { store } = await makeStore(2);
    for (let i = 0; i < 4; i += 1) {
      await store.createTrace({
        agentId: "agent-1",
        agentVersion: "v1",
        runId: "run-" + i,
        sessionId: null,
        actorType: "user",
      });
      // Ensure distinct startedAt ordering even on a fast machine.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(store.listTraces({ limit: 10 })).toHaveLength(2);
  });
});

describe("TraceStore change notifications", () => {
  it("notifies subscribers after every successful mutation", async () => {
    const { store } = await makeStore();
    const listener = vi.fn();
    const unsubscribe = store.onChange(listener);

    await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-1",
      sessionId: null,
      actorType: "user",
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-2",
      sessionId: null,
      actorType: "user",
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("TraceStore retry chains", () => {
  it("computes the attempt number from the retried trace", async () => {
    const { store } = await makeStore();
    const first = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-1",
      sessionId: null,
      actorType: "user",
    });
    await store.endTrace(first.id, { status: "failed", cause: "runtime_error" });

    const retry = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-2",
      sessionId: null,
      actorType: "user",
      retryOfTraceId: first.id,
    });
    expect(retry.attempt).toBe(2);
    expect(retry.retryOfTraceId).toBe(first.id);

    const secondRetry = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-3",
      sessionId: null,
      actorType: "user",
      retryOfTraceId: retry.id,
    });
    expect(secondRetry.attempt).toBe(3);

    const [summary] = store.listTraces({ agentId: "agent-1" }).filter((t) => t.id === secondRetry.id);
    expect(summary.attempt).toBe(3);
    expect(summary.retryOfTraceId).toBe(retry.id);
  });

  it("resolves the forward retriedByTraceId link even when the chain hop isn't in listTraces()", async () => {
    const { store } = await makeStore();
    const first = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-1",
      sessionId: null,
      actorType: "user",
    });
    await store.endTrace(first.id, { status: "failed", cause: "runtime_error" });
    expect(store.getTrace(first.id).retriedByTraceId).toBeNull();

    const retry = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-2",
      sessionId: null,
      actorType: "user",
      retryOfTraceId: first.id,
    });
    await store.endTrace(retry.id, { status: "completed", cause: "completed" });

    // getTrace computes the forward link fresh from the whole store, not
    // from any filtered/paginated list, so this must resolve correctly even
    // though a status:"failed" filter would never surface the completed retry.
    expect(store.getTrace(first.id).retriedByTraceId).toBe(retry.id);
    const filteredOut = store.listTraces({ status: "failed" });
    expect(filteredOut.some((t) => t.id === retry.id)).toBe(false);
  });

  it("defaults to attempt 1 when no retryOfTraceId is given", async () => {
    const { store } = await makeStore();
    const trace = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-1",
      sessionId: null,
      actorType: "user",
    });
    expect(trace.attempt).toBe(1);
    expect(trace.retryOfTraceId).toBeNull();
  });
});

describe("TraceStore concurrency across Agents", () => {
  it("attributes concurrently-written traces and spans to the correct Agent without cross-contamination", async () => {
    const { store } = await makeStore();

    const runOneAgent = async (agentId: string, spanCount: number) => {
      const trace = await store.createTrace({
        agentId,
        agentVersion: "v1",
        runId: agentId + "-run",
        sessionId: null,
        actorType: "user",
      });
      // Fire span writes concurrently, same as a live Codex event stream would.
      await Promise.all(
        Array.from({ length: spanCount }, (_, i) =>
          store.recordInstant(trace.id, {
            name: "span-" + i,
            category: "tool_call",
            status: "completed",
            output: { agentId },
          }),
        ),
      );
      await store.endTrace(trace.id, { status: "completed", cause: "completed" });
      return trace.id;
    };

    const [traceAId, traceBId] = await Promise.all([
      runOneAgent("agent-alpha", 5),
      runOneAgent("agent-beta", 3),
    ]);

    const traceA = store.getTrace(traceAId);
    const traceB = store.getTrace(traceBId);

    expect(traceA.agentId).toBe("agent-alpha");
    expect(traceA.spans).toHaveLength(5);
    expect(traceA.spans.every((span) => span.output?.includes("agent-alpha"))).toBe(true);

    expect(traceB.agentId).toBe("agent-beta");
    expect(traceB.spans).toHaveLength(3);
    expect(traceB.spans.every((span) => span.output?.includes("agent-beta"))).toBe(true);

    expect(store.listTraces({ agentId: "agent-alpha" }).map((t) => t.id)).toEqual([traceAId]);
    expect(store.listTraces({ agentId: "agent-beta" }).map((t) => t.id)).toEqual([traceBId]);
    expect(store.listTraces({}).length).toBe(2);
  });
});

describe("TraceStore write-failure recovery", () => {
  it("surfaces a persistence failure without becoming stuck", async () => {
    const { store, filePath } = await makeStore();
    const mutableStore = store as unknown as { filePath: string };
    const originalPath = filePath;
    mutableStore.filePath = path.join(path.dirname(filePath), "missing-dir", "traces.json");

    await expect(
      store.createTrace({
        agentId: "agent-1",
        agentVersion: "v1",
        runId: "run-1",
        sessionId: null,
        actorType: "user",
      }),
    ).rejects.toThrow();
    expect(store.listTraces({})).toHaveLength(0);

    mutableStore.filePath = originalPath;
    const recovered = await store.createTrace({
      agentId: "agent-1",
      agentVersion: "v1",
      runId: "run-2",
      sessionId: null,
      actorType: "user",
    });
    expect(store.getTrace(recovered.id)).toBeTruthy();
  });
});
