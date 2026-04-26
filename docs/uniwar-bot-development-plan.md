# UniWar Bot Development Plan

This document turns the mechanics research in [Uniwar-game-mechanics-deep-research-report.md](../Uniwar-game-mechanics-deep-research-report.md) into an execution plan for a playable, trainable UniWar bot project.

## 1. Target Outcome

We want one codebase that can do four things well:

1. Reproduce UniWar rules with high fidelity, including RNG, fog of war, buried/submerged units, race abilities, economy, production, repair, capture, veterancy, and scenario tags.
2. Offer a local GUI where a human can play against the bot, bot vs bot can be observed, and replays/debug overlays can be inspected.
3. Provide a fast simulation environment for search and self-play training.
4. Train stronger bots over time with a search-based approach rather than a pure scripted opponent.

Recommended primary AI approach: AlphaZero-style policy/value learning with PUCT MCTS.

Recommended supporting baselines:

- Rule-based heuristic bot for smoke tests and GUI play.
- Tactical expectiminimax/alpha-beta bot for small maps and local combat verification.
- Pure MCTS bot without neural network as an intermediate baseline.

Reason for this choice:

- UniWar has a very large branching factor because a single turn contains a sequence of unit actions, not one move.
- Combat is stochastic, so pure minimax is not the best final architecture.
- Fog of war introduces partial observability, which makes search and training harder and favors a staged rollout.

### 1.1 Initial Scope Boundary

The first production slice should stay intentionally narrow:

- local offline matches first,
- no direct integration with official UniWar servers or accounts,
- no map editor in the first playable release,
- 1v1 GUI first, while keeping the engine ready for team and FFA rules.

## 2. Engineering Principles

These principles should be enforced from the start.

### 2.1 Rules Fidelity First

- Current official unit cards are the primary source of truth when they conflict with older tutorial pages.
- Missing values from the report must remain explicit `UNKNOWN` or `UNVERIFIED`. Do not fill gaps with guessed constants.
- Every encoded rule should carry source metadata: `source`, `confidence`, `last_verified`, `notes`.

### 2.2 Determinism and Reproducibility

- The engine must be deterministic given an initial seed and an action sequence.
- Replays must fully reconstruct a match.
- All training and bot evaluation runs must log seeds, model version, map version, and ruleset version.

### 2.3 Separation of Concerns

- The rules engine must not depend on GUI code.
- The AI layer must interact with the engine through a stable environment API.
- The GUI should consume engine state snapshots and events, not re-implement game rules.

### 2.4 N-Player Ready Engine, 1v1 First Product

- The engine data model should support more than two players, teams, and scenario tags from day one.
- The first playable milestone can still be limited to 1v1 local matches.

## 3. Recommended Stack

Recommended stack for the first full implementation:

- `Python 3.12` for the core engine, AI, tools, and training pipeline.
- `PyTorch` for policy/value models.
- `NumPy` for fast tensor-friendly state transforms.
- `FastAPI` plus WebSocket endpoints for local orchestration.
- `React + TypeScript + Vite` for the GUI.
- `SVG` or `Canvas` for the hex board renderer.
- `SQLite` for local metadata and experiment tracking.
- `Parquet` or chunked binary files for replay buffers and self-play datasets.

Why this stack:

- Python is the lowest-friction option for AlphaZero-style experimentation.
- A browser GUI is easier to iterate on than a native desktop UI and keeps rendering/debug tools flexible.
- FastAPI creates a clean boundary between gameplay UI and simulation/training processes.

Optimization policy:

- Start with a clean Python reference engine.
- Profile before optimizing.
- If self-play speed becomes the bottleneck, move hot paths to `numba`, `cython`, or a Rust extension without changing the public engine API.

## 4. Proposed Architecture

### 4.1 Content Layer

The project should be data-driven, not hardcoded around unit logic.

Suggested content artifacts:

- `data/raw/` for direct transcriptions from the report and later live-game verification captures.
- `data/validated/units.json` for the 33 unit definitions.
- `data/validated/terrain.json` for terrain behaviors and later the full terrain matrix.
- `data/validated/abilities.json` for EMP, UV, plague, teleport, bury, submerge, repair auras, capture rules, and veterancy.
- `data/validated/scenario_tags.json` for tags like `#SPC`, `#NOFOW`, `#AI1`, `#RNG123`, `#BLITZ`, `#BLIM`, `#RNGBUILD`.
- `data/maps/` for test maps, training maps, and benchmark maps.
- `data/golden_scenarios/` for single-mechanic regression setups.

