// App: wires the performance engine to audio out, MIDI in/out, the on-screen
// keyboard, and the control panel. This is the only browser-specific glue; the
// musical brain lives in src/engine and stays portable.

import { Performer, DEFAULT_PARAMS } from './engine/performer.js';
import { noteName } from './engine/music.js';
import { notesToMidi } from './engine/midifile.js';
import { PianoSynth } from './audio/piano.js';
import { MidiInput } from './midi/input.js';
import { MidiOutput } from './midi/output.js';
import { OnScreenKeyboard } from './ui/keyboard.js';

const SETTINGS_KEY = 'hpp.settings.v1';

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

    this.recording = false;
    this.recordStart = 0;
    this.recorded = [];       // captured performance for MIDI export
    this.saved = this.loadSettings();

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
    // Capture the generated performance for MIDI export.
    if (this.recording) {
      this.recorded.push({
        midi: n.midi,
        velocity: n.velocity,
        time: Math.max(0, n.time - this.recordStart),
        duration: n.duration,
      });
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
    if (el) {
      const c = this.performer.chord;
      if (!c) {
        el.textContent = '—';
        el.classList.remove('active');
      } else {
        el.textContent = `${noteName(c.root + 60).slice(0, -1)} ${c.quality}`;
        el.classList.add('active');
      }
    }

    // Inferred scale persists once played, even after the keys are released —
    // it's the running tonal context, not just the chord under the hands.
    const scaleEl = document.getElementById('scale-readout');
    if (scaleEl) {
      const s = this.performer.getScale();
      if (!s) {
        scaleEl.textContent = '—';
        scaleEl.classList.remove('active');
      } else {
        // Dim the readout when the engine isn't confident about the key yet.
        scaleEl.textContent = s.name;
        scaleEl.classList.add('active');
        scaleEl.style.opacity = (0.55 + Math.min(0.45, s.confidence)).toFixed(2);
      }
    }

    // Paint the inferred scale onto the on-screen keyboard.
    const s = this.performer.getScale();
    if (this.keyboard) {
      this.keyboard.highlightScale(s ? s.scalePcs : [], s ? s.tonic : null);
    }
  }

  // --- Settings persistence -------------------------------------------------

  loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.params) this.performer.setParams(s.params);
      if (s.bpm) this.performer.setTempo(s.bpm);
      return s;
    } catch (e) {
      return null;
    }
  }

  saveSettings() {
    try {
      const pedalEl = document.getElementById('pedal');
      const latchEl = document.getElementById('latch');
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        params: this.performer.params,
        bpm: this.performer.bpm,
        pedal: pedalEl ? pedalEl.checked : true,
        latch: latchEl ? latchEl.checked : false,
      }));
    } catch (e) { /* storage unavailable — ignore */ }
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
        if (spec.key === 'spread') this.synth.setStereoWidth(v);
        this.saveSettings();
      });
    }
    this.synth.setWarmth(this.performer.params.warmth);
    this.synth.setStereoWidth(this.performer.params.spread);
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
      this.saveSettings();
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
      this.saveSettings();
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
    if (this.saved && this.saved.pedal != null) pedal.checked = this.saved.pedal;
    this.synth.pedal = pedal.checked;
    pedal.addEventListener('change', () => {
      this.synth.pedal = pedal.checked;
      this.saveSettings();
    });

    // Latch / hold
    const latch = document.getElementById('latch');
    if (this.saved && this.saved.latch != null) latch.checked = this.saved.latch;
    this.performer.setLatch(latch.checked);
    latch.addEventListener('change', () => {
      this.performer.setLatch(latch.checked);
      this.updateChordReadout();
      this.saveSettings();
    });

    // Panic / all notes off
    document.getElementById('panic').addEventListener('click', () => this.panic());

    // Record → download a .mid of the generated performance
    document.getElementById('record').addEventListener('click', (e) => this.toggleRecord(e.target));

    // Randomize the performance controls to a fresh, musical combination
    document.getElementById('randomize').addEventListener('click', () => this.randomize());

    // Reflect any saved tempo into the slider.
    if (this.saved && this.saved.bpm) {
      tempo.value = this.performer.bpm;
      tempoVal.textContent = this.performer.bpm;
    }
  }

  panic() {
    this.performer.clear();
    if (this.synth.allNotesOff) this.synth.allNotesOff();
    if (this.useMidiOut) this.midiOut.allNotesOff && this.midiOut.allNotesOff();
    this.updateChordReadout();
  }

  toggleRecord(btn) {
    if (!this.recording) {
      this.recording = true;
      this.recorded = [];
      this.recordStart = this.synth.now();
      btn.textContent = '■ Stop & save';
      btn.classList.add('recording');
    } else {
      this.recording = false;
      btn.textContent = '● Record MIDI';
      btn.classList.remove('recording');
      this.downloadMidi();
    }
  }

  downloadMidi() {
    if (!this.recorded.length) return;
    const bytes = notesToMidi(this.recorded, { bpm: this.performer.bpm });
    const blob = new Blob([bytes], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `piano-performance-${Date.now()}.mid`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  randomize() {
    // Musically sensible ranges — never fully robotic, never total chaos.
    const r = (min, max) => min + Math.random() * (max - min);
    const params = {
      density: r(0.2, 0.9),
      timing: r(0.25, 0.8),
      warmth: r(0.3, 0.9),
      spread: r(0.2, 0.9),
      selection: r(0.2, 0.8),
    };
    this.setAllControls(params);
    this.saveSettings();
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
