// A lightweight Web Audio piano voice.
//
// Not a sampled Steinway — it's a synthesized, slightly FM-flavored piano tone
// that is good enough to audition the performance engine and feels warm under
// the hands. Each note is a couple of detuned partials through a velocity- and
// warmth-sensitive lowpass with a percussive amplitude envelope, plus a soft
// "hammer" transient. A shared convolution-free reverb (feedback delay) adds air.

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class PianoSynth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.warmth = 0.5;
    this.voices = new Map(); // midi -> active voice node (for note-off)
    this.pedal = true;       // sustain: let notes ring past their nominal length
  }

  async ensureStarted() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;

    // Simple stereo-ish ambience: short feedback delay acting as a plate.
    const delay = this.ctx.createDelay(0.5);
    delay.delayTime.value = 0.13;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.28;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.18;
    const damp = this.ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 3200;

    this.master.connect(this.ctx.destination);
    this.master.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wet);
    wet.connect(this.ctx.destination);

    this.reverbIn = delay;

    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setWarmth(w) {
    this.warmth = Math.max(0, Math.min(1, w));
  }

  setMasterGain(g) {
    if (this.master) this.master.gain.value = g;
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // Schedule a note at absolute audio-context time `when` (seconds).
  play(midi, velocity = 90, when = null, duration = 0.5) {
    if (!this.ctx) return;
    const t = when == null ? this.ctx.currentTime : Math.max(when, this.ctx.currentTime);
    const freq = midiToFreq(midi);
    const vel = velocity / 127;

    // Warmth darkens the tone and softens the attack; bright lets harmonics
    // and transient through.
    const warmth = this.warmth;
    const cutoff = 1200 + vel * 5200 * (1.1 - warmth * 0.55) + freq * 1.5;
    const peak = 0.16 + vel * 0.5;

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.value = 0;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(14000, cutoff), t);
    filter.Q.value = 0.6;
    // Tone darkens as the note rings, like a real string losing harmonics.
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(600, cutoff * 0.35),
      t + 0.6,
    );

    // Two partials + a slightly detuned fifth-ish overtone for body.
    const partials = [
      { ratio: 1, type: 'triangle', gain: 1.0, detune: 0 },
      { ratio: 2.0, type: 'sine', gain: 0.45 * (1 - warmth * 0.4), detune: 1.5 },
      { ratio: 3.01, type: 'sine', gain: 0.18 * (1 - warmth * 0.6), detune: -2 },
    ];
    const oscs = partials.map((p) => {
      const o = this.ctx.createOscillator();
      o.type = p.type;
      o.frequency.value = freq * p.ratio;
      o.detune.value = p.detune;
      const g = this.ctx.createGain();
      g.gain.value = p.gain;
      o.connect(g);
      g.connect(filter);
      return o;
    });

    // Hammer transient: a tiny noise burst gives the attack its "thunk".
    const noise = this.ctx.createBufferSource();
    const nb = this.ctx.createBuffer(1, 1024, this.ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nd.length, 3);
    noise.buffer = nb;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = (0.12 + vel * 0.2) * (1 - warmth * 0.5);
    noise.connect(noiseGain);
    noiseGain.connect(filter);

    filter.connect(voiceGain);
    voiceGain.connect(this.master);

    // Amplitude envelope: fast attack, exponential decay; pedal lets it ring.
    const attack = 0.004 + warmth * 0.01;
    const ring = this.pedal ? Math.max(duration, 1.6) : duration;
    voiceGain.gain.setValueAtTime(0, t);
    voiceGain.gain.linearRampToValueAtTime(peak, t + attack);
    voiceGain.gain.exponentialRampToValueAtTime(peak * 0.3, t + 0.18);
    voiceGain.gain.exponentialRampToValueAtTime(0.0008, t + ring);

    const stopAt = t + ring + 0.1;
    oscs.forEach((o) => {
      o.start(t);
      o.stop(stopAt);
    });
    noise.start(t);
    noise.stop(t + 0.05);

    // Track for explicit note-off (live keyboard playing of the dry input).
    const voice = { voiceGain, oscs, stopAt };
    this.voices.set(midi + ':' + t.toFixed(4), voice);
    oscs[0].onended = () => this.voices.delete(midi + ':' + t.toFixed(4));
  }
}
