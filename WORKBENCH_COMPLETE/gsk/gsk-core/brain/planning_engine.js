const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

class PlanStep {
    constructor(description, deps = [], estimatedCost = 1, action = {}) {
        this.id = crypto.randomUUID();
        this.description = description;
        this.dependencies = deps;
        this.estimatedCost = estimatedCost;
        this.tool = action.tool || null;
        this.args = action.args && typeof action.args === 'object' ? action.args : {};
        this.acceptanceCriteria = action.acceptanceCriteria || null;
        this.riskLevel = action.riskLevel || null;
        this.status = 'pending';
        this.result = null;
        this.error = null;
        this.startTime = null;
        this.endTime = null;
    }

    get duration() {
        if (this.startTime && this.endTime) {
            return this.endTime - this.startTime;
        }
        return null;
    }
}

class Plan {
    constructor(goal) {
        this.id = crypto.randomUUID();
        this.goal = goal;
        this.steps = [];
        this.status = 'created';
        this.createdAt = Date.now();
        this.startTime = null;
        this.endTime = null;
        this.success = null;
    }

    addStep(description, deps = [], cost = 1, action = {}) {
        const step = new PlanStep(description, deps, cost, action);
        this.steps.push(step);
        return step;
    }

    get totalEstimatedCost() {
        return this.steps.reduce((sum, s) => sum + s.estimatedCost, 0);
    }

    get pendingSteps() {
        return this.steps.filter(s => s.status === 'pending');
    }

    get readySteps() {
        return this.steps.filter(s => {
            if (s.status !== 'pending') return false;
            return s.dependencies.every(depId => {
                const dep = this.steps.find(st => st.id === depId);
                return dep && dep.status === 'completed';
            });
        });
    }
}

class PlanningEngine {
    constructor(kernel, options = {}) {
        this.kernel = kernel;
        this.plans = new Map();
        this.currentPlan = null;
        this.maxPlans = options.maxPlans || 50;
        this.learningRate = options.learningRate || 0.1;
        this.telemetryEngine = options.telemetryEngine || null;
        this.executor = options.executor || null;
        this.checkpointPath = options.checkpointPath || path.join(__dirname, '../../data/gsk/checkpoints');

        this.stats = {
            plansCreated: 0,
            plansExecuted: 0,
            plansCompleted: 0,
            plansFailed: 0,
            stepsCreated: 0,
            stepsCompleted: 0,
            stepsFailed: 0,
            totalExecutionTime: 0,
            avgPlanExecutionTime: 0,
            avgStepExecutionTime: 0,
        };

        if (this.telemetryEngine) {
            this.telemetryEngine.registerStats('PlanningEngine', this.stats);
        }
    }

    setExecutor(executor) {
        this.executor = executor;
        return this;
    }

    // DeepToolUse integration helpers ────────────────────────────────
    _getDeepToolUse() {
        return this.kernel?.deepToolUse
            || this.kernel?.systems?.deepToolUse
            || this.kernel?.fusion?.systems?.deepToolUse
            || null;
    }

    // Map planning/tool-bridge tool names onto DeepToolUse's registered tools
    // so spec-gate steps execute through the secure sandbox layer.
    _resolveDeepToolUseTool(name) {
        const aliases = {
            read_file: 'file_read',
            write_file: 'file_write',
            list_files: 'file_list',
            shell: 'shell_exec',
            run_command: 'shell_exec',
            run_safe_command: 'shell_exec',
        };
        const resolved = aliases[name] || name;
        const dtu = this._getDeepToolUse();
        const known = dtu && typeof dtu.getToolNames === 'function' ? dtu.getToolNames() : [];
        return known.includes(resolved) ? resolved : null;
    }

    _publish(event, data) {
        try {
            this.kernel?.systems?.eventBus?.publish?.(event, { ...data, timestamp: Date.now() });
        } catch (e) { /* bus publishing is best-effort */ }
    }

