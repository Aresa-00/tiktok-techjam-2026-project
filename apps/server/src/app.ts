import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  retryOfRunId: z.string().uuid().optional(),
});
const traceIdParams = z.object({ id: z.string().uuid() });
const tracesQuery = z.object({
  agentId: z.string().uuid().optional(),
  status: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    let candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    // EventSource cannot set custom headers, so SSE stream routes also accept
    // the token as a query param. Scoped narrowly to /stream paths only.
    if (!candidate && request.url.includes("/stream") && typeof request.query === "object") {
      const query = request.query as Record<string, unknown>;
      if (typeof query.token === "string") candidate = query.token;
    }
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, {
      retryOfRunId: body.retryOfRunId,
    });
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/runs/:id/trace", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { trace: service.getTraceForRun(id) };
  });

  app.get("/api/traces", async (request) => {
    const query = tracesQuery.parse(request.query);
    return { traces: service.listTraces(query) };
  });

  app.get("/api/traces/stream", async (request, reply) => {
    const query = tracesQuery.parse(request.query);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let lastPayload = "";
    const send = () => {
      const payload = JSON.stringify(service.listTraces(query));
      if (payload !== lastPayload) {
        lastPayload = payload;
        reply.raw.write(`data: ${payload}\n\n`);
      }
    };
    send();
    const unsubscribeChange = service.onTraceChange(send);
    const heartbeat = setInterval(send, 3000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribeChange();
      reply.raw.end();
    });
  });

  app.get("/api/traces/:id", async (request) => {
    const { id } = traceIdParams.parse(request.params);
    return { trace: service.getTrace(id) };
  });

  app.get("/api/traces/:id/stream", async (request, reply) => {
    const { id } = traceIdParams.parse(request.params);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let lastPayload = "";
    let closed = false;
    const send = () => {
      if (closed) return;
      let trace;
      try {
        trace = service.getTrace(id);
      } catch {
        reply.raw.write("event: not_found\ndata: {}\n\n");
        return end();
      }
      const payload = JSON.stringify(trace);
      if (payload !== lastPayload) {
        lastPayload = payload;
        reply.raw.write(`data: ${payload}\n\n`);
      }
      // Deliberately NOT closing once trace.status leaves "running": a
      // terminal trace can still change afterward - specifically,
      // retriedByTraceId gets set the moment someone retries this Run,
      // which happens strictly after it already reached a terminal status.
      // Closing here would leave the retry breadcrumb stuck stale until the
      // client manually reselects the trace.
    };
    const end = () => {
      if (closed) return;
      closed = true;
      clearInterval(unsubscribeTimer);
      unsubscribeChange();
      reply.raw.end();
    };
    send();
    // Push on every store mutation for low latency, with a slow poll as a
    // safety net in case a listener is ever missed.
    const unsubscribeChange = service.onTraceChange(send);
    const unsubscribeTimer = setInterval(send, 2000);
    request.raw.on("close", end);
  });

  app.get("/api/traces/:id/export", async (request, reply) => {
    const { id } = traceIdParams.parse(request.params);
    const trace = service.getTrace(id);
    reply.header(
      "Content-Disposition",
      `attachment; filename="trace-${trace.id}.json"`,
    );
    return trace;
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