Every record should include confidence metadata so unresolved mechanics are visible in code review and in the GUI debug panel.

### 4.2 Core Domain Model

Core entities:

- `MatchConfig`: map, players, teams, seed, scenario tags, ruleset version.
- `MatchState`: full authoritative state.
- `PlayerState`: credits, owned structures, perspective data, defeat state.
- `TileState`: terrain, ownership, occupancy, scenario metadata.
- `UnitState`: unit type, owner, HP, veterancy, statuses, cooldowns, availability, hidden-mode state, path history for the active turn.
- `TurnState`: current player, action phase, gang-up chain state, last attacker reference, per-turn RNG stream.
- `Action`: atomic decision such as `Produce`, `Move`, `Attack`, `Capture`, `Repair`, `UseAbility`, `ToggleHiddenState`, `EndTurn`.
- `Event`: replayable state transition event with enough detail for UI and audit.

Important modeling decision:

- Represent a UniWar turn as a sequence of atomic actions plus `EndTurn`.
- Do not model "the whole turn" as one action.
- This is required for both GUI interaction and AlphaZero-style search.

### 4.3 Rules Engine Modules

Split the engine into narrow modules:

- `coords`: axial/cube hex math, ranges, rings, line traversal.
- `map_rules`: terrain occupancy, production eligibility, capture eligibility, structure effects.
- `movement`: pathfinding, mobility costs, path validation, move-after-attack and attack-after-move handling.
- `visibility`: fog of war, per-player visible state, buried/submerged visibility rules.
- `combat`: hit probability, binomial damage, retaliation, armor piercing, underwater penalties.
- `gang_up`: adjacency geometry and reset rules.
- `status_effects`: EMP, UV, plague, disabled, cooldowns, submerged/buried state, resurface bonuses.
- `economy`: credits, production, capture completion, base depletion tags, random build tags.
- `repair`: repair points, auto-heal, tile modifiers, support modifiers, stacked repair logic.
- `progression`: veterancy and transformation rules.
- `scenarios`: tags, map options, timers, challenge variants.
- `serialization`: save/load, replay logs, deterministic hashing.

### 4.4 Two Views of State

The engine should expose two distinct state views:

- `AuthoritativeState`: full hidden information, all timers, all unit internals.
- `PlayerObservation`: only what a specific player is allowed to see.

This is mandatory for fog of war support and for later imperfect-information search.

### 4.5 API and Runtime Services

Suggested services:

- `engine-service`: authoritative local match runner.
- `bot-service`: wraps search and model inference.
- `training-service`: self-play workers, replay buffer writing, evaluation matches.
- `analysis-service`: replay inspection, combat odds, scenario runner, benchmark harness.

The GUI should talk to the engine over a local API or WebSocket stream. Self-play should be able to bypass the GUI entirely.

### 4.6 GUI Scope

The first GUI should support:

- Create/load local matches.
- Human vs bot.
- Bot vs bot.
- Seeded replays.
- Fog of war perspective switching.
- Unit info panel.
- Action history and replay scrubber.
- Optional debug overlays for move range, attack range, vision, terrain modifiers, gang-up bonus, expected damage, and MCTS visit counts.

The GUI should not be treated as polish-only work. It is also the primary debugging surface for rules validation.

## 5. AI Strategy

### 5.1 Mainline Recommendation

Build the final bot around AlphaZero-style self-play:

- Policy/value network proposes promising atomic actions.
- PUCT MCTS searches from the current partial-turn state.
- The engine is used as the simulation oracle.
- Training data comes from self-play games with temperature control, evaluation gating, and replay-buffer sampling.

### 5.2 Why Not Pure Minimax

Pure minimax is useful as a baseline, but not as the final strategy.

- UniWar combat contains chance.
- Fog of war creates hidden state.
- Full-turn branching is too large for deep alpha-beta on normal maps.
- Some action sequences are long enough that handcrafted move ordering becomes expensive fast.

Minimax still has value for:

- Small-map tactical puzzles.
- Regression testing of combat and move ordering.
- Providing a simple non-neural benchmark.

### 5.3 Search Design

Recommended search rollout stages:

1. `Heuristic bot`
   - Weighted material, capture pressure, income lead, threat maps, expected damage.
   - Used for smoke tests and initial GUI play.
