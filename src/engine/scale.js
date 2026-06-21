// Scale / key tracker: infers the tonal center the music is moving through, not
// just the chord under the hands right now.
//
// The estimate is *contextual and incremental*. Each chord (and the notes in it)
// feeds a pitch-class histogram that decays over time, so the most recent chord
// dominates while previous chords and notes still pull on the result — a ii-V
// lands on its key, a borrowed chord bends the scale without instantly redefining
// it. The histogram is matched against the Krumhansl–Schmuckler key profiles
// (the standard perceptual key-finding weights) to pick a tonic and major/minor
// quality, from which we hand back the diatonic scale the part should move in.

import { NOTE_NAMES, pitchClass } from './music.js';

// Krumhansl–Kessler probe-tone profiles: how strongly each scale degree implies
// a given key. Index 0 = tonic.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]; // natural minor / aeolian

// Pearson correlation between a 12-bin histogram (rotated to a candidate tonic)
// and a key profile. Correlation, not a raw dot product, so the overall loudness
// of the histogram doesn't bias the result toward busier passages.
function correlate(hist, profile, tonic) {
  let mh = 0;
  let mp = 0;
  for (let i = 0; i < 12; i++) {
    mh += hist[(i + tonic) % 12];
    mp += profile[i];
  }
  mh /= 12;
  mp /= 12;
  let num = 0;
  let dh = 0;
  let dp = 0;
  for (let i = 0; i < 12; i++) {
    const h = hist[(i + tonic) % 12] - mh;
    const p = profile[i] - mp;
    num += h * p;
    dh += h * h;
    dp += p * p;
  }
  if (dh === 0 || dp === 0) return 0;
  return num / Math.sqrt(dh * dp);
}

export class ScaleTracker {
  // decay: how much the running history is retained when a new chord arrives.
  //   ~0.55 means a chord's influence roughly halves every couple of changes —
  //   recent enough to follow modulations, slow enough to feel a key.
  constructor({ decay = 0.55 } = {}) {
    this.decay = decay;
    this.hist = new Array(12).fill(0);
    this.lastTonic = null;
  }

  reset() {
    this.hist = new Array(12).fill(0);
    this.lastTonic = null;
  }

  // Fold a newly-played chord into the running histogram. The root and bass are
  // weighted a little more (they anchor function), and the literal held pitch
  // classes count too so melodic content steers the key, not just chord labels.
  observeChord(chord) {
    for (let i = 0; i < 12; i++) this.hist[i] *= this.decay;
    if (!chord) return;
    const add = (pc, w) => { this.hist[pitchClass(pc)] += w; };
    for (const pc of chord.chordTonePcs) add(pc, 1);
    for (const pc of chord.pitchClasses) add(pc, 0.5); // notes actually sounding
    add(chord.root, 1.0);                               // root anchors function
    add(pitchClass(chord.bass), 0.6);                   // bass note in play
  }

  // Add bare melodic notes (pitch classes) with a light weight — useful if the
  // performer ever feeds played single notes between chords.
  observeNotes(pitchClassesArr, weight = 0.4) {
    for (const pc of pitchClassesArr) this.hist[pitchClass(pc)] += weight;
  }

  // Best-fitting scale given everything heard so far.
  // Returns { tonic, mode, scalePcs, name, confidence } or null if nothing yet.
  estimate() {
    const total = this.hist.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;

    let best = null;
    let second = -Infinity;
    for (let tonic = 0; tonic < 12; tonic++) {
      const maj = correlate(this.hist, MAJOR_PROFILE, tonic);
      const min = correlate(this.hist, MINOR_PROFILE, tonic);
      const candidates = [
        { tonic, mode: 'major', score: maj },
        { tonic, mode: 'minor', score: min },
      ];
      for (const c of candidates) {
        if (!best || c.score > best.score) {
          if (best) second = best.score;
          best = c;
        } else if (c.score > second) {
          second = c.score;
        }
      }
    }

    // Light hysteresis: don't flip the displayed key for a marginally-better
    // rival, so a passing chord doesn't make the readout flicker.
    if (
      this.lastTonic != null &&
      best.tonic !== this.lastTonic.tonic &&
      second > -Infinity &&
      best.score - second < 0.04
    ) {
      best = this.lastTonic;
    }
    this.lastTonic = best;

    const scale = (best.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE)
      .map((iv) => (best.tonic + iv) % 12);
    const confidence = Math.max(0, Math.min(1, (best.score - second) * 2 + best.score * 0.3));

    return {
      tonic: best.tonic,
      mode: best.mode,
      scalePcs: scale,
      name: `${NOTE_NAMES[best.tonic]} ${best.mode}`,
      confidence,
    };
  }
}
