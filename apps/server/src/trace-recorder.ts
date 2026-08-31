import { createRedactor } from "./redaction.js";
import type { EndSpanInput, StartSpanInput, TraceStore } from "./trace-store.js";

const redactForLog = createRedactor();

/**
 * Bound to one Trace. Runners and the sandbox layer call this instead of
 * touching TraceStore directly - it keeps the "record what happened"
 * concern separate from "where it's persisted".
 *
 * Writes are fire-and-collect: callers on a synchronous hot path (for
 * example, parsing a stream of Codex JSON events) can call start/end
 * without awaiting each one, then await `flush()` once before returning a
 * result, so no span write is lost even though the caller stayed sync.
 */
export class TraceRecorder {
  private readonly pending: Promise<unknown>[] = [];

  constructor(
    private readonly store: TraceStore,
    readonly traceId: string,
  ) {}

  /** Use when the caller can await - e.g. once before entering a sync streaming loop. */
  async startSpan(input: StartSpanInput): Promise<string> {
    const span = await this.store.startSpan(this.traceId, input);
    return span.id;
  }

  /** Fire-and-collect: safe to call from a synchronous hot path such as line-by-line event parsing. */
  endSpan(spanId: string, result: EndSpanInput): void {
    if (!spanId) return;
    this.pending.push(this.store.endSpan(this.traceId, spanId, result));
  }

  /** Fire-and-collect: records a single point-in-time event (e.g. one Codex `item.completed`). */
  recordInstant(input: Parameters<TraceStore["recordInstant"]>[1]): void {
    this.pending.push(this.store.recordInstant(this.traceId, input));
  }

  /** Waits for every span write issued so far to land before the caller proceeds. */
  async flush(): Promise<void> {
    const results = await Promise.allSettled(this.pending.splice(0, this.pending.length));
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(
          "[trace-recorder] a span write failed and was dropped:",
          redactForLog(String(result.reason)).text,
        );
      }
    }
  }
}
