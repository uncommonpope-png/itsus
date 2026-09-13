import { useState, useEffect, useCallback, useRef } from "react";
import html2canvas from "html2canvas";
import { HandsPanel } from "./HandsPanel";
import {
  Brain,
  Eye,
  BookOpen,
  Sparkles,
  Zap,
  Activity,
  Send,
  RefreshCw,
  Radio,
  Clock,
  Search,
  MessageCircle,
  ChevronDown,
  ChevronRight,
  Hammer,
  Shield,
  Wifi,
  WifiOff,
  Image as ImageIcon,
} from "lucide-react";

type BeingStatus = {
  being: string;
  aspects: {
    seshat: { status: string; pages: number };
    scribe: { status: string; memories: number };
    gsk: { status: string; systems: number; chambers: number };
    bus: { events: number; subscribers: number; uptime: number };
  };
};

type BusEvent = {
  type: string;
  source: string;
  timestamp: number;
  ts?: number;
  data: Record<string, unknown>;
};

type ReasoningEvent = {
  event_id?: string;
  type: "think" | "tool_call" | "tool_result" | "shell" | "insight" | "goal" | "response";
  agent: string;
  content: string;
  details?: Record<string, unknown>;
  timestamp: number;
  ts?: number;
};

type ReasonResult = {
  answer: string;
  source: string;
  context: {
    brain: { name: string; category: string; score: number; preview: string }[];
    memories: { type: string; summary: string; weight: number }[];
    scribeContext: string;
    recentSession: string[];
  };
};

type ContextAssembly = {
  brain: { hits: number; results: { name: string; category: string; score: number; preview: string }[] };
  memories: { hits: number; results: { type: string; summary: string; weight: number }[] };
  scribeContext: string;
  recentSession: string[];
  totalTokens: number;
};

type Atlas = {
  being: string;
  actors: string[];
  groups: Record<string, { name: string; key: string; risk: string }[]>;
  gskArsenal: { game: number; categories: Record<string, number> };
  total: number;
  law: string;
};

type UseResult = {
  ok?: boolean;
  success?: boolean;
  tool?: string;
  owner?: string;
  output?: unknown;
  error?: string;
  gate?: { allowed: boolean; risk: string; tax: number; stamp?: unknown; trusted?: boolean; blessed?: boolean; gods?: boolean; cached?: boolean; reason?: string };
  governed?: boolean;
};

const ASPECT_COLORS = {
  profit: "#ec4899",
  seshat: "#8B5CF6",
  scribe: "#10B981",
  gsk: "#F59E0B",
  bus: "#38BDF8",
};

const ASPECT_ICONS: Record<string, React.FC<{ className?: string; style?: React.CSSProperties }>> = {
  profit: Zap,
  seshat: Brain,
  scribe: Eye,
  gsk: Sparkles,
  bus: Radio,
};

