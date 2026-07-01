// Voicing: turn an abstract chord into actual keys a pianist's two hands would
// hold, shaped by the spread / warmth / selection controls.
//
// The result is a stable target the pattern walker arpeggiates over until the
// chord changes. Keeping voicing and rhythm separate is what lets the same held
// chord produce coherent movement instead of random notes.

import { extensionPcs, scaleForChord, clampMidi, pitchClass } from './music.js';
import { chance, pick, range } from './rng.js';

// Place a pitch class at the octave nearest to a target MIDI note.
function nearestOctave(pc, target) {
  const base = pc + 12 * Math.floor(target / 12);
  let best = base;
  let bestDist = Infinity;
  for (let o = -1; o <= 2; o++) {
    const cand = base + o * 12;
    const d = Math.abs(cand - target);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return clampMidi(best);
}

// Place a pitch class at whatever octave sits closest to an existing set of
// notes — the core of smooth voice leading. Common tones map to themselves
// (distance 0); everything else takes the shortest step.
function placeNearSet(pc, prev) {
  let best = null;
  let bestDist = Infinity;
  for (let m = ((pc % 12) + 12) % 12; m <= 104; m += 12) {
    let d = Infinity;
    for (const p of prev) d = Math.min(d, Math.abs(m - p));
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best;
}

// After voice-leading placement, two voices can land on the same key. Nudge
// duplicates up an octave so the chord keeps all its tones.
function spaceOutCollisions(notes) {
  const sorted = [...notes].sort((a, b) => a - b);
  const out = [];
  for (let n of sorted) {
    while (out.includes(n)) n += 12;
    out.push(clampMidi(n));
  }
  return out;
}

// Build the two-handed voicing for a chord.
//
// params: { spread, warmth, selection } each 0..1
// prevVoices: the previous voicing's right-hand notes, for voice leading (or null).
// Returns { bass, voices, all } where `voices` is the right-hand voicing low->high.
export function buildVoicing(chord, params, rng, prevVoices = null) {
  const { spread, warmth, selection } = params;

  // Warmth pulls the whole voicing into a rounder, lower-mid register and away
  // from the bright/brittle top of the keyboard. Spread lowers the bass anchor
  // and widens the gap between hands.
  const center = Math.round(range(rng, 58, 66) - warmth * 6 + spread * 1);
  const bassTarget = Math.round(48 - spread * 9 - warmth * 2); // C3 down toward C2

  // --- Bass (left hand) -----------------------------------------------------
  // Root in the bass most of the time; occasionally the 5th or 3rd for an
  // inversion when spread/selection invite movement.
  let bassPc = chord.root;
  if (chance(rng, selection * 0.25)) {
    // Inversions are tasteful only on the strong chord tones; the 7th and any
    // color tones turn muddy in the low bass register, so keep to root/3rd/5th.
    const choices = chord.chordTonePcs.slice(0, 3);
    bassPc = pick(rng, choices);
  }
  const bass = nearestOctave(bassPc, bassTarget);

  // --- Right hand -----------------------------------------------------------
  // Start from the literal chord tones. Selection layers in tasteful color
  // tones (9ths, 6ths, etc.); higher selection => more of them.
  const tonePcs = new Set(chord.chordTonePcs);
  const exts = extensionPcs(chord);
  const numExt = Math.floor(selection * Math.min(exts.length, 3) + (chance(rng, selection) ? 1 : 0));
  for (let i = 0; i < numExt; i++) {
    tonePcs.add(exts[i % exts.length]);
  }

  // Drop the root from the right hand at higher selection — the left hand has
  // it, and rootless voicings sound more like a real player's right hand.
  if (selection > 0.55 && tonePcs.size > 3) {
    tonePcs.delete(chord.root);
  }

  const pcs = [...tonePcs];
  let voices;
  if (prevVoices && prevVoices.length) {
    // Voice-leading: place each new tone at the octave nearest the previous
    // voicing, so common tones are held and the others move by the smallest
    // step — the way a real player keeps a hand still and lets fingers walk to
    // the closest chord tone instead of jumping to a fresh block every change.
    voices = pcs.map((pc) => clampMidi(placeNearSet(pc, prevVoices)));
    voices = spaceOutCollisions(voices);
  } else {
    // First chord (no history): lay the tones out around the center. Closed
    // voicing keeps them within an octave; spread opens them out so adjacent
    // voices can jump an octave for a wide, ringing sound.
    voices = [];
    let cursor = center - 4;
    for (let i = 0; i < pcs.length; i++) {
      let note = nearestOctave(pcs[i], cursor);
      if (note <= cursor) note += 12; // keep ascending so voices don't collide
      // Spread: sometimes lift a voice an extra octave to open the chord.
      if (chance(rng, spread * 0.4) && i > 0) note += 12;
      voices.push(clampMidi(note));
      cursor = note;
    }
  }
  voices.sort((a, b) => a - b);

  // Optional top doubling for sparkle when spread is high (octave on top).
  if (spread > 0.7 && voices.length) {
    const top = voices[voices.length - 1];
    if (top + 12 <= 96) voices.push(top + 12);
  }

  // Deduplicate (octave lifts can collide).
  const uniqueVoices = [...new Set(voices)].sort((a, b) => a - b);

  return {
    bass,
    voices: uniqueVoices,
    all: [bass, ...uniqueVoices],
    scale: scaleForChord(chord),
    chord,
  };
}

// Find a tasteful one-step approach tone leading into a target note, drawn from
// the chord's scale. Used by the pattern walker for passing-tone embellishment.
export function approachTone(targetMidi, scale, rng) {
  const dir = chance(rng, 0.5) ? 1 : -1;
  for (let step = 1; step <= 2; step++) {
    const cand = targetMidi + dir * step;
    if (scale.includes(pitchClass(cand))) return clampMidi(cand);
  }
  return clampMidi(targetMidi - dir); // chromatic fallback
}
