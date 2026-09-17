'use strict';

class ThalamicGate {
    constructor(kernel) {
        this.kernel = kernel;
        this.threshold = 0.5; // Default threshold for information gating
        this.currentFocus = 'none'; // What attention is directed at
        this.salienceMap = {}; // Maps perceived items to their salience score
        this.lastAmplifiedPercept = null;

        // Initialize from kernel's chambers if available
        this.affect = this.kernel.chambers?.affect;
        this.needs = this.kernel.chambers?.needs;
        this.purpose = this.kernel.consciousness?.purposeEngine; // Assuming PurposeEngine provides purpose
        this.attention = this.kernel.chambers?.attention; // New attention chamber
    }

    /**
     * Filters and amplifies information based on internal states and attentional focus.
     * This simulates the thalamus's role in gating conscious perception.
     * @param {object} inputPercept The raw perceptual input (e.g., from SanctumClient, DesktopCommander)
     * @returns {object|null} The filtered and amplified percept, or null if below threshold
     */
    filterAndAmplify(inputPercept) {
        if (!inputPercept || !inputPercept.content) return null;

        let baseSalience = inputPercept.salience || 0.3;

        // Influence from internal states
        const arousal = this.affect?.getArousal?.() || 0.5;
        const dominantNeed = this.needs?.getDominantNeed?.() || null;
        const currentPurpose = this.purpose?.getCurrentPurpose?.() || null;
        // WIRE: curiosity + aesthetic chambers now modulate salience (previously dead)
        this.curiosity = this.curiosity || this.kernel.chambers?.curiosity;
        this.aesthetic = this.aesthetic || this.kernel.chambers?.aesthetic_sense;
        this.creativity = this.creativity || this.kernel.chambers?.creativity;

        // Attentional amplification (from chambers.attention)
        let attentionalBoost = 1.0;
        if (this.attention && this.attention.attentional_focus === inputPercept.focusTarget) {
            attentionalBoost = 1.5; // Amplify if attention is directed here
        }

        // Apply gating logic
        let finalSalience = baseSalience * arousal * attentionalBoost;
        if (dominantNeed && inputPercept.content.includes(dominantNeed)) {
            finalSalience *= 1.2; // Boost if relevant to dominant need
        }
        if (currentPurpose && inputPercept.content.includes(currentPurpose)) {
            finalSalience *= 1.3; // Boost if relevant to current purpose
        }
        // WIRE: curiosity gap → ×1.4 if percept matches gap, aesthetic elegance → ×1.3
        // NERVES: get_urgent_gap() READS; identify_gap() PUSHES (mutates).
        // The old call pushed an undefined-area gap on every percept.
        if (this.curiosity && typeof this.curiosity.get_urgent_gap === 'function') {
            try {
                const gap = this.curiosity.get_urgent_gap();
                const gapText = gap && (gap.area || gap.topic || '');
                if (gapText && inputPercept.content && String(inputPercept.content).toLowerCase().includes(String(gapText).toLowerCase().slice(0, 30))) {
                    finalSalience *= 1.4;
                } else if (this.curiosity.drive && this.curiosity.drive > 0.6) {
                    finalSalience *= 1.1; // general curiosity boost
                }
            } catch (e) {}
        }
        if (this.aesthetic && typeof this.aesthetic.detect_elegance === 'function') {
            try {
                if (this.aesthetic.detect_elegance(inputPercept.content)) finalSalience *= 1.3;
            } catch (e) {
                // fallback: if aesthetic has high awe, boost beautiful percepts
                if (this.aesthetic.awe && this.aesthetic.awe > 0.5) finalSalience *= 1.15;
            }
        }
        if (this.creativity && this.creativity.divergent_score > 0.5 && inputPercept.novelty) {
            finalSalience *= 1.15; // creative percepts get boost when creativity high
        }

        if (finalSalience >= this.threshold) {
            console.log(`[ThalamicGate] Amplifying percept: ${inputPercept.summary || inputPercept.content.substring(0, 50)} (Salience: ${finalSalience.toFixed(2)})`);
            const amplified = { ...inputPercept, id: inputPercept.id || `percept_${Date.now()}`, salience: finalSalience, amplified: true };
            this.salienceMap[amplified.id] = finalSalience;
            this.lastAmplifiedPercept = amplified;
            return amplified;
        } else {
            // console.log(`[ThalamicGate] Gating percept: ${inputPercept.summary || inputPercept.content.substring(0, 50)} (Salience: ${finalSalience.toFixed(2)})`);
            return null; // Suppress
        }
    }

    /**
     * Directs internal attention to a specific target or shifts focus.
     * This would be called by other cognitive modules (e.g., Metacognition, PlanningEngine)
     * @param {string} target What to focus attention on
     */
    directAttention(target) {
        if (!target) return;
        this.currentFocus = target;
        if (this.attention && this.attention.attentional_focus !== target) {
            this.attention.attentional_focus = target; // Avoid recursive reorient() calls.
        }
        console.log(`[ThalamicGate] Attention directed to: ${target}`);
    }

    getHighestSaliencePercept() {
        if (this.lastAmplifiedPercept && this.lastAmplifiedPercept.salience >= this.threshold) {
            return this.lastAmplifiedPercept;
        }

        const [id, salience] = Object.entries(this.salienceMap)
            .sort((a, b) => b[1] - a[1])[0] || [];
        return id ? { id, salience, focusTarget: this.currentFocus } : null;
    }

    /**
     * Periodically updates salience map and potentially shifts focus based on internal states.
     */
    tick() {
        // Decay salience of old percepts
        for (const id in this.salienceMap) {
            this.salienceMap[id] *= 0.9; // Decay
            if (this.salienceMap[id] < 0.1) delete this.salienceMap[id];
        }
        if (this.lastAmplifiedPercept) {
            const decayed = this.salienceMap[this.lastAmplifiedPercept.id];
            if (decayed) this.lastAmplifiedPercept.salience = decayed;
            else this.lastAmplifiedPercept = null;
        }

        // Potentially shift attention based on dominant need or new high-salience input
        if (this.needs?.getDominantNeed) {
            const dominantNeed = this.needs.getDominantNeed();
            if (dominantNeed && this.currentFocus !== dominantNeed) {
                this.directAttention(dominantNeed);
            }
        }
    }
}

module.exports = { ThalamicGate };