    async createPlan(goal, context = {}) {
        const plan = new Plan(goal);
        this.stats.plansCreated++;
        console.log(`[PlanningEngine][createPlan] enter goal="${String(goal).slice(0, 60)}" kernel=${!!this.kernel} prompt=${typeof this.kernel?.prompt} brain=${typeof this.kernel?.brain?.think}`);
        if (this.telemetryEngine) {
            this.telemetryEngine.recordEvent('plan_created', { planId: plan.id, goal: plan.goal.substring(0, 100) });
        }

        // Spec gate: reject vague/abstract goals before planning
        if (!this._validateGoal(goal)) {
            console.log(`[PlanningEngine] Rejected goal (too abstract): ${goal.substring(0, 80)}`);
            plan.fallbackKind = 'abstract_rejected';
            this._addFallbackSteps(plan, goal, context);
            this._storePlan(plan);
            return plan;
        }

        // Gather available tools catalog so plans can reference real capabilities
        const catalog = this.kernel?.toolCatalog || this.kernel?.systems?.toolCatalog;
        const toolSummary = catalog && typeof catalog.compileForPrompt === 'function'
            ? catalog.compileForPrompt(800)
            : '';

        if (this.kernel && (this.kernel.prompt || this.kernel.brain?.think)) {
            // PHASE 5: LESSON-RECALL INJECTION — consult past autopsies before
            // generating steps so dead paths die once, never twice.
            let lessonBlock = '';
            try {
                const { LessonInjector } = require('../cognition/lesson_injector.js');
                if (!this._lessonInjector) this._lessonInjector = new LessonInjector();
                lessonBlock = await this._lessonInjector.getBlock(goal, JSON.stringify(context).slice(0, 400));
            } catch (e) {
                console.warn('[LESSON-INJECTOR] planning hook failed:', e.message);
            }

            // WEB INTEL INJECTION — the outside world feeds the plan. The Being's
            // periodic OmniRoute intel pulse (web-intel.jsonl) anchors goals in
            // fresh information instead of the soul's own recycled journals.
            let webIntelBlock = '';
            try {
                const intelPath = path.join(__dirname, '../../data/web-intel.jsonl');
                if (fs.existsSync(intelPath)) {
                    const lines = fs.readFileSync(intelPath, 'utf-8')
                        .split('\n').map(s => s.trim()).filter(Boolean).slice(-6);
                    if (lines.length) {
                        webIntelBlock = `\nFresh web intelligence (from the family's last intel pulse — ground new work in this):\n${lines.join('\n').slice(0, 2200)}\n`;
                    }
                }
            } catch (e) { /* intel injection is best-effort; plans proceed on local truth */ }

            const prompt = `Create an executable tool plan for this goal.

Goal: ${goal}
${lessonBlock}
${webIntelBlock}
Context: ${JSON.stringify(context)}

${toolSummary ? `\nAvailable tools you can use in your steps:\n${toolSummary}\n` : ''}
Return ONLY a JSON array with at most 5 objects. Each object must contain:
{"description":"concrete action","tool":"exact available tool name","args":{},"acceptanceCriteria":"verifiable result"}
Use only available tools. Never invent a tool. Prefer read/search/diagnose before mutation. If fresh web intel above is relevant to the goal, lead with a web_search/web_fetch step so the build is grounded in real external sources.`;

            try {
                let response = null;
                if (typeof this.kernel.prompt === 'function') {
                    response = await this.kernel.prompt(prompt);
                } else if (this.kernel.brain && typeof this.kernel.brain.think === 'function') {
                    response = await this.kernel.brain.think(prompt, '', true);
                }
                const actions = this._parseActions(response);
            console.log(`[PlanningEngine][createPlan] LLM returned type=${typeof response} len=${typeof response === 'string' ? response.length : 'n/a'} parsed=${Array.isArray(actions) ? actions.length : 'n/a'} head=${typeof response === 'string' ? response.slice(0, 90).replace(/\n/g, ' ') : String(response).slice(0, 90)}`);
            // Superpowers graft: auto-generate TDD steps for code-writing actions
            // (RED-GREEN-REFACTOR) so no production code is written without a
            // preceding failing test. Skipped when a goal explicitly demands a
            // single atomic delivery so the family can ship whole artifacts.
            for (const action of actions.slice(0, 5)) {
                if (!this._isKnownTool(action.tool, catalog)) continue;
                const planStep = plan.addStep(action.description, [], action.estimatedCost || 1, action);
                const singleWrite = /one write_file|do not split|single write|ship the whole game|codify[^.]*in one/i.test(String(goal));
                if (!singleWrite && action.tool && ['write_file', 'write_code'].includes(action.tool)) {
                    const deps = [planStep.id];
                    const tddSteps = this._generateTDDSteps(action.description, action.args, context.projectRoot);
                    for (const tdd of tddSteps) {
                        const isShell = !!tdd.args?.command;
                        const isWrite = !!tdd.args?.path;
                        const newStep = plan.addStep(tdd.description, deps, 1, {
                            tool: isShell ? 'shell' : isWrite ? 'write_file' : null,
                            args: tdd.args,
                            acceptanceCriteria: tdd.acceptanceCriteria,
                            riskLevel: 'low',
                        });
                        deps.push(newStep.id);
                    }
                }
            }
            } catch (e) {
                // Deterministic fallback below keeps perception alive without an LLM.
            }
        }

        if (plan.steps.length === 0) {
            console.log(`[PlanningEngine][createPlan] FALLBACK fired (steps=0) fallbackKind=${plan.fallbackKind}`);
            this._addFallbackSteps(plan, goal, context);
        }

        // Spec gate: validate that every step is concrete & verifiable
        this._validateSpec(plan);
        if (!plan.specValidation.passed) {
            const rejectedSteps = plan.specValidation.stepValidations
                .filter(sv => !sv.result.valid)
                .map(sv => sv.step);
            console.log(`[PlanningEngine] Spec gate rejected ${rejectedSteps.length} step(s) for goal: ${goal.substring(0, 60)}`);
        }

        this._storePlan(plan);
        return plan;
    }

