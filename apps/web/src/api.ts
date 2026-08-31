import type { Agent, AgentRun, Message, SystemInfo, Trace, TraceSummary } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function getAuthToken(): string {
  return authToken;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string, retryOfRunId?: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content, ...(retryOfRunId ? { retryOfRunId } : {}) }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  runTrace: (runId: string) =>
    request<{ trace: Trace }>("/api/runs/" + runId + "/trace"),
  listTraces: (params: { agentId?: string; status?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.agentId) query.set("agentId", params.agentId);
    if (params.status) query.set("status", params.status);
    const suffix = query.toString() ? "?" + query.toString() : "";
    return request<{ traces: TraceSummary[] }>("/api/traces" + suffix);
  },
  trace: (id: string) => request<{ trace: Trace }>("/api/traces/" + id),
  traceStreamUrl: (id: string) =>
    "/api/traces/" + id + "/stream" + (authToken ? "?token=" + encodeURIComponent(authToken) : ""),
  tracesStreamUrl: (params: { agentId?: string; status?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.agentId) query.set("agentId", params.agentId);
    if (params.status) query.set("status", params.status);
    if (authToken) query.set("token", authToken);
    const suffix = query.toString() ? "?" + query.toString() : "";
    return "/api/traces/stream" + suffix;
  },
  exportTrace: (id: string) => request<Trace>("/api/traces/" + id + "/export"),
};
