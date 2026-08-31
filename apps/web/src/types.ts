export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface RunRedaction {
  scope: "output" | "error";
  rule: string;
  count: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  redactions?: RunRedaction[];
  createdAt: string;
  traceId?: string;
}

export type SpanStatus = "running" | "completed" | "failed" | "cancelled";
export type TraceCause = "completed" | "user_requested_stop" | "policy_blocked" | "runtime_error";
export type SpanCategory =
  | "orchestration"
  | "model_call"
  | "tool_call"
  | "sandbox_execution"
  | "workspace_operation"
  | "policy_decision";

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
  input: string | null;
  output: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface Trace {
  id: string;
  agentId: string;
  agentVersion: string;
  runId: string;
  sessionId: string | null;
  actorType: "user" | "system";
  status: SpanStatus;
  cause: TraceCause | null;
  retryOfTraceId: string | null;
  retriedByTraceId: string | null;
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  usage: AgentRun["usage"];
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
  usage: AgentRun["usage"];
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