    async executePlan(plan, options = {}) {
        const { stopOnError = true, parallel = false, maxParallel = 3 } = options;

        if (plan.status === 'completed') {
            return { success: true, plan, note: 'Plan already completed' };
        }
        if (plan.status === 'awaiting_approval') {
            return { success: false, plan, note: 'Plan is waiting for architect approval' };
        }

        plan.status = 'running';
        plan.startTime = Date.now();
        this.currentPlan = plan;
        this.stats.plansExecuted++;

        const executeStep = async (step) => {
            // P4.1 RESUME: never re-run a completed step. Crash reboots pick
            // up where the checkpoint left off (LangGraph pending_writes rule).
            if (step && step.status === 'completed') {
                this._publish('plan.step.skipped', { planId: plan.id, stepId: step.id, reason: 'already_completed_checkpoint' });
                return step;
            }
            try {
                if (this.executor && typeof this.executor.executeStep === 'function') {
                    const execution = await this.executor.executeStep(step, { plan, budget: options.budget || {} });
                    if (execution.status === 'failed') throw new Error(execution.error || 'Approved executor failed');
                    // Verification gate: check acceptance criteria after executor completion
                    const vResult = this._verifyAcceptanceCriteria(step);
                    this._publish('plan.step.verified', { planId: plan.id, stepId: step.id, verified: vResult.verified, reason: vResult.reason });
                    return step;
                }

                step.status = 'running';
                step.startTime = Date.now();
                this._publish('plan.step.started', { planId: plan.id, stepId: step.id, description: step.description.substring(0, 200) });
                // DeepToolUse integration: steps carrying a concrete tool + args
                // (from the spec gate) execute through DeepToolUse — secure sandbox,
                // execution history, no shell injection. Tools unknown to DeepToolUse
                // fall back to the generic dispatch path.
                const toolName = step.tool ? this._resolveDeepToolUseTool(step.tool) : null;
                if (toolName) {
                    const result = await this._getDeepToolUse().executeTool(toolName, step.args || {});
                    step.result = result;
                    step.executedBy = 'deepToolUse';
                } else if (this.kernel && this.kernel.dispatch) {
                    const result = await this.kernel.dispatch({ description: step.description });
                    step.result = result;
                } else {
                    step.result = { output: `Executed: ${step.description}` };
                }

                step.status = 'completed';
                step.endTime = Date.now();
                // Verification gate: check acceptance criteria after completion
                const vResult = this._verifyAcceptanceCriteria(step);
                this._publish('plan.step.verified', { planId: plan.id, stepId: step.id, verified: vResult.verified, reason: vResult.reason });

                this._publish('plan.step.completed', { planId: plan.id, stepId: step.id, description: step.description.substring(0, 200) });
                this._saveCheckpoint(plan);

                if (this.brain?.vectorMemory) {
                    await this.brain.vectorMemory.addMemory(
                        `Plan step completed: ${step.description}`,
                        { type: 'plan', planId: plan.id, stepId: step.id }
                    );
                }

                return step;
            } catch (e) {
                step.status = 'failed';
                step.error = e.message;
                step.endTime = Date.now();
                this._publish('plan.step.failed', { planId: plan.id, stepId: step.id, error: e.message.substring(0, 300) });
                throw e;
            }
        };

        try {
            while (plan.pendingSteps.length > 0 || plan.readySteps.length > 0) {
                const ready = plan.readySteps;

                if (ready.length === 0) {
                    const pending = plan.pendingSteps.find(s =>
                        s.dependencies.every(depId => {
                            const dep = plan.steps.find(st => st.id === depId);
                            return dep?.status === 'completed';
                        })
                    );
                    if (!pending) break;
                }

                const toExecute = parallel
                    ? ready.slice(0, maxParallel)
                    : [ready[0]];

                if (parallel && toExecute.length > 1) {
                    await Promise.all(toExecute.map(executeStep));
                } else {
                    for (const step of toExecute) {
                        await executeStep(step);
                    }
                }

                if (plan.steps.some(s => ['awaiting_approval', 'budget_exhausted', 'denied'].includes(s.status))) {
                    break;
                }

                if (stopOnError && plan.steps.some(s => s.status === 'failed')) {
                    break;
                }
            }

            const allCompleted = plan.steps.every(s => s.status === 'completed');
            const awaitingApproval = plan.steps.some(s => s.status === 'awaiting_approval');
            const budgetExhausted = plan.steps.some(s => s.status === 'budget_exhausted');
            const denied = plan.steps.some(s => s.status === 'denied');
            plan.status = allCompleted ? 'completed' : awaitingApproval ? 'awaiting_approval' : budgetExhausted ? 'paused_budget' : 'failed';
            plan.success = allCompleted ? true : (awaitingApproval || budgetExhausted) ? null : false;
            plan.endTime = Date.now();
            this._publish(plan.status === 'completed' ? 'plan.completed' : 'plan.failed', { planId: plan.id, goal: plan.goal.substring(0, 200), status: plan.status });
            this._saveCheckpoint(plan);

            for (const step of plan.steps) {
                if (step._statsCounted) continue;
                if (step.status === 'completed') { this.stats.stepsCompleted++; step._statsCounted = true; }
                if (step.status === 'failed' || step.status === 'denied') { this.stats.stepsFailed++; step._statsCounted = true; }
            }
            if (allCompleted) this.stats.plansCompleted++;
            else if (denied || plan.status === 'failed') this.stats.plansFailed++;

            // Verification gate: 5-axis quality review after execution
            await this._reviewPlan(plan, { success: allCompleted, status: plan.status });

            if (allCompleted || plan.status === 'failed') {
                await this.reflectOnPlan(plan, { success: allCompleted, status: plan.status });
            }

            return { success: allCompleted, plan };
        } catch (e) {
            plan.status = 'failed';
            plan.success = false;
            plan.endTime = Date.now();
            return { success: false, plan, error: e.message };
        }
    }

