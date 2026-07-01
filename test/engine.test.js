import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRng, gaussian } from '../src/engine/rng.js';
import {
  detectChord,
  pitchClass,
  noteName,
  extensionPcs,
} from '../src/engine/music.js';
import { buildVoicing } from '../src/engine/voicing.js';
import { ScaleTracker } from '../src/engine/scale.js';
import { notesToMidi } from '../src/engine/midifile.js';
import { Performer, DEFAULT_PARAMS } from '../src/engine/performer.js';

// --- RNG -------------------------------------------------------------------

test('rng is deterministic for a given seed', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('gaussian stays centered and bounded', () => {
  const rng = makeRng(7);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < 5000; i++) {
    const g = gaussian(rng);
    sum += g;
    max = Math.max(max, Math.abs(g));
  }
  assert.ok(Math.abs(sum / 5000) < 0.05, 'mean near zero');
  assert.ok(max < 2.5, 'tails are bounded');
});

// --- Chord detection -------------------------------------------------------

test('detects a C major triad', () => {
  const c = detectChord([60, 64, 67]); // C E G
  assert.equal(noteName(c.root + 60).slice(0, -1), 'C');
  assert.equal(c.quality, 'maj');
});

test('detects a Dm7', () => {
  const c = detectChord([62, 65, 69, 72]); // D F A C
  assert.equal(pitchClass(c.root), 2); // D
  assert.equal(c.quality, 'min7');
});

test('detects a G dominant 7', () => {
  const c = detectChord([67, 71, 74, 77]); // G B D F
  assert.equal(pitchClass(c.root), 7); // G
  assert.equal(c.quality, 'dom7');
});

test('single note never crashes the detector', () => {
  const c = detectChord([60]);
  assert.ok(c);
  assert.equal(pitchClass(c.root), 0);
});

// --- Voicing ---------------------------------------------------------------

test('voicing places bass below the right hand', () => {
  const chord = detectChord([60, 64, 67]);
  const rng = makeRng(1);
  const v = buildVoicing(chord, DEFAULT_PARAMS, rng);
  assert.ok(v.voices.length >= 2);
  assert.ok(v.bass < Math.min(...v.voices), 'bass under voices');
  for (const m of v.all) assert.ok(m >= 0 && m <= 127);
});

test('spread widens the voicing range', () => {
  const chord = detectChord([60, 64, 67, 71]);
  const close = buildVoicing(chord, { ...DEFAULT_PARAMS, spread: 0.0 }, makeRng(3));
  const wide = buildVoicing(chord, { ...DEFAULT_PARAMS, spread: 1.0 }, makeRng(3));
  const span = (v) => Math.max(...v.all) - Math.min(...v.all);
  assert.ok(span(wide) >= span(close), 'wider spread => larger or equal range');
});

test('selection adds color tones beyond the literal chord', () => {
  const chord = detectChord([60, 64, 67]); // C major triad: 3 pcs
  const literal = buildVoicing(chord, { ...DEFAULT_PARAMS, selection: 0 }, makeRng(9));
  const rich = buildVoicing(chord, { ...DEFAULT_PARAMS, selection: 1 }, makeRng(9));
  const pcs = (v) => new Set(v.voices.map(pitchClass));
  assert.ok(pcs(rich).size >= pcs(literal).size, 'more distinct tones with selection');
  assert.ok(extensionPcs(chord).length > 0);
});

// --- Scale tracking --------------------------------------------------------

test('a ii-V-I in C is heard as C major', () => {
  const t = new ScaleTracker();
  t.observeChord(detectChord([62, 65, 69, 72])); // Dm7
  t.observeChord(detectChord([67, 71, 74, 77])); // G7
  t.observeChord(detectChord([60, 64, 67, 71])); // Cmaj7
  const s = t.estimate();
  assert.equal(pitchClass(s.tonic), 0, 'tonic C');
  assert.equal(s.mode, 'major');
  assert.deepEqual(s.scalePcs, [0, 2, 4, 5, 7, 9, 11]);
});

test('a minor ii-V-i is heard as a minor key', () => {
  const t = new ScaleTracker();
  t.observeChord(detectChord([62, 65, 68, 72])); // Dm7b5
  t.observeChord(detectChord([64, 68, 71, 74])); // E7(ish)
  t.observeChord(detectChord([57, 60, 64, 67])); // Am7
  const s = t.estimate();
  assert.equal(pitchClass(s.tonic), 9, 'tonic A');
  assert.equal(s.mode, 'minor');
});

