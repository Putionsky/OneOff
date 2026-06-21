// App: wires the performance engine to audio out, MIDI in/out, the on-screen
// keyboard, and the control panel. This is the only browser-specific glue; the
// musical brain lives in src/engine and stays portable.

import { Performer, DEFAULT_PARAMS } from './engine/performer.js';
import { noteName } from './engine/music.js';
import { PianoSynth } from './audio/piano.js';
import { MidiInput } from './midi/input.js';
import { MidiOutput } from './midi/output.js';
import { OnScreenKeyboard } from './ui/keyboard.js';

const PARAM_SPEC = [
  {
    key: 'density',
    label: 'Density',
    blurb: 'Sparse, ringing chords → busy, flowing lines.',
  },
  {
    key: 'timing',
    label: 'Timing',
    blurb: 'Tight & quantized → loose, swung, rolled — the give-and-take of a real hand.',
  },
  {
    key: 'warmth',
    label: 'Warmth',
    blurb: 'Bright & hard → soft, round, pedaled and legato.',
  },
  {
    key: 'spread',
    label: 'Spread',
    blurb: 'Close, one-register voicing → wide, open, two-handed.',
  },
  {
    key: 'selection',
    label: 'Note selection',
    blurb: 'Play the literal chord → add extensions, color tones & passing notes.',
  },
];

const PRESETS = {
  'Ballad': { density: 0.22, timing: 0.6, warmth: 0.85, spread: 0.6, selection: 0.5, bpm: 72 },
  'Flowing arpeggio': { density: 0.8, timing: 0.45, warmth: 0.55, spread: 0.65, selection: 0.45, bpm: 104 },
  'Jazz comp': { density: 0.45, timing: 0.7, warmth: 0.6, spread: 0.5, selection: 0.85, bpm: 120 },
  'Cinematic': { density: 0.3, timing: 0.5, warmth: 0.95, spread: 0.9, selection: 0.6, bpm: 60 },
  'Driving pop': { density: 0.7, timing: 0.25, warmth: 0.4, spread: 0.45, selection: 0.3, bpm: 124 },
};

class App {
  constructor() {
    this.synth = new PianoSynth();
    this.performer = new Performer({ params: { ...DEFAULT_PARAMS }, bpm: 96, seed: 1234 });
    this.useMidiOut = false;
    this.monitorInput = true; // hear the raw keys you press
    this.timeOffset = 0;      // audioCtx time -> performance.now() bridge for MIDI out

    this.performer.onNote = (n) => this.emit(n);

    this.midiIn = new MidiInput({
      onNoteOn: (m, v) => this.handleNoteOn(m, v),
      onNoteOff: (m) => this.handleNoteOff(m),
      onPorts: (ports) => this.fillPorts('midi-in', ports, 'No MIDI inputs'),
    });
    this.midiOut = new MidiOutput({
      onPorts: (ports) => this.fillPorts('midi-out', ports, 'No MIDI outputs'),
    });
  }

  async init() {
    this.buildControls();
    this.buildKeyboard();
    this.buildTransport();
    this.startScheduler();
    this.updateChordReadout();
  }

  // --- Audio/MIDI emission --------------------------------------------------

  emit(n) {
    if (this.useMidiOut) {
      const whenSec = performance.now() / 1000 + (n.time - this.synth.now());
      this.midiOut.play(n.midi, n.velocity, whenSec, n.duration);
    } else {
      this.synth.play(n.midi, n.velocity, n.time, n.duration);
    }
    // Visual feedback slightly ahead of the sound.
    const lead = Math.max(0, (n.time - this.synth.now()) * 1000);
    setTimeout(() => this.keyboard && this.keyboard.flash(n.midi), lead);
  }

  // --- Input handling -------------------------------------------------------

  async handleNoteOn(midi, vel) {
    await this.synth.ensureStarted();
    this.performer.noteOn(midi);
    if (this.monitorInput && !this.useMidiOut) {
      this.synth.play(midi, Math.min(vel, 70), null, 0.5);
    }
    this.updateChordReadout();
  }

  handleNoteOff(midi) {
    this.performer.noteOff(midi);
    this.updateChordReadout();
  }

  updateChordReadout() {
    const el = document.getElementById('chord-readout');
    if (!el) return;
    const c = this.performer.chord;
    if (!c) {
      el.textContent = '—';
      el.classList.remove('active');
      return;
    }
    el.textContent = `${noteName(c.root + 60).slice(0, -1)} ${c.quality}`;
    el.classList.add('active');
  }

  // --- Scheduler ------------------------------------------------------------

