from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
FIXTURES = ROOT / "tests" / "fixtures"
SCENARIOS = FIXTURES / "scenarios"
MISSING = object()

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


from uniwarbot import (  # noqa: E402
    GameMap,
    GameState,
    HexCoord,
    MapMetadata,
    PlayerState,
    TileState,
    UnitState,
    UnitActionState,
    game_state_to_json,
    json_to_game_state,
)


class GameStateScenarioTestCase(unittest.TestCase):
    def load_text(self, relative_path: str) -> str:
        return (FIXTURES / relative_path).read_text(encoding="utf-8")

    def load_json(self, relative_path: str) -> dict[str, Any]:
        return json.loads(self.load_text(relative_path))

    def load_state(self, relative_path: str) -> GameState:
        return json_to_game_state(self.load_text(relative_path))

    def load_scenarios(self) -> list[dict[str, Any]]:
        scenario_files = sorted(SCENARIOS.glob("*.json"))
        scenarios: list[dict[str, Any]] = []
        for path in scenario_files:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if "cases" in payload:
                suite_name = str(payload.get("name", path.stem))
                defaults = {
                    key: value
                    for key, value in payload.items()
                    if key not in {"cases", "name"}
                }
                for case in list(payload["cases"]):
                    merged = dict(defaults)
                    merged.update(dict(case))
                    merged["name"] = f"{suite_name} :: {case['name']}"
                    scenarios.append(merged)
                continue
            scenarios.append(payload)
        return scenarios

    def parse_coord(self, value: Any) -> HexCoord:
        if isinstance(value, dict):
            return HexCoord.from_dict(dict(value))
        if isinstance(value, str):
            q_text, r_text = value.split(":")
            return HexCoord(q=int(q_text), r=int(r_text))
        raise TypeError(f"Unsupported coord value: {value!r}")

    def state_from_compact_data(self, data: dict[str, Any]) -> GameState:
        tiles = {
            self.parse_coord(tile["coord"]): TileState(
                coord=self.parse_coord(tile["coord"]),
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
        player_order = [
            str(player["player_id"]) for player in player_entries
        ] or ["p1", "p2"]
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
            state.add_unit(
                UnitState(
                    instance_id=str(unit["instance_id"]),
                    unit_id=str(unit["unit_id"]),
                    owner_id=str(unit["owner_id"]),
                    position=self.parse_coord(unit["coord"]),
                    hp=int(unit.get("hp", 10)),
                    action=UnitActionState.from_dict(action_data),
                    metadata=dict(unit.get("metadata", {})),
                )
            )
        return state

    def load_state_from_scenario(self, scenario: dict[str, Any]) -> GameState:
        if "input_state_data" in scenario:
            return self.state_from_compact_data(dict(scenario["input_state_data"]))
        return self.load_state(str(scenario["input_state"]))

    def apply_actions(self, state: GameState, actions: list[dict[str, Any]]) -> GameState:
        for action in actions:
            action_type = str(action["type"])
            if action_type == "add_unit":
                unit = UnitState.from_dict(self.load_json(str(action["unit_fixture"])))
                state.add_unit(unit)
                continue
            if action_type == "move_unit":
                destination = self.parse_coord(action["destination"])
                expected_error = action.get("expect_error")
                if expected_error is not None:
                    with self.assertRaisesRegex(ValueError, str(expected_error)):
                        state.move_unit(str(action["unit_id"]), destination)
                    continue
                state.move_unit(str(action["unit_id"]), destination)
                continue
            if action_type == "attack_unit":
                kwargs: dict[str, Any] = {}
                if "attack_bonus" in action:
                    kwargs["attack_bonus"] = int(action["attack_bonus"])
                if "retaliation_bonus" in action:
                    kwargs["retaliation_bonus"] = int(action["retaliation_bonus"])
                if "defender_damage" in action:
                    kwargs["defender_damage"] = int(action["defender_damage"])
                if "attacker_damage" in action:
                    kwargs["attacker_damage"] = int(action["attacker_damage"])
                if "was_melee" in action:
                    kwargs["was_melee"] = bool(action["was_melee"])
                expected_error = action.get("expect_error")
                if expected_error is not None:
                    with self.assertRaisesRegex(ValueError, str(expected_error)):
                        state.attack_unit(
                            str(action["attacker_id"]),
                            str(action["defender_id"]),
                            **kwargs,
                        )
                    continue
                state.attack_unit(str(action["attacker_id"]), str(action["defender_id"]), **kwargs)
                continue
            if action_type == "assert_gang_up_bonus":
                actual_bonus = state.get_gang_up_bonus(
                    str(action["attacker_id"]),
                    str(action["defender_id"]),
                )
                self.assertEqual(
                    actual_bonus,
                    int(action["expected_bonus"]),
                    msg=str(action.get("name", "gang_up_bonus")),
                )
                continue
            if action_type == "end_turn":
                state.end_turn()
                continue
            if action_type == "set_metadata":
                state.metadata[str(action["key"])] = action["value"]
                continue
            if action_type == "round_trip_json":
                state = json_to_game_state(game_state_to_json(state))
                continue
            raise ValueError(f"Unsupported action type: {action_type}")
        return state

    def resolve_path(self, state_dict: dict[str, Any], path: str) -> Any:
        if path.startswith("tile."):
            parts = path.split(".")
            coord_key = parts[1]
            tile = self.find_tile(state_dict, coord_key)
            if tile is MISSING:
                return MISSING
            return self.walk_value(tile, parts[2:])
        return self.walk_value(state_dict, path.split("."))

    def find_tile(self, state_dict: dict[str, Any], coord_key: str) -> Any:
        q_text, r_text = coord_key.split(":")
        q = int(q_text)
        r = int(r_text)
        for tile in state_dict["game_map"]["tiles"]:
            if tile["coord"]["q"] == q and tile["coord"]["r"] == r:
                return tile
        return MISSING

    def walk_value(self, value: Any, parts: list[str]) -> Any:
        current = value
        for part in parts:
            if current is None:
                return MISSING
            if isinstance(current, list):
                try:
                    current = current[int(part)]
                except (ValueError, IndexError):
                    return MISSING
                continue
            if isinstance(current, dict):
                if part not in current:
                    return MISSING
                current = current[part]
                continue
            return MISSING
        return current

    def assert_partial_state(
        self,
        state: GameState,
        expectations: dict[str, Any],
        *,
        scenario_name: str,
    ) -> None:
        state_dict = state.to_dict()
        for path, expected in expectations.items():
            with self.subTest(scenario=scenario_name, path=path):
                actual = self.resolve_path(state_dict, path)
                if expected == "__missing__":
                    self.assertIs(
                        actual,
                        MISSING,
                        msg=f"{scenario_name}: expected missing path {path}, got {actual!r}",
                    )
                else:
                    self.assertEqual(
                        actual,
                        expected,
                        msg=f"{scenario_name}: path {path}",
                    )

    def test_game_state_scenarios(self) -> None:
        for scenario in self.load_scenarios():
            scenario_name = str(scenario["name"])
            state = self.load_state_from_scenario(scenario)
            input_state_dict = state.to_dict()
            state = self.apply_actions(state, list(scenario.get("actions", [])))

            if bool(scenario.get("assert_final_dict_equals_input", False)):
                self.assertEqual(
                    state.to_dict(),
                    input_state_dict,
                    msg=f"{scenario_name}: full state changed after round trip",
                )

            if "expected_state" in scenario:
                self.assert_partial_state(
                    state,
                    dict(scenario["expected_state"]),
                    scenario_name=scenario_name,
                )
            if "expected_changes" in scenario:
                self.assert_partial_state(
                    state,
                    dict(scenario["expected_changes"]),
                    scenario_name=scenario_name,
                )


if __name__ == "__main__":
    unittest.main()
