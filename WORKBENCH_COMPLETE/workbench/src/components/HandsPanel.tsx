'use strict';

/**
 * HandsPanel — the family's governed execution surface.
 *
 * Submit a task to the being (build = analyze→plan→council→execute→journal;
 * delegate = softer crew/brain path), approve/deny anything the executor
 * pauses on, and watch the live task/step feed over the existing SSE bus.
 */

import { useEffect, useRef, useState, useCallback } from "react";

interface ApprovalItem {
  id: string;
  status: string;
  riskLevel?: string;
  tax?: number;
  goal?: string;
  action?: { tool?: string; description?: string; args?: any };
  source?: string;
  createdAt?: number;
}

interface FeedItem {
  ts: number;
  type: string;
  [k: string]: any;
}

export function HandsPanel() {
  const [busy, setBusy] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [task, setTask] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [mode, setMode] = useState<"build" | "delegate">("build");
  const [submitMsg, setSubmitMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [st, ap, hi] = await Promise.all([
        fetch("/api/hands/status").then((r) => r.json()),
        fetch("/api/hands/approvals").then((r) => r.json()),
        fetch("/api/hands/history").then((r) => r.json()),
      ]);
      if (st.success) {
        setBusy(!!st.busy);
        setQueueLen(st.queue?.length || 0);
      }
      if (ap.success) setApprovals(ap.approvals || []);
      if (hi.success && hi.history?.length) {
        setFeed((f) => (f.length ? f : hi.history.map((h: any) => ({ ts: h.ts, type: h.type, ...h })).slice(-60)));
      }
    } catch { /* server warming */ }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    const es = new EventSource("/api/gsk/events");
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data || "{}");
        if (typeof d.type === "string" && d.type.startsWith("hands.")) {
          setFeed((f) => [...f.slice(-60), { ts: Date.now(), ...d }]);
        }
      } catch { /* ignore malformed */ }
    };
    return () => { clearInterval(iv); es.close(); };
  }, [refresh]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [feed]);

  const submit = async () => {
    if (!task.trim()) return;
    setSubmitMsg(null);
    try {
      const r = await fetch("/api/hands/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: task.trim(), projectRoot: projectRoot.trim() || undefined, mode }),
      }).then((res) => res.json());
      setSubmitMsg(r.success ? { ok: true, text: `queued: ${r.taskId}` } : { ok: false, text: r.error || "submit failed" });
      if (r.success) {
        setTask("");
        refresh();
      }
    } catch (e: any) {
      setSubmitMsg({ ok: false, text: e?.message || "submit error" });
    }
  };

  const decide = async (id: string, approve: boolean) => {
    try {
      await fetch(approve ? "/api/hands/approve" : "/api/hands/deny", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, actor: "craig", reason: "declined via hands panel" }),
      }).then((r) => r.json());
      refresh();
    } catch { /* best-effort */ }
  };

  const timeAgo = (ts?: number) => {
    if (!ts) return "";
    const s = Math.floor((Date.now() - ts) / 1000);
    return s < 5 ? "just now" : s < 120 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
  };

  return (
    <div className="mt-4 rounded-xl border border-slate-700/50 bg-slate-900/60 p-3">
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-bold tracking-wider uppercase text-emerald-300">Hands — Governed Execution</h3>
        <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border ${busy ? "text-amber-300 border-amber-500/40" : "text-emerald-400 border-emerald-500/40"}`}>
          {busy ? `executing · ${queueLen} queued` : queueLen > 0 ? `${queueLen} queued` : "idle"}
        </span>
      </div>

      {/* Task intake */}
      <div className="flex flex-col gap-2">
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder='Task the family, e.g. "Analyze the workbench repo and propose the next UI improvement"'
          className="w-full bg-slate-950/70 border border-slate-700/50 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:border-emerald-500/50 outline-none resize-none h-16"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={projectRoot}
            onChange={(e) => setProjectRoot(e.target.value)}
            placeholder="projectRoot (default: repo root)"
            className="flex-1 min-w-[220px] bg-slate-950/70 border border-slate-700/50 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:border-emerald-500/50 outline-none"
          />
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "build" | "delegate")}
            className="bg-slate-950/70 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none"
          >
            <option value="build">build (governed plan→execute)</option>
            <option value="delegate">delegate (crew/brain)</option>
          </select>
          <button
            onClick={submit}
            disabled={!task.trim() || busy}
            className="px-3 py-1.5 bg-emerald-900/30 border border-emerald-500/40 text-emerald-300 text-xs rounded-lg hover:bg-emerald-900/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Task the Family
          </button>
        </div>
        {submitMsg && (
          <span className={`text-[10px] font-mono ${submitMsg.ok ? "text-emerald-400" : "text-rose-400"}`}>{submitMsg.text}</span>
        )}
      </div>

      {/* Pending approvals */}
      {approvals.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          <h4 className="text-[10px] uppercase tracking-wider text-amber-300/80">Pending approvals ({approvals.length})</h4>
          {approvals.slice(0, 8).map((a) => (
            <div key={a.id} className="flex items-center gap-2 border border-amber-500/25 bg-amber-950/20 rounded-lg px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-mono text-amber-300 uppercase">
                  {a.source || "executor"} · {a.riskLevel || "low"} · {timeAgo(a.createdAt)}
                </div>
                <div className="text-xs text-slate-200 truncate">
                  {a.action?.tool || "plan"}: {a.action?.description || a.goal || ""}
                </div>
              </div>
              <button
                onClick={() => decide(a.id, true)}
                className="px-2.5 py-1 bg-emerald-900/30 border border-emerald-500/40 text-emerald-300 text-[10px] rounded-lg hover:bg-emerald-900/50 cursor-pointer"
              >
                Approve
              </button>
              <button
                onClick={() => decide(a.id, false)}
                className="px-2.5 py-1 bg-rose-900/30 border border-rose-500/40 text-rose-300 text-[10px] rounded-lg hover:bg-rose-900/50 cursor-pointer"
              >
                Deny
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Live feed */}
      <div className="mt-3">
        <h4 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Activity</h4>
        <div ref={feedRef} className="h-28 overflow-y-auto rounded-lg bg-slate-950/70 border border-slate-800 px-2 py-1 font-mono text-[10px] leading-relaxed">
          {feed.length === 0 && <span className="text-slate-600">No hands activity yet — submit a task above.</span>}
          {feed.map((f, i) => (
            <div key={`${f.ts}-${i}`} className="text-slate-400">
              <span className="text-slate-600">{new Date(f.ts).toLocaleTimeString()} </span>
              <span className="text-emerald-400/80">{f.type.replace(/^hands\./, "")}</span>
              {f.taskId && <span className="text-slate-600"> {String(f.taskId).slice(-12)}</span>}
              {" "}
              <span className="text-slate-300">{f.task || f.error || f.status || f.desc || f.reason || ""}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}