2. `Expectiminimax bot`
   - Limited-depth tactical search for small maps and scenario regression.
   - Helpful for validating combat and gang-up behavior.
3. `Pure MCTS bot`
   - No neural net, but uses fast playouts and handcrafted rollout policy.
4. `AlphaZero bot`
   - PUCT MCTS plus policy/value model.
5. `Belief-state bot`
   - Extends MCTS to fog of war via sampled hidden-state particles or information-set approximations.

### 5.4 Handling Chance

The project should treat combat randomness explicitly, not hide it behind expected values.

Recommended training/search policy:

- Engine always supports exact seeded stochastic resolution.
- Tactical tools can also compute expected damage analytically.
- MCTS can start with sampled chance outcomes during simulation.
- Later, if needed, add explicit chance nodes or limited outcome bucketing for high-value combat states.

This gives a practical path:

- Correctness first.
- Faster approximate search second.
- More principled chance handling only where it improves strength.

### 5.5 Handling Fog of War

Recommended staged rollout:

1. Full fog rules in the engine from the beginning.
2. Perfect-information training mode for early AlphaZero experiments.
3. Production bot under fog uses a belief-state layer:
   - maintain possible enemy states consistent with observations,
   - sample particles,
   - run MCTS over particles,
   - aggregate action values.

This avoids blocking the whole bot effort on perfect imperfect-information research.

### 5.6 Model Representation

Start simple.

- Encode the map as a padded axial-grid tensor.
- Use per-cell channels for terrain, ownership, unit type, HP, veterancy, availability, cooldowns, statuses, hidden state flags, capture state, and visibility.
- Add scalar features for credits, turn number, side to move, scenario tags, and remaining timers.
- Mask illegal actions at inference time.

Recommended first network:

- Residual CNN over the padded hex tensor plus scalar head fusion.

Upgrade path only if necessary:

- Graph neural network or transformer encoder for irregular maps and better generalization across map shapes.

### 5.7 Action Encoding

The action head should target atomic legal actions generated by the engine.

Examples:

- `Produce(unit_type, structure_hex)`
- `Move(unit_id, path)`
- `Attack(unit_id, target_hex)`
- `Capture(unit_id)`
- `Repair(unit_id)`
- `UseAbility(unit_id, ability, target_spec)`
- `ToggleBurrow(unit_id)`
- `ToggleSubmerge(unit_id)`
- `Teleport(unit_id, target_hex)`
- `EndTurn`

Do not attempt a fixed global action vocabulary for every possible path on day one. Generate legal actions from the state, then map them to masked indices.

## 6. Roadmap

Rough estimate below assumes one experienced full-time engineer. Add parallelism if more people join.

| Milestone | Goal | Rough Size | Exit Criteria |
|---|---|---:|---|
| M0 | Spec and repo bootstrap | 3-5 days | Docs, repo layout, coding standards, scenario format, confidence metadata format |
| M1 | Structured rules dataset | 1-2 weeks | 33 units, terrain catalog, ability catalog, scenario tags encoded with confidence flags |
| M2 | Core engine foundation | 2-3 weeks | Hex map, action system, turn flow, serialization, deterministic replay core |
| M3 | Combat, economy, statuses | 2-3 weeks | RNG combat, retaliation, capture, repair, production, cooldowns, transformations, veterancy |
| M4 | Visibility and hidden units | 1-2 weeks | Fog of war, observation views, buried/submerged support |
| M5 | Scenario and replay tooling | 1-2 weeks | Map loader, tags, replay browser format, golden scenario runner |
| M6 | Verification harness | 1-2 weeks | High-value mechanic tests, seed regression suite, performance benchmarks |
| M7 | Playable GUI | 2-3 weeks | Human vs bot, bot vs bot, replay viewer, debug overlays |
| M8 | Baseline bots | 2-3 weeks | Heuristic bot and tactical search bot stable in GUI |
| M9 | AlphaZero training loop | 4-8 weeks | Self-play workers, replay buffer, policy/value training, gating matches |
| M10 | Strength, profiling, packaging | ongoing | Faster rollouts, better models, packaged local app, experiment dashboards |

### 6.1 M0 - Spec and Bootstrap

Deliverables:

- Repo structure.
- Formatting, linting, typing, test harness.
- Rules confidence schema.
- Replay schema.
- Initial map format.
- Golden-scenario format.

Decisions to lock in here:

- coordinate system,
- action/event schema,
- seed management,
- API boundary,
- file formats.

