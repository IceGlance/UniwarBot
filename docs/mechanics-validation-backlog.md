# Mechanics Validation Backlog

This backlog tracks mechanics that the research report identifies as unresolved, ambiguous, or only partially published. The goal is to turn each one into an explicit validation task instead of letting assumptions leak into the engine.

## Status Legend

- `validated`: confirmed by current official source or direct in-game verification.
- `provisional`: implemented for development flow, but still awaiting stronger confirmation.
- `blocked`: should not be hardcoded yet because the project would be building on guesses.

## High-Priority Validation Items

| ID | Mechanic | Current Report Status | Why It Matters | Proposed Validation Method | Temporary Engine Policy |
|---|---|---|---|---|---|
| VAL-01 | Full terrain matrix: movement cost and ATK/DEF modifiers for each unit x terrain pair | Not fully published on the web; the report marks this as the biggest gap | Movement, combat odds, evaluation, search quality, GUI overlays | Capture in-game Info screen values for every unit/terrain combination and normalize them into structured data | Keep structure ready, but do not invent missing numeric values |
| VAL-02 | Exact teleport recharge for Mecha, Mecha II, Guardian, Eclipse | Official pages confirm teleport and one-round disable, but not the numeric recharge | Search legality, cooldown tracking, tactical planning | Live-game scenario tests plus any updated official unit-card evidence | Mark as `provisional` if needed for local experiments; never label as validated without evidence |
| VAL-03 | Detection rules for submerged units | The report says public rules remain incomplete | Fog of war correctness and naval search behavior | Controlled map scenarios with submerged units, visibility checks, and attack attempts | Keep underwater visibility logic modular and confidence-tagged |
| VAL-04 | Exact stacking formula for multiple repair-support sources | Multipliers `x2` and `x3` are known, stacking formula is not | End-turn survival, tactical planning, evaluation | Multi-support scenarios around damaged units on plain/base/medical tiles | Implement a strategy hook, not a hardcoded final formula |
| VAL-05 | Veterancy XP gain formula | Bonus effects are known; XP gain formula is community consensus | Long matches, self-play reward structure, evaluation of trades | Empirical match logging with known last-hit values and XP state changes | Allow veterancy state in engine, but gate exact XP formula behind source confidence |
| VAL-06 | Capture defense penalty and other capture edge cases | Capture duration is known; detailed stat penalty is not fully current in official web docs | Accurate capture tactics and GUI odds during capture | Manual in-game experiments with equivalent attackers vs capturing/non-capturing defenders | Keep capture penalties data-driven and source-tagged |
| VAL-07 | Engineer move-plus-EMP exact restriction | The report says current official web is weaker here and old community notes fill the gap | Action generator legality and tactical search | Dedicated test scenarios that compare move-plus-EMP legality against live-game behavior | Treat as `provisional` until confirmed |
| VAL-08 | Battery move semantics: `Moves per turn = 2` vs "cannot move and attack in one turn" | Official UI is internally unclear | Action generator and search branching | Build direct scenario tests for move, then attack, then availability state | Model the action economy explicitly rather than deriving it from one stat field |
| VAL-09 | Plague precedence details and cleanse edge cases | Core plague behavior is known; all precedence rules are not fully official | Status simulation, healing logic, long-run self-play fidelity | Scenario ladder covering infection spread, medical cure, engineer-assisted repair cure, and non-lethal ticking | Implement tests before optimizing |

## Secondary Validation Items

| ID | Mechanic | Current Report Status | Proposed Validation Method |
|---|---|---|---|
| VAL-10 | Exact line-of-sight interaction with terrain | Report marks terrain-specific LOS effects as unpublished | Scenario maps with blockers, elevated terrain, and visibility probes |
| VAL-11 | Surface attacks against submerged targets in all class combinations | Calculator confirms this broadly, but edge cases may still matter | Matrix tests across naval, amphibian, air, and land attackers |
| VAL-12 | Ground Heavy interaction with buried units | Community consensus says passing over them deals 1 damage | In-game pass-through scenarios with HP snapshots |
| VAL-13 | Same-hex gang-up edge cases after unit movement | Community consensus documents some special cases | Narrow tactical maps with repeated attacks and hex reuse |
| VAL-14 | Transformation edge cases under disable, plague, and low HP | Transformations are known, but interaction details may matter | Scenario tests for each transformation under abnormal states |

## Required Golden Scenario Suite

These scenarios should exist as machine-readable fixtures before AlphaZero work starts.

1. Basic combat with seeded RNG and retaliation.
2. Armor piercing against high-defense targets.
3. Gang-up geometry for `+1`, `+2`, and `+3`.
4. Capture start, full-round completion, and unit disappearance.
5. Auto-heal on unused damaged units.
6. Manual repair on normal terrain.
7. Medical tile `x3` repair.
8. Engineer and Assimilator support repair.
9. Infector support repair.
10. EMP disable timing and cooldown countdown.
11. UV damage and buried-unit exclusion.
12. Plague spread, non-lethal tick, and cure behavior.
13. Teleport use, one-round disable, and recharge lock.
14. Buried resurface bonus.
15. Submerged attack penalty and observed/unobserved state transitions.
16. Move-after-attack units.
17. Attack-after-move units.
18. Artillery move-or-attack behavior.
19. Veterancy level gain and stat change.
20. Scenario tags `#NOFOW` and seeded `#RNG`.

## Validation Workflow

Use the same workflow for each open mechanic:

1. Create the smallest possible scenario that isolates the rule.
2. Record the expected observation from the report and the current confidence level.
3. Reproduce the scenario in the local engine.
4. Reproduce the scenario in the live game when possible.
5. Compare results and update the structured rules data.
6. Add or update a golden scenario test.
7. Promote the rule from `provisional` to `validated` only after evidence is attached.

## Promotion Rules

A mechanic can move to `validated` only if at least one of the following is true:

- it is directly stated in a current official source,
- it is visible in current official unit-card data,
- it is confirmed by repeatable live-game experiments and recorded in the repo,
- it is backed by a stronger source than the current community consensus.

Until then:

- keep the rule tagged,
- expose it in debug tools,
- do not silently rely on it in benchmark conclusions.
