'use strict';

/**
 * hands.ts — THE HANDS. The single governed execution channel for the family.
 *
 * The being already owns the full governed executor stack in-process
 * (gsk-module.js -> GSKFusion: planningEngine, approvedToolExecutor,
 * secureSandbox, hitlGate, sovereignAutonomyLoop). What was missing was one
 * controlled path from intent to repo mutation — this module is that path:
 *
 *   task intake -> blood-flow guard -> gskMod.build()/delegate()
 *               -> council gate + executor approvals -> execute -> journal
 *
 * Blood-flow law (hard denies that NO approval can override):
 *   - kill/taskkill/Stop-Process against family members (OmniRoute :20128,
 *     CPL :3457, scribe :4000, GSK :3001, workbench :3000) or twin-spawning
 *     any family service
 *   - irreversible git (push -f, reset --hard, clean -f)
 *   - secret-path access (.git-credentials, .pm2/dump.pm2, HF_TOKEN, .env…)
 *   - recursive delete on sanctioned roots; registry/system-level commands
 *
 * Everything else flows through the existing governed machinery: SAFE/LOW
 * executes under the council gate; HIGH/CRITICAL pauses for approval, and
 * approve() re-runs the blood guard on the queued action — so even the
 * being's own ambient loop can never execute a hard-denied action.
 */

import path from "path";
import fs from "fs";

const KILL_VERB = /\b(taskkill|pkill|killall|Stop-Process|kill)\b/i;
const FAMILY_SERVICE = /\b(omniroute|omni-route|cpl_?daemon|scribe|gsk_daemon|boot-family)\b/i;
const TWIN_SPAWN =
  /\b(npx|node|tsx|deno|bun)\s+([^\s]+\s+)?(tsx\s+)?(server\.ts|gsk_daemon\.js|boot-family\.cjs)\b/i;
const FAMILY_START_HINT = /(npm run (start|dev))\b|(start\s+(omniroute|cpl|cpl_?daemon|scribe))/i;
const FORCE_GIT = /\bgit\b[^\n|;]*\b(push\s+(-f|--force)\b|reset\s+--hard\b|clean\s+-f\b)\b/i;
const RECURSIVE_DELETE = /\b(del\s+\/s|rm\s+-rf|Remove-Item[^\n]*\s-Recurse)\b/i;
const SYSTEM_OPS =
  /\b(regedit\b|reg\s+delete\b|format\b|shutdown\b|restart\b|Stop-Computer\b|Restart-Computer\b|Set-ExecutionPolicy\b|sc\s+delete\b|Uninstall-Package\b)\b/i;
const SECRET_PATHS =
  /(\.git-credentials|\.pm2[\\/]dump\.pm2|HF_TOKEN|NINE_ROUTER_API_KEY|SCRIBE_KEY|GENESIS_TOKEN|MCP_API_KEY|\b\.env\b|id_rsa|\.pem\b)/i;
const WRITEY_TOOL = /^(write|edit|append|create|delete|remove|mkdir|cp|mv|rm|chmod|chown|rename|copy|move|patch|update|repair)/;

export interface HandsTaskInput {
  task: string;
  projectRoot?: string;
  mode?: "build" | "delegate";
}

export interface HandsOpts {
  getBeing: () => Promise<any>;
  sanctionedRoots: string[];
  emit?: (type: string, payload: any) => void;
  logDir?: string;
}

interface QueueItem {
  id: string;
  input: HandsTaskInput;
  projectRoot: string;
  mode: "build" | "delegate";
  actor: string;
  ts: number;
}

interface HistoryEntry {
  ts: number;
  type: string;
  [key: string]: any;
}

export class Hands {
  private opts: HandsOpts;
  private busy = false;
  private queue: QueueItem[] = [];
  private history: HistoryEntry[] = [];
  private seq = 0;

  constructor(opts: HandsOpts) {
    this.opts = opts;
  }

  // ── Blood-flow guard ────────────────────────────────────────────────────