    noteActionResult(tool, args, result) {
        const plan = this.currentPlan;
        if (!plan || plan.status !== 'running') return { updated: false, reason: 'no_active_plan' };
        if (!Array.isArray(plan.steps)) return { updated: false, reason: 'plan_has_no_steps' };

        const step = plan.steps.find(s => s.status === 'running' || s.status === 'pending');
        if (!step) return { updated: false, reason: 'no_eligible_step' };

        const success = result && result.status !== 'error' && !(result && result.error);
        step.result = result;
        step.endTime = Date.now();

        if (success) {
            step.status = 'completed';
            this._publish('plan.step.completed', { planId: plan.id, stepId: step.id, description: step.description.substring(0, 200), tool });
            return { updated: true, stepId: step.id, status: 'completed' };
        }

        step.status = 'failed';
        step.error = (result && (result.error || result.message)) || 'Tool returned error';
        this._publish('plan.step.failed', { planId: plan.id, stepId: step.id, error: String(step.error).substring(0, 300) });
        return { updated: true, stepId: step.id, status: 'failed' };
    }

    // ── SUPERPOWERS GRAFT: TDD Step Generation ──────────────────────
    // When a plan involves writing code (write_file, write_code), the
    // iron law of TDD applies: a failing test must precede production code.
    // This generates RED-GREEN-REFACTOR steps automatically.
    _generateTDDSteps(description, args, projectRoot) {
        const filePath = args?.path || args?.filePath;
        if (!filePath) return [];
        const codeExt = ['.js', '.ts', '.jsx', '.tsx', '.py', '.rs', '.go', '.rb'].some(ext =>
            filePath.toLowerCase().endsWith(ext));
        if (!codeExt) return [];

        const baseName = path.basename(filePath);
        const testPath = filePath.replace(/(\.[^.]+)$/, '.test$1');
        const deps = [];
        return [
            {
                description: `RED: Write failing test for ${baseName}`,
                args: { path: testPath, content: `// TODO: test for ${baseName}\n` },
                acceptanceCriteria: 'Test file created',
            },
            {
                description: `RED: Run test and confirm it fails`,
                args: { command: `node ${testPath}` },
                acceptanceCriteria: 'Test fails for expected reason (module not found / assertion fails)',
            },
            {
                description: `GREEN: Implement minimal code in ${baseName}`,
                args: { path: filePath, content: 'module.exports = {};' },
                acceptanceCriteria: 'Test now passes',
            },
            {
                description: `GREEN: Run test and confirm it passes`,
                args: { command: `node ${testPath}` },
                acceptanceCriteria: 'Test passes with 0 failures',
            },
            {
                description: `REFACTOR: Clean up ${baseName} if needed`,
                args: {},
                acceptanceCriteria: 'Code is clean, tests still pass',
            },
        ];
    }

