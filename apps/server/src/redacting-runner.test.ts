import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { createRedactor } from "./redaction.js";
import {
  RedactedError,
  RedactingRunner,
  summarizeRedactions,
  type RedactionReport,
} from "./redacting-runner.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const LEAK =
  'Done. Wrote config with password=hunter2-topsecret and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.';

class LeakyRunner implements AgentRunner {
  cancelled = 0;
  constructor(private readonly behaviour: "ok" | "throw" | "cancel" = "ok") {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.behaviour === "cancel") throw new RunCancelledError();
    if (this.behaviour === "throw") {
      throw new Error("codex failed: ARK_API_KEY=sk-live-abcdefghijklmnop rejected");
    }
    return {
      output: LEAK + " (" + request.prompt + ")",
      threadId: "thread-1",
      usage: { inputTokens: 3, outputTokens: 9 },
    };
  }
  async cancel(): Promise<boolean> {
    this.cancelled += 1;
    return true;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe("RedactingRunner", () => {
  const redact = createRedactor({ literals: ["sk-live-abcdefghijklmnop"] });

  it("scrubs secrets from the agent message and keeps other fields", async () => {
    const reports: RedactionReport[] = [];
    const runner = new RedactingRunner(new LeakyRunner(), redact, (report) =>
      reports.push(report),
    );

    const result = await runner.run({
      agentId: "agent-1",
      workspacePath: "/tmp/ws",
      prompt: "go",
      threadId: null,
    });

    expect(result.output).not.toContain("hunter2-topsecret");
    expect(result.output).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(result.output).toContain("password=[REDACTED]");
    expect(result.output).toContain("(go)");
    expect(result.threadId).toBe("thread-1");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 9 });

    expect(result.redactions).toEqual(
      expect.arrayContaining([
        { scope: "output", rule: "secret-assignment", count: 1 },
        { scope: "output", rule: "github-token", count: 1 },
      ]),
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ agentId: "agent-1", scope: "output" });
    expect(reports[0]?.matches.map((match) => match.rule)).toEqual(
      expect.arrayContaining(["secret-assignment", "github-token"]),
    );
  });

  it("does not call the sink when the output is clean", async () => {
    const reports: RedactionReport[] = [];
    const clean: AgentRunner = {
      run: async () => ({ output: "all good, no secrets", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const runner = new RedactingRunner(clean, redact, (report) => reports.push(report));
    await runner.run({ agentId: "a", workspacePath: "/tmp", prompt: "p", threadId: null });
    expect(reports).toEqual([]);
  });

  it("redacts thrown error messages and reports scope 'error'", async () => {
    const reports: RedactionReport[] = [];
    const runner = new RedactingRunner(new LeakyRunner("throw"), redact, (report) =>
      reports.push(report),
    );

    const rejection = runner.run({
      agentId: "agent-2",
      workspacePath: "/tmp",
      prompt: "p",
      threadId: null,
    });
    await expect(rejection).rejects.toBeInstanceOf(RedactedError);
    await expect(rejection).rejects.toThrow(/ARK_API_KEY=\[REDACTED\] rejected/);
    await expect(rejection).rejects.toMatchObject({
      redactions: [{ scope: "error", rule: "known-secret", count: 1 }],
    });

    expect(reports[0]).toMatchObject({ agentId: "agent-2", scope: "error" });
  });

  it("summarizeRedactions collapses matches into counted rows", () => {
    expect(
      summarizeRedactions("output", [
        { rule: "jwt", length: 40 },
        { rule: "jwt", length: 42 },
        { rule: "github-token", length: 44 },
      ]),
    ).toEqual([
      { scope: "output", rule: "jwt", count: 2 },
      { scope: "output", rule: "github-token", count: 1 },
    ]);
    expect(summarizeRedactions("error", [])).toEqual([]);
  });

  it("rethrows RunCancelledError untouched", async () => {
    const runner = new RedactingRunner(new LeakyRunner("cancel"), redact);
    await expect(
      runner.run({ agentId: "a", workspacePath: "/tmp", prompt: "p", threadId: null }),
    ).rejects.toBeInstanceOf(RunCancelledError);
  });

  it("delegates cancel and isAvailable to the wrapped runner", async () => {
    const inner = new LeakyRunner();
    const runner = new RedactingRunner(inner, redact);
    expect(await runner.isAvailable()).toBe(true);
    expect(await runner.cancel("a")).toBe(true);
    expect(inner.cancelled).toBe(1);
  });

  it("never lets a broken sink break a run", async () => {
    const runner = new RedactingRunner(new LeakyRunner(), redact, () => {
      throw new Error("sink is down");
    });
    const result = await runner.run({
      agentId: "a",
      workspacePath: "/tmp",
      prompt: "go",
      threadId: null,
    });
    expect(result.output).toContain("[REDACTED]");
  });
});

describe("RedactingRunner inside AgentService", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("stores only the redacted output in the run and the conversation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-redact-"));
    directories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const runner = new RedactingRunner(new LeakyRunner(), createRedactor(), () => {});
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();

    const agent = await service.createAgent({ name: "Redacted" });
    const { run } = await service.sendMessage(agent.id, "write the config file");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const stored = service.getRun(run.id);
    expect(stored.output).toContain("[REDACTED]");
    expect(stored.output).not.toContain("hunter2-topsecret");
    expect(stored.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "output", rule: "secret-assignment" }),
        expect.objectContaining({ scope: "output", rule: "github-token" }),
      ]),
    );

    const assistant = service.getMessages(agent.id).at(-1);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).not.toContain("hunter2-topsecret");
    expect(assistant?.content).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
});