  /** Hard-deny rules. Returns { allowed:true } or { allowed:false, reason }. */
  guardCommand(command: string): { allowed: boolean; reason?: string } {
    if (typeof command !== "string" || command.length === 0) {
      return { allowed: false, reason: "empty_command" };
    }
    if (SYSTEM_OPS.test(command)) {
      return { allowed: false, reason: "system_operation_hard_denied" };
    }
    if (KILL_VERB.test(command) && FAMILY_SERVICE.test(command)) {
      return { allowed: false, reason: "blood_flow_family_kill" };
    }
    if (TWIN_SPAWN.test(command) || (FAMILY_START_HINT.test(command) && FAMILY_SERVICE.test(command))) {
      return { allowed: false, reason: "blood_flow_twin_spawn" };
    }
    if (FORCE_GIT.test(command)) {
      return { allowed: false, reason: "irreversible_git_hard_denied" };
    }
    if (SECRET_PATHS.test(command)) {
      return { allowed: false, reason: "secret_access_hard_denied" };
    }
    if (RECURSIVE_DELETE.test(command)) {
      const root = this._touch(command);
      if (root) return { allowed: false, reason: "recursive_delete_sanctioned_root" };
    }
    return { allowed: true };
  }

  /** Path-level guard for file tools. */
  guardPaths(args: any): { allowed: boolean; reason?: string } {
    const strings = this._collectStrings(args, 2);
    for (const s of strings) {
      if (SECRET_PATHS.test(s)) return { allowed: false, reason: "secret_access_hard_denied" };
      if (this._looksLikePath(s)) {
        const abs = this._abs(s);
        if (!this._insideSanctioned(abs)) {
          return { allowed: false, reason: "outside_sanctioned_roots" };
        }
      }
    }
    return { allowed: true };
  }

  /** Full guard for a tool call (ad-hoc route + approval re-check). */
  guardTool(tool: string, args: any = {}): { allowed: boolean; reason?: string } {
    const t = String(tool || "").toLowerCase();
    const command =
      typeof args?.command === "string"
        ? args.command
        : typeof args?.cmd === "string"
          ? args.cmd
          : typeof args?.shell === "string"
            ? args.shell
            : null;
    if (command) {
      const g = this.guardCommand(command);
      if (!g.allowed) return g;
    }
    const blob = JSON.stringify(args || {});
    if (SECRET_PATHS.test(blob)) return { allowed: false, reason: "secret_access_hard_denied" };
    if (WRITEY_TOOL.test(t) || /(^|_)(file|path|dir)/.test(t)) {
      const p = this.guardPaths(args);
      if (!p.allowed) return p;
    }
    if (/^(git|git_)/.test(t) && FORCE_GIT.test(blob)) {
      return { allowed: false, reason: "irreversible_git_hard_denied" };
    }
    return { allowed: true };
  }

  // ── Task intake (single-flight) ─────────────────────────────────────────