### 6.2 M1 - Structured Rules Dataset

Main work:

- Convert the report into machine-readable unit, terrain, ability, and scenario-tag files.
- Encode all 33 units and all reported classes.
- Encode unresolved values explicitly.
- Build a small validation script that checks schema completeness.

Acceptance criteria:

- No unit stats are buried in code.
- The engine can load all units and terrains from data files.
- Unknown mechanics are visible in a machine-readable backlog, not hidden in TODO comments.

### 6.3 M2 - Core Engine Foundation

Main work:

- Hex board representation.
- Occupancy and pathfinding.
- Turn sequencing.
- Atomic action validation and application.
- Replay event generation.
- Deterministic state hashing.

Acceptance criteria:

- A scripted match can be replayed from start to finish.
- The same seed plus action list always yields the same state hash.
- Illegal actions are rejected with structured error reasons.

### 6.4 M3 - Combat, Economy, Statuses

Main work:

- Implement the published hit probability formula.
- Implement binomial damage and seeded randomness.
- Implement retaliation order.
- Add armor piercing support.
- Add gang-up bonus logic.
- Add capture, production, income, depletion tags, and repair.
- Add EMP, UV, plague, bury, submerge, teleport, transformations, move-after-attack, attack-after-move.
- Add veterancy state and upgrade effects.

Acceptance criteria:

- Combat calculator output matches golden cases.
- Retaliation and death ordering are correct.
- Turn-end auto-heal works.
- Cooldowns and disabled states tick correctly.

### 6.5 M4 - Visibility and Hidden State

Main work:

- Per-player observation generation.
- Visibility masks and remembered information.
- Buried and submerged hidden-state handling.
- Perspective-specific replay support.

Acceptance criteria:

- The same authoritative match can be rendered from different player perspectives.
- Hidden units are visible only when rules permit.
- Search code can request either full state or observed state.

### 6.6 M5 - Scenario and Replay Tooling

Main work:

- Load maps and scenario metadata.
- Add support for key tags from the report.
- Implement seed injection and deterministic replays.
- Add a scenario runner for one-mechanic tests.

Recommended tag order:

- first: `#NOFOW`, `#RNG`, `#SPC`
- second: `#AI1/#AI2/#AI3`, `#BLITZ`, `#BLIM`
- later: `#RNGBUILD`, team tags, challenge-specific rules

Acceptance criteria:

- A scenario file can recreate a known test state.
- Replay files are stable across runs.
- Scenario tags are parsed without leaking tag logic into unrelated modules.

### 6.7 M6 - Verification Harness

Main work:

- Golden scenarios for every major mechanic.
- Property tests for engine invariants.
- Regression snapshots for seeded combat.
- Performance benchmarks.
- Rules audit reports that show which mechanics are still unverified.

Acceptance criteria:

- The test suite catches intentional changes to combat, capture, or visibility.
- Benchmarks exist for state transitions, action generation, and MCTS playout rate.

### 6.8 M7 - Playable GUI

Main work:

- Board rendering.
- Click-to-act controls.
- Action preview and legal target highlighting.
- Side panel with unit, terrain, status, cooldown, and battle-odds information.
- Replay scrubber and seed display.
- Bot control panel for search depth, simulations, model choice, and player assignment.

Acceptance criteria:

- A human can complete a full local match.
- A developer can inspect why the bot chose an action.
- The GUI can visualize hidden information correctly per side.

### 6.9 M8 - Baseline Bots

Main work:

- Heuristic evaluator.
- Tactical search on reduced depth or tactical windows.
- Move ordering and action pruning.
- Safety heuristics for production and end-turn decisions.

Acceptance criteria:

- Bots make legal decisions consistently.
- A baseline bot can finish games without stalling or timing out.
- The project has a benchmark ladder for bot-vs-bot comparison.

### 6.10 M9 - AlphaZero Training Loop

Main work:

- Self-play worker pool.
- Replay buffer.
- Training loop.
- Evaluation matches and gating.
- Model registry and checkpointing.
- Curriculum over maps, races, and visibility settings.

Recommended curriculum:

1. Small 1v1 maps, no fog, limited unit set.
2. Full 1v1 rules, no fog.
3. Full 1v1 rules with fog.
4. Larger maps and asymmetric race matchups.
5. Team and scenario variants after 1v1 stabilizes.

Acceptance criteria:

