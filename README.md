# OneOff

Concept pitch and game design notes for **One Off**, a first-person shooter starring Santa Claus against rogue elves. Every eliminated elf triggers Santa's rallying shout of "One Off!" Explore the design details in [docs/game_design.md](docs/game_design.md).

## Running the Three.js browser prototype
A minimal WebGL prototype lives in `web/` and runs entirely in the browser using Three.js.

1. From the repository root, start a static server: `python -m http.server 8000 --directory web`.
2. Open `http://localhost:8000` in your browser.
3. Click to lock the mouse. Move with **WASD**, jump with **Space**, and left-click to shoot elves.

The prototype uses CDN-loaded ES modules for Three.js, so no build step is required. If you want to host it, deploy the `web/` folder as-is to any static host.

## How to test (current state)
This repository contains the in-browser prototype plus design documentation. To validate the concept today:

1. **Play the prototype:** Run the steps above to feel the pacing, clarity of callouts, and responsiveness of the movement and shooting loop.
2. **Readthrough pass:** Walk through [docs/game_design.md](docs/game_design.md) and log open questions or risks (e.g., weapon balance, encounter pacing).
3. **Paper/whitebox exercises:** Sketch arena layouts and enemy spawn flows on paper or in a graybox editor to validate sightlines, cover, and movement loops.
4. **Audio/VO check:** Evaluate the frequency of the "One Off!" callout in a quick mockup (e.g., timeline in DAW) to ensure it stays energetic without fatiguing players.
5. **Playtest plan:** When you expand the prototype, run short (10–15 minute) sessions focused on combo clarity, weapon feel, and objective readability; gather notes on pacing and player comprehension.