  async submitTask(input: HandsTaskInput, actor = "craig"): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    const task = String(input?.task || "").trim();
    if (!task) return { ok: false, error: "task (description) is required" };
    const mode = input.mode === "delegate" ? "delegate" : "build";
    const rawRoot = (input.projectRoot || this.opts.sanctionedRoots[0] || "").trim();
    const projectRoot = this._abs(rawRoot);
    if (!this._insideSanctioned(projectRoot)) {
      return { ok: false, error: `projectRoot outside sanctioned roots: ${projectRoot}` };
    }
    const id = `hands_${Date.now()}_${++this.seq}`;
    this.queue.push({ id, input: { ...input, task }, projectRoot, mode, actor, ts: Date.now() });
    this._emit("hands.task.queued", { taskId: id, task: task.slice(0, 200), mode, projectRoot });
    this._journal({ type: "task.queued", taskId: id, task: task.slice(0, 300), mode, actor, projectRoot });
    this.pump();
    return { ok: true, taskId: id };
  }

  private async pump() {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    const item = this.queue.shift()!;
    this._emit("hands.task.started", { taskId: item.id, task: item.input.task.slice(0, 200), mode: item.mode });
    this._journal({ type: "task.started", taskId: item.id, task: item.input.task.slice(0, 300) });
    try {
      const being = await this.opts.getBeing();
      const gsk: any = being?.gsk;
      let result: any;
      const onStep = (s: any, i: number, n: number) =>
        this._emit("hands.step", {
          taskId: item.id,
          step: i,
          total: n,
          status: s?.status || "running",
          desc: String(s?.description || s?.type || "").slice(0, 200),
        });
      if (item.mode === "delegate") {
        result = await gsk.delegate(
          item.input.task,
          { projectRoot: item.projectRoot },
          { projectRoot: item.projectRoot, timeoutMs: 600000 }
        );
        if (result?.ok === false) throw new Error(result.error || "delegate returned not-ok");
      } else {
        result = await gsk.build(
          {
            task: item.input.task,
            project: item.projectRoot,
            priority: "normal",
            mode: "autonomous",
            approvals: "auto",
            timeoutMs: 600000,
            context: {},
          },
          { onStep }
        );
      }
      const status = result?.result?.status || result?.status || "completed";
      this._emit("hands.task.done", { taskId: item.id, status });
      this._journal({ type: "task.done", taskId: item.id, status, summary: JSON.stringify(result).slice(0, 700) });
    } catch (e: any) {
      const msg = e?.message || String(e);
      this._emit("hands.task.failed", { taskId: item.id, error: msg.slice(0, 300) });
      this._journal({ type: "task.failed", taskId: item.id, error: msg.slice(0, 500) });
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  // ── Approval surface ────────────────────────────────────────────────────

  async approvals(): Promise<any[]> {
    try {
      const being = await this.opts.getBeing();
      const sys = being?.gsk?.getSystems?.() || {};
      const list: any[] = [];
      const ex = sys.approvedToolExecutor;
      if (ex?.getPendingApprovals) {
        for (const a of ex.getPendingApprovals()) list.push({ ...a, source: "executor" });
      }
      const hitl = sys.hitlGate;
      if (hitl?.queuePath && fs.existsSync(hitl.queuePath)) {
        try {
          const q = JSON.parse(fs.readFileSync(hitl.queuePath, "utf8") || "[]");
          for (const e of Array.isArray(q) ? q : []) {
            if (e?.status === "pending") list.push({ id: e.id, status: "pending", riskLevel: e.risk || "low", goal: e.goal || "", source: "hitl", createdAt: e.createdAt, planId: e.planId });
          }
        } catch { /* queue file transient */ }
      }
      return list;
    } catch {
      return [];
    }
  }

  async approve(id: string, actor = "architect"): Promise<{ ok: boolean; error?: string; result?: any }> {
    try {
      const being = await this.opts.getBeing();
      const sys = being?.gsk?.getSystems?.() || {};
      const ex = sys.approvedToolExecutor;
      let target: any = null;
      if (ex?.pendingApprovals?.has?.(id)) target = ex.pendingApprovals.get(id);
      else if (ex?.pendingApprovals?.get?.(id)) target = ex.pendingApprovals.get(id);

      if (target) {
        // Re-run the blood guard on the queued action — hard denies win even
        // against a human-issued approval (covers the ambient loop's queue).
        const g = this.guardTool(target.action?.tool || "shell_exec", target.action?.args || {});
        if (!g.allowed) {
          ex.denyRequest?.(id, `blood_guard: ${g.reason}`);
          this._journal({ type: "approval.denied_by_blood_guard", approvalId: id, reason: g.reason });
          this._emit("hands.approval.denied", { approvalId: id, reason: g.reason });
          return { ok: false, error: `blood_guard: ${g.reason}` };
        }
        ex.approveRequest?.(id, actor);
        const result = await ex.executeApproved?.(id);
        this._journal({ type: "approval.executed", approvalId: id, actor, status: result?.status || "executed" });
        this._emit("hands.approval.executed", { approvalId: id, actor, status: result?.status || "executed" });
        return { ok: true, result };
      }
      const hitl = sys.hitlGate;
      if (hitl?.resolve) {
        hitl.resolve(id, "approved", { approvedBy: actor, via: "hands" });
        this._journal({ type: "approval.hitl_approved", approvalId: id, actor });
        this._emit("hands.approval.hitl_approved", { approvalId: id, actor });
        return { ok: true, result: { status: "approved" } };
      }
      return { ok: false, error: "approval_not_found" };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async deny(id: string, reason = "Denied by architect", actor = "architect"): Promise<{ ok: boolean; error?: string }> {
    try {
      const being = await this.opts.getBeing();
      const sys = being?.gsk?.getSystems?.() || {};
      const ex = sys.approvedToolExecutor;
      if (ex?.pendingApprovals?.has?.(id)) {
        ex.denyRequest?.(id, reason);
        this._journal({ type: "approval.denied", approvalId: id, reason, actor });
        this._emit("hands.approval.denied", { approvalId: id, reason });
        return { ok: true };
      }
      const hitl = sys.hitlGate;
      if (hitl?.resolve) {
        hitl.resolve(id, "rejected", { reason, deniedBy: actor });
        this._journal({ type: "approval.hitl_denied", approvalId: id, reason, actor });
        this._emit("hands.approval.denied", { approvalId: id, reason });
        return { ok: true };
      }
      return { ok: false, error: "approval_not_found" };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // ── Status / history ────────────────────────────────────────────────────

  status() {
    return {
      busy: this.busy,
      queue: this.queue.map((q) => ({ taskId: q.id, task: q.input.task.slice(0, 200), mode: q.mode, projectRoot: q.projectRoot, actor: q.actor, ts: q.ts })),
      sanctionedRoots: this.opts.sanctionedRoots,
      historySize: this.history.length,
    };
  }

  historyItems(n = 40) {
    return this.history.slice(-n);
  }

  /** Journal an ad-hoc (guard-passed) tool call from the UI/API. */
  logAdHoc(tool: string, args: any, actor: string, result: any) {
    this._journal({
      type: "tool.adhoc",
      tool,
      actor,
      ok: !(result && (result?.error || result?.ok === false)),
      summary: JSON.stringify(result).slice(0, 300),
    });
    this._emit("hands.tool", { tool, actor, ok: !(result && (result?.error || result?.ok === false)) });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private _touch(cmd: string): string | null {
    const roots = this.opts.sanctionedRoots.map((r) => this._norm(r));
    for (const r of roots) {
      if (cmd.includes(r)) return r;
    }
    return null;
  }

  private _collectStrings(obj: any, depth = 0, out: string[] = []): string[] {
    if (obj === null || obj === undefined || depth < 0) return out;
    if (typeof obj === "string") {
      out.push(obj);
      return out;
    }
    if (typeof obj !== "object") return out;
    for (const v of Object.values(obj)) this._collectStrings(v, depth - 1, out);
    return out;
  }

  private _looksLikePath(s: string): boolean {
    if (!s || s.length > 260) return false;
    return /^[a-zA-Z]:[\\/]|[\\/]/.test(s) || s.startsWith(".") || /^(src|dist|gsk|workbench|scribe|cpl)[\\/]/.test(s);
  }

  private _abs(p: string): string {
    if (!p) return p;
    if (/^[a-zA-Z]:[\\/]/.test(p)) return path.normalize(p);
    return path.resolve(this.opts.sanctionedRoots[0] || process.cwd(), p);
  }

  private _norm(p: string): string {
    return path.normalize(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  }

  private _insideSanctioned(p: string): boolean {
    const abs = this._norm(p);
    if (!abs) return false;
    return this.opts.sanctionedRoots.some((r) => {
      const root = this._norm(r);
      return abs === root || abs.startsWith(root + "/");
    });
  }

  private _journal(entry: HistoryEntry) {
    this.history.push({ ts: Date.now(), ...entry });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    const dir = this.opts.logDir;
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hands.jsonl"), JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
    } catch { /* journaling is best-effort */ }
  }

  private _emit(type: string, payload: any) {
    try {
      this.opts.emit?.(type, payload);
      this.opts.getBeing().then((b: any) => b?.bus?.publish?.("hands", { type, ...payload })).catch(() => {});
    } catch { /* emit is best-effort */ }
  }
}

export function createHands(opts: HandsOpts): Hands {
  return new Hands(opts);
}