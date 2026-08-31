import { createRedactor, type Redactor } from "./redaction.js";
import type { RunUsage } from "./types.js";

export type SpanCategory =
  | "orchestration"
  | "model_call"
  | "tool_call"
  | "sandbox_execution"
  | "workspace_operation"
  | "policy_decision";

export type SpanStatus = "running" | "completed" | "failed" | "cancelled";

export interface Span {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  category: SpanCategory;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Redacted / length-capped input summary. Never raw secrets. */
  input: string | null;
  /** Redacted / length-capped output summary. Never raw secrets. */
  output: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export type TraceCause = "completed" | "user_requested_stop" | "policy_blocked" | "runtime_error";

export interface Trace {
  id: string;
  agentId: string;
  /** Stand-in for Agent version: the Agent's updatedAt at the moment the Run started. */
  agentVersion: string;
  runId: string;
  /** Codex thread id, when known - lets you correlate multi-turn conversations. */
  sessionId: string | null;
  actorType: "user" | "system";
  status: SpanStatus;
  /** Why the trace ended in this status - lets the UI distinguish "user stopped it" from "it broke". */
  cause: TraceCause | null;
  /** Set when this trace is a retry of a previous failed/cancelled Run. */
  retryOfTraceId: string | null;
  /** Set when a later attempt exists for this Run - computed at read time so it's independent of any list filter. */
  retriedByTraceId: string | null;
  /** 1 for a fresh Run, 2+ for each retry in the chain. */
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  usage: RunUsage | null;
  spans: Span[];
}

export interface TraceSummary {
  id: string;
  agentId: string;
  runId: string;
  status: SpanStatus;
  cause: TraceCause | null;
  retryOfTraceId: string | null;
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  spanCount: number;
  errorSpanCount: number;
  usage: RunUsage | null;
}

/**
 * Shared fallback redactor. `TraceStore` is given a redactor configured with
 * the deployment's literal secrets (ARK_API_KEY, APP_AUTH_TOKEN); anything
 * that calls these helpers without one still gets the full pattern set.
 */
const defaultRedactor = createRedactor();

/**
 * Redacts secrets and caps length so spans never store raw credentials or
 * unbounded payloads. Uses the same detection engine as the RedactingRunner
 * middleware (`redaction.ts`). Invariant: redact before *storage*, not just
 * before display.
 */
export function redactAndSummarize(
  value: unknown,
  maxLength = 2_000,
  redact: Redactor = defaultRedactor,
): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "string" ? value : safeStringify(value);
  let text = redact(raw).text;
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + `… [truncated ${text.length - maxLength} chars]`;
  }
  return text;
}

/**
 * Recursively redacts every string in a structured value (span metadata),
 * leaving numbers, booleans, and null untouched. No length cap — metadata is
 * expected to be small structured fields, not payloads.
 */
export function redactDeep<T>(value: T, redact: Redactor = defaultRedactor): T {
  if (typeof value === "string") return redact(value).text as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, redact)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactDeep(item, redact),
      ]),
    ) as T;
  }
  return value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
