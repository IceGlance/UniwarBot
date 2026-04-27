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
    GameState,
    HexCoord,
    UnitState,
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
        return [json.loads(path.read_text(encoding="utf-8")) for path in scenario_files]

    def apply_actions(self, state: GameState, actions: list[dict[str, Any]]) -> GameState:
        for action in actions:
            action_type = str(action["type"])
            if action_type == "add_unit":
                unit = UnitState.from_dict(self.load_json(str(action["unit_fixture"])))
                state.add_unit(unit)
                continue
            if action_type == "move_unit":
                destination = HexCoord.from_dict(dict(action["destination"]))
                expected_error = action.get("expect_error")
                if expected_error is not None:
                    with self.assertRaisesRegex(ValueError, str(expected_error)):
                        state.move_unit(str(action["unit_id"]), destination)
                    continue
                state.move_unit(str(action["unit_id"]), destination)
                continue
            if action_type == "attack_unit":
                state.attack_unit(
                    str(action["attacker_id"]),
                    str(action["defender_id"]),
                    defender_damage=int(action.get("defender_damage", 0)),
                    attacker_damage=int(action.get("attacker_damage", 0)),
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
            state = self.load_state(str(scenario["input_state"]))
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
