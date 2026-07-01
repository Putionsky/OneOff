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

### Performing & capturing

- **Latch / hold** — keep a chord playing after you release the keys; the next
  fresh grab starts the next chord, so you can walk a progression hands-free.
- **Panic** — instant all-notes-off for the built-in piano and any MIDI out.
- **Record MIDI** — capture the generated performance and download it as a
  standard `.mid` file to drop straight into a DAW.
- **Surprise me** — roll a fresh, musical set of controls.
- **Inferred scale on the keyboard** — the on-screen keys light up with the
  current key's scale tones (tonic highlighted).
- Your controls, tempo, pedal and latch state **persist** across reloads.

## How it works

A held chord becomes a performance in three stages, with a running key estimate
threaded through them:

1. **Detect** (`src/engine/music.js`) — identify the chord's root and quality from
   the held notes (triads through 7ths, sus, dim, plus a graceful cluster
   fallback) and know which color tones and scale tones are idiomatic for it.
1b. **Infer the scale** (`src/engine/scale.js`) — track the tonal center the music
   is moving through, not just the chord under the hands. Each chord (and its
   notes) feeds a pitch-class histogram that **decays over time**, so the most
   recent chord dominates while previous chords still pull on the result. The
   histogram is matched against the Krumhansl–Schmuckler key profiles to pick a
   tonic and major/minor quality. The result is shown on screen and used to keep
   melodic passing/grace notes moving *within the inferred key* rather than only
   the current chord — e.g. a Dm7 → G7 → Cmaj7 settles into C major, and an Am7
   after it stays in C rather than flipping. Light hysteresis stops the readout
   from flickering on passing chords.
2. **Voice** (`src/engine/voicing.js`) — lay the chord out as keys two hands would
   actually hold: a bass anchor and a right-hand voicing, shaped by *spread*
   (close ↔ open), *warmth* (register and brightness), and *note selection*
   (literal ↔ extended, rootless voicings at high settings). When a chord
   changes, the new voicing is **voice-led** from the previous one — common tones
   are held and the rest move by the smallest step, instead of jumping to a fresh
   block each change.
3. **Perform** (`src/engine/patterns.js` + `src/engine/humanize.js`) — walk that
   voicing over a step clock. *Density* blends a sustained block-chord texture
   into a flowing arpeggio and decides how many subdivisions sound; *timing* adds
   per-note gaussian micro-timing, swing on the off-beats, and chord rolls;
   *warmth* sets the velocity level and note length (legato vs. articulated);
   accents follow the metric grid; *note selection* sprinkles in grace/approach
   notes. Over each four-bar **phrase** a long-breath dynamic arc swells toward
   the middle and a slight *ritardando* eases the ending, so the part phrases
   instead of running on a treadmill. A seedable RNG (`src/engine/rng.js`) drives
   the human variation so a performance is reproducible and testable.

`src/engine/performer.js` ties these together behind a lookahead scheduler and
emits timed note events. It knows nothing about audio or MIDI — callers wire its
output to the built-in synth, a MIDI port, or (in tests) an offline buffer.

### Architecture

```
src/
  engine/        ← pure, framework-free musical brain (unit-tested)
    rng.js         seedable RNG + gaussian/chance helpers
    music.js       note naming, chord detection, scales, extensions
    scale.js       contextual key/scale inference (decaying K–S key-finding)
    voicing.js     chord  -> two-handed voicing (spread/warmth/selection)
    humanize.js    timing jitter, swing, velocity dynamics, chord rolls, phrasing
    patterns.js    voicing -> per-step note events (density/selection)
    midifile.js    export a captured performance as a Standard MIDI File
    performer.js   real-time scheduler + chord state + latch + offline render
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
hand, spread widening the range, selection adding tones), **voice leading**
(common tones held, minimal motion), **contextual key inference** (ii-V-I, minor
ii-V-i, recency-driven key changes), **phrase dynamics**, **latch/hold**,
**MIDI-file export** (valid SMF bytes), and performer properties (valid
MIDI/velocity/duration, density increasing note count, timing spreading notes off
the grid, chord changes re-voicing). 28 tests, run with `node --test`.

## Why browser-first

A native VST/AU is the natural long-term home, but it can't be built *and verified
playing* in this environment, and a web build is something you can open and play
immediately. The hard part — the humanization engine — is written to be portable,
so the browser app doubles as a fast way to dial in the feel before wrapping it in
a native plugin.