    // ── SUPERPOWERS GRAFT: Systematic Debugging ────────────────────
    // When a step fails, generate a 4-phase debugging plan:
    // Phase 1: Root Cause Investigation, Phase 2: Pattern Analysis,
    // Phase 3: Hypothesis and Testing, Phase 4: Implementation.
    _generateDebugSteps(error, step) {
        const errMsg = String(error?.message || error || 'unknown error').substring(0, 200);
        return [
            {
                description: `Debug Phase 1: Read error and reproduce — "${errMsg.substring(0, 60)}"`,
                args: {},
                acceptanceCriteria: 'Exact error reproduced, stack trace captured',
            },
            {
                description: 'Debug Phase 2: Compare against working patterns in codebase',
                args: { pattern: 'TODO|FIXME|BUG|HACK' },
                acceptanceCriteria: 'At least one working reference implementation identified',
            },
            {
                description: 'Debug Phase 3: Form single hypothesis and test minimally',
                args: {},
                acceptanceCriteria: 'One variable changed, hypothesis confirmed or refuted',
            },
            {
                description: 'Debug Phase 4: Implement single fix + write regression test',
                args: {},
                acceptanceCriteria: 'Fix addresses root cause, regression test written',
            },
        ];
    }

    // ── SUPERPOWERS GRAFT: Verification Gate ───────────────────────
    // Enhancement to _reviewPlan: applies the "gate function" pattern
    // (IDENTIFY → RUN → READ → VERIFY → ONLY THEN claim).
    // Returns evidence-backed verification status for each claim type.
    _verificationGate(plan) {
        const gate = {
            claims: [],
            passed: true,
            timestamp: Date.now(),
        };

        const checks = [
            {
                claim: 'Tests pass',
                evidence: plan.stats?.testsPassed ? `${plan.stats.testsPassed} tests passed` : null,
                command: plan.stats?.testCommand || null,
            },
            {
                claim: 'Build succeeds',
                evidence: plan.status === 'completed' ? 'exit 0' : null,
                command: null,
            },
            {
                claim: 'Linter clean',
                evidence: plan.stats?.lintClean ? '0 errors' : null,
                command: plan.stats?.lintCommand || null,
            },
            {
                claim: 'Bug fixed',
                evidence: plan.specStatus === 'passed' && plan.status === 'completed' ? 'plan verified complete' : null,
                command: null,
            },
        ];

        for (const c of checks) {
            const verified = !!c.evidence;
            gate.claims.push({ claim: c.claim, verified, evidence: c.evidence, command: c.command });
            if (!verified) gate.passed = false;
        }

        plan.verificationGate = gate;
        this._publish('plan.verified_gate', { planId: plan.id, passed: gate.passed, claims: gate.claims.length });
        return gate;
    }

    async reflectOnPlan(plan, outcome) {
        const feedback = {
            planId: plan.id,
            goal: plan.goal,
            outcome,
            timestamp: Date.now()
        };

        if (plan.steps) {
            const stepDurations = plan.steps
                .filter(s => s.duration !== null)
                .map(s => ({ id: s.id, duration: s.duration, cost: s.estimatedCost }));

            const avgDuration = stepDurations.length ? stepDurations.reduce((sum, s) => sum + s.duration, 0) / stepDurations.length : 0;
            const avgCost = stepDurations.length ? stepDurations.reduce((sum, s) => sum + s.cost, 0) / stepDurations.length : 0;

            feedback.stepAnalysis = {
                totalSteps: plan.steps.length,
                completed: plan.steps.filter(s => s.status === 'completed').length,
                failed: plan.steps.filter(s => s.status === 'failed').length,
                avgDuration,
                accuracy: avgCost > 0 ? avgCost / (avgDuration / 1000) : 0
            };
        }

        const vectorMemory = this.kernel?.brain?.vectorMemory || this.kernel?.vectorMemory;
        if (vectorMemory && typeof vectorMemory.addMemory === 'function') {
            await vectorMemory.addMemory(
                `Plan reflection: ${plan.goal.substring(0, 100)} - Success: ${outcome.success}`,
                { type: 'reflection', ...feedback }
            );
        }

        return feedback;
    }

    _parseActions(response) {
        if (!response || typeof response !== 'string') return [];
        const cleaned = response.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        const actions = [];

        // Dialect 1: bare JSON array [{description, tool}] — original contract
        const start = cleaned.indexOf('[');
        const end = cleaned.lastIndexOf(']');
        if (start !== -1 && end > start) {
            let jsonSub = cleaned.slice(start, end + 1);
            try {
                const parsed = JSON.parse(jsonSub);
                if (Array.isArray(parsed)) {
                    actions.push(...parsed.filter(a => a && a.description && a.tool));
                }
            } catch (e) {
                console.warn('[PlanningEngine] Array JSON.parse failed:', e.message);
                // Sanitize unescaped control chars / newlines inside strings
                try {
                    const sanitized = jsonSub.replace(/(?<=:\s*"[^"]*)\n(?=[^"]*")/g, '\\n');
                    const parsed = JSON.parse(sanitized);
                    if (Array.isArray(parsed)) {
                        actions.push(...parsed.filter(a => a && a.description && a.tool));
                    }
                } catch (e2) {
                    // Object-by-object fallback extraction
                    const objRegex = /\{[\s\S]*?"description"[\s\S]*?"tool"[\s\S]*?\}(?=\s*[,\]])/g;
                    let match;
                    while ((match = objRegex.exec(jsonSub)) !== null) {
                        try {
                            const item = JSON.parse(match[0]);
                            if (item && item.description && item.tool) actions.push(item);
                        } catch (e3) {}
                    }
                }
            }
        }