test('the most recent chord dominates a key change', () => {
  const t = new ScaleTracker({ decay: 0.5 });
  // Establish C major, then move firmly to E-flat major territory.
  t.observeChord(detectChord([60, 64, 67])); // C
  t.observeChord(detectChord([67, 71, 74])); // G
  const before = t.estimate();
  // C and G establish sharp-side territory (no flats).
  assert.ok(!before.scalePcs.includes(10), 'no Bb in the initial key');
  t.observeChord(detectChord([63, 67, 70])); // Eb
  t.observeChord(detectChord([58, 62, 65])); // Bb
  t.observeChord(detectChord([63, 67, 70])); // Eb again
  const after = t.estimate();
  assert.notEqual(after.tonic, before.tonic, 'key followed the new context');
  assert.ok(after.scalePcs.includes(10), 'flat-side key after the move (contains Bb)');
});

test('no observations yields no scale', () => {
  const t = new ScaleTracker();
  assert.equal(t.estimate(), null);
});

test('performer exposes a contextual scale after a chord is played', () => {
  const p = new Performer({ seed: 3 });
  assert.equal(p.getScale(), null);
  p.setHeldNotes([60, 64, 67, 71]); // Cmaj7
  const s = p.getScale();
  assert.ok(s, 'scale inferred');
  assert.equal(pitchClass(s.tonic), 0);
  assert.ok(Array.isArray(s.scalePcs) && s.scalePcs.length === 7);
});

// --- Voice leading ---------------------------------------------------------

test('voice leading holds common tones and moves others minimally', () => {
  // C major -> A minor share C and E; only one voice should need to move.
  const cMaj = detectChord([60, 64, 67]);
  const aMin = detectChord([57, 60, 64]);
  const params = { ...DEFAULT_PARAMS, spread: 0, selection: 0 };
  const v1 = buildVoicing(cMaj, params, makeRng(1));
  const v2 = buildVoicing(aMin, params, makeRng(1), v1.voices);
  // Total motion of the led voicing should be small — no big block jump.
  const nearestMove = (note, set) => Math.min(...set.map((s) => Math.abs(s - note)));
  const motion = v2.voices.reduce((sum, n) => sum + nearestMove(n, v1.voices), 0);
  assert.ok(motion <= 4, `smooth voice leading, total motion ${motion}`);
});

test('without history a voicing still forms around the middle register', () => {
  const v = buildVoicing(detectChord([60, 64, 67]), DEFAULT_PARAMS, makeRng(1));
  assert.ok(v.voices.every((m) => m > 40 && m < 96));
});

// --- MIDI file export ------------------------------------------------------

test('notesToMidi produces a valid Standard MIDI File', () => {
  const notes = [
    { midi: 60, velocity: 90, time: 0, duration: 0.5 },
    { midi: 64, velocity: 80, time: 0.5, duration: 0.5 },
    { midi: 67, velocity: 100, time: 1.0, duration: 0.5 },
  ];
  const bytes = notesToMidi(notes, { bpm: 120, ppq: 480 });
  const ascii = (arr) => String.fromCharCode(...arr);
  assert.equal(ascii(bytes.slice(0, 4)), 'MThd', 'header magic');
  // Track chunk present somewhere after the 14-byte header.
  let hasTrack = false;
  for (let i = 0; i < bytes.length - 3; i++) {
    if (ascii(bytes.slice(i, i + 4)) === 'MTrk') hasTrack = true;
  }
  assert.ok(hasTrack, 'track chunk present');
  assert.ok(bytes.some((b) => (b & 0xf0) === 0x90), 'contains a note-on status');
  assert.ok(bytes.length > 20, 'non-trivial length');
});

test('empty performance still yields a well-formed (silent) MIDI file', () => {
  const bytes = notesToMidi([], { bpm: 96 });
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
});

// --- Latch / hold ----------------------------------------------------------

test('latch keeps the chord sounding after keys are released', () => {
  const p = new Performer({ seed: 1 });
  p.setLatch(true);
  p.noteOn(60);
  p.noteOn(64);
  p.noteOn(67);
  p.noteOff(60);
  p.noteOff(64);
  p.noteOff(67);
  assert.ok(p.chord, 'chord still latched after release');
  assert.equal(p.heldNotes.size, 3);
});

