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
