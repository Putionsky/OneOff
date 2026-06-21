// Music-theory helpers: note naming, chord detection, and scale knowledge.
//
// Everything here is pure and works on MIDI note numbers (middle C = 60).

export const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

export function pitchClass(midi) {
  return ((midi % 12) + 12) % 12;
}

export function noteName(midi) {
  return NOTE_NAMES[pitchClass(midi)] + (Math.floor(midi / 12) - 1);
}

// Distinct pitch classes of a set of MIDI notes, sorted low to high.
export function pitchClasses(notes) {
  return [...new Set(notes.map(pitchClass))].sort((a, b) => a - b);
}

// Interval signatures for common chord qualities, as semitone sets above the
// root. Ordered roughly by how "specific"/recognizable they are so the matcher
// prefers a richer interpretation when several fit.
const QUALITIES = [
  { name: 'maj7', intervals: [0, 4, 7, 11] },
  { name: 'min7', intervals: [0, 3, 7, 10] },
  { name: 'dom7', intervals: [0, 4, 7, 10] },
  { name: 'min7b5', intervals: [0, 3, 6, 10] },
  { name: 'dim7', intervals: [0, 3, 6, 9] },
  { name: 'maj6', intervals: [0, 4, 7, 9] },
  { name: 'min6', intervals: [0, 3, 7, 9] },
  { name: 'sus4', intervals: [0, 5, 7] },
  { name: 'sus2', intervals: [0, 2, 7] },
  { name: 'aug', intervals: [0, 4, 8] },
  { name: 'dim', intervals: [0, 3, 6] },
  { name: 'maj', intervals: [0, 4, 7] },
  { name: 'min', intervals: [0, 3, 7] },
  { name: 'fifth', intervals: [0, 7] },
  { name: 'octave', intervals: [0] },
];

// The tasteful color tones we are allowed to add per quality when the
// "note selection" control reaches into extensions. Expressed as semitones
// above the root. Kept conservative so additions still sound idiomatic.
const EXTENSIONS = {
  maj7: [2, 9, 11, 14],      // 9, 13, maj7, 9(oct)
  maj: [2, 9, 11],           // add9, 6, maj7
  maj6: [2, 9, 14],
  dom7: [2, 9, 10, 14, 5],   // 9, 13, b7, 9, 11(sus-ish)
  min7: [2, 5, 10, 14],      // 9, 11, b7, 9
  min: [2, 5, 10],
  min6: [2, 5, 9],
  min7b5: [3, 8, 10],
  dim7: [2, 5, 8],
  sus4: [2, 9, 10],
  sus2: [5, 9, 10],
  default: [2, 7],
};

// Identify the most plausible root + quality of a held chord.
//
// We try every held pitch class as a candidate root, score each quality by how
// many of its intervals are present (and penalize extra non-chord tones lightly),
// and keep the best. A single note or interval still yields a usable result so
// the performer never stalls on sparse input.
export function detectChord(notes) {
  if (!notes || notes.length === 0) return null;
  const pcs = pitchClasses(notes);
  const bass = Math.min(...notes);
  const present = new Set(pcs);

  let best = null;
  for (const rootPc of pcs) {
    for (const q of QUALITIES) {
      let hit = 0;
      for (const iv of q.intervals) {
        if (present.has((rootPc + iv) % 12)) hit++;
      }
      // Require the root and a strong fraction of the chord's tones.
      const coverage = hit / q.intervals.length;
      const extra = pcs.length - hit; // held tones unexplained by this quality
      if (hit < q.intervals.length) continue; // quality fully contained in held set
      const score = q.intervals.length * 10 - extra * 2 + coverage;
      if (!best || score > best.score) {
        best = { score, root: rootPc, quality: q.name, intervals: q.intervals };
      }
    }
  }

  // Fallback: nothing matched cleanly (dense or atonal cluster). Treat lowest
  // pitch class as root and expose the raw pitch classes.
  if (!best) {
    best = {
      root: pitchClass(bass),
      quality: 'cluster',
      intervals: pcs.map((pc) => ((pc - pitchClass(bass)) + 12) % 12),
    };
  }

  return {
    root: best.root,
    quality: best.quality,
    bass,
    notes: [...notes].sort((a, b) => a - b),
    pitchClasses: pcs,
    chordTonePcs: best.intervals.map((iv) => (best.root + iv) % 12),
  };
}

// Color tones (as pitch classes) available for embellishing a chord.
export function extensionPcs(chord) {
  const list = EXTENSIONS[chord.quality] || EXTENSIONS.default;
  return list.map((iv) => (chord.root + iv) % 12);
}

// A diatonic-ish scale for choosing approach/passing tones. We derive it from
// the chord quality so embellishments stay in character.
export function scaleForChord(chord) {
  const major = [0, 2, 4, 5, 7, 9, 11];
  const dorian = [0, 2, 3, 5, 7, 9, 10];
  const mixolydian = [0, 2, 4, 5, 7, 9, 10];
  const locrian = [0, 1, 3, 5, 6, 8, 10];
  const dimScale = [0, 2, 3, 5, 6, 8, 9, 11];
  let mode = major;
  if (chord.quality.startsWith('min7b5')) mode = locrian;
  else if (chord.quality.startsWith('min')) mode = dorian;
  else if (chord.quality.startsWith('dom') || chord.quality === 'sus4') mode = mixolydian;
  else if (chord.quality.startsWith('dim')) mode = dimScale;
  return mode.map((iv) => (chord.root + iv) % 12);
}

export function clampMidi(midi) {
  return Math.max(0, Math.min(127, Math.round(midi)));
}
