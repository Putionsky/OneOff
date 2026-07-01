// On-screen piano keyboard so the instrument is playable with no MIDI hardware.
// Supports mouse/touch and a computer-keyboard mapping (a w s e d ... like a
// tracker). Emits the same noteOn/noteOff callbacks as the MIDI input.

const WHITE = [0, 2, 4, 5, 7, 9, 11];
const BLACK = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 }; // pc -> index offset among whites

// Computer keyboard -> semitone offset from the low C of the on-screen range.
const KEYMAP = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16,
};

export class OnScreenKeyboard {
  constructor(el, { lowNote = 48, octaves = 3, onNoteOn, onNoteOff } = {}) {
    this.el = el;
    this.lowNote = lowNote;
    this.octaves = octaves;
    this.onNoteOn = onNoteOn || (() => {});
    this.onNoteOff = onNoteOff || (() => {});
    this.down = new Set();
    this.keyEls = new Map();
    this.render();
    this.bindComputerKeys();
  }

  render() {
    this.el.innerHTML = '';
    this.el.classList.add('keyboard');
    const total = this.octaves * 12;
    // Whites first (flow layout), blacks absolutely positioned over them.
    let whiteIndex = 0;
    const whiteWidthPct = 100 / (this.octaves * 7);
    for (let i = 0; i <= total; i++) {
      const midi = this.lowNote + i;
      const pc = midi % 12;
      if (WHITE.includes(pc)) {
        const k = document.createElement('div');
        k.className = 'key white';
        k.dataset.midi = midi;
        k.style.width = whiteWidthPct + '%';
        this.attach(k, midi);
        this.el.appendChild(k);
        this.keyEls.set(midi, k);
        whiteIndex++;
      }
    }
    // Black keys
    whiteIndex = 0;
    for (let i = 0; i <= total; i++) {
      const midi = this.lowNote + i;
      const pc = midi % 12;
      if (WHITE.includes(pc)) {
        whiteIndex++;
      } else {
        const k = document.createElement('div');
        k.className = 'key black';
        k.dataset.midi = midi;
        k.style.left = (whiteIndex * whiteWidthPct - whiteWidthPct * 0.3) + '%';
        k.style.width = whiteWidthPct * 0.6 + '%';
        this.attach(k, midi);
        this.el.appendChild(k);
        this.keyEls.set(midi, k);
      }
    }
  }

  attach(el, midi) {
    const press = (e) => {
      e.preventDefault();
      this.press(midi);
    };
    const release = (e) => {
      e.preventDefault();
      this.release(midi);
    };
    el.addEventListener('mousedown', press);
    el.addEventListener('mouseup', release);
    el.addEventListener('mouseleave', (e) => {
      if (this.down.has(midi)) release(e);
    });
    el.addEventListener('touchstart', press, { passive: false });
    el.addEventListener('touchend', release, { passive: false });
  }

  press(midi) {
    if (this.down.has(midi)) return;
    this.down.add(midi);
    const el = this.keyEls.get(midi);
    if (el) el.classList.add('held');
    this.onNoteOn(midi, 100);
  }

  release(midi) {
    if (!this.down.has(midi)) return;
    this.down.delete(midi);
    const el = this.keyEls.get(midi);
    if (el) el.classList.remove('held');
    this.onNoteOff(midi);
  }

  // Tint the keys that belong to the inferred scale, and mark its tonic, so the
  // player can see the tonal space the engine is moving through.
  highlightScale(scalePcs, rootPc) {
    const set = new Set(scalePcs || []);
    for (const [midi, el] of this.keyEls) {
      const pc = ((midi % 12) + 12) % 12;
      el.classList.toggle('in-scale', set.has(pc));
      el.classList.toggle('tonic', rootPc != null && pc === rootPc);
    }
  }

  // Visually flash a key when the engine itself sounds a note.
  flash(midi) {
    const el = this.keyEls.get(midi);
    if (!el) return;
    el.classList.add('sounding');
    setTimeout(() => el.classList.remove('sounding'), 140);
  }

  bindComputerKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey) return;
      const off = KEYMAP[e.key.toLowerCase()];
      if (off == null) return;
      this.press(this.lowNote + 12 + off); // start an octave up for comfort
    });
    window.addEventListener('keyup', (e) => {
      const off = KEYMAP[e.key.toLowerCase()];
      if (off == null) return;
      this.release(this.lowNote + 12 + off);
    });
  }
}
