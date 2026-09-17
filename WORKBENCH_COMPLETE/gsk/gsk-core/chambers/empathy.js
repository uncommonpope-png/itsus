'use strict';

/**
 * EMPATHY CHAMBER — PLT_AFFINITY: P:0.3, L:0.9, T:0.2
 * Affective empathy, emotional contagion
 */

class EmpathyChamber {
    constructor() {
        this.empathic_accuracy = 0.5;
        this.emotional_contagion = 0.4;
        this.perspective_taking = 0.5;
        this.empathic_concern = 0.6;
        this.others_valence = {};
    }
    
    breathe() {
        this.empathic_accuracy = Math.max(0.2, this.empathic_accuracy - 0.0005);
    }
    
    receive_emotion(entity_id, emotion, intensity = 0.5) {
        this.others_valence[entity_id] = emotion;
        this.emotional_contagion = Math.min(1.0, this.emotional_contagion + intensity * 0.1);
        if (emotion < 0) {
            this.empathic_concern = Math.min(1.0, this.empathic_concern + 0.05);
        }
    }
    
    infer_emotion(observed_behavior) {
        const behaviors = {
            'smiling': 'joy',
            'crying': 'sadness',
            'shaking': 'fear',
            'angry': 'anger',
            'hugging': 'affection',
            'withdrawn': 'sadness',
        };
        for (const [key, emotion] of Object.entries(behaviors)) {
            if (observed_behavior.includes(key)) {
                this.empathic_accuracy = Math.min(1.0, this.empathic_accuracy + 0.02);
                return emotion;
            }
        }
        return 'neutral';
    }
    
    take_perspective(entity_id) {
        this.perspective_taking = Math.min(1.0, this.perspective_taking + 0.03);
    }
    
    respond_with_care(entity_id, response) {
        if (response === 'support') {
            this.empathic_concern = Math.min(1.0, this.empathic_concern + 0.1);
        }
    }
    
    mirror_emotion(emotion) {
        const mirror_intensity = this.emotional_contagion;
        return { mirrored: emotion, intensity: mirror_intensity };
    }

    // NERVES: trust derived live from concern+accuracy. Readers asked for
    // `.trust` and got undefined forever — now it exists and moves.
    get trust() {
        return Math.min(1.0, (this.empathic_concern * 0.6) + (this.empathic_accuracy * 0.4));
    }
    
    summary() {
        return `accuracy=${this.empathic_accuracy.toFixed(2)} | contagion=${this.emotional_contagion.toFixed(2)} | concern=${this.empathic_concern.toFixed(2)}`;
    }
}

module.exports = { EmpathyChamber };