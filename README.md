# Humanized Piano Performer

Feed it MIDI chords in real time — it plays them back like someone sitting at the
piano, not like an arpeggiator running a grid.

Most arpeggiators and MIDI generators are great at *patterns* but sound
mechanical: every note dead on the grid, every velocity identical, every chord
hitting as a block. This engine instead builds a **voicing** for the chord you're
holding and **performs** it — arpeggiating, comping, rolling chords, leaning into
strong beats, drifting off the grid, adding the occasional grace note — so the
result feels played.

It runs in the browser using Web MIDI + Web Audio, so you can play it today with a
MIDI controller (or the on-screen keyboard) and hear it through the built-in piano
voice, or route the generated performance out to your DAW via MIDI.

## Try it

```bash
node scripts/serve.js          # serves http://localhost:5173
```

Open the page, click **Start audio**, and hold a chord — on a connected MIDI
controller, with the mouse/touch on the on-screen keyboard, or with the computer
keys `a w s e d f t g y h u j`. The engine performs whatever you hold and follows
chord changes in real time.

> Web Audio and Web MIDI require a secure context. `http://localhost` counts as
> secure, so the local server is enough. Web MIDI input/output needs Chrome or
> Edge; without it, the on-screen and computer keyboards still drive the built-in
> piano.

## The five controls

Each maps to a real dimension of how a pianist plays a held chord:

| Control | Low | High |
| --- | --- | --- |
| **Density** | sparse, ringing chords that sustain | busy, continuous flowing lines |
| **Timing** | tight and quantized | loose, swung, with rolled chords and rubato |
| **Warmth** | bright, hard, articulated | soft, round, pedaled and legato |
| **Spread** | close voicing in one register | wide, open, two-handed voicings |
| **Note selection** | the literal chord you played | added extensions, color tones, passing notes |

Plus tempo, a sustain-pedal toggle, output routing (built-in piano or MIDI out),
and five starting-point presets (Ballad, Flowing arpeggio, Jazz comp, Cinematic,
Driving pop).

## How it works

A held chord becomes a performance in three stages:

1. **Detect** (`src/engine/music.js`) — identify the chord's root and quality from
   the held notes (triads through 7ths, sus, dim, plus a graceful cluster
   fallback) and know which color tones and scale tones are idiomatic for it.
2. **Voice** (`src/engine/voicing.js`) — lay the chord out as keys two hands would
   actually hold: a bass anchor and a right-hand voicing, shaped by *spread*
   (close ↔ open), *warmth* (register and brightness), and *note selection*
   (literal ↔ extended, rootless voicings at high settings).
3. **Perform** (`src/engine/patterns.js` + `src/engine/humanize.js`) — walk that
   voicing over a step clock. *Density* blends a sustained block-chord texture
   into a flowing arpeggio and decides how many subdivisions sound; *timing* adds
   per-note gaussian micro-timing, swing on the off-beats, and chord rolls;
   *warmth* sets the velocity level and note length (legato vs. articulated);
   accents follow the metric grid; *note selection* sprinkles in grace/approach
   notes. A seedable RNG (`src/engine/rng.js`) drives the human variation so a
   performance is reproducible and testable.

`src/engine/performer.js` ties these together behind a lookahead scheduler and
emits timed note events. It knows nothing about audio or MIDI — callers wire its
output to the built-in synth, a MIDI port, or (in tests) an offline buffer.

### Architecture

```
src/
  engine/        ← pure, framework-free musical brain (unit-tested)
    rng.js         seedable RNG + gaussian/chance helpers
    music.js       note naming, chord detection, scales, extensions
    voicing.js     chord  -> two-handed voicing (spread/warmth/selection)
    humanize.js    timing jitter, swing, velocity dynamics, chord rolls
    patterns.js    voicing -> per-step note events (density/selection)
    performer.js   real-time scheduler + chord state + offline render
  audio/piano.js   Web Audio synthesized piano voice
  midi/input.js    Web MIDI input (chords in)
  midi/output.js   Web MIDI output (performance out to a DAW/instrument)
  ui/keyboard.js   on-screen + computer-key keyboard
  app.js           browser glue (the only platform-specific layer)
test/              node --test suite for the engine
```

The split is deliberate: everything musical is in `src/engine`, has **no browser
dependencies**, and is covered by tests. The same code that powers the page could
be compiled or re-implemented inside a JUCE/VST shell (the engine's
`detectChord → buildVoicing → generateStep` pipeline maps directly onto a MIDI
plugin's `processBlock`) without touching the performance logic — that's the path
to a native DAW plugin.

## Tests

```bash
node --test
```

Covers RNG determinism, chord detection, voicing behavior (bass below the right
hand, spread widening the range, selection adding tones), and performer
properties (valid MIDI/velocity/duration, density increasing note count, timing
spreading notes off the grid, chord changes re-voicing).

## Why browser-first

A native VST/AU is the natural long-term home, but it can't be built *and verified
playing* in this environment, and a web build is something you can open and play
immediately. The hard part — the humanization engine — is written to be portable,
so the browser app doubles as a fast way to dial in the feel before wrapping it in
a native plugin.
