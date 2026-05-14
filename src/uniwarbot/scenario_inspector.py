from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .state import (
    GameMap,
    GameState,
    HexCoord,
    MapMetadata,
    PlayerState,
    TileState,
    UnitActionState,
    UnitStatusState,
    UnitState,
    game_state_to_json,
    json_to_game_state,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
SCENARIOS = FIXTURES / "scenarios"
MISSING = object()


def parse_coord(value: Any) -> HexCoord:
    if isinstance(value, dict):
        return HexCoord.from_dict(dict(value))
    if isinstance(value, str):
        q_text, r_text = value.split(":")
        return HexCoord(q=int(q_text), r=int(r_text))
    raise TypeError(f"Unsupported coord value: {value!r}")


def state_from_compact_data(data: dict[str, Any]) -> GameState:
    tiles = {
        parse_coord(tile["coord"]): TileState(
            coord=parse_coord(tile["coord"]),
            terrain_id=str(tile["terrain_id"]),
            owner_id=tile.get("owner_id"),
            metadata=dict(tile.get("metadata", {})),
        )
        for tile in list(data.get("tiles", []))
    }
    game_map = GameMap(
        metadata=MapMetadata(
            map_id=str(data.get("map_id", "test-map")),
            name=str(data.get("map_name", "Test Map")),
            width=None if data.get("width") is None else int(data["width"]),
            height=None if data.get("height") is None else int(data["height"]),
            tags=[str(item) for item in data.get("tags", [])],
            notes=None if data.get("notes") is None else str(data["notes"]),
        ),
        tiles=tiles,
    )
    player_entries = list(data.get("players", []))
    player_order = [str(player["player_id"]) for player in player_entries] or ["p1", "p2"]
    state = GameState(
        ruleset_version=str(data.get("ruleset_version", "test-v1")),
        active_player_id=str(data.get("active_player_id", player_order[0])),
        player_order=player_order,
        turn_number=int(data.get("turn_number", 1)),
        round_number=int(data.get("round_number", 1)),
        current_rseed=int(data.get("current_rseed", 12345)),
        game_map=game_map,
        metadata=dict(data.get("metadata", {"income_per_base": 100, "income_per_city": 50})),
    )
    for player in player_entries:
        state.add_player(
            PlayerState(
                player_id=str(player["player_id"]),
                faction=str(player["faction"]),
                credits=int(player.get("credits", 0)),
                team_id=player.get("team_id"),
                defeated=bool(player.get("defeated", False)),
                has_ended_turn=bool(player.get("has_ended_turn", False)),
                metadata=dict(player.get("metadata", {})),
            )
        )
    for unit in list(data.get("units", [])):
        action_data = dict(unit.get("action", {}))
        status_data = dict(unit.get("status", {}))
        state.add_unit(
            UnitState(
                instance_id=str(unit["instance_id"]),
                unit_id=str(unit["unit_id"]),
                owner_id=str(unit["owner_id"]),
                position=parse_coord(unit["coord"]),
                hp=int(unit.get("hp", 10)),
                veterancy_level=int(unit.get("veterancy_level", 0)),
                experience_points=int(unit.get("experience_points", 0)),
                status=UnitStatusState.from_dict(status_data),
                action=UnitActionState.from_dict(action_data),
                metadata=dict(unit.get("metadata", {})),
            )
        )
    return state


def load_text(relative_path: str) -> str:
    return (FIXTURES / relative_path).read_text(encoding="utf-8")


def load_json(relative_path: str) -> dict[str, Any]:
    return json.loads(load_text(relative_path))


def load_state(relative_path: str) -> GameState:
    return json_to_game_state(load_text(relative_path))


def scenario_id_for(relative_file: str, scenario_name: str) -> str:
    safe = "".join(ch if ch.isalnum() else "_" for ch in scenario_name.lower())
    while "__" in safe:
        safe = safe.replace("__", "_")
    safe = safe.strip("_")
    return f"{Path(relative_file).stem}__{safe or 'scenario'}"


def load_scenarios() -> list[dict[str, Any]]:
    scenarios: list[dict[str, Any]] = []
    for path in sorted(SCENARIOS.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        relative_file = str(path.relative_to(ROOT)).replace("\\", "/")
        if "cases" in payload:
            suite_name = str(payload.get("name", path.stem))
            defaults = {key: value for key, value in payload.items() if key not in {"cases", "name"}}
            for case_index, case in enumerate(list(payload["cases"])):
                merged = dict(defaults)
                merged.update(dict(case))
                merged_name = f"{suite_name} :: {case['name']}"
                merged["name"] = merged_name
                merged["_relative_file"] = relative_file
                merged["_suite_name"] = suite_name
                merged["_case_name"] = str(case["name"])
                merged["_case_index"] = case_index
                merged["scenario_id"] = scenario_id_for(relative_file, merged_name)
                scenarios.append(merged)
            continue
        suite_name = payload.get("suite_name")
        case_name = payload.get("case_name")
        display_name = (
            f"{suite_name} :: {case_name}"
            if suite_name is not None and case_name is not None
            else str(payload["name"])
        )
        payload["_relative_file"] = relative_file
        payload["_suite_name"] = suite_name
        payload["_case_name"] = case_name
        payload["_case_index"] = 0
        payload["name"] = display_name
        payload["scenario_id"] = scenario_id_for(relative_file, display_name)
        scenarios.append(payload)
    return scenarios


def load_scenario_by_id(scenario_id: str) -> dict[str, Any]:
    for scenario in load_scenarios():
        if str(scenario["scenario_id"]) == scenario_id:
            return scenario
    raise KeyError(f"Unknown scenario_id: {scenario_id}")


def load_state_from_scenario(scenario: dict[str, Any]) -> GameState:
    if "input_state_data" in scenario:
        return state_from_compact_data(dict(scenario["input_state_data"]))
    return load_state(str(scenario["input_state"]))


def build_state_at_step(scenario: dict[str, Any], step_index: int) -> GameState:
    state = load_state_from_scenario(scenario)
    if step_index < 0:
        return state
    actions = list(scenario.get("actions", []))
    if step_index >= len(actions):
        raise IndexError(f"step_index {step_index} out of range for scenario with {len(actions)} actions")
    for action in actions[: step_index + 1]:
        apply_result = _apply_action(state, dict(action))
        state = apply_result["state"]
    return state


def flatten_state_dict(state_dict: dict[str, Any]) -> dict[str, Any]:
    flattened: dict[str, Any] = {}

    def walk(prefix: str, value: Any) -> None:
        if isinstance(value, dict):
            for key in sorted(value):
                next_prefix = f"{prefix}.{key}" if prefix else str(key)
                walk(next_prefix, value[key])
            return
        if isinstance(value, list):
            for index, item in enumerate(value):
                next_prefix = f"{prefix}.{index}" if prefix else str(index)
                walk(next_prefix, item)
            return
        flattened[prefix] = value

    for key, value in state_dict.items():
        if key == "game_map":
            metadata = dict(value.get("metadata", {}))
            walk("game_map.metadata", metadata)
            for tile in value.get("tiles", []):
                coord = tile["coord"]
                coord_key = f"{coord['q']}:{coord['r']}"
                for tile_key, tile_value in tile.items():
                    if tile_key == "coord":
                        continue
                    walk(f"tile.{coord_key}.{tile_key}", tile_value)
            continue
        walk(key, value)
    return flattened


def compute_state_changes(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_flat = flatten_state_dict(before)
    after_flat = flatten_state_dict(after)
    paths = sorted(set(before_flat) | set(after_flat))
    changes: dict[str, Any] = {}
    for path in paths:
        before_value = before_flat.get(path, MISSING)
        after_value = after_flat.get(path, MISSING)
        if before_value != after_value:
            changes[path] = {
                "before": "__missing__" if before_value is MISSING else before_value,
                "after": "__missing__" if after_value is MISSING else after_value,
            }
    return changes


def _apply_action(state: GameState, action: dict[str, Any]) -> dict[str, Any]:
    action_type = str(action["type"])
    expected_error = action.get("expect_error")
    result: dict[str, Any] = {"action_type": action_type, "expected_error": expected_error}
    try:
        if action_type == "add_unit":
            unit = UnitState.from_dict(load_json(str(action["unit_fixture"])))
            state.add_unit(unit)
        elif action_type == "move_unit":
            state.move_unit(
                str(action["unit_id"]),
                parse_coord(action["destination"]),
                continue_as_atomic_attack=bool(
                    action.get("continue_as_atomic_attack", False)
                ),
            )
        elif action_type == "resurface_unit":
            state.resurface_unit(
                str(action["unit_id"]),
                continue_as_atomic_attack=bool(action.get("continue_as_atomic_attack", False)),
            )
        elif action_type == "bury_unit":
            state.bury_unit(str(action["unit_id"]))
        elif action_type == "attack_unit":
            kwargs: dict[str, Any] = {}
            for key in ("attack_bonus", "retaliation_bonus", "defender_damage", "attacker_damage"):
                if key in action:
                    kwargs[key] = int(action[key])
            if "was_melee" in action:
                kwargs["was_melee"] = bool(action["was_melee"])
            state.attack_unit(str(action["attacker_id"]), str(action["defender_id"]), **kwargs)
        elif action_type == "assert_gang_up_bonus":
            result["computed_value"] = state.get_gang_up_bonus(
                str(action["attacker_id"]),
                str(action["defender_id"]),
            )
        elif action_type == "assert_possible_moves":
            result["computed_value"] = state.get_possible_moves(str(action["unit_id"]))
        elif action_type == "end_turn":
            result["next_player_id"] = state.end_turn()
        elif action_type == "set_metadata":
            state.metadata[str(action["key"])] = action["value"]
        elif action_type == "round_trip_json":
            state = json_to_game_state(game_state_to_json(state))
            result["state_replaced"] = True
        else:
            raise ValueError(f"Unsupported action type: {action_type}")
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        if expected_error is None:
            raise
    return {"state": state, "result": result}


def build_scenario_report(scenario: dict[str, Any]) -> dict[str, Any]:
    state = load_state_from_scenario(scenario)
    initial_state = state.to_dict()
    steps: list[dict[str, Any]] = []
    for index, action in enumerate(list(scenario.get("actions", [])), start=1):
        before_state = state.to_dict()
        apply_result = _apply_action(state, dict(action))
        state = apply_result["state"]
        action_result = apply_result["result"]
        after_state = state.to_dict()
        changes = compute_state_changes(before_state, after_state)
        step_payload = {
            "index": index,
            "action": dict(action),
            "before_state": before_state,
            "after_state": after_state,
            "actual_changes": changes,
            "result": action_result,
        }
        if index == len(list(scenario.get("actions", []))):
            if "expected_changes" in scenario:
                step_payload["expected_changes"] = dict(scenario["expected_changes"])
            if "expected_state" in scenario:
                step_payload["expected_state"] = dict(scenario["expected_state"])
        steps.append(step_payload)
    final_state = state.to_dict()
    return {
        "scenario_id": str(scenario["scenario_id"]),
        "name": str(scenario["name"]),
        "suite_name": scenario.get("_suite_name"),
        "case_name": scenario.get("_case_name"),
        "relative_file": scenario.get("_relative_file"),
        "input_state": scenario.get("input_state"),
        "has_compact_input_state": "input_state_data" in scenario,
        "initial_state": initial_state,
        "steps": steps,
        "final_state": final_state,
        "final_changes": compute_state_changes(initial_state, final_state),
        "expected_changes": dict(scenario.get("expected_changes", {})),
        "expected_state": dict(scenario.get("expected_state", {})),
    }


def list_scenario_summaries() -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for scenario in load_scenarios():
        summaries.append(
            {
                "scenario_id": str(scenario["scenario_id"]),
                "name": str(scenario["name"]),
                "suite_name": scenario.get("_suite_name"),
                "case_name": scenario.get("_case_name"),
                "relative_file": scenario.get("_relative_file"),
                "action_count": len(list(scenario.get("actions", []))),
                "input_state": scenario.get("input_state"),
                "has_compact_input_state": "input_state_data" in scenario,
            }
        )
    return summaries


def compute_possible_moves_at_step(
    scenario_id: str,
    *,
    step_index: int,
    unit_id: str,
) -> dict[str, Any]:
    scenario = load_scenario_by_id(scenario_id)
    state = build_state_at_step(scenario, step_index)
    return state.get_possible_moves(unit_id)
