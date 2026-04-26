# UniwarBot

UniwarBot is a local-first project for building a faithful UniWar simulator, a playable GUI, and a trainable AI bot stack.

The project goal is not just to script a few moves. The target is a full game engine that can:

- reproduce UniWar mechanics with high fidelity,
- let a human play against the bot in a local GUI,
- support bot-vs-bot matches, replays, and debugging overlays,
- provide a fast simulation backend for search and self-play training,
- train stronger agents over time with an AlphaZero-style PUCT MCTS pipeline.

## Project Goals

The long-term deliverable is one codebase with three major subsystems:

1. `Rules engine`
   A deterministic, replayable simulator for units, terrains, economy, combat, fog of war, hidden states, abilities, capture, repair, veterancy, and scenario rules.

2. `Playable GUI`
   A local interface for human-vs-bot and bot-vs-bot play, with strong debugging support for ranges, visibility, expected damage, and search decisions.

3. `AI and training`
   A layered bot stack that starts with heuristic and tactical-search baselines, then grows into self-play training with policy/value models and MCTS.

## Current Direction

The recommended implementation path for this repository is:

1. Structure the mechanics data.
2. Build the deterministic engine.
3. Add verification scenarios and replay support.
4. Add the GUI.
5. Add baseline bots.
6. Add AlphaZero-style training.

That ordering is intentional. A strong bot depends on a correct simulator, and a correct simulator is much easier to validate with machine-readable data, golden scenarios, and a visual frontend.

## Repository Contents

- `Uniwar-game-mechanics-deep-research-report.md`
  Main research document describing the mechanics and known unknowns.

- `docs/uniwar-bot-development-plan.md`
  Development roadmap, architecture direction, AI strategy, and milestones.

- `docs/mechanics-validation-backlog.md`
  Explicit backlog for mechanics that are still unpublished or only partially confirmed.

- `data/validated/game-dictionary.json`
  Machine-readable dictionary of terrains and units for the engine and bot pipeline.

## Design Principles

- `Rules fidelity first`
  When sources conflict, current official unit cards outrank older tutorial pages.

- `No silent guessing`
  If a mechanic is unpublished, unresolved values stay explicit as `null`, `UNKNOWN`, or `UNVERIFIED`.

- `Determinism matters`
  The engine should be reproducible from seed plus action history.

- `Data-driven implementation`
  Units, terrains, and special abilities should live in structured data, not scattered constants.

- `Bot training is downstream of correctness`
  Search and learning only make sense once the engine and tests are trustworthy.

## Planned Technical Shape

Recommended stack:

- `Python 3.12` for engine, AI, tooling, and training
- `PyTorch` for policy/value models
- `FastAPI` plus WebSockets for local orchestration
- `React + TypeScript` for the GUI

This is still a planning and data-foundation repository. The next practical milestone is to turn the rules data into a working engine skeleton and a golden-scenario test harness.
