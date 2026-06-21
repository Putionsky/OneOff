// Pattern walker: given a held voicing and the controls, decide what is played
// on each subdivision of the bar. This is where "a chord" becomes "a part".
//
// The walker blends two textures by density:
//   low density  -> sustained / block-chord comping that rings,
//   high density -> a flowing arpeggio line.
// Note selection layers in passing tones and grace notes; the humanize module
// then bends timing, velocity and length so the result feels played.

import { chance, gaussian, pick } from './rng.js';
import {
  timingOffsetBeats,
  velocityFor,
  durationBeats,
  rollSpreadBeats,
} from './humanize.js';
import { approachTone } from './voicing.js';
import { clampMidi } from './music.js';

// Metric strength of a step, 0..1 (downbeat strongest). Drives accents and how
// likely a step is to sound.
export function metricWeight(step, stepsPerBar) {
  const stepsPerBeat = stepsPerBar / 4;
  const posInBeat = step % stepsPerBeat;
  const beatIndex = Math.floor(step / stepsPerBeat);
  if (posInBeat === 0) {
    if (beatIndex === 0) return 1.0;
    if (beatIndex === 2) return 0.9;
    return 0.8;
  }
  if (posInBeat === Math.floor(stepsPerBeat / 2)) return 0.5; // the "and"
  return 0.3;
}

function isAndOfBeat(step, stepsPerBar) {
  const stepsPerBeat = stepsPerBar / 4;
  return step % stepsPerBeat === Math.floor(stepsPerBeat / 2);
}

// How likely a non-downbeat step is to sound, as a function of density and the
// step's metric weight. Strong positions fill in first; weak sixteenths only
// join once density is high — exactly how a part thickens up.
function activation(density, mw) {
  return Math.min(1, density * (0.35 + 0.85 * mw) + (mw - 0.4) * 0.3);
}

export function makeWalkState() {
  return { arpIndex: 0, direction: 1, bar: -1, shape: 'updown' };
}

// Reshape the arpeggio direction per bar so a held chord doesn't loop a single
// identical figure. Higher selection invites more variety.
function maybeReshape(state, bar, params, rng) {
  if (bar === state.bar) return;
  state.bar = bar;
  const shapes = ['up', 'down', 'updown', 'updown', 'converge'];
  if (chance(rng, 0.4 + params.selection * 0.4)) {
    state.shape = pick(rng, shapes);
    if (state.shape === 'down') state.direction = -1;
    else state.direction = 1;
  }
}

// Advance the arpeggio cursor across the voicing according to the current shape,
// bouncing at the ends so lines turn around musically.
function nextVoiceIndex(state, n) {
  if (n <= 1) return 0;
  let i = state.arpIndex;
  switch (state.shape) {
    case 'up':
      i = (i + 1) % n;
      break;
    case 'down':
      i = (i - 1 + n) % n;
      break;
    case 'converge': {
      // alternate outer voices moving inward, then reset outward
      i = (i + 1) % n;
      break;
    }
    case 'updown':
    default:
      i += state.direction;
      if (i >= n) {
        i = n - 2 >= 0 ? n - 2 : 0;
        state.direction = -1;
      } else if (i < 0) {
        i = n > 1 ? 1 : 0;
        state.direction = 1;
      }
      break;
  }
  state.arpIndex = i;
  return i;
}

