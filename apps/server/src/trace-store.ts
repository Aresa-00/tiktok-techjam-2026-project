import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { HttpError } from "./errors.js";
import { createRedactor, type Redactor } from "./redaction.js";
import type { RunUsage } from "./types.js";
import { redactAndSummarize, redactDeep, type Span, type SpanCategory, type SpanStatus, type Trace, type TraceCause, type TraceSummary } from "./trace-types.js";

interface TraceDatabase {
  version: 1;
  traces: Trace[];
}

const emptyDatabase = (): TraceDatabase => ({ version: 1, traces: [] });
const now = () => new Date().toISOString();

export interface CreateTraceInput {
  agentId: string;
  agentVersion: string;
  runId: string;
  sessionId: string | null;
  actorType: "user" | "system";
  retryOfTraceId?: string | null;
}

export interface StartSpanInput {
  parentSpanId?: string | null;
  name: string;
  category: SpanCategory;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface EndSpanInput {
  status: Extract<SpanStatus, "completed" | "failed" | "cancelled">;
  output?: unknown;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only-ish trace storage. Same single-process, atomic-rewrite
 * approach as JsonStore, kept in a separate file so a busy Run's span
 * writes never contend with Agent/message/run persistence.
 */
export class TraceStore {
  private data: TraceDatabase = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  private readonly redact: Redactor;

  constructor(
    private readonly filePath: string,
    private readonly maxTraces = 300,
    redact: Redactor = createRedactor(),
  ) {
    this.redact = redact;
  }

  /** Notified after every successful mutation - lets the SSE routes push without polling the filesystem. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TraceDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.traces)) {
        throw new Error("Unsupported trace database format");
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  listTraces(filter: {
    agentId?: string | undefined;
    status?: SpanStatus | undefined;
    limit?: number | undefined;
  } = {}): TraceSummary[] {
    const limit = filter.limit ?? 50;
    return this.data.traces
      .filter((trace) => !filter.agentId || trace.agentId === filter.agentId)
      .filter((trace) => !filter.status || trace.status === filter.status)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit)
      .map(summarize);
  }

  getTrace(id: string): Trace {
    const trace = this.data.traces.find((item) => item.id === id);
    if (!trace) {
      throw new HttpError(404, "Trace not found");
    }
    return this.withRetryLink(structuredClone(trace));
  }

  getTraceByRunId(runId: string): Trace | null {
    const trace = this.data.traces.find((item) => item.runId === runId);
    return trace ? this.withRetryLink(structuredClone(trace)) : null;
  }

  /**
   * Fills in `retriedByTraceId` against the live store, not any
   * caller-supplied list, so the forward link in a retry chain is correct
   * even when the client's own trace list is narrowed by a status/agent
   * filter and would otherwise miss the later attempt.
   */
  private withRetryLink(trace: Trace): Trace {
    const child = this.data.traces
      .filter((item) => item.retryOfTraceId === trace.id)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    trace.retriedByTraceId = child ? child.id : null;
    return trace;
  }

  async createTrace(input: CreateTraceInput): Promise<Trace> {
    const retryOfTraceId = input.retryOfTraceId ?? null;
    const trace: Trace = {
      id: randomUUID(),
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      runId: input.runId,
      sessionId: input.sessionId,
      actorType: input.actorType,
      status: "running",
      cause: null,
      retryOfTraceId,
      retriedByTraceId: null,
      attempt: 1,
      startedAt: now(),
      endedAt: null,
      durationMs: null,
      usage: null,
      spans: [],
    };
    await this.mutate((database) => {
      // Computed inside the mutation, not before it, so a concurrent retry
      // chain can't read a stale attempt count from outside the write queue.
      if (retryOfTraceId) {
        const previous = database.traces.find((item) => item.id === retryOfTraceId);
        if (previous) trace.attempt = previous.attempt + 1;
      }
      database.traces.push(trace);
      pruneOldest(database, this.maxTraces);
    });
    return trace;
  }

  async startSpan(traceId: string, input: StartSpanInput): Promise<Span> {
    const span: Span = {
      id: randomUUID(),
      traceId,
      parentSpanId: input.parentSpanId ?? null,
      name: input.name,
      category: input.category,
      status: "running",
      startedAt: now(),
      endedAt: null,
      durationMs: null,
      input: redactAndSummarize(input.input, 2_000, this.redact),
      output: null,
      error: null,
      metadata: redactDeep(input.metadata ?? {}, this.redact),
    };
    await this.mutate((database) => {
      const trace = database.traces.find((item) => item.id === traceId);
      if (!trace) return;
      trace.spans.push(span);
    });
    return span;
  }

  async endSpan(traceId: string, spanId: string, result: EndSpanInput): Promise<void> {
    await this.mutate((database) => {
      const trace = database.traces.find((item) => item.id === traceId);
      const span = trace?.spans.find((item) => item.id === spanId);
      if (!trace || !span) return;
      const endedAt = now();
      span.status = result.status;
      span.output = redactAndSummarize(result.output, 2_000, this.redact);
      span.error = redactAndSummarize(result.error, 2_000, this.redact);
      span.metadata = {
        ...span.metadata,
        ...redactDeep(result.metadata ?? {}, this.redact),
      };
      span.endedAt = endedAt;
      span.durationMs = new Date(endedAt).getTime() - new Date(span.startedAt).getTime();
    });
  }

  /** Records a zero-duration audit entry for events observed only as a single point in time. */
  async recordInstant(
    traceId: string,
    input: StartSpanInput & { status: SpanStatus; output?: unknown; error?: string | null },
  ): Promise<Span> {
    const span = await this.startSpan(traceId, input);
    await this.endSpan(traceId, span.id, {
      status: input.status === "running" ? "completed" : input.status,
      output: input.output,
      error: input.error ?? null,
    });
    return { ...span, status: input.status };
  }

  async endTrace(
    traceId: string,
    result: {
      status: Extract<SpanStatus, "completed" | "failed" | "cancelled">;
      cause?: TraceCause;
      usage?: RunUsage | null;
    },
  ): Promise<void> {
    await this.mutate((database) => {
      const trace = database.traces.find((item) => item.id === traceId);
      if (!trace) return;
      const endedAt = now();
      trace.status = result.status;
      trace.cause = result.cause ?? trace.cause;
      trace.usage = result.usage ?? trace.usage;
      trace.endedAt = endedAt;
      trace.durationMs = new Date(endedAt).getTime() - new Date(trace.startedAt).getTime();
    });
  }

  private async mutate(mutation: (database: TraceDatabase) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      mutation(next);
      await this.persist(next);
      this.data = next;
      for (const listener of this.listeners) listener();
    });
    this.queue = operation.catch((error: unknown) => {
      // Keep the write queue alive even if one mutation fails to persist -
      // otherwise every later trace write would wait on a rejected promise
      // forever. The failure is still surfaced to whoever called mutate().
      console.error(
        "[trace-store] failed to persist trace mutation:",
        this.redact(String(error)).text,
      );
    });
    await operation;
  }

  private async persist(data: TraceDatabase = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function pruneOldest(database: TraceDatabase, maxTraces: number): void {
  if (database.traces.length <= maxTraces) return;
  database.traces.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  database.traces.length = maxTraces;
}

function summarize(trace: Trace): TraceSummary {
  return {
    id: trace.id,
    agentId: trace.agentId,
    runId: trace.runId,
    status: trace.status,
    cause: trace.cause,
    retryOfTraceId: trace.retryOfTraceId,
    attempt: trace.attempt,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    spanCount: trace.spans.length,
    errorSpanCount: trace.spans.filter((span) => span.status === "failed").length,
    usage: trace.usage,
  };
}
