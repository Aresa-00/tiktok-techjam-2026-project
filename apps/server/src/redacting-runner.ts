import { RunCancelledError } from "./errors.js";
import type { Redactor, RedactionMatch } from "./redaction.js";
import type {
  AgentRunner,
  RunRedaction,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

export interface RedactionReport {
  agentId: string;
  /** Where the secret was caught: the agent message or a failure message. */
  scope: "output" | "error";
  matches: RedactionMatch[];
}

export type RedactionSink = (report: RedactionReport) => void;

/** Default sink: a single structured line, secret-free by construction. */
export const logRedaction: RedactionSink = (report) => {
  // eslint-disable-next-line no-console -- audit signal for the Glass Box track
  console.warn(
    JSON.stringify({
      event: "secret.redacted",
      agentId: report.agentId,
      scope: report.scope,
      rules: report.matches.map((match) => match.rule),
      count: report.matches.length,
    }),
  );
};

/** An error whose message has been redacted, carrying the redaction summary. */
export class RedactedError extends Error {
  constructor(
    message: string,
    readonly redactions: RunRedaction[],
  ) {
    super(message);
    this.name = "RedactedError";
  }
}

/** Collapse per-match detail into `{ scope, rule, count }` rows for a run. */
export function summarizeRedactions(
  scope: RunRedaction["scope"],
  matches: readonly RedactionMatch[],
): RunRedaction[] {
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.rule, (counts.get(match.rule) ?? 0) + 1);
  }
  return [...counts].map(([rule, count]) => ({ scope, rule, count }));
}

/**
 * Middleware that wraps any {@link AgentRunner} and scrubs credentials from
 * everything the Agent hands back before the control plane stores or returns
 * it. Runs on both the success path (the agent message) and the failure path
 * (the error message, which can carry Codex stderr).
 *
 * Cancellation is transparent: {@link RunCancelledError} is rethrown untouched
 * so {@link AgentService} still classifies the run as `cancelled`.
 */
export class RedactingRunner implements AgentRunner {
  constructor(
    private readonly inner: AgentRunner,
    private readonly redact: Redactor,
    private readonly sink: RedactionSink = logRedaction,
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    let result: RunnerResult;
    try {
      result = await this.inner.run(request);
    } catch (error) {
      if (error instanceof RunCancelledError) {
        throw error;
      }
      const original = error instanceof Error ? error.message : String(error);
      const { text, matches } = this.redact(original);
      if (matches.length > 0) {
        this.report(request.agentId, "error", matches);
      }
      throw new RedactedError(text, summarizeRedactions("error", matches));
    }

    const { text, matches } = this.redact(result.output);
    if (matches.length > 0) {
      this.report(request.agentId, "output", matches);
    }
    return {
      ...result,
      output: text,
      redactions: summarizeRedactions("output", matches),
    };
  }

  cancel(agentId: string): Promise<boolean> {
    return this.inner.cancel(agentId);
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  private report(
    agentId: string,
    scope: RedactionReport["scope"],
    matches: RedactionMatch[],
  ): void {
    try {
      this.sink({ agentId, scope, matches });
    } catch {
      // A broken audit sink must never break a run.
    }
  }
}