  startScheduler() {
    this.performer.start(this.synth.now ? 0 : 0);
    // We (re)anchor the performer clock to the audio clock on first sound.
    this.scheduleAnchored = false;
    setInterval(() => {
      if (!this.synth.ctx) return;
      if (!this.scheduleAnchored) {
        this.performer.start(this.synth.now());
        this.scheduleAnchored = true;
      }
      this.performer.schedule(this.synth.now(), 0.12);
    }, 25);
  }

  // --- UI construction ------------------------------------------------------

  buildControls() {
    const host = document.getElementById('controls');
    for (const spec of PARAM_SPEC) {
      const wrap = document.createElement('div');
      wrap.className = 'control';
      const value = this.performer.params[spec.key];
      wrap.innerHTML = `
        <div class="control-head">
          <label for="ctl-${spec.key}">${spec.label}</label>
          <span class="control-value" id="val-${spec.key}">${Math.round(value * 100)}</span>
        </div>
        <input type="range" min="0" max="100" value="${Math.round(value * 100)}"
               id="ctl-${spec.key}" />
        <p class="blurb">${spec.blurb}</p>`;
      host.appendChild(wrap);
      const input = wrap.querySelector('input');
      input.addEventListener('input', () => {
        const v = Number(input.value) / 100;
        this.performer.setParams({ [spec.key]: v });
        document.getElementById('val-' + spec.key).textContent = input.value;
        if (spec.key === 'warmth') this.synth.setWarmth(v);
      });
    }
    this.synth.setWarmth(this.performer.params.warmth);
  }

  setAllControls(params) {
    for (const spec of PARAM_SPEC) {
      if (params[spec.key] == null) continue;
      const input = document.getElementById('ctl-' + spec.key);
      input.value = Math.round(params[spec.key] * 100);
      input.dispatchEvent(new Event('input'));
    }
  }

  buildKeyboard() {
    const el = document.getElementById('keyboard');
    this.keyboard = new OnScreenKeyboard(el, {
      lowNote: 48,
      octaves: 3,
      onNoteOn: (m, v) => this.handleNoteOn(m, v),
      onNoteOff: (m) => this.handleNoteOff(m),
    });
  }

  buildTransport() {
    // Tempo
    const tempo = document.getElementById('tempo');
    const tempoVal = document.getElementById('tempo-val');
    tempo.value = this.performer.bpm;
    tempoVal.textContent = this.performer.bpm;
    tempo.addEventListener('input', () => {
      this.performer.setTempo(Number(tempo.value));
      tempoVal.textContent = tempo.value;
    });

    // Presets
    const presetSel = document.getElementById('preset');
    presetSel.innerHTML = '<option value="">Presets…</option>' +
      Object.keys(PRESETS).map((n) => `<option>${n}</option>`).join('');
    presetSel.addEventListener('change', () => {
      const p = PRESETS[presetSel.value];
      if (!p) return;
      this.performer.setTempo(p.bpm);
      tempo.value = p.bpm;
      tempoVal.textContent = p.bpm;
      this.setAllControls(p);
    });

    // Start audio (browsers require a user gesture)
    const startBtn = document.getElementById('start-audio');
    startBtn.addEventListener('click', async () => {
      await this.synth.ensureStarted();
      startBtn.textContent = 'Audio running';
      startBtn.disabled = true;
      this.connectMidi();
    });

    // Output routing
    const outToggle = document.getElementById('out-mode');
    outToggle.addEventListener('change', () => {
      this.useMidiOut = outToggle.value === 'midi';
      document.getElementById('midi-out').disabled = !this.useMidiOut;
    });

    document.getElementById('midi-in').addEventListener('change', (e) => {
      this.midiIn.selectPort(e.target.value);
    });
    document.getElementById('midi-out').addEventListener('change', (e) => {
      this.midiOut.selectPort(e.target.value);
    });

    const pedal = document.getElementById('pedal');
    pedal.addEventListener('change', () => { this.synth.pedal = pedal.checked; });
  }

  async connectMidi() {
    const ok = await this.midiIn.connect();
    await this.midiOut.connect();
    const status = document.getElementById('midi-status');
    status.textContent = ok
      ? 'MIDI connected — play chords on your controller or the keys below.'
      : 'Web MIDI unavailable — use the on-screen keyboard or computer keys (a w s e d f …).';
  }

  fillPorts(id, ports, emptyLabel) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const all = id === 'midi-in' ? '<option value="">All inputs</option>' : '';
    sel.innerHTML = all + (ports.length
      ? ports.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')
      : `<option value="">${emptyLabel}</option>`);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  window.__app = app; // handy for debugging in the console
});
