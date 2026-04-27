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

## Running Tests

This repository now uses `unittest` with one discovered Python test method per JSON scenario case. That means the test output is detailed and case-by-case, not collapsed into one giant runner.

Current suite shape:

- state transition scenarios,
- serialization round-trip scenarios,
- end-turn / start-turn economy and status scenarios,
- teleport lock scenarios,
- a broad surface attack matrix,
- detailed gang-up combat scenarios.

### Python Version

Use `Python 3.12`.

The package metadata in [pyproject.toml](/C:/CodexProjects/Uniwar/pyproject.toml) currently declares:

- `requires-python = ">=3.12"`

### Virtual Environment Setup

Create a local virtual environment in the repository root:

```powershell
python -m venv .venv
```

Activate it in PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

Upgrade packaging tools:

```powershell
python -m pip install --upgrade pip setuptools wheel
```

Install project dependencies:

```powershell
python -m pip install -r requirements-dev.txt
```

If `pip` fails with a Windows temp-directory permission error in this environment, use a repo-local temp directory and retry:

```powershell
New-Item -ItemType Directory -Force .tmp | Out-Null
$env:TEMP = (Resolve-Path .tmp).Path
$env:TMP = $env:TEMP
python -m pip install -r requirements-dev.txt
```

Right now the project has no third-party runtime dependencies declared in `pyproject.toml`. So `requirements-dev.txt` only installs the local package in editable mode:

```text
-e .
```

That means:

- imports resolve from `src/`,
- local code edits are immediately visible,
- you do not need to reinstall after every Python code change.

### If Python Is Not On PATH

If you need to use the bundled workspace runtime directly:

```powershell
& "C:\Users\Pavlo\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements-dev.txt
```

### Running All Tests

After the environment is activated and dependencies are installed, run the full suite with:

```powershell
python -m unittest discover -s tests -v
```

If you do not want to activate the environment first, run the venv interpreter directly:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

You should see many individually reported tests, for example attack matrix cases, gang-up cases, and end-turn cases.

### Running One Test Class

Run only the scenario runner:

```powershell
python -m unittest tests.test_state.GameStateScenarioTestCase -v
```

### Running One Specific Test Case

Run one named scenario test:

```powershell
python -m unittest tests.test_state.GameStateScenarioTestCase.test_174_gang_up_rules_marauder_second_hit_from_same_hex_gets_2_and_keeps_carried_seed -v
```

The numeric test name may change when new scenarios are added, so the reliable way to find a specific test is to run full discovery once and copy the exact discovered name.

### Recommended Workflow

- activate `.venv` before running tests,
- run the full suite after almost any change to `src/uniwarbot/`,
- fix failing tests before adding more mechanics,
- prefer adding new behavior as `input state -> action -> expected changes` JSON scenarios,
- keep combat tests deterministic by setting explicit `current_rseed` in input states.

### Current Local Environment

A local `.venv` has already been created in this repository on this machine. It is ignored by Git and intended only for local development.

The current test suite has been verified from that environment with:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```
