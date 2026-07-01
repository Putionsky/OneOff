// Standard MIDI File (SMF) writer — capture a generated performance and hand
// back a downloadable .mid so the humanized part can be dragged into any DAW.
//
// Pure and dependency-free: notes in, bytes out. Format 0 (one track).

// Variable-length quantity encoding, as MIDI delta-times require.
function vlq(value) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function str(s) {
  return [...s].map((c) => c.charCodeAt(0));
}

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u16(n) {
  return [(n >>> 8) & 0xff, n & 0xff];
}

// notes: [{ midi, velocity, time (seconds), duration (seconds) }]
// options: { bpm = 96, ppq = 480, channel = 0 }
// Returns a Uint8Array of a complete SMF.
export function notesToMidi(notes, { bpm = 96, ppq = 480, channel = 0 } = {}) {
  const ticksPerSecond = (ppq * bpm) / 60;
  const toTicks = (t) => Math.max(0, Math.round(t * ticksPerSecond));

  // Expand into absolute-tick on/off events.
  const evs = [];
  for (const n of notes) {
    const on = toTicks(n.time);
    const off = Math.max(on + 1, toTicks(n.time + Math.max(0.02, n.duration)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
    const key = Math.max(0, Math.min(127, Math.round(n.midi)));
    evs.push({ tick: on, kind: 1, key, vel });
    evs.push({ tick: off, kind: 0, key, vel: 0 });
  }
  // Sort by tick; at equal ticks, note-offs precede note-ons so re-struck notes
  // don't get cut by a stray off.
  evs.sort((a, b) => a.tick - b.tick || a.kind - b.kind);

  const track = [];
  // Tempo meta event (microseconds per quarter note).
  const usPerBeat = Math.round(60000000 / bpm);
  track.push(...vlq(0), 0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff);

  let last = 0;
  for (const e of evs) {
    const delta = e.tick - last;
    last = e.tick;
    track.push(...vlq(delta));
    track.push((e.kind ? 0x90 : 0x80) | (channel & 0x0f), e.key, e.vel);
  }
  // End of track.
  track.push(...vlq(0), 0xff, 0x2f, 0x00);

  const header = [
    ...str('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(ppq),
  ];
  const trackChunk = [...str('MTrk'), ...u32(track.length), ...track];

  return new Uint8Array([...header, ...trackChunk]);
}