// Generate the events that sound on one subdivision step.
//
//   voicing  : output of buildVoicing()
//   params   : { density, timing, warmth, spread, selection }
//   ctx      : { step, stepsPerBar, bar, beatBeats } describing the grid
//   state    : walk state (mutated)
//   rng      : seedable rng
//
// Returns an array of events: { midi, velocity, timeOffsetBeats, durationBeats,
// role }. timeOffsetBeats is relative to the step's grid position.
export function generateStep(voicing, params, ctx, state, rng) {
  const { step, stepsPerBar } = ctx;
  const { density, timing, spread, selection } = params;
  const stepBeats = 4 / stepsPerBar;
  const mw = metricWeight(step, stepsPerBar);
  const offbeat = isAndOfBeat(step, stepsPerBar);
  const events = [];

  maybeReshape(state, ctx.bar, params, rng);

  const voices = voicing.voices;
  const voiceCount = voices.length;

  const timeCtx = { isOffbeat: offbeat, metricWeight: mw };

  // --- Bass (left hand) -----------------------------------------------------
  // Anchors strong beats. At low density it's a simple root-on-the-beat pulse;
  // a bit of selection lets it skip to beat 3 like a comping player.
  const stepsPerBeat = stepsPerBar / 4;
  const onBeat = step % stepsPerBeat === 0;
  const beatIndex = Math.floor(step / stepsPerBeat);
  const playBass =
    (step === 0) ||
    (onBeat && beatIndex === 2 && chance(rng, 0.5 + density * 0.3)) ||
    (onBeat && chance(rng, density * 0.4));
  if (playBass) {
    events.push({
      midi: voicing.bass,
      velocity: velocityFor(
        { metricWeight: mw, voiceRole: 'bass' },
        params,
        rng,
      ),
      timeOffsetBeats: timingOffsetBeats(timeCtx, timing, rng),
      durationBeats: durationBeats(stepBeats * (density < 0.4 ? 4 : 2), params, rng),
      role: 'bass',
    });
  }

  // --- Right hand -----------------------------------------------------------
  const blockMode = density < 0.32;
  const active = step === 0 || chance(rng, activation(density, mw));

  if (voiceCount === 0 || !active) {
    return events;
  }

  if (blockMode && mw >= 0.8) {
    // Sustained comping: strike a small rolled block of the upper voices and
    // let it ring. The roll spreads notes bottom-to-top for a played attack.
    const roll = rollSpreadBeats(timing, spread);
    const used = voices.slice(-Math.min(voiceCount, 3 + Math.round(spread)));
    used.forEach((midi, i) => {
      const isTop = i === used.length - 1;
      events.push({
        midi,
        velocity: velocityFor(
          {
            metricWeight: mw,
            voiceRole: isTop ? 'melody' : 'inner',
            voiceIndex: i,
            voiceCount: used.length,
          },
          params,
          rng,
        ),
        timeOffsetBeats: timingOffsetBeats(timeCtx, timing, rng) + i * roll,
        durationBeats: durationBeats(stepBeats * 6, params, rng), // ring
        role: isTop ? 'melody' : 'inner',
      });
    });
    return events;
  }

  // Arpeggio / line: one voice this step (occasionally two when busy).
  const idx = nextVoiceIndex(state, voiceCount);
  let midi = voices[idx];
  const isTop = idx === voiceCount - 1;

  // Embellishment: a grace/approach note a hair before a melody note. Driven by
  // note selection — this is the ornament that most reads as "a player". The
  // approach tone is drawn from the contextual key scale when one has been
  // inferred, so passing notes move within the tonality rather than just the
  // current chord; it falls back to the chord-local scale otherwise.
  const embellishScale = ctx.keyScale || voicing.scale;
  if (selection > 0.4 && chance(rng, selection * 0.3) && mw < 0.9) {
    const grace = approachTone(midi, embellishScale, rng);
    events.push({
      midi: grace,
      velocity: velocityFor(
        { metricWeight: mw * 0.6, voiceRole: 'inner', voiceIndex: 0, voiceCount: 2 },
        params,
        rng,
      ),
      timeOffsetBeats: timingOffsetBeats(timeCtx, timing, rng) - stepBeats * 0.35,
      durationBeats: durationBeats(stepBeats * 0.6, params, rng),
      role: 'grace',
    });
  }

  events.push({
    midi,
    velocity: velocityFor(
      {
        metricWeight: mw,
        voiceRole: isTop ? 'melody' : 'inner',
        voiceIndex: idx,
        voiceCount,
      },
      params,
      rng,
    ),
    timeOffsetBeats: timingOffsetBeats(timeCtx, timing, rng),
    durationBeats: durationBeats(stepBeats * (density > 0.75 ? 1.4 : 2.2), params, rng),
    role: isTop ? 'melody' : 'inner',
  });

  // When very busy, allow a second harmony voice a third/sixth away for a
  // fuller two-note line.
  if (density > 0.8 && chance(rng, (density - 0.8) * 3) && voiceCount > 2) {
    const harmIdx = (idx + 2) % voiceCount;
    events.push({
      midi: voices[harmIdx],
      velocity: velocityFor(
        { metricWeight: mw, voiceRole: 'inner', voiceIndex: harmIdx, voiceCount },
        params,
        rng,
      ),
      timeOffsetBeats: timingOffsetBeats(timeCtx, timing, rng) + 0.004,
      durationBeats: durationBeats(stepBeats * 1.4, params, rng),
      role: 'inner',
    });
  }

  // Keep everything in range.
  for (const e of events) e.midi = clampMidi(e.midi);
  return events;
}