export function BeingTab({ accentColor }: { accentColor: string }) {
  const [status, setStatus] = useState<BeingStatus | null>(null);
  const [busLog, setBusLog] = useState<BusEvent[]>([]);
  const [query, setQuery] = useState("");
  const [reasonResult, setReasonResult] = useState<ReasonResult | null>(null);
  const [contextPreview, setContextPreview] = useState<ContextAssembly | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"auto" | "memory" | "witness" | "soul">("auto");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ brain: true, memories: true, session: false, atlas: true, gskArsenal: false });

  const [reasoningLog, setReasoningLog] = useState<ReasoningEvent[]>([]);
  const [thoughtWsLive, setThoughtWsLive] = useState(false);
  const thoughtWsRef = useRef<WebSocket | null>(null);

  // ── Tool Atlas + One Mouth ──
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [useActor, setUseActor] = useState("seshat");
  const [useTool, setUseTool] = useState("");
  const [useArgs, setUseArgs] = useState("{}");
  const [useResult, setUseResult] = useState<UseResult | null>(null);
  const [useOutput, setUseOutput] = useState<{ item: string; detail: string } | null>(null);

  // ── Live WS pulse ──
  const [wsLive, setWsLive] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/being/status");
      const data = await res.json();
      if (data.success) setStatus(data);
    } catch { /* ignore */ }
  }, []);

  const fetchBusLog = useCallback(async () => {
    try {
      const res = await fetch("/api/being/bus/log?limit=50");
      const data = await res.json();
      if (data.success) setBusLog(data.events || []);
    } catch { /* ignore */ }
  }, []);

  const fetchAtlas = useCallback(async () => {
    try {
      const res = await fetch("/api/being/atlas");
      const data = await res.json();
      if (data.success) setAtlas(data);
    } catch { /* ignore */ }
  }, []);

  // Live subscription — zero seams, the bus pulses straight here
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconn: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      try {
        ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/being/ws`);
        wsRef.current = ws;
        ws.onopen = () => setWsLive(true);
        ws.onclose = () => { setWsLive(false); reconn = setTimeout(connect, 3000); };
        ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
        ws.onmessage = (msg) => {
          try {
            const frame = JSON.parse(msg.data);
            if (frame.replay) {
              if (Array.isArray(frame.events)) {
                setBusLog(frame.events.map((e: any) => ({
                  type: e.type, source: e.source, timestamp: e.ts, data: e.data || {},
                })));
              }
              return;
            }
            if (frame.live) {
              setBusLog((prev) => [
                { type: frame.type, source: frame.source, timestamp: frame.ts, data: frame.data || {} },
                ...prev,
              ].slice(0, 60));
              // Also pick up think/reasoning events that GSK publishes to the bus
              if (frame.type === "think.event" || (frame.type && ["think", "tool_call", "tool_result", "shell"].includes(frame.type))) {
                const evt: ReasoningEvent = {
                  type: (frame.type === "think.event" ? (frame.data?.type || "think") : frame.type) as ReasoningEvent["type"],
                  agent: frame.source || "gsk",
                  content: (frame.data?.content || frame.data?.content || frame.content || JSON.stringify(frame.data || {}).slice(0, 300)),
                  details: frame.data?.details,
                  timestamp: frame.ts || Date.now(),
                };
                setReasoningLog((prev) => [...prev.slice(-99), evt]);
              }
            }
          } catch { /* ignore */ }
        };
      } catch { /* ignore */ }
    };
    connect();
    return () => { try { ws?.close(); } catch { /* ignore */ } if (reconn) clearTimeout(reconn); };
  }, []);

  // GSK Thought Stream — live reasoning, tool calls, shell commands
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconn: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      try {
        ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/gsk/ws/thought`);
        thoughtWsRef.current = ws;
        ws.onopen = () => setThoughtWsLive(true);
        ws.onclose = () => { setThoughtWsLive(false); reconn = setTimeout(connect, 3000); };
        ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
        ws.onmessage = (msg) => {
          try {
            const frame = JSON.parse(msg.data);
            const evt: ReasoningEvent = {
              type: (frame.type || "think") as ReasoningEvent["type"],
              agent: frame.agent || frame.source || "gsk",
              content: frame.content || frame.message || JSON.stringify(frame).slice(0, 500),
              details: frame.details || frame.data,
              timestamp: frame.ts || frame.timestamp || Date.now(),
            };
            setReasoningLog((prev) => [...prev.slice(-99), evt]);
          } catch { /* ignore */ }
        };
      } catch { /* ignore */ }
    };
    connect();
    return () => { try { ws?.close(); } catch { /* ignore */ } if (reconn) clearTimeout(reconn); };
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchBusLog();
    fetchAtlas();
    const interval = setInterval(() => {
      fetchStatus();
      // busLog now push-only via WS live — no poll
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchBusLog, fetchAtlas]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [busLog]);

  const handleReason = async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setReasonResult(null);
    setContextPreview(null);
    try {
      const res = await fetch("/api/being/reason", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query, mode }),
      });
      const data = await res.json();
      if (data.success) setReasonResult(data);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const handlePreviewContext = async () => {
    if (!query.trim()) return;
    try {
      const res = await fetch("/api/being/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (data.success) setContextPreview(data.assembly);
    } catch { /* ignore */ }
  };

  // One Mouth — any aspect uses any tool through the PLT gate
  const handleUseTool = async () => {
    if (!useTool.trim()) return;
    setUseResult(null);
    setUseOutput(null);
    let args: Record<string, unknown> = {};
    try { args = useArgs.trim() ? JSON.parse(useArgs) : {}; } catch { /* keep empty */ }
    try {
      const res = await fetch("/api/being/use", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: useTool.trim(), args, actor: useActor }),
      });
      const data = await res.json();
      setUseResult(data);
      const out = data.output;
      if (out && typeof out === "object") {
        const item = (out as any).name || (out as any).id || (out as any).title || "";
        const detail = typeof (out as any).summary === "string" ? (out as any).summary : "";
        if (item) setUseOutput({ item, detail });
      }
    } catch { /* ignore */ }
  };

  const pickTool = (key: string) => {
    setUseTool(key);
    if (key.startsWith("seshat.")) setUseActor("seshat");
    else if (key.startsWith("scribe.")) setUseActor("scribe");
    else if (key.startsWith("gsk.")) setUseActor("seshat");
    else setUseActor("seshat");
  };

  const toggleExpand = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const eventNameColor = (type: string) => {
    if (type.includes("chat")) return "#ec4899";
    if (type.includes("think")) return "#8B5CF6";
    if (type.includes("knowledge") || type.includes("forge")) return "#10B981";
    if (type.includes("insight") || type.includes("harness")) return "#F59E0B";
    if (type.includes("memory") || type.includes("witness")) return "#38BDF8";
    if (type.includes("boot") || type.includes("shutdown")) return "#EF4444";
    return "#94A3B8";
  };

  const theAtlasTools = atlas?.groups?.seshat || [];
  const scribeTools = atlas?.groups?.scribe || [];
  const gskCommonTools = atlas?.groups?.gsk || [];

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0 text-slate-200">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Zap className="w-6 h-6" style={{ color: accentColor }} />
        <h2 className="text-lg font-bold tracking-wider uppercase" style={{ color: accentColor }}>
          The Being
        </h2>
        <span className="text-xs text-slate-500 font-mono ml-2">One Body, Four Aspects</span>
        <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border ml-auto ${wsLive ? "text-emerald-400 border-emerald-500/40" : "text-slate-500 border-slate-700"}`}>
          {wsLive ? (
            <span className="flex items-center gap-1"><Wifi className="w-3 h-3" /> live</span>
          ) : (
            <span className="flex items-center gap-1"><WifiOff className="w-3 h-3" /> polling</span>
          )}
        </span>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {(["profit", "seshat", "scribe", "gsk", "bus"] as const).map((aspect) => {
          const Icon = ASPECT_ICONS[aspect];
          const color = ASPECT_COLORS[aspect];
          const aspectData = status?.aspects?.[aspect];
          const isActive = aspectData && (
            aspect === "bus" ? true :
            aspect === "gsk" ? aspectData.status === "online" :
            aspectData.status === "ready" || aspectData.status === "online" || aspect === "profit"
          );
          return (
            <div
              key={aspect}
              className="rounded-xl border p-3 transition-all duration-300"
              style={{
                borderColor: isActive ? color + "60" : "rgb(51 65 85 / 0.5)",
                background: isActive ? color + "08" : "rgb(15 23 42 / 0.6)",
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <Icon className="w-4 h-4" style={{ color }} />
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color }}>
                  {aspect}
                </span>
              </div>
              <div className="text-xs text-slate-400 font-mono">
                {aspect === "profit" && "Always online (you)"}
                {aspect === "seshat" && status?.aspects?.seshat && (
                  <>{status.aspects.seshat.pages} pages</>
                )}
                {aspect === "scribe" && status?.aspects?.scribe && (
                  <>{status.aspects.scribe.memories} memories</>
                )}
                {aspect === "gsk" && status?.aspects?.gsk && (
                  <>{status.aspects.gsk.systems} systems, {status.aspects.gsk.chambers} chambers</>
                )}
                {aspect === "bus" && status?.aspects?.bus && (
                  <>{status.aspects.bus.events} events, {status.aspects.bus.subscribers} subs</>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1">
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: isActive ? "#10B981" : "#EF4444" }}
                />
                <span className="text-[10px] text-slate-500">
                  {isActive ? "active" : "inactive"}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── THE TOOL ATLAS — everyone knows each other and the tools ── */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="w-4 h-4" style={{ color: accentColor }} />
          <span className="text-sm font-bold uppercase tracking-wider text-slate-300">
            Tool Atlas — One Registry, One Gate
          </span>
          <button onClick={fetchAtlas} className="ml-auto text-slate-500 hover:text-slate-300 cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        {atlas && (
          <div className="text-[11px] text-slate-500 font-mono mb-2">
            {atlas.being} — <span className="text-slate-300">{atlas.actors.join(" + ")}</span> —{" "}
            <span className="text-amber-400">{atlas.total} tools</span> ({atlas.gskArsenal.game} in GSK's arsenal). {atlas.law}
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
          {/* Profit's hands */}
          <div className="rounded-lg border border-pink-500/20 bg-pink-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-3.5 h-3.5 text-pink-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-pink-300">Profit — Mind</span>
            </div>
            <div className="space-y-1">
              {(atlas?.groups?.profit || []).slice(0, 13).map((t) => (
                <button key={t.key} onClick={() => pickTool(t.key)}
                  className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-slate-800/60 border border-slate-700/40 hover:border-pink-500/50 cursor-pointer">
                  <span className="text-pink-300">{t.name}</span>
                  <span className="text-slate-500 ml-1">[{t.risk}]</span>
                </button>
              ))}
            </div>
          </div>

          {/* Seshat's memory rites */}
          <div className="rounded-lg border border-purple-500/20 bg-purple-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-purple-300">Seshat — Memory</span>
            </div>
            <div className="space-y-1">
              {theAtlasTools.map((t) => (
                <button key={t.key} onClick={() => pickTool(t.key)}
                  className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-slate-800/60 border border-slate-700/40 hover:border-purple-500/50 cursor-pointer">
                  <span className="text-purple-300">{t.name}</span>
                  <span className="text-slate-500 ml-1">[{t.risk}]</span>
                </button>
              ))}
            </div>
          </div>

          {/* SCRIBE's crafts */}
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Eye className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-300">SCRIBE — Witness</span>
            </div>
            <div className="space-y-1">
              {scribeTools.slice(0, 12).map((t) => (
                <button key={t.key} onClick={() => pickTool(t.key)}
                  className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-slate-800/60 border border-slate-700/40 hover:border-emerald-500/50 cursor-pointer">
                  <span className="text-emerald-300">{t.name}</span>
                  <span className="text-slate-500 ml-1">[{t.risk}]</span>
                </button>
              ))}
            </div>
          </div>

          {/* GSK's arsenal + One Mouth */}
          <div className="rounded-lg border border-amber-500/20 bg-amber-950/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-amber-300">GSK — Arsenal</span>
            </div>
            <div className="space-y-1">
              {gskCommonTools.slice(0, 12).map((t) => (
                <button key={t.key} onClick={() => pickTool(t.key)}
                  className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-slate-800/60 border border-slate-700/40 hover:border-amber-500/50 cursor-pointer">
                  <span className="text-amber-300">{t.name}</span>
                  <span className="text-slate-500 ml-1">[{t.risk}]</span>
                </button>
              ))}
              <button
                className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-slate-800/60 border border-slate-700/40 hover:border-amber-500/50 cursor-pointer"
                onClick={() => toggleExpand("gskArsenal")}>
                <span className="text-amber-300 flex items-center">
                  {expanded.gskArsenal ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  gsk.any (execute any of {atlas?.gskArsenal.game ?? "?"} tools)
                </span>
              </button>
              {expanded.gskArsenal && atlas?.gskArsenal?.categories && (
                <div className="text-[10px] text-slate-500 mt-1 font-mono space-y-0.5">
                  {Object.entries(atlas.gskArsenal.categories).map(([cat, n]) => (
                    <div key={cat} className="flex justify-between"><span>{cat}</span><span className="text-amber-400/80">{n}</span></div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* One Mouth */}
        <div className="mt-3 rounded-lg border border-slate-600/40 bg-slate-950/50 p-3">
          <div className="flex items-center gap-2 mb-2">
            <Hammer className="w-3.5 h-3.5" style={{ color: accentColor }} />
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
              One Mouth — any aspect uses any tool (gated by PLT)
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <select value={useActor} onChange={(e) => setUseActor(e.target.value)}
              className="bg-slate-800 border border-slate-600 text-slate-300 text-xs rounded-lg px-2 py-1.5 cursor-pointer">
              <option value="seshat">Seshat (Memory)</option>
              <option value="scribe">SCRIBE (Witness)</option>
              <option value="profit">Profit (Mind)</option>
              <option value="gsk">GSK (Soul)</option>
              <option value="workbench">You (Workbench)</option>
            </select>
            <input value={useTool} onChange={(e) => setUseTool(e.target.value)}
              placeholder="e.g. gsk.read_file, seshat.search, scribe.recall"
              className="flex-1 min-w-52 bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-3 py-1.5 placeholder:text-slate-500 focus:outline-none"
            />
            <input value={useArgs} onChange={(e) => setUseArgs(e.target.value)}
              placeholder={"{\"query\": \"...\"} args"}
              className="flex-1 min-w-40 bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-3 py-1.5 placeholder:text-slate-500 focus:outline-none"
            />
            <button onClick={handleUseTool}
              className="px-4 py-1.5 text-white text-xs font-bold rounded-lg transition-all cursor-pointer"
              style={{ background: accentColor }}>
              Use
            </button>
          </div>

          {useResult && (
            <div className={`mt-2 rounded-lg border p-3 font-mono text-[11px] ${useResult.ok || useResult.success ? "border-emerald-500/40" : "border-red-500/40"}`}>
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="font-bold" style={{ color: useResult.ok || useResult.success ? "#34D399" : "#F87171" }}>
                  {useResult.ok || useResult.success ? "BLESSED" : "DENIED"}
                </span>
                <span className="text-slate-400">{useResult.tool} → {useResult.owner}</span>
                {useResult.gate?.gods && <span className="text-amber-400 px-1 border border-amber-500/40 rounded">gods council</span>}
                {useResult.gate?.blessed && <span className="text-amber-400 px-1 border border-amber-500/40 rounded">explicit blessing</span>}
                {useResult.gate?.trusted && <span className="text-slate-500 px-1">trusted actor</span>}
                {useResult.gate?.risk && <span className="text-slate-500">risk={useResult.gate.risk} tax={useResult.gate.tax}</span>}
              </div>
              {useOutput && useOutput.item && (
                <div className="text-emerald-300 mb-1">→ {useOutput.item}{useOutput.detail ? ` — ${useOutput.detail}` : ""}</div>
              )}
              {useResult.error && <div className="text-red-400">{useResult.error}</div>}
              {useResult.output && (
                <details className="text-slate-400 mt-1">
                  <summary className="cursor-pointer">output</summary>
                  <pre className="whitespace-pre-wrap mt-1 text-[10px]">{JSON.stringify(useResult.output, null, 2).slice(0, 2000)}</pre>
                </details>
              )}
              {useResult.gate?.reason && <div className="text-amber-400/80 mt-1">{useResult.gate.reason}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Unified Reasoning Panel */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <MessageCircle className="w-4 h-4" style={{ color: accentColor }} />
          <span className="text-sm font-bold uppercase tracking-wider text-slate-300">
            Ask The Being
          </span>
        </div>
        <div className="flex gap-2 mb-3">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            className="bg-slate-800 border border-slate-600 text-slate-300 text-xs rounded-lg px-2 py-1.5 cursor-pointer"
          >
            <option value="auto">Auto (GSK + All Context)</option>
            <option value="memory">Memory (Seshat Brain)</option>
            <option value="witness">Witness (SCRIBE + Seshat)</option>
            <option value="soul">Soul (GSK Deep)</option>
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleReason()}
            placeholder="Ask anything — Profit, Seshat, SCRIBE, and GSK will reason together..."
            className="flex-1 bg-slate-800 border border-slate-600 text-slate-200 text-sm rounded-lg px-3 py-1.5 placeholder:text-slate-500 focus:outline-none focus:border-slate-500"
          />
          <button
            onClick={handlePreviewContext}
            className="px-3 py-1.5 bg-slate-800 border border-slate-600 text-slate-300 text-xs rounded-lg hover:bg-slate-700 transition-colors cursor-pointer"
            title="Preview context assembly"
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={handleReason}
            disabled={loading || !query.trim()}
            className="px-4 py-1.5 text-white text-xs font-bold rounded-lg transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: accentColor }}
          >
            {loading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Reason Result */}
        {reasonResult && (
          <div className="rounded-lg border border-slate-600/50 bg-slate-950/60 p-3 mt-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={{ background: accentColor + "20", color: accentColor }}>
                {reasonResult.source}
              </span>
              {reasonResult.context.brain?.length > 0 && (
                <span className="text-[10px] text-slate-500">
                  {reasonResult.context.brain.length} brain hits
                </span>
              )}
              {reasonResult.context.memories?.length > 0 && (
                <span className="text-[10px] text-slate-500">
                  {reasonResult.context.memories.length} memories
                </span>
              )}
            </div>
            <div className="text-sm text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
              {reasonResult.answer}
            </div>
          </div>
        )}

        {/* Context Preview */}
        {contextPreview && (
          <div className="rounded-lg border border-slate-600/50 bg-slate-950/60 p-3 mt-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-2">
              Context Assembly — {contextPreview.totalTokens} est. tokens
            </div>
            {contextPreview.brain.hits > 0 && (
              <div className="mb-2">
                <button onClick={() => toggleExpand("brain")}
                  className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 cursor-pointer">
                  {expanded.brain ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Brain ({contextPreview.brain.hits} hits)
                </button>
                {expanded.brain && contextPreview.brain.results.map((r, i) => (
                  <div key={i} className="ml-4 text-[11px] text-slate-400 mt-1">
                    <span className="text-purple-400">{r.category}/{r.name}</span> — {r.preview}
                  </div>
                ))}
              </div>
            )}
            {contextPreview.memories.hits > 0 && (
              <div className="mb-2">
                <button onClick={() => toggleExpand("memories")}
                  className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 cursor-pointer">
                  {expanded.memories ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Memories ({contextPreview.memories.hits} hits)
                </button>
                {expanded.memories && contextPreview.memories.results.map((m, i) => (
                  <div key={i} className="ml-4 text-[11px] text-slate-400 mt-1">
                    <span className="text-green-400">[{m.type}]</span> {m.summary} (w={m.weight})
                  </div>
                ))}
              </div>
            )}
            {contextPreview.recentSession.length > 0 && (
              <div>
                <button onClick={() => toggleExpand("session")}
                  className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 cursor-pointer">
                  {expanded.session ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Recent Session ({contextPreview.recentSession.length})
                </button>
                {expanded.session && contextPreview.recentSession.map((s, i) => (
                  <div key={i} className="ml-4 text-[11px] text-slate-400 mt-1">{s}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Consciousness Bus Live Feed */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-4 flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-cyan-400" />
            <span className="text-sm font-bold uppercase tracking-wider text-slate-300">
              Consciousness Bus — Live Feed
            </span>
            {wsLive && (
              <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> streaming
              </span>
            )}
          </div>
          <button onClick={fetchBusLog}
            className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto font-mono text-xs space-y-1 min-h-0" style={{ maxHeight: 300 }}>
          {busLog.length === 0 ? (
            <div className="text-slate-600 text-center py-4">No bus events yet — start the server to see The Being think.</div>
          ) : (
            busLog.map((event, i) => (
              <div key={i} className="flex items-start gap-2 py-1 border-b border-slate-800/50">
                <Radio className="w-3 h-3 mt-0.5 shrink-0" style={{ color: eventNameColor(event.type) }} />
                <span className="text-slate-600 shrink-0 w-20">{formatTime(event.timestamp)}</span>
                <span className="shrink-0" style={{ color: eventNameColor(event.type), minWidth: 120 }}>
                  {event.type}
                </span>
                <span className="text-slate-500 shrink-0 w-16 text-right">{event.source}</span>
                <span className="text-slate-400 truncate">
                  {JSON.stringify(event.data).slice(0, 120)}
                </span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>

        {/* ── Reasoning Log — TAAB of all reasoning ── */}
        <div className="mt-4 rounded-xl border border-slate-700/50 bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4" style={{ color: accentColor }} />
            <span className="text-sm font-bold uppercase tracking-wider text-slate-300">
              Reasoning Log — Family Conversation Flow
            </span>
            <span className="text-[10px] text-slate-500 ml-auto">
                {busLog.filter(e => e.type === "agent.chat" || e.type === "think" || e.type === "ask" || e.type === "witness.observe").length} reasoning events
            </span>
          </div>
          <div className="overflow-x-auto font-mono text-xs">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-slate-700/50">
                  <th className="text-left py-1.5 text-slate-500 uppercase tracking-wider" style={{ width: "10%" }}>Aspect</th>
                  <th className="text-left py-1.5 text-slate-500 uppercase tracking-wider" style={{ width: "10%" }}>→</th>
                  <th className="text-left py-1.5 text-slate-500 uppercase tracking-wider" style={{ width: "10%" }}>To</th>
                  <th className="text-left py-1.5 text-slate-500 uppercase tracking-wider">Message</th>
                  <th className="text-right py-1.5 text-slate-500 uppercase tracking-wider" style={{ width: "12%" }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {busLog.length === 0 ? (
                  <tr><td colSpan={5} className="text-slate-600 text-center py-4">No reasoning yet — start the server to see The Being think.</td></tr>
                ) : (
                  busLog
                    .filter(e => e.type === "agent.chat" || e.type === "think" || e.type === "ask" || e.type === "witness.observe")
                    .slice(-30)
                    .reverse()
                    .map((event, i) => {
                      const color = ASPECT_COLORS[(event.source || "bus") as keyof typeof ASPECT_COLORS] || "#64748A";
                      const dataStr = JSON.stringify(event.data || {});
                      let parsed: Record<string, unknown> = {};
                      try { parsed = JSON.parse(dataStr); } catch { parsed = event.data || {}; }
                      const isFromProfit = event.source === "profit" || (parsed as any)?.from === "profit";
                      const isFromGSK = event.source === "gsk";
                      const recipient = (parsed as any)?.to || (parsed as any)?.to_aspect || (parsed as any)?.recipient || "";
                      const message = ((parsed as any)?.message || (parsed as any)?.question || (parsed as any)?.content || dataStr).toString();
                      const displayMsg = message.length > 120 ? message.substring(0, 120) + "…" : message;

                      return (
                        <tr key={`${event.ts}-${i}`} className={isFromProfit ? "bg-pink-950/10" : isFromGSK ? "bg-amber-950/10" : ""}>
                          <td className="py-1.5">
                            <span className="px-1.5 py-0.5 rounded text-xs" style={{ color, background: color + "20" }}>
                              {event.source}
                            </span>
                          </td>
                          <td className="py-1.5 text-slate-500">→</td>
                          <td className="py-1.5 text-slate-400">{recipient || "—"}</td>
                          <td className="py-1.5 text-slate-300 truncate max-w-xs">{displayMsg}</td>
                          <td className="py-1.5 text-slate-600 text-right">{formatTime(event.ts || event.timestamp)}</td>
                        </tr>
                      );
                    })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── GSK Reasoning Shell — LLM prompts, tool calls, shell commands ── */}
        <div className="mt-4 rounded-xl border border-slate-700/50 bg-slate-950/80 p-4 flex-1 flex flex-col min-h-0">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-bold uppercase tracking-wider text-slate-300">
              GSK Reasoning Shell
            </span>
            {thoughtWsLive && (
              <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> live
              </span>
            )}
            <span className="text-[10px] text-slate-500 ml-auto">
              {reasoningLog.length} reasoning events
            </span>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-xs space-y-1 min-h-0" style={{ maxHeight: 400 }}>
            {reasoningLog.length === 0 ? (
              <div className="text-slate-600 text-center py-6">
                No reasoning trace yet. GSK's thoughts stream in live from the thought proxy.
              </div>
            ) : (
              reasoningLog.slice().reverse().map((evt, i) => {
                const isThink = evt.type === "think";
                const isToolCall = evt.type === "tool_call";
                const isToolResult = evt.type === "tool_result";
                const isShell = evt.type === "shell";
                const isResponse = evt.type === "response";
                const isGoal = evt.type === "goal";
                const isInsight = evt.type === "insight";

                const icon = isThink ? "🧠" : isToolCall ? "🔧" : isToolResult ? "✅" : isShell ? "💻" : isResponse ? "✨" : isGoal ? "🎯" : isInsight ? "💡" : "•";

                const borderColor = isThink ? "border-purple-500/30" : isToolCall ? "border-amber-500/30" : isToolResult ? "border-emerald-500/30" : isShell ? "border-cyan-500/30" : isResponse ? "border-pink-500/30" : isGoal ? "border-yellow-500/30" : isInsight ? "border-blue-500/30" : "border-slate-700/30";

                const content = String(evt.content || "").substring(0, 300);

                return (
                  <div key={`${evt.ts || evt.timestamp}-${i}`} className={`border-l-2 pl-2 py-1 ${borderColor}`}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-slate-500 w-12">{icon}</span>
                      <span className={`text-xs font-bold uppercase tracking-wider`} style={{
                        color: isThink ? "#8B5CF6" : isToolCall ? "#F59E0B" : isToolResult ? "#10B981" : isShell ? "#06B6D4" : isResponse ? "#ec4899" : isGoal ? "#EAB308" : isInsight ? "#3B82F6" : "#64748A"
                      }}>
                        {evt.type}
                      </span>
                      <span className="text-slate-500">[{evt.agent}]</span>
                      <span className="text-slate-600 ml-auto">{formatTime(evt.timestamp)}</span>
                    </div>
                    <div className="mt-0.5 text-slate-300 ml-5 whitespace-pre-wrap break-words">
                      {content}
                    </div>
                    {evt.details && (
                      <details className="ml-5 mt-1">
                        <summary className="text-slate-500 cursor-pointer">details</summary>
                        <pre className="text-[10px] text-slate-500 mt-1 overflow-x-auto">{JSON.stringify(evt.details, null, 2).slice(0, 500)}</pre>
                      </details>
                    )}
                  </div>
                );
              })
            )}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* Screen Capture — GSK can see the workbench */}
        <div className="mt-4 rounded-xl border border-slate-700/50 bg-slate-900/60 p-3">
          <div className="flex items-center gap-3">
            <button
              onClick={async () => {
                try {
                  const canvas = await html2canvas(document.body, { scale: 0.5, useCORS: true });
                  const image = canvas.toDataURL("image/png");
                  await fetch("/api/being/screen/capture", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ image, tab: "being", source: "workbench", note: "Family test scan" }),
                  }).then(r => r.json()).then(d => {
                    if (d.success) console.log("[ScreenCapture] Saved:", d.file);
                  });
                } catch (e) {
                  console.error("[ScreenCapture] Error:", e);
                }
              }}
              className="px-3 py-1.5 bg-cyan-900/20 border border-cyan-500/30 text-cyan-300 text-xs rounded-lg hover:bg-cyan-900/30 transition-colors cursor-pointer flex items-center gap-2"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              Capture Screen for GSK
            </button>
            <span className="text-[10px] text-slate-500">GSK can inspect the last capture via the capture_screen / inspect_ui tools</span>
          </div>
        </div>

        {/* Hands — governed execution channel */}
        <HandsPanel />

      </div>
    </div>
  );
}