// Performer: the real-time brain. It holds the currently-held chord, rebuilds a
// voicing when that chord changes, and walks a step clock that emits humanized
// note events. It knows nothing about audio or MIDI hardware — callers wire its
// output to a synth, a MIDI port, or an offline buffer for tests.

import { detectChord } from './music.js';
import { buildVoicing } from './voicing.js';
import { generateStep, makeWalkState } from './patterns.js';
import { ScaleTracker } from './scale.js';
import { makeRng } from './rng.js';

export const DEFAULT_PARAMS = {
  density: 0.5,    // sparse, ringing  <->  busy, flowing
  timing: 0.5,     // tight/quantized  <->  loose, swung, rolled
  warmth: 0.5,     // bright/hard      <->  soft, round, legato
  spread: 0.5,     // close voicing    <->  wide, open, two-handed
  selection: 0.4,  // literal chord    <->  extensions, passing tones
};

export class Performer {
  constructor(options = {}) {
    this.params = { ...DEFAULT_PARAMS, ...(options.params || {}) };
    this.bpm = options.bpm || 96;
    this.stepsPerBar = options.stepsPerBar || 16; // 16th notes in 4/4
    this.barsPerPhrase = options.barsPerPhrase || 4;
    this.rng = makeRng(options.seed ?? 1234);

    this.chord = null;        // detected chord object
    this.voicing = null;      // current target voicing
    this.heldNotes = new Set();     // notes the engine is currently performing
    this.physicallyHeld = new Set(); // keys actually down (differs under latch)
    this.latch = false;
    this.walk = makeWalkState();

    // Contextual key/scale inference across the chords played so far.
    this.scaleTracker = new ScaleTracker({ decay: options.scaleDecay ?? 0.55 });
    this.currentScale = null;  // last estimate(): { tonic, mode, scalePcs, name, confidence }

    this.stepIndex = 0;       // absolute step counter since start
    this.nextStepTime = 0;    // absolute time (seconds) of the next step
    this.running = false;

    // Emitted when a note should sound: { midi, velocity, time, duration, role }.
    this.onNote = options.onNote || (() => {});
  }

  secondsPerBeat() {
    return 60 / this.bpm;
  }

  secondsPerStep() {
    return this.secondsPerBeat() * (4 / this.stepsPerBar);
  }

  setTempo(bpm) {
    this.bpm = Math.max(20, Math.min(300, bpm));
  }

  setParams(partial) {
    this.params = { ...this.params, ...partial };
  }

  // Update the set of held MIDI notes. Rebuilds the voicing only when the actual
  // chord (pitch-class content) changes, so re-voicing a sustained chord doesn't
  // jitter the part.
  setHeldNotes(notes) {
    this.heldNotes = new Set(notes);
    const arr = [...this.heldNotes];
    if (arr.length === 0) {
      this.chord = null;
      this.voicing = null;
      return;
    }
    const next = detectChord(arr);
    const sameChord =
      this.chord &&
      this.chord.root === next.root &&
      this.chord.quality === next.quality &&
      this.chord.bass === next.bass;
    this.chord = next;
    if (!sameChord) {
      // Feed the outgoing voicing in so the new chord leads its voices smoothly
      // from the last one instead of jumping to a fresh block.
      const prevVoices = this.voicing ? this.voicing.voices : null;
      this.voicing = buildVoicing(next, this.params, this.rng, prevVoices);
      // Keep the walk valid for the new voicing length.
      this.walk.arpIndex = Math.min(
        this.walk.arpIndex,
        Math.max(0, this.voicing.voices.length - 1),
      );
      // Fold the new chord into the running key estimate and refresh the scale
      // the part should move within.
      this.scaleTracker.observeChord(next);
      this.currentScale = this.scaleTracker.estimate();
    }
  }

  // Current contextual scale estimate, or null before any chord is played.
  getScale() {
    return this.currentScale;
  }

  // Latch/hold: when on, the chord keeps sounding after the keys are released,
  // and the next fresh key-press starts a new chord. Lets you play a progression
  // one grab at a time and leave your hands free.
  setLatch(on) {
    this.latch = !!on;
    if (!this.latch) this.setHeldNotes([...this.physicallyHeld]);
  }

  noteOn(midi) {
    const wasEmpty = this.physicallyHeld.size === 0;
    this.physicallyHeld.add(midi);
    if (this.latch && wasEmpty) {
      // A new grab after everything was released: replace the latched chord.
      this.setHeldNotes([midi]);
    } else if (this.latch) {
      const set = new Set(this.heldNotes);
      set.add(midi);
      this.setHeldNotes([...set]);
    } else {
      this.setHeldNotes([...this.physicallyHeld]);
    }
  }

  noteOff(midi) {
    this.physicallyHeld.delete(midi);
    if (!this.latch) this.setHeldNotes([...this.physicallyHeld]);
    // In latch mode the sounding chord is intentionally kept after release.
  }

  // Panic / all-notes-off: forget every held and latched note and go silent.
  clear() {
    this.physicallyHeld.clear();
    this.setHeldNotes([]);
  }

  start(time = 0) {
    this.running = true;
    this.stepIndex = 0;
    this.nextStepTime = time;
    this.walk = makeWalkState();
  }

  stop() {
    this.running = false;
  }

  // Lookahead scheduler entry point. Call this frequently (e.g. every 25ms in
  // the browser). It emits every step whose time falls before
  // currentTime + lookahead, advancing the clock as it goes.
  schedule(currentTime, lookahead = 0.1) {
    if (!this.running) return;
    while (this.nextStepTime < currentTime + lookahead) {
      this.emitStep(this.nextStepTime);
      this.nextStepTime += this.secondsPerStep();
      this.stepIndex += 1;
    }
  }

  // Generate and emit the events for the current step at absolute time t.
  emitStep(t) {
    if (!this.voicing) return;
    const step = ((this.stepIndex % this.stepsPerBar) + this.stepsPerBar) % this.stepsPerBar;
    const bar = Math.floor(this.stepIndex / this.stepsPerBar);
    // Position within a repeating phrase (default 4 bars) so the engine can
    // shape long-breath dynamics and end-of-phrase rubato.
    const phraseSteps = this.barsPerPhrase * this.stepsPerBar;
    const phrasePos = (((this.stepIndex % phraseSteps) + phraseSteps) % phraseSteps) / phraseSteps;
    const ctx = {
      step,
      stepsPerBar: this.stepsPerBar,
      bar,
      phrasePos,
      keyScale: this.currentScale ? this.currentScale.scalePcs : null,
    };
    const events = generateStep(this.voicing, this.params, ctx, this.walk, this.rng);
    const spb = this.secondsPerBeat();
    for (const e of events) {
      const time = t + e.timeOffsetBeats * spb;
      this.onNote({
        midi: e.midi,
        velocity: e.velocity,
        time: Math.max(0, time),
        duration: e.durationBeats * spb,
        role: e.role,
      });
    }
  }

  // Offline render: play a fixed chord for `bars` bars and collect every event
  // with absolute times starting at 0. Used by tests and for quick auditioning.
  renderBars(notes, bars = 2) {
    this.setHeldNotes(notes);
    this.start(0);
    const collected = [];
    const original = this.onNote;
    this.onNote = (n) => collected.push(n);
    const totalSteps = bars * this.stepsPerBar;
    const stepDur = this.secondsPerStep();
    for (let i = 0; i < totalSteps; i++) {
      this.emitStep(i * stepDur);
      this.stepIndex += 1;
    }
    this.onNote = original;
    this.stop();
    return collected.sort((a, b) => a.time - b.time);
  }
}
