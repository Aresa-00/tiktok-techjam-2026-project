import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { TraceStore } from "./trace-store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new TraceStore(path.join(root, "data", "traces.json")),
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("Trace and audit middleware", () => {
  it("records a Trace with an orchestration root span and a passing policy_decision span", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const trace = service.getTraceForRun(run.id);
    expect(trace.status).toBe("completed");
    expect(trace.cause).toBe("completed");
    expect(trace.runId).toBe(run.id);
    expect(trace.agentId).toBe(agent.id);

    const rootSpan = trace.spans.find((span) => span.category === "orchestration");
    expect(rootSpan?.status).toBe("completed");

    const policySpan = trace.spans.find((span) => span.category === "policy_decision");
    expect(policySpan?.status).toBe("completed");
    expect(policySpan?.output).toContain("true");

    expect(service.getAgent(agent.id).id).toBe(agent.id);
    const [summary] = service.listTraces({ agentId: agent.id });
    expect(summary.id).toBe(trace.id);
    expect(summary.errorSpanCount).toBe(0);
  });

  it("blocks an over-limit prompt with a failed policy_decision span and never invokes the Runtime", async () => {
    let invoked = false;
    const service = await makeService({
      run: async () => {
        invoked = true;
        return { output: "should not run", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Guarded" });
    const oversizedPrompt = "x".repeat(20_001);
    const { run } = await service.sendMessage(agent.id, oversizedPrompt);
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    expect(invoked).toBe(false);
    const trace = service.getTraceForRun(run.id);
    expect(trace.status).toBe("failed");
    expect(trace.cause).toBe("policy_blocked");

    const policySpan = trace.spans.find((span) => span.category === "policy_decision");
    expect(policySpan?.status).toBe("failed");
    expect(policySpan?.error).toContain("policy limit");

    expect(service.getAgent(agent.id).lastError).toContain("policy limit");
  });

  it("links a retry to the failed Run it retries and increments the attempt count", async () => {
    let shouldFail = true;
    const service = await makeService({
      run: async (request) => {
        if (shouldFail) throw new Error("simulated Runtime failure");
        return { output: "Completed: " + request.prompt, threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Flaky" });

    const { run: firstRun } = await service.sendMessage(agent.id, "do the thing");
    await expect.poll(() => service.getRun(firstRun.id).status).toBe("failed");
    const firstTrace = service.getTraceForRun(firstRun.id);
    expect(firstTrace.attempt).toBe(1);
    expect(firstTrace.retryOfTraceId).toBeNull();

    shouldFail = false;
    const { run: retryRun } = await service.sendMessage(agent.id, "do the thing", {
      retryOfRunId: firstRun.id,
    });
    await expect.poll(() => service.getRun(retryRun.id).status).toBe("completed");
    const retryTrace = service.getTraceForRun(retryRun.id);
    expect(retryTrace.attempt).toBe(2);
    expect(retryTrace.retryOfTraceId).toBe(firstTrace.id);
  });

  it("rejects a retry that points at a Run belonging to a different Agent", async () => {
    const service = await makeService();
    const agentA = await service.createAgent({ name: "A" });
    const agentB = await service.createAgent({ name: "B" });
    const { run } = await service.sendMessage(agentA.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await expect(
      service.sendMessage(agentB.id, "hello", { retryOfRunId: run.id }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects retrying a Run that did not fail or get cancelled", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Fine" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await expect(
      service.sendMessage(agent.id, "hello", { retryOfRunId: run.id }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
