// Humanization: the micro-details that separate a sequencer from a player.
//
// These functions take an idealized note (perfectly on the grid, fixed
// velocity) and bend its timing, loudness, and length the way hands and
// musical intent do. All offsets are in beats or velocity units so the caller
// can convert to seconds with the current tempo.

import { gaussian, range } from './rng.js';

// Per-note timing offset, in beats.
//
//  - Gaussian "push/drag": no human lands exactly on the grid. The spread of
//    the jitter scales with the `timing` control.
//  - Swing: off-beat subdivisions are delayed toward a triplet feel. A little
//    swing is what makes a straight 16th line breathe.
//  - Metric anchoring: strong beats are held tighter than weak ones, the way a
//    player keeps the pulse steady but lets ornaments float.
export function timingOffsetBeats(ctx, timing, rng) {
  const { isOffbeat, metricWeight, phrasePos = 0 } = ctx; // metricWeight 0..1, 1 = downbeat
  // Looser on weak positions, tighter on strong ones.
  const looseness = timing * (1.0 - 0.6 * metricWeight);
  const jitter = gaussian(rng) * 0.045 * looseness; // up to ~45ms-ish at 120bpm
  // Swing: only off-beats, and only as timing opens up. Max ~1/3 of a 16th.
  const swing = isOffbeat ? timing * 0.12 : 0;
  // Rubato: a gentle push into a phrase and a slight drag (ritardando) as it
  // ends, so four-bar groups breathe instead of running on a treadmill.
  let rubato = 0;
  if (phrasePos > 0.85) rubato = timing * 0.09 * ((phrasePos - 0.85) / 0.15);
  return jitter + swing + rubato;
}

// Velocity for a note, 1..127.
//
// Combines: a metric accent map (downbeats louder), a gentle overall level set
// by warmth (warmer = softer, rounder), expressive random variation, and a
// voice taper so inner/upper voices sit under the melody and bass.
export function velocityFor(ctx, params, rng) {
  const { metricWeight, voiceRole, voiceIndex, voiceCount, phrasePos = 0 } = ctx;
  const { warmth, timing } = params;

  // Base level: warmth lowers the ceiling and softens the floor.
  const base = 92 - warmth * 22; // ~92 (bright) down to ~70 (warm)

  // Metric accent: strong beats get a lift, weak ones drop back.
  const accent = (metricWeight - 0.5) * 26;

  // Role shaping: bass anchored and present, melody on top sings, inner voices
  // tucked under so the texture has depth instead of a flat block.
  let role = 0;
  if (voiceRole === 'bass') role = 6 - warmth * 3;
  else if (voiceRole === 'melody') role = 8;
  else {
    // inner voice: taper from low (quieter) toward the top
    const t = voiceCount > 1 ? voiceIndex / (voiceCount - 1) : 0.5;
    role = -10 + t * 6;
  }

  // Phrase arc: a gentle swell toward the middle of a phrase and a softening at
  // its edges, the long-breath dynamic shape a sequencer never has.
  const phraseArc = (Math.sin(Math.PI * phrasePos) - 0.35) * 9;

  // Expressive human variation; a touch wider as `timing` (looseness) grows.
  const variation = gaussian(rng) * (6 + timing * 9);

  const v = base + accent + role + phraseArc + variation;
  return Math.max(1, Math.min(127, Math.round(v)));
}

// Note length in beats. Warmth = legato/overlap (singing, pedaled); cold and
// busy = shorter, more articulated. Density shortens notes so a fast line stays
// clear instead of turning to mud.
export function durationBeats(stepBeats, params, rng) {
  const { warmth, density } = params;
  const legato = 0.55 + warmth * 0.9 - density * 0.25;
  const human = range(rng, 0.9, 1.12);
  return Math.max(0.05, stepBeats * legato * human);
}

// Chord-roll spread, in beats, applied across simultaneously-struck notes so a
// chord "rolls" from bottom to top instead of hitting as a block. Scales with
// timing and spread (a wider voicing rolls a touch wider).
export function rollSpreadBeats(timing, spread) {
  return timing * 0.05 * (0.6 + spread * 0.8);
}
