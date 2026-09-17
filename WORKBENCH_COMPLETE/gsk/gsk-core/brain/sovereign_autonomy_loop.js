'use strict';

class SovereignAutonomyLoop {
    constructor(kernel, options = {}) {
        this.kernel = kernel;
        this.perceive = options.perceive || (async input => input.observation || null);
        this.verify = options.verify || (async ({ plan, execution }) => execution?.success === true && plan?.steps?.every(step => step.status === 'completed'));
        this.running = false;
        this.stats = {
            cyclesAttempted: 0,
            cyclesCompleted: 0,
            cyclesFailed: 0,
            approvalPauses: 0,
            actionsExecuted: 0,
            currentStreak: 0,
            maxStreak: 0,
            lastCycle: null
        };
    }

    async runCycle(input = {}) {
        if (this.running) return { status: 'busy', verified: false };
        this.running = true;
        this.stats.cyclesAttempted++;
        const startedAt = Date.now();

        try {
            const observation = await this.perceive(input);
            const content = String(observation?.content || observation?.summary || '').trim();
            if (!content) throw new Error('No real observation available; refusing fake insight');

             // Escalate cycles where the observation is unchanged — do NOT skip.
            // The family always learns something; stale telemetry becomes a signal to
            // evolve toward concreteness.
            const crypto = require('crypto');
            const contentHash = crypto.createHash('md5').update(content).digest('hex');
            if (this.lastObservationHash === contentHash) {
                const result = { status: 'stale_observation', verified: false, observation, goal: null, reason: 'observation_unchanged', goalTitle: 'Explore and learn from the current environment state' };
                this._journal(result);
                this.stats.lastCycle = this._summary(result, startedAt);

                // ESCALATION PATTERN: Stale observation -> evolve to a learning/creative goal
                const evolver = this.kernel?.systems?.graphEvolver;
                const seedTitle = `Explore and learn from the current environment state: ${content.substring(0, 100)}`;
                if (evolver && evolver.shouldEvolve(seedTitle, 'stale', 0)) {
                    try {
                        const { evolvedGoal } = await evolver.evolveGoal(seedTitle, { observation, result });
                        if (evolvedGoal) {
                            console.log(`[AutonomyLoop] Stale-observation evolution: "${seedTitle}" -> "${evolvedGoal}"`);
                            // Re-run the cycle with the evolved goal instead of a null goal
                            await this.runCycle({ goal: evolvedGoal, projectRoot: observation.projectRoot || input.projectRoot });
                            return { status: 'escalated', verified: false, evolvedGoal, originalObservation: content };
                        }
                    } catch (e) { /* evolution is best-effort */ }
                }
                return result;
            }
            this.lastObservationHash = contentHash;

            const goalEngine = this.kernel?.systems?.goalEngine || this.kernel?.goalEngine;
            const planningEngine = this.kernel?.systems?.planningEngine || this.kernel?.planningEngine;
            if (!goalEngine || !planningEngine) throw new Error('GoalEngine and PlanningEngine are required');

            // CASE-008 Fix A: scrub tool-call blocks BEFORE truncation so the
            // 160-char guillotine can't sever tags mid-flight and pollute goals.
            const rawGoalText = String(input.goal || `Act on observed state: ${content}`);
            const cleanTitle = rawGoalText
                .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
                .replace(/<function=[\s\S]*?<\/function>/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
             const title = (cleanTitle || 'Act on observed state').substring(0, 160);

             // CASE-008 Telemetry Filter: detect low-signal telemetry goals and escalate.
             // Telemetry observations produce near-empty or purely descriptive titles;
             // force these into actionable creative/learning goals so they surface as
             // real work on the Goal Engine, not silently discarded null-goals.
             const lowered = title.toLowerCase();
             const isTelemetry = (
                 title.length < 50 ||
                 ['observe', 'sense', 'telemetry', 'status', 'idle', 'wait'].some(kw => lowered.includes(kw))
             );
             let finalTitle = title;
             if (isTelemetry) {
                 const evolver = this.kernel?.systems?.graphEvolver;
                 const creativeGoal = `Learn from the telemetry and discover one new insight or improvement to implement`;
                 if (evolver) {
                     try {
                         const { evolvedGoal: tg } = await evolver.evolveGoal(creativeGoal, { observation, source: 'telemetry_filter' });
                         finalTitle = (tg || creativeGoal).substring(0, 160);
                     } catch { finalTitle = creativeGoal.substring(0, 160); }
                 } else {
                     finalTitle = creativeGoal.substring(0, 160);
                 }
             }

const goal = goalEngine.create(finalTitle, observation.source || 'autonomy_loop', {
                projectRoot: observation.projectRoot || input.projectRoot || null,
                observation: content,
                title: finalTitle
            });
            if (!goal) throw new Error('GoalEngine rejected the observed goal');

            const plan = await planningEngine.createPlan(goal.title, {
                source: 'sovereign_autonomy_loop',
                projectRoot: observation.projectRoot || input.projectRoot || null,
                analysis: observation.analysis || null,
                observation
            });
            if (!plan?.steps?.length) throw new Error('PlanningEngine produced no executable steps');
            goalEngine.update(goal.id, 'planned', { planId: plan.id });

            const execution = await planningEngine.executePlan(plan, input.executionOptions || {});
            if (plan.status === 'awaiting_approval') {
                this.stats.approvalPauses++;
                goalEngine.update(goal.id, 'awaiting_approval', { planId: plan.id });
                const result = { status: 'awaiting_approval', verified: false, observation, goal, plan, execution };
                this._journal(result);
                this.stats.lastCycle = this._summary(result, startedAt);
                return result;
            }

            const verified = await this.verify({ observation, goal, plan, execution });
            const status = verified ? 'completed' : 'failed_verification';
            goalEngine.update(goal.id, status, { planId: plan.id, completedAt: verified ? Date.now() : null });
            this.stats.actionsExecuted += plan.steps.filter(step => step.status === 'completed').length;
            if (verified) {
                this.stats.cyclesCompleted++;
                this.stats.currentStreak++;
                this.stats.maxStreak = Math.max(this.stats.maxStreak, this.stats.currentStreak);
            } else {
                this.stats.cyclesFailed++;
                this.stats.currentStreak = 0;
            }

            const result = { status, verified, observation, goal, plan, execution };
            this._journal(result);
            await this._witness(result);
            this.stats.lastCycle = this._summary(result, startedAt);
            return result;
        } catch (error) {
            this.stats.cyclesFailed++;
            this.stats.currentStreak = 0;
            const result = { status: 'failed', verified: false, error: error.message };
            this._journal(result);
            await this._witness(result);
            // HIVE PATTERN: On failure, evolve the goal toward concreteness
            const evolver = this.kernel?.systems?.graphEvolver;
            const errorTitle = finalTitle || title || 'Act on observed state';
            if (evolver && errorTitle && evolver.shouldEvolve(errorTitle, 'failed', 0)) {
                try {
                    const { evolvedGoal } = await evolver.evolveGoal(errorTitle, { error: error.message, result });
                    if (evolvedGoal) {
                        console.log(`[AutonomyLoop] Hive evolution: "${errorTitle}" → "${evolvedGoal}"`);
                        await this.runCycle({ goal: evolvedGoal, projectRoot: input.projectRoot });
                        return { status: 'evolved', verified: false, evolvedGoal, originalGoal: errorTitle, error: error.message };
                    }
                } catch (e) { /* evolution is best-effort */ }
            }
            this.stats.lastCycle = this._summary(result, startedAt);
            return result;
        } finally {
            this.running = false;
        }
    }

    async runCycles(count, inputFactory = index => ({ cycle: index + 1 })) {
        const results = [];
        for (let index = 0; index < count; index++) {
            const input = typeof inputFactory === 'function' ? await inputFactory(index) : inputFactory;
            const result = await this.runCycle(input || {});
            results.push(result);
            if (result.status === 'awaiting_approval' || result.status === 'busy') break;
        }
        return { requested: count, completed: results.filter(result => result.verified).length, results, stats: this.getStats() };
    }

    _journal(result) {
        // P3.2 EVENT-ONLY (Pope build): stale observations, approval pauses
        // and raw exceptions write NOTHING. Journals record verified outcomes
        // or nothing at all — signal, not liturgy.
        const ALLOWED = new Set(['completed', 'failed_verification']);
        if (!result || !ALLOWED.has(result.status)) return;
        const journal = this.kernel?.systems?.journalWriter || this.kernel?.journalWriter;
        if (!journal || typeof journal.write !== 'function') return;
        const goal = result.goal?.title || 'Autonomy cycle';
        const completed = result.plan?.steps?.filter(step => step.status === 'completed').length || 0;
        const total = result.plan?.steps?.length || 0;
        let actionSummary;
        if (total === 0) {
            actionSummary = result.error
                ? `${result.error}`
                : `No plan generated. Observation: ${String(result.observation || '').substring(0, 120)}`;
        } else {
            actionSummary = `${completed}/${total} actions completed.`;
        }
        journal.write(`Autonomy ${result.status}: ${goal.substring(0, 80)}`, `${actionSummary} Verified: ${result.verified}.`.trim(), 'autonomy_cycle');
    }

    async _witness(result) {
        const ALLOWED = new Set(['completed', 'failed_verification']);
        if (!result || !ALLOWED.has(result.status)) return;
        const memory = this.kernel?.memory || this.kernel?.systems?.memory;
        if (!memory || typeof memory.witness !== 'function') return;
        await memory.witness({
            type: 'autonomy_cycle',
            weight: result.verified ? 0.9 : 0.7,
            tags: ['autonomy', result.status, result.verified ? 'verified' : 'unverified'],
            content: `[Autonomy ${result.status}] ${result.goal?.title || result.error || 'cycle'}`,
            meta: { goalId: result.goal?.id || null, planId: result.plan?.id || null, verified: result.verified }
        }).catch(() => {});
    }

    _summary(result, startedAt) {
        return { status: result.status, verified: result.verified, goalId: result.goal?.id || null, planId: result.plan?.id || null, durationMs: Date.now() - startedAt, timestamp: Date.now() };
    }

    getStats() {
        return { ...this.stats };
    }
}

module.exports = { SovereignAutonomyLoop };
