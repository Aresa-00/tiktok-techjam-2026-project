import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { createRedactor } from "./redaction.js";
import { RedactingRunner } from "./redacting-runner.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: AppConfig): AgentRunner {
  const base: AgentRunner =
    config.runtimeProvider === "container"
      ? new ContainerCodexRunner(config)
      : new CodexRunner(config);

  if (!config.redactSecrets) {
    return base;
  }

  const redact = createRedactor({
    literals: [config.arkApiKey, config.authToken],
  });
  return new RedactingRunner(base, redact);
}
