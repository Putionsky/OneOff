# One Off - Game Design Document

## Concept Overview
One Off is a festive first-person shooter where players control Santa Claus as he fends off rogue elves on Christmas Eve. Each time an elf is eliminated, Santa triumphantly shouts "One Off!", reinforcing the fast-paced score-chasing tone.

## Narrative Premise
A mischievous faction of elves has sabotaged the North Pole workshop. Santa must secure the area, recover stolen presents, and restore order before dawn. The story unfolds through brief in-engine vignettes between combat arenas.

## Core Gameplay Loop
1. **Enter arena:** Santa drops into a snowy, gift-strewn arena with verticality and destructible cover.
2. **Engage waves:** Dynamic elf waves mix melee and ranged units, pushing the player to reposition.
3. **Score chase:** A visible combo meter rewards rapid takedowns; every elf defeated triggers the "One Off!" shout.
4. **Collect & craft:** Gather candy canes and spare parts to upgrade Santa's arsenal at toy benches.
5. **Push objective:** Deliver presents to marked chimneys or defend sleigh landing zones.

## Player Abilities
- **Arctic Arsenal:** Candy Cane Carbine (accurate mid-range), Snowball Launcher (splash damage), Gingerbread Shotgun (close-range burst).
- **Movement:** Sprint, slide on ice patches, double-jump via jet-boosted boots, and a short grappling hook swing from sleigh tethers.
- **Ultimate – Naughty List:** Temporarily reveals elf positions and grants infinite ammo; every elimination during this window echoes an intensified "One Off!".

## Enemies
- **Workshop Grunts:** Basic melee elves that swarm; weak to shotgun blasts.
- **Toy Snipers:** Perched elves using ornament rifles; force use of cover.
- **Bombardiers:** Toss explosive gift boxes that damage cover; drop crafting parts when stunned.
- **Sleigh Saboteurs:** Prioritize objectives, attempting to steal presents or damage sleigh beacons.
- **Mini-Boss – Krampus Construct:** Mechanical juggernaut assembled from stolen parts; telegraphed melee slams and ranged coal barrages.

## Level Concepts
- **Snowbound Plaza:** Wide open square with ice rinks for sliding flanks; chimneys on rooftops for delivery objectives.
- **Workshop Factory:** Tight conveyor belts and toy presses that create moving cover and hazard timing windows.
- **Aurora Cliffs:** Multi-level outpost with sleigh launch pads, strong emphasis on grappling between ledges.

## Progression & Rewards
- **Upgrades:** Attach candy cane bayonets, rapid-fire stockings, sticky snow ammo, and peppermint scopes.
- **Cosmetics:** Festive suit palettes, glowing antler headsets, and sleigh trail colors unlocked by high combo streaks.
- **Challenges:** Daily goals like "Deliver 10 presents without taking damage" or "Defeat 3 Bombardiers mid-air".

## Audio & Voice
- Santa's "One Off!" callout triggers on every elf elimination, layered with slight pitch variation to avoid repetition.
- Jingle-infused combat music ramps with combo multiplier; sleigh bells accent kill streaks.
- Impact sounds emphasize candy-coated ballistics and crunchy snow footsteps.

## Visual Style
- Stylized, saturated holiday palette with neon accents on tech gear.
- Snow particle density scales with action intensity; muzzle flashes cast warm glows on ice.
- UI uses ornament motifs for health, ammo, and combo indicators.

## Technical Notes
- **Engine:** Browser-based prototype built with Three.js and pointer-lock controls targeting WebGL; future rendering upgrades can swap in a custom shader pipeline or migrate to a higher-fidelity engine if needed.
- **Perspective:** First-person, with optional photo mode for cinematic replays.
- **Accessibility:** Colorblind-friendly enemy outlines, adjustable shout frequency, and subtitle support for voice lines.

## Pillars of Fun
- **Joyful Power Fantasy:** Santa as a heroic protector, not a villain.
- **Momentum & Clarity:** Fast traversal with readable enemy silhouettes and clear callouts.
- **Festive Chaos:** Each "One Off!" punctuates a celebration of skillful play.

## Playtest & Validation Plan
- **Core loop mock:** Build or script a minimal arena with one weapon, two elf types, and the "One Off!" shout to assess pacing and callout frequency.
- **Combo readability:** Ask testers to explain how the combo works after one wave; adjust HUD clarity or audio cues if they cannot.
- **Weapon feel:** Track time-to-kill and ammo usage per elf type; tune damage and reload speeds to keep flows snappy but readable.
- **Objective clarity:** Prototype one delivery objective and one defense objective; observe whether testers understand goals without guidance.
- **Fatigue check:** Limit sessions to 10–15 minutes and survey whether the repeated shout remains motivating versus tiring.
