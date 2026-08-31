import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { Span, SpanCategory, SpanStatus, Trace, TraceCause, TraceSummary } from "./types";

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

const causeLabels: Record<TraceCause, string> = {
  completed: "Completed normally",
  user_requested_stop: "Stopped by user",
  policy_blocked: "Blocked by policy",
  runtime_error: "Runtime error",
};

function StatusBadge({ status }: { status: SpanStatus }) {
  return <span className={"trace-status trace-status-" + status}>{status}</span>;
}

function CategoryBadge({ category }: { category: Span["category"] }) {
  return (
    <span className={"trace-category trace-category-" + category}>
      {category.replace("_", " ")}
    </span>
  );
}

interface SpanNode extends Span {
  children: SpanNode[];
}

function buildSpanTree(spans: Span[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>();
  for (const span of spans) nodes.set(span.id, { ...span, children: [] });
  const roots: SpanNode[] = [];
  for (const span of spans) {
    const node = nodes.get(span.id)!;
    const parent = span.parentSpanId ? nodes.get(span.parentSpanId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const byStart = (a: SpanNode, b: SpanNode) => a.startedAt.localeCompare(b.startedAt);
  const sortRec = (list: SpanNode[]) => {
    list.sort(byStart);
    for (const item of list) sortRec(item.children);
  };
  sortRec(roots);
  return roots;
}

/** Finds the earliest-started failed span, returned as [ancestor, ..., failedSpan]. */
function findFirstFailurePath(tree: SpanNode[]): SpanNode[] | null {
  for (const node of tree) {
    if (node.status === "failed") return [node];
    const childPath = findFirstFailurePath(node.children);
    if (childPath) return [node, ...childPath];
  }
  return null;
}

function flattenSpans(tree: SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (list: SpanNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(tree);
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Keeps a node if its own category is selected, or if it has any descendant
 * that is - so a filtered-out parent still renders as context for a
 * matching child instead of the child disappearing along with it.
 */
function filterTreeByCategory(tree: SpanNode[], selected: Set<SpanCategory>): SpanNode[] {
  const result: SpanNode[] = [];
  for (const node of tree) {
    const filteredChildren = filterTreeByCategory(node.children, selected);
    if (selected.has(node.category) || filteredChildren.length > 0) {
      result.push({ ...node, children: filteredChildren });
    }
  }
  return result;
}

interface SpanRowProps {
  node: SpanNode;
  depth: number;
  expandedIds: Set<string>;
  payloadOpenIds: Set<string>;
  highlightId: string | null;
  onToggleExpand: (id: string) => void;
  onTogglePayload: (id: string) => void;
}

function SpanRow({
  node,
  depth,
  expandedIds,
  payloadOpenIds,
  highlightId,
  onToggleExpand,
  onTogglePayload,
}: SpanRowProps) {
  const hasChildren = node.children.length > 0;
  const hasPayload = Boolean(node.input || node.output || node.error);
  const expanded = expandedIds.has(node.id);
  const showPayload = payloadOpenIds.has(node.id);

  return (
    <div className="span-row-wrap" id={"span-" + node.id}>
      <div
        className={"span-row " + (highlightId === node.id ? "span-row-highlight" : "")}
        style={{ paddingLeft: depth * 20 + 12 }}
      >
        <button
          className="span-toggle"
          onClick={() => onToggleExpand(node.id)}
          disabled={!hasChildren}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {hasChildren ? (expanded ? "▾" : "▸") : "·"}
        </button>
        <CategoryBadge category={node.category} />
        <span className="span-name">{node.name}</span>
        <span className="span-duration">{formatDuration(node.durationMs)}</span>
        <StatusBadge status={node.status} />
        {hasPayload && (
          <button className="span-payload-toggle" onClick={() => onTogglePayload(node.id)}>
            {showPayload ? "hide" : "details"}
          </button>
        )}
      </div>
      {showPayload && (
        <div className="span-payload" style={{ marginLeft: depth * 20 + 36 }}>
          {node.error && <div className="span-payload-error">{node.error}</div>}
          {node.input && (
            <div>
              <span className="span-payload-label">input</span>
              <pre>{node.input}</pre>
            </div>
          )}
          {node.output && (
            <div>
              <span className="span-payload-label">output</span>
              <pre>{node.output}</pre>
            </div>
          )}
        </div>
      )}
      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <SpanRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              payloadOpenIds={payloadOpenIds}
              highlightId={highlightId}
              onToggleExpand={onToggleExpand}
              onTogglePayload={onTogglePayload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceTimeline({
  trace,
  highlightId,
  selectedCategories,
}: {
  trace: Trace;
  highlightId: string | null;
  selectedCategories: Set<SpanCategory>;
}) {
  const flat = useMemo(
    () => flattenSpans(buildSpanTree(trace.spans)).filter((span) => selectedCategories.has(span.category)),
    [trace.spans, selectedCategories],
  );
  const traceStart = new Date(trace.startedAt).getTime();
  const traceEnd = trace.endedAt ? new Date(trace.endedAt).getTime() : Date.now();
  const totalMs = Math.max(traceEnd - traceStart, 1);

  return (
    <div className="span-timeline">
      {flat.length === 0 ? (
        <div className="trace-empty">No spans match the selected categories.</div>
      ) : (
        flat.map((span) => {
          const startOffset = new Date(span.startedAt).getTime() - traceStart;
          const durationMs =
            span.durationMs ?? Math.max(traceEnd - new Date(span.startedAt).getTime(), 0);
          const leftPct = Math.min(Math.max((startOffset / totalMs) * 100, 0), 100);
          const widthPct = Math.min(Math.max((durationMs / totalMs) * 100, 0.4), 100 - leftPct);
          return (
            <div
              key={span.id}
              id={"span-" + span.id}
              className={"timeline-row " + (highlightId === span.id ? "span-row-highlight" : "")}
            >
              <div className="timeline-row-label">
                <CategoryBadge category={span.category} />
                <span className="span-name">{span.name}</span>
              </div>
              <div className="timeline-track">
                <div
                  className={"timeline-bar timeline-bar-" + span.status}
                  style={{ left: leftPct + "%", width: widthPct + "%" }}
                  title={span.name + " · " + formatDuration(span.durationMs)}
                />
              </div>
              <span className="span-duration">{formatDuration(span.durationMs)}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Resolves display info for a linked trace in a retry chain. Checks the
 * already-loaded (possibly filtered) list first - no network call - and
 * only falls back to a direct-by-id fetch when the filter has hidden it.
 */
function useChainLink(id: string | null, allTraces: TraceSummary[]): TraceSummary | null {
  const fromList = id ? (allTraces.find((t) => t.id === id) ?? null) : null;
  const [fetched, setFetched] = useState<TraceSummary | null>(null);

  useEffect(() => {
    setFetched(null);
    if (!id || fromList) return;
    let cancelled = false;
    api
      .trace(id)
      .then(({ trace: t }) => {
        if (cancelled) return;
        setFetched({
          id: t.id,
          agentId: t.agentId,
          runId: t.runId,
          status: t.status,
          cause: t.cause,
          retryOfTraceId: t.retryOfTraceId,
          attempt: t.attempt,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          durationMs: t.durationMs,
          spanCount: t.spans.length,
          errorSpanCount: t.spans.filter((span) => span.status === "failed").length,
          usage: t.usage,
        });
      })
      .catch(() => setFetched(null));
    return () => {
      cancelled = true;
    };
    // fromList is derived from id + allTraces each render; only re-fetch when the id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return fromList ?? fetched;
}

function TraceDetail({
  trace,
  allTraces,
  onViewTrace,
}: {
  trace: Trace;
  allTraces: TraceSummary[];
  onViewTrace: (id: string) => void;
}) {
  const tree = useMemo(() => buildSpanTree(trace.spans), [trace.spans]);
  const errorCount = trace.spans.filter((span) => span.status === "failed").length;
  const previousAttempt = useChainLink(trace.retryOfTraceId, allTraces);
  const nextAttempt = useChainLink(trace.retriedByTraceId, allTraces);

  const categoryCounts = useMemo(() => {
    const counts = new Map<SpanCategory, number>();
    for (const span of trace.spans) counts.set(span.category, (counts.get(span.category) ?? 0) + 1);
    return counts;
  }, [trace.spans]);
  const presentCategories = useMemo(
    () => Array.from(categoryCounts.keys()).sort(),
    [categoryCounts],
  );
  const [selectedCategories, setSelectedCategories] = useState<Set<SpanCategory>>(new Set());

  const toggleCategory = useCallback((category: SpanCategory) => {
    setSelectedCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const filteredTree = useMemo(
    () => filterTreeByCategory(tree, selectedCategories),
    [tree, selectedCategories],
  );
  const [viewMode, setViewMode] = useState<"tree" | "timeline">("tree");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [payloadOpenIds, setPayloadOpenIds] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Default: expand root spans only, whenever the selected Run changes.
    setExpandedIds(new Set(tree.map((node) => node.id)));
    setPayloadOpenIds(new Set());
    setHighlightId(null);
    setRetryError(null);
    setRetrySent(false);
    setSelectedCategories(new Set(presentCategories));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace.id]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePayload = useCallback((id: string) => {
    setPayloadOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const jumpToFailure = useCallback(() => {
    const path = findFirstFailurePath(tree);
    if (!path) return;
    const failing = path[path.length - 1];
    setViewMode("tree");
    setSelectedCategories((current) => {
      if (current.has(failing.category)) return current;
      return new Set(current).add(failing.category);
    });
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const node of path) next.add(node.id);
      return next;
    });
    setPayloadOpenIds((current) => new Set(current).add(failing.id));
    setHighlightId(failing.id);
    if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
    highlightTimeout.current = setTimeout(() => setHighlightId(null), 2200);
    requestAnimationFrame(() => {
      setTimeout(() => {
        document.getElementById("span-" + failing.id)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 50);
    });
  }, [tree]);

  const handleExport = useCallback(async () => {
    try {
      const full = await api.exportTrace(trace.id);
      const blob = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "trace-" + trace.id.slice(0, 8) + ".json";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // Export is best-effort; the trace is still fully visible in the UI either way.
    }
  }, [trace.id]);

  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrySent, setRetrySent] = useState(false);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    setRetrySent(false);
    try {
      const { run: originalRun } = await api.run(trace.runId);
      await api.sendMessage(trace.agentId, originalRun.prompt, trace.runId);
      setRetrySent(true);
    } catch (err) {
      setRetryError(err instanceof ApiError ? err.message : "Could not start a retry");
    } finally {
      setRetrying(false);
    }
  }, [trace.runId, trace.agentId]);

  return (
    <div className="trace-detail">
      {trace.retryOfTraceId && (
        <div className="retry-breadcrumb">
          Attempt {trace.attempt} · retry of the attempt at{" "}
          {previousAttempt ? formatDateTime(previousAttempt.startedAt) : "an earlier time"}
          {previousAttempt?.cause ? `, which ${causeLabels[previousAttempt.cause].toLowerCase()}` : ""}
          {" · "}
          <button className="retry-breadcrumb-link" onClick={() => onViewTrace(trace.retryOfTraceId!)}>
            view that attempt
          </button>
        </div>
      )}
      {nextAttempt && (
        <div className="retry-breadcrumb retry-breadcrumb-forward">
          This Run was retried as attempt {nextAttempt.attempt} ({nextAttempt.status}
          {nextAttempt.cause ? `, ${causeLabels[nextAttempt.cause].toLowerCase()}` : ""}) ·{" "}
          <button className="retry-breadcrumb-link" onClick={() => onViewTrace(nextAttempt.id)}>
            view that attempt
          </button>
        </div>
      )}
      <div className="trace-detail-header">
        <div>
          <div className="trace-detail-title-row">
            <h2>Run {trace.runId.slice(0, 8)}</h2>
            <StatusBadge status={trace.status} />
            {trace.attempt > 1 && <span className="attempt-badge">attempt {trace.attempt}</span>}
          </div>
          <p className="trace-detail-meta">
            {formatDateTime(trace.startedAt)} · {formatDuration(trace.durationMs)} ·{" "}
            {trace.spans.length} spans
            {errorCount > 0 ? " · " + errorCount + " failed" : ""}
            {trace.cause ? " · " + causeLabels[trace.cause] : ""}
          </p>
        </div>
        <div className="trace-detail-actions">
          {trace.usage && (
            <div className="trace-usage">
              <span>in {trace.usage.inputTokens ?? "—"}</span>
              <span>out {trace.usage.outputTokens ?? "—"}</span>
            </div>
          )}
          {trace.status === "failed" && (
            <button
              className="button button-ghost retry-button"
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          )}
          <button className="button button-ghost trace-export-button" onClick={handleExport}>
            Export JSON
          </button>
        </div>
      </div>

      {retrySent && (
        <div className="retry-status retry-status-ok">
          Retry started - a new Run for this Agent should appear in the list shortly.
        </div>
      )}
      {retryError && <div className="retry-status retry-status-error">{retryError}</div>}

      <div className="trace-meta-row">
        <span>trace {trace.id.slice(0, 8)}</span>
        <span>agent {trace.agentId.slice(0, 8)}</span>
        {trace.sessionId && <span>session {trace.sessionId.slice(0, 8)}</span>}
      </div>

      <div className="trace-toolbar-row">
        <div className="view-toggle small-toggle">
          <button
            className={"view-toggle-tab " + (viewMode === "tree" ? "active" : "")}
            onClick={() => setViewMode("tree")}
          >
            Tree
          </button>
          <button
            className={"view-toggle-tab " + (viewMode === "timeline" ? "active" : "")}
            onClick={() => setViewMode("timeline")}
          >
            Timeline
          </button>
        </div>
        {errorCount > 0 && (
          <button className="jump-to-failure-button" onClick={jumpToFailure}>
            ⚠ Jump to failing step
          </button>
        )}
      </div>

      {presentCategories.length > 1 && (
        <div className="category-filter-row">
          {presentCategories.map((category) => (
            <button
              key={category}
              className={
                "category-filter-chip " + (selectedCategories.has(category) ? "active" : "")
              }
              onClick={() => toggleCategory(category)}
            >
              {category.replace("_", " ")}
              <span className="category-filter-count">{categoryCounts.get(category)}</span>
            </button>
          ))}
          {selectedCategories.size < presentCategories.length && (
            <button
              className="category-filter-reset"
              onClick={() => setSelectedCategories(new Set(presentCategories))}
            >
              show all
            </button>
          )}
        </div>
      )}

      {viewMode === "tree" ? (
        <div className="span-tree">
          {filteredTree.length === 0 ? (
            <div className="trace-empty">No spans match the selected categories.</div>
          ) : (
            filteredTree.map((node) => (
              <SpanRow
                key={node.id}
                node={node}
                depth={0}
                expandedIds={expandedIds}
                payloadOpenIds={payloadOpenIds}
                highlightId={highlightId}
                onToggleExpand={toggleExpand}
                onTogglePayload={togglePayload}
              />
            ))
          )}
        </div>
      ) : (
        <TraceTimeline trace={trace} highlightId={highlightId} selectedCategories={selectedCategories} />
      )}
    </div>
  );
}

const statusFilters: Array<{ label: string; value: SpanStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Running", value: "running" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
];

export default function TracesView({ agentId }: { agentId: string | null }) {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Trace | null>(null);
  const [statusFilter, setStatusFilter] = useState<SpanStatus | "all">("all");
  const [scopeToAgent, setScopeToAgent] = useState(true);
  const [connected, setConnected] = useState(false);

  // Live-updating Run list via Server-Sent Events - no polling.
  useEffect(() => {
    const url = api.tracesStreamUrl({
      agentId: scopeToAgent && agentId ? agentId : undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
    });
    const source = new EventSource(url);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as TraceSummary[];
        setTraces(next);
        setSelectedId((current) =>
          current && next.some((trace) => trace.id === current) ? current : (next[0]?.id ?? null),
        );
      } catch {
        // Ignore a malformed frame; the next tick self-corrects.
      }
    };
    return () => source.close();
  }, [agentId, scopeToAgent, statusFilter]);

  // Live-updating trace detail via SSE, scoped to the selected Run.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const source = new EventSource(api.traceStreamUrl(selectedId));
    source.onmessage = (event) => {
      try {
        setDetail(JSON.parse(event.data) as Trace);
      } catch {
        // Ignore a malformed frame.
      }
    };
    source.addEventListener("not_found", () => setDetail(null));
    return () => source.close();
  }, [selectedId]);

  return (
    <div className="traces-view">
      <div className="traces-list-panel">
        <div className="traces-toolbar">
          <div className="traces-toolbar-top">
            <div className="traces-filter-group">
              {statusFilters.map((filter) => (
                <button
                  key={filter.value}
                  className={"trace-filter-chip " + (statusFilter === filter.value ? "active" : "")}
                  onClick={() => setStatusFilter(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <span
              className={"live-indicator " + (connected ? "live" : "stale")}
              title={connected ? "Live" : "Reconnecting…"}
            >
              ●
            </span>
          </div>
          {agentId && (
            <label className="trace-scope-toggle">
              <input
                type="checkbox"
                checked={scopeToAgent}
                onChange={(event) => setScopeToAgent(event.target.checked)}
              />
              This Agent only
            </label>
          )}
        </div>

        <div className="traces-list">
          {traces.length === 0 && <div className="trace-empty">No Runs recorded yet.</div>}
          {traces.map((trace) => (
            <button
              key={trace.id}
              className={"trace-list-item " + (trace.id === selectedId ? "selected" : "")}
              onClick={() => setSelectedId(trace.id)}
            >
              <div className="trace-list-item-top">
                <StatusBadge status={trace.status} />
                <span className="trace-list-item-time">{formatDateTime(trace.startedAt)}</span>
              </div>
              <div className="trace-list-item-bottom">
                <span>{trace.spanCount} spans</span>
                <span>{formatDuration(trace.durationMs)}</span>
                {trace.attempt > 1 && <span className="attempt-badge-small">attempt {trace.attempt}</span>}
                {trace.errorSpanCount > 0 && (
                  <span className="trace-error-flag">{trace.errorSpanCount} failed</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="traces-detail-panel">
        {detail ? (
          <TraceDetail trace={detail} allTraces={traces} onViewTrace={setSelectedId} />
        ) : (
          <div className="trace-empty">Select a Run to inspect its trace.</div>
        )}
      </div>
    </div>
  );
}