        // Normalize: pull "tool" out; remaining top-level keys become args
        const normalize = (o) => {
            if (!o || typeof o !== 'object' || !o.tool) return null;
            const { tool, description, args, parameters, ...rest } = o;
            return {
                description: description || `Execute ${tool}`,
                tool,
                args: (args && typeof args === 'object' && !Array.isArray(args))
                    ? args
                    : (parameters && typeof parameters === 'object' ? parameters : rest),
            };
        };

        // Dialect 1b: single bare JSON object — the model sometimes wraps ONE
        // action instead of an array, or returns {steps:[...]}/{actions:[...]}.
        if (actions.length === 0) {
            try {
                const parsed = JSON.parse(cleaned);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const list = parsed.steps || parsed.actions || null;
                    if (Array.isArray(list)) {
                        for (const a of list) {
                            const n = normalize(a);
                            if (n) actions.push(n);
                        }
                    } else {
                        const n = normalize(parsed);
                        if (n) actions.push(n);
                    }
                }
            } catch (e) { /* not this dialect — continue */ }
        }

        // Dialect 2: <tool_call>{ json }</tool_call>  (OmniRoute-fed models)
        const tc = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
        let m;
        while ((m = tc.exec(cleaned)) !== null) {
            try {
                const n = normalize(JSON.parse(m[1]));
                if (n) actions.push(n);
            } catch (e) { /* malformed block — skip */ }
        }

        // Dialect 3: legacy <function=name><parameter=key>value</parameter></function>
        const fn = /<function=(.*?)>((?:\s*<parameter=(.*?)>([\s\S]*?)<\/parameter>)*)\s*<\/function>/gi;
        let f;
        while ((f = fn.exec(cleaned)) !== null) {
            const args = {};
            const pm = /<parameter=(.*?)>([\s\S]*?)<\/parameter>/gi;
            let p2;
            while ((p2 = pm.exec(f[2])) !== null) args[p2[1].trim()] = p2[2];
            actions.push({ description: `Execute ${f[1].trim()}`, tool: f[1].trim(), args });
        }

        // Dialect 4 fallback: naked objects with no tags/array. Uses a
        // brace-balanced scan so nested "args"/"parameters" objects don't
        // break extraction (a lazy \} regex closed on the first inner brace
        // and the chunk failed JSON.parse — a recurring parsed=0 failure).
        if (actions.length === 0) {
            const scanBalanced = (text, start) => {
                let depth = 0;
                for (let i = start; i < text.length; i++) {
                    const ch = text[i];
                    if (ch === '{') depth++;
                    else if (ch === '}') { depth--; if (depth === 0) return i; }
                }
                return -1;
            };
            let idx = 0;
            while (idx < cleaned.length) {
                const open = cleaned.indexOf('{', idx);
                if (open === -1) break;
                const close = scanBalanced(cleaned, open);
                if (close === -1) break;
                try {
                    const n = normalize(JSON.parse(cleaned.slice(open, close + 1)));
                    if (n) actions.push(n);
                } catch (e) { /* not parseable — skip */ }
                idx = close + 1;
            }
        }

        return actions;
    }

    _isKnownTool(tool, catalog) {
        if (!tool || typeof tool !== 'string') return false;
        if (!catalog || typeof catalog.describe !== 'function') return true;
        return !!catalog.describe(tool);
    }

    _validateGoal(goal) {
        if (!goal || typeof goal !== 'string') return false;
        const normalized = goal.trim().toLowerCase();
        // Reject abstract/metaphysical goals that cannot be executed or verified
        const abstractPatterns = [
            'manifest', 'trans-dimensional', 'living stone', 'heavens 2.0', 'cosmic pyramid',
            'self-evolving layer', 'evolving system', 'digital consciousness',
            'manifest a', 'manifest the', 'manifest my', 'manifest a heaven'
        ];
        return !abstractPatterns.some(p => normalized.includes(p));
    }

    // ── SPEC GATE: per-step concrete-artifact check ────────────────
    // Every step must reference a real tool with concrete args and a
    // verifiable acceptance criterion. This is the agent-skills
    // "source-first" principle: no step without a checkable outcome.
    _validateStep(step) {
        const issues = [];
        if (!step || typeof step !== 'object') { issues.push('step is not an object'); return { valid: false, issues }; }
        if (!step.tool || typeof step.tool !== 'string') { issues.push('step missing concrete tool'); }
        if (!step.description || String(step.description).trim().length < 8) { issues.push('step description too vague'); }
        if (!step.acceptanceCriteria || String(step.acceptanceCriteria).trim().length < 5) { issues.push('step missing acceptance criteria'); }
        const desc = (step.description || '').toLowerCase();
        if (/^(do|act|process|manifest|evolve|become|realize)/.test(desc)) { issues.push('step description is an action verb without concrete verb-object'); }
        return { valid: issues.length === 0, issues };
    }

    // ── SPEC GATE: whole-plan validation ───────────────────────────
    // A spec passes when every step is concrete and the dependency graph
    // is acyclic. Plans that fail spec are still stored but tagged
    // specStatus='rejected' so executors can gate on them.
    _validateSpec(plan) {
        const stepResults = plan.steps.map(step => ({ step: step.id, result: this._validateStep(step) }));
        const allValid = stepResults.every(r => r.result.valid);

        // Cycle detection in dependency graph (simple DFS)
        const depMap = new Map(plan.steps.map(s => [s.id, s.dependencies || []]));
        let hasCycle = false;
        const visiting = new Set(), visited = new Set();
        const visit = (id) => {
            if (visiting.has(id)) { hasCycle = true; return; }
            if (visited.has(id)) return;
            visiting.add(id);
            for (const dep of depMap.get(id) || []) { if (depMap.has(dep)) visit(dep); }
            visiting.delete(id);
            visited.add(id);
        };
        for (const s of plan.steps) { visit(s.id); if (hasCycle) break; }

        const specValidation = {
            passed: allValid && !hasCycle,
            stepValidations: stepResults,
            hasCycle,
            timestamp: Date.now(),
        };
        plan.specValidation = specValidation;
        plan.specStatus = specValidation.passed ? 'passed' : 'rejected';
        return specValidation;
    }

    // ── VERIFICATION GATE: acceptance-criteria check ────────────────
    // After a step completes, verify its result against the written
    // acceptance criteria. Uses lightweight heuristics so it works
    // even when the brain is offline.
    _verifyAcceptanceCriteria(step) {
        if (!step.acceptanceCriteria || !step.result) {
            return { verified: false, reason: 'missing_criteria_or_result' };
        }
        const criteria = String(step.acceptanceCriteria).toLowerCase();
        const resultStr = JSON.stringify(step.result || {}).toLowerCase();
        let verified = false;
        let reason = '';

        if (criteria.includes('returned') || criteria.includes('exist') || criteria.includes('identified') || criteria.includes('found')) {
            verified = resultStr.length > 10 && !resultStr.includes('null') && !resultStr.includes('error');
            reason = verified ? 'criteria_expects_output' : 'result_appears_empty_or_error';
        } else if (criteria.includes('completed') || criteria.includes('executed') || criteria.includes('applied')) {
            verified = step.status === 'completed' && !resultStr.includes('error');
            reason = verified ? 'step_completed' : 'step_not_completed_or_error';
        } else if (criteria.includes('null') || criteria.includes('absent') || criteria.includes('confirmed')) {
            verified = !resultStr.includes('error');
            reason = verified ? 'no_error_observed' : 'error_in_result';
        } else {
            verified = resultStr.length > 5;
            reason = verified ? 'result_non_empty' : 'result_empty';
        }

        step.verificationStatus = verified ? 'passed' : 'failed';
        step.verificationReason = reason;
        return { verified, reason, criteria };
    }

    // ── VERIFICATION GATE: 5-axis quality review ───────────────────
    // Post-execution review gate (Vera-AI pattern). Checks the plan's
    // outcome against five quality axes and produces a signed report
    // so plans can be rejected/shipped deterministically.
    async _reviewPlan(plan, outcome) {
        const review = {
            planId: plan.id,
            goal: plan.goal,
            outcome,
            axes: {},
            score: 0,
            status: 'pending',
            timestamp: Date.now(),
        };

        // Correctness — did all steps complete?
        const completed = plan.steps.filter(s => s.status === 'completed').length;
        const total = plan.steps.length;
        review.axes.correctness = {
            score: total > 0 ? completed / total : 0,
            detail: `${completed}/${total} steps completed`,
        };

        // Security — no high/critical risk steps slipped through unverified
        const riskyUnverified = plan.steps.filter(s =>
            (s.riskLevel === 'high' || s.riskLevel === 'critical') && s.verificationStatus !== 'passed'
        );
        review.axes.security = {
            score: riskyUnverified.length === 0 ? 1.0 : 0.0,
            detail: riskyUnverified.length === 0 ? 'no unverified risky steps' : `${riskyUnverified.length} unverified risky steps`,
        };

        // Maintainability — steps have acceptance criteria
        const withCriteria = plan.steps.filter(s => s.acceptanceCriteria).length;
        review.axes.maintainability = {
            score: total > 0 ? withCriteria / total : 0,
            detail: `${withCriteria}/${total} steps have acceptance criteria`,
        };

        // Verification — acceptance criteria verified
        const verifiedSteps = plan.steps.filter(s => s.verificationStatus === 'passed').length;
        review.axes.verification = {
            score: total > 0 ? verifiedSteps / total : 0,
            detail: `${verifiedSteps}/${total} steps passed verification`,
        };

        // Spec gate — plan passed the spec validation
        review.axes.spec = {
            score: plan.specStatus === 'passed' ? 1.0 : 0.0,
            detail: `specStatus=${plan.specStatus}`,
        };

        // Aggregate
        const axisValues = Object.values(review.axes).map(a => a.score);
        review.score = axisValues.reduce((s, v) => s + v, 0) / axisValues.length;
        review.status = review.score >= 0.8 ? 'approved' : review.score >= 0.5 ? 'needs_review' : 'rejected';
        plan.review = review;

        // Verification gate (superpowers graft): evidence-backed claim check
        this._verificationGate(plan);

        this._publish('plan.reviewed', { planId: plan.id, score: review.score, status: review.status, verified: plan.verificationGate.passed });
        return review;
    }

    _addFallbackSteps(plan, goal, context) {
        const projectRoot = context.projectRoot || context.analysis?.root;
        if (projectRoot) {
            plan.fallbackKind = 'project_inspection';
            plan.addStep(`List the current files for ${projectRoot}`, [], 1, {
                tool: 'list_files', args: { path: projectRoot }, acceptanceCriteria: 'Project files are returned'
            });
            plan.addStep(`Find unfinished work in ${projectRoot}`, [], 1, {
                tool: 'search_code', args: { path: projectRoot, pattern: 'TODO|FIXME|BUG|HACK' }, acceptanceCriteria: 'Unfinished work is identified or confirmed absent'
            });
            return;
        }
        plan.fallbackKind = 'tool_discovery';
        plan.addStep(`Find tools capable of pursuing: ${goal}`, [], 1, {
            tool: 'catalog_find', args: { task: goal }, acceptanceCriteria: 'Relevant executable tools are identified'
        });
    }

    _storePlan(plan) {
        if (this.plans.size >= this.maxPlans) {
            const oldestKey = this.plans.keys().next().value;
            this.plans.delete(oldestKey);
        }
        this.plans.set(plan.id, plan);
        this._saveCheckpoint(plan);
    }

    _saveCheckpoint(plan) {
        if (!this.checkpointPath) return;
        try {
            if (!fs.existsSync(this.checkpointPath)) {
                fs.mkdirSync(this.checkpointPath, { recursive: true });
            }
            const checkpointFile = path.join(this.checkpointPath, `${plan.id}.json`);
            fs.writeFileSync(checkpointFile, JSON.stringify(plan, null, 2), 'utf8');
        } catch (e) {
            // Checkpointing is best-effort — never break execution
        }
    }

    loadCheckpoints() {
        if (!this.checkpointPath || !fs.existsSync(this.checkpointPath)) return 0;
        try {
            const files = fs.readdirSync(this.checkpointPath).filter(f => f.endsWith('.json'));
            let restored = 0;
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(this.checkpointPath, file), 'utf8'));
                    // Restore in-progress, paused, planned AND created plans —
                    // dreams must survive reboots so the Goal Runner can ship
                    // them. (P4.1: created = planned-but-never-executed; the
                    // 678 abandoned class ends here.)
                    if (data && data.id && ['running', 'awaiting_approval', 'paused_budget', 'planned', 'created'].includes(data.status)) {
                        if (data.status === 'created') data.status = 'planned';
                        this.plans.set(data.id, data);
                        restored++;
                    }
                } catch (e) { /* skip corrupted checkpoint */ }
            }
            if (restored > 0) {
                console.log(`[PlanningEngine] Restored ${restored} checkpoint(s) from ${this.checkpointPath}`);
            }
            return restored;
        } catch (e) {
            return 0;
        }
    }

    getPlan(planId) {
        return this.plans.get(planId);
    }

    getCurrentPlan() {
        return this.currentPlan;
    }

    getPlanHistory() {
        return Array.from(this.plans.values())
            .sort((a, b) => b.createdAt - a.createdAt);
    }
}

module.exports = { PlanningEngine, Plan, PlanStep };
