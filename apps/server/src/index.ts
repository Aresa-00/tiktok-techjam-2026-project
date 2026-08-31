import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRedactor } from "./redaction.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { TraceStore } from "./trace-store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const redact = createRedactor({ literals: [config.arkApiKey, config.authToken] });
const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const traceStore = new TraceStore(
  path.join(config.dataDirectory, "traces.json"),
  300,
  redact,
);
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner, traceStore);
await service.initialize();

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