test('a fresh grab replaces the latched chord', () => {
  const p = new Performer({ seed: 1 });
  p.setLatch(true);
  p.noteOn(60); p.noteOn(64); p.noteOn(67); // C
  p.noteOff(60); p.noteOff(64); p.noteOff(67);
  p.noteOn(65); p.noteOn(69); p.noteOn(72); // F — new grab
  assert.equal(pitchClass(p.chord.root), 5, 'new chord is F');
  assert.equal(p.heldNotes.size, 3);
});

test('clear() silences everything', () => {
  const p = new Performer({ seed: 1 });
  p.noteOn(60); p.noteOn(64);
  p.clear();
  assert.equal(p.chord, null);
  assert.equal(p.heldNotes.size, 0);
});

// --- Phrase dynamics -------------------------------------------------------

test('phrase dynamics swell toward the middle of a phrase', () => {
  // Compare average melody/inner velocity in an early bar vs. a mid-phrase bar.
  const p = new Performer({ seed: 4, bpm: 120, params: { ...DEFAULT_PARAMS, density: 0.7 } });
  const ev = p.renderBars([60, 64, 67, 71], 4);
  const barLen = (60 / 120) * 4;
  const avgIn = (lo, hi) => {
    const xs = ev.filter((e) => e.time >= lo && e.time < hi && e.role !== 'bass');
    return xs.reduce((s, e) => s + e.velocity, 0) / Math.max(1, xs.length);
  };
  const early = avgIn(0, barLen);            // phrase start (softer)
  const mid = avgIn(barLen * 1.5, barLen * 2.5); // phrase middle (louder)
  assert.ok(mid > early - 2, `mid-phrase (${mid.toFixed(1)}) not softer than start (${early.toFixed(1)})`);
});

// --- Performer integration -------------------------------------------------

test('renders notes for a held chord', () => {
  const p = new Performer({ seed: 5, bpm: 100 });
  const events = p.renderBars([60, 64, 67], 2);
  assert.ok(events.length > 0, 'produced events');
  for (const e of events) {
    assert.ok(e.midi >= 0 && e.midi <= 127, 'valid midi');
    assert.ok(e.velocity >= 1 && e.velocity <= 127, 'valid velocity');
    assert.ok(e.duration > 0, 'positive duration');
    assert.ok(e.time >= 0, 'non-negative time');
  }
});

test('events are time-ordered and within the rendered window', () => {
  const p = new Performer({ seed: 11, bpm: 120 });
  const events = p.renderBars([62, 65, 69, 72], 2);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].time >= events[i - 1].time - 0.2, 'roughly ordered');
  }
  const barLen = (60 / 120) * 4;
  assert.ok(Math.max(...events.map((e) => e.time)) < barLen * 2 + 1);
});

test('higher density produces more notes than lower density', () => {
  const sparse = new Performer({ seed: 21, bpm: 100, params: { ...DEFAULT_PARAMS, density: 0.1 } });
  const busy = new Performer({ seed: 21, bpm: 100, params: { ...DEFAULT_PARAMS, density: 0.95 } });
  const ns = sparse.renderBars([60, 64, 67], 4).length;
  const nb = busy.renderBars([60, 64, 67], 4).length;
  assert.ok(nb > ns, `busy(${nb}) should exceed sparse(${ns})`);
});

test('timing=0 is near-quantized; timing=1 spreads notes off the grid', () => {
  const mkSpread = (timing) => {
    const p = new Performer({ seed: 33, bpm: 120, params: { ...DEFAULT_PARAMS, timing } });
    const ev = p.renderBars([60, 64, 67], 4);
    const stepDur = p.secondsPerStep();
    // measure how far note times sit from the nearest grid line
    let total = 0;
    for (const e of ev) {
      const nearest = Math.round(e.time / stepDur) * stepDur;
      total += Math.abs(e.time - nearest);
    }
    return total / ev.length;
  };
  const tight = mkSpread(0);
  const loose = mkSpread(1);
  assert.ok(loose > tight, `loose(${loose.toFixed(4)}) > tight(${tight.toFixed(4)})`);
});

test('empty chord yields silence', () => {
  const p = new Performer({ seed: 1 });
  const events = p.renderBars([], 2);
  assert.equal(events.length, 0);
});

test('changing the held chord re-voices on the next note', () => {
  const p = new Performer({ seed: 2, bpm: 120 });
  p.setHeldNotes([60, 64, 67]);
  const v1 = p.voicing.voices.slice();
  p.setHeldNotes([65, 69, 72]); // F major
  const v2 = p.voicing.voices.slice();
  assert.notDeepEqual(v1, v2, 'voicing updated for the new chord');
});