- The training loop produces stronger checkpoints over time.
- New models can be promoted only if they beat the current best model under a fixed benchmark suite.
- All self-play artifacts are reproducible and attributable.

### 6.11 M10 - Profiling, Packaging, and Long-Run Research

Main work:

- Speed up simulation hotspots.
- Add batched inference.
- Add distributed self-play if needed.
- Package the local app.
- Add experiment dashboards and model comparison tools.
- Explore better model architectures only after the baseline pipeline is stable.

## 7. Major Risks and Mitigations

- `Rules gaps`: the report still leaves terrain matrix, teleport recharge, submerged detection, repair stacking, and some action-economy details unresolved. Mitigation: keep these in the validation backlog, tag them in data, and block silent hardcoding.
- `Branching factor`: UniWar turns are multi-action sequences. Mitigation: search over atomic actions, add action pruning, and use the GUI plus golden scenarios to debug legality early.
- `Partial observability`: fog of war can derail training if handled too early. Mitigation: build fog in the engine now, but stage bot training through perfect-information mode first.
- `Simulation speed`: AlphaZero is only viable with a fast simulator. Mitigation: ship a clean reference engine first, benchmark it, then optimize the proven hotspots only.

## 8. Testing Strategy

The project needs more than standard unit tests.

### 8.1 Test Types

- Unit tests for formulas and rule modules.
- Golden scenario tests for high-value mechanics.
- Property tests for invariants.
- Replay determinism tests.
- Perspective tests for fog of war.
- GUI integration tests for core flows.
- Performance benchmarks.

### 8.2 Critical Invariants

- HP never drops below zero or above the unit maximum.
- Only legal units can produce, capture, repair, or use abilities.
- Replay application is associative with logged event order.
- State hashes remain stable for identical inputs.
- Observation views never reveal hidden information not earned by visibility rules.

### 8.3 Golden Scenario Priorities

Highest-priority golden tests:

- retaliation even if the defender should die from incoming damage,
- gang-up `+1`, `+2`, `+3` geometry,
- move-after-attack vs attack-after-move behavior,
- capture timing and unit disappearance,
- medical repair multiplier,
- support repair multiplier,
- plague spread and cure,
- teleport disabling for one round,
- buried resurface bonus,
- submerged penalties and visibility,
- no-fog scenario mode,
- seeded combat reproducibility.

## 9. Mechanics Validation Policy

The report explicitly leaves some mechanics unresolved. That is not a documentation problem; it is a development requirement.

Project rule:

- unresolved mechanics must live in a dedicated validation backlog,
- engine code must surface their confidence level,
- any temporary implementation for an unresolved mechanic must be marked `provisional`,
- promotion from `provisional` to `validated` requires either live-game confirmation or a source upgrade.

See [mechanics-validation-backlog.md](./mechanics-validation-backlog.md).

## 10. Suggested Repository Layout

```text
Uniwar/
  docs/
    uniwar-bot-development-plan.md
    mechanics-validation-backlog.md
  data/
    raw/
    validated/
    maps/
    golden_scenarios/
  engine/
    coords/
    state/
    rules/
    io/
  ai/
    heuristics/
    search/
    policy_value/
  training/
    self_play/
    replay_buffer/
    eval/
  api/
  gui/
  tools/
  tests/
    unit/
    golden/
    property/
    integration/
    perf/
  replays/
  models/
```

## 11. Recommended Order of Real Execution

The best implementation order is:

1. Build the structured rules dataset and validation backlog.
2. Build the deterministic engine and replay format.
3. Add combat, economy, and status effects.
4. Add fog of war and hidden-state support.
5. Build the golden-scenario test harness.
6. Build a basic GUI for human debugging.
7. Add a simple heuristic bot.
8. Add tactical search.
9. Add self-play and AlphaZero training.
10. Optimize only after the full loop works.

This order matters because a strong bot is impossible without a fast, trustworthy simulator, and a trustworthy simulator is hard to build without scenario-driven verification and a visual debug surface.

## 12. Success Criteria

The project can be considered successful when all of the following are true:

- The engine reproduces the published mechanics and clearly labels the still-unverified ones.
- A human can play complete local matches against the bot in the GUI.
- Replays are deterministic and debuggable.
- The heuristic bot and tactical search bot are stable.
- The AlphaZero pipeline produces measurable strength improvements.
- The project can benchmark models on a fixed pool of maps, races, and seeds.
- The codebase can evolve as new live-game rule confirmations arrive without invasive rewrites.
