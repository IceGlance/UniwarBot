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
    UnitStatusState,
    VeterancyLevel,
    build_default_unit_action_state,
    game_state_to_json,
    json_to_game_state,
)
from uniwarbot.gui_api import build_game_state_from_map  # noqa: E402
from uniwarbot.scenario_inspector import flatten_state_dict  # noqa: E402


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
            suite_name = payload.get("suite_name")
            case_name = payload.get("case_name")
            if suite_name is not None and case_name is not None:
                payload["name"] = f"{suite_name} :: {case_name}"
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
            status_data = dict(unit.get("status", {}))
            state.add_unit(
                UnitState(
                    instance_id=str(unit["instance_id"]),
                    unit_id=str(unit["unit_id"]),
                    owner_id=str(unit["owner_id"]),
                    position=self.parse_coord(unit["coord"]),
                    hp=int(unit.get("hp", 10)),
                    veterancy_level=int(unit.get("veterancy_level", 0)),
                    experience_points=int(unit.get("experience_points", 0)),
                    status=UnitStatusState.from_dict(status_data),
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
                kwargs = {
                    "continue_as_atomic_attack": bool(
                        action.get("continue_as_atomic_attack", False)
                    )
                }
                if expected_error is not None:
                    with self.assertRaisesRegex(ValueError, str(expected_error)):
                        state.move_unit(str(action["unit_id"]), destination, **kwargs)
                    continue
                state.move_unit(str(action["unit_id"]), destination, **kwargs)
                continue
            if action_type == "resurface_unit":
                expected_error = action.get("expect_error")
                kwargs = {
                    "continue_as_atomic_attack": bool(
                        action.get("continue_as_atomic_attack", False)
                    )
                }
                if expected_error is not None:
                    with self.assertRaisesRegex(ValueError, str(expected_error)):
                        state.resurface_unit(str(action["unit_id"]), **kwargs)
                    continue
                state.resurface_unit(str(action["unit_id"]), **kwargs)
                continue
            if action_type == "bury_unit":
                expected_error = action.get("expect_error")
                if expected_error is not None:
                    with self.assertRaisesRegex(ValueError, str(expected_error)):
                        state.bury_unit(str(action["unit_id"]))
                    continue
                state.bury_unit(str(action["unit_id"]))
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
            if action_type == "assert_possible_moves":
                actual_moves = state.get_possible_moves(str(action["unit_id"]))
                expected_moves = dict(action["expected"])
                actual_moves_subset = {
                    key: actual_moves.get(key)
                    for key in expected_moves
                }
                self.assertEqual(
                    actual_moves_subset,
                    expected_moves,
                    msg=str(action.get("name", "possible_moves")),
                )
                continue
            if action_type == "end_turn":
                expected_error = action.get("expect_error")
                if expected_error is not None:
                    with self.assertRaisesRegex(ValueError, str(expected_error)):
                        state.end_turn()
                    continue
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

    def assert_expected_changes(
        self,
        before_state_dict: dict[str, Any],
        after_state: GameState,
        expectations: dict[str, Any],
        *,
        scenario_name: str,
    ) -> None:
        before_flat = flatten_state_dict(before_state_dict)
        after_flat = flatten_state_dict(after_state.to_dict())
        for path, expected in expectations.items():
            with self.subTest(scenario=scenario_name, path=path):
                actual_before = before_flat.get(path, MISSING)
                actual_after = after_flat.get(path, MISSING)
                if isinstance(expected, dict) and "before" in expected and "after" in expected:
                    expected_before = expected["before"]
                    expected_after = expected["after"]
                else:
                    expected_before = MISSING
                    expected_after = expected

                if expected_before == "__missing__":
                    self.assertIs(
                        actual_before,
                        MISSING,
                        msg=f"{scenario_name}: expected missing previous path {path}, got {actual_before!r}",
                    )
                elif expected_before is not MISSING:
                    self.assertEqual(
                        actual_before,
                        expected_before,
                        msg=f"{scenario_name}: previous value for path {path}",
                    )

                if expected_after == "__missing__":
                    self.assertIs(
                        actual_after,
                        MISSING,
                        msg=f"{scenario_name}: expected missing final path {path}, got {actual_after!r}",
                    )
                else:
                    self.assertEqual(
                        actual_after,
                        expected_after,
                        msg=f"{scenario_name}: final value for path {path}",
                    )

    def run_scenario(self, scenario: dict[str, Any]) -> None:
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
            self.assert_expected_changes(
                input_state_dict,
                state,
                dict(scenario["expected_changes"]),
                scenario_name=scenario_name,
            )


class GameStartFromMapTestCase(unittest.TestCase):
    def test_build_game_state_from_map_remaps_units_to_selected_factions(self) -> None:
        map_payload = {
            "map_id": "start-map",
            "name": "Start Map",
            "size": {"width": 3, "height": 2},
            "players": [
                {"player_id": "p1", "allowed_factions": ["titans", "sapiens"]},
                {"player_id": "p2", "allowed_factions": ["sapiens", "khraleans"]},
            ],
            "economy": {"base_income": 100, "city_income": 50, "starting_credits": 250},
            "start_random_seed": 123,
            "tiles": [
                {"coord": {"q": 0, "r": 0}, "terrain_id": "plain", "owner_id": None},
                {"coord": {"q": 1, "r": 0}, "terrain_id": "plain", "owner_id": None},
                {"coord": {"q": 2, "r": 0}, "terrain_id": "water", "owner_id": None},
                {"coord": {"q": 0, "r": 1}, "terrain_id": "plain", "owner_id": None},
            ],
            "units": [
                {
                    "instance_id": "u1",
                    "unit_id": "marine",
                    "owner_id": "p1",
                    "position": {"q": 0, "r": 0},
                    "hp": 9,
                    "status": {"plague_infected": True},
                },
                {
                    "instance_id": "u2",
                    "unit_id": "submarine",
                    "owner_id": "p1",
                    "position": {"q": 2, "r": 0},
                    "hp": 10,
                    "status": {"hidden_mode": "submerged"},
                },
                {
                    "instance_id": "u3",
                    "unit_id": "mecha",
                    "owner_id": "p2",
                    "position": {"q": 1, "r": 0},
                    "hp": 10,
                    "status": {
                        "teleport_lock_phase": "owner_turn",
                        "teleport_cooldown_rounds": 2,
                    },
                },
                {
                    "instance_id": "u4",
                    "unit_id": "underling",
                    "owner_id": "p2",
                    "position": {"q": 0, "r": 1},
                    "hp": 10,
                    "status": {
                        "hidden_mode": "buried",
                        "buried_resurface_bonus": 4,
                    },
                },
            ],
        }

        state = build_game_state_from_map(
            map_payload,
            player_factions={"p1": "titans", "p2": "sapiens"},
        )

        self.assertEqual("titans", state.players["p1"].faction)
        self.assertEqual("sapiens", state.players["p2"].faction)
        self.assertEqual("mecha", state.units["u1"].unit_id)
        self.assertFalse(state.units["u1"].status.plague_infected)
        self.assertEqual("skimmer", state.units["u2"].unit_id)
        self.assertIsNotNone(state.units["u2"].status.hidden_mode)
        self.assertEqual("submerged", state.units["u2"].status.hidden_mode.value)
        self.assertEqual("marine", state.units["u3"].unit_id)
        self.assertIsNone(state.units["u3"].status.teleport_lock_phase)
        self.assertEqual(0, state.units["u3"].status.teleport_cooldown_rounds)
        self.assertEqual("marine", state.units["u4"].unit_id)
        self.assertIsNone(state.units["u4"].status.hidden_mode)
        self.assertEqual(0, state.units["u4"].status.buried_resurface_bonus)

    def test_build_game_state_from_map_uses_seed_override_and_validates_factions(self) -> None:
        map_payload = {
            "map_id": "seed-map",
            "name": "Seed Map",
            "size": {"width": 1, "height": 1},
            "players": [
                {"player_id": "p1", "allowed_factions": ["sapiens"]},
            ],
            "economy": {"base_income": 100, "city_income": 50, "starting_credits": 100},
            "start_random_seed": 321,
            "tiles": [
                {"coord": {"q": 0, "r": 0}, "terrain_id": "plain", "owner_id": None},
            ],
            "units": [],
        }

        default_seed_state = build_game_state_from_map(map_payload)
        self.assertEqual(321, default_seed_state.current_rseed)

        override_seed_state = build_game_state_from_map(map_payload, seed_override=777)
        self.assertEqual(777, override_seed_state.current_rseed)

        with self.assertRaisesRegex(ValueError, "not allowed"):
            build_game_state_from_map(
                map_payload,
                player_factions={"p1": "titans"},
            )

    def test_build_game_state_from_map_exposes_capture_on_neutral_base_and_harbor(self) -> None:
        map_payload = {
            "map_id": "capture-map",
            "name": "Capture Map",
            "size": {"width": 3, "height": 1},
            "players": [
                {"player_id": "p1", "allowed_factions": ["khraleans"]},
                {"player_id": "p2", "allowed_factions": ["titans"]},
            ],
            "economy": {"base_income": 100, "city_income": 50, "starting_credits": 100},
            "tiles": [
                {"coord": {"q": 0, "r": 0}, "terrain_id": "base", "owner_id": None},
                {"coord": {"q": 1, "r": 0}, "terrain_id": "harbor", "owner_id": None},
                {"coord": {"q": 2, "r": 0}, "terrain_id": "plain", "owner_id": None},
            ],
            "units": [
                {
                    "instance_id": "u_underling",
                    "unit_id": "underling",
                    "owner_id": "p1",
                    "position": {"q": 0, "r": 0},
                    "hp": 10,
                },
                {
                    "instance_id": "u_salamander",
                    "unit_id": "salamander",
                    "owner_id": "p1",
                    "position": {"q": 1, "r": 0},
                    "hp": 10,
                },
            ],
        }

        state = build_game_state_from_map(map_payload, player_factions={"p1": "khraleans", "p2": "titans"})

        self.assertTrue(state.get_current_special_options("u_underling")["can_capture"])
        self.assertTrue(state.get_current_special_options("u_salamander")["can_capture"])

    def test_build_game_state_from_map_exposes_adjacent_attack_targets(self) -> None:
        map_payload = {
            "map_id": "attack-map",
            "name": "Attack Map",
            "size": {"width": 3, "height": 1},
            "players": [
                {"player_id": "p1", "allowed_factions": ["sapiens"]},
                {"player_id": "p2", "allowed_factions": ["sapiens"]},
            ],
            "economy": {"base_income": 100, "city_income": 50, "starting_credits": 100},
            "tiles": [
                {"coord": {"q": 0, "r": 0}, "terrain_id": "plain", "owner_id": None},
                {"coord": {"q": 1, "r": 0}, "terrain_id": "plain", "owner_id": None},
                {"coord": {"q": 2, "r": 0}, "terrain_id": "plain", "owner_id": None},
            ],
            "units": [
                {
                    "instance_id": "u_marine_p1",
                    "unit_id": "marine",
                    "owner_id": "p1",
                    "position": {"q": 0, "r": 0},
                    "hp": 10,
                },
                {
                    "instance_id": "u_marine_p2_adjacent",
                    "unit_id": "marine",
                    "owner_id": "p2",
                    "position": {"q": 1, "r": 0},
                    "hp": 10,
                },
                {
                    "instance_id": "u_marine_p2_far",
                    "unit_id": "marine",
                    "owner_id": "p2",
                    "position": {"q": 2, "r": 0},
                    "hp": 10,
                },
            ],
        }

        state = build_game_state_from_map(map_payload)
        move_info = state.get_possible_moves("u_marine_p1")

        self.assertEqual(["u_marine_p2_adjacent"], move_info["current_attack_targets"])

    def test_begin_capture_marks_unit_capture_target_and_tile_capture_state(self) -> None:
        map_payload = {
            "map_id": "capture-begin-map",
            "name": "Capture Begin Map",
            "size": {"width": 1, "height": 1},
            "players": [
                {"player_id": "p1", "allowed_factions": ["khraleans"]},
            ],
            "economy": {"base_income": 100, "city_income": 50, "starting_credits": 100},
            "tiles": [
                {"coord": {"q": 0, "r": 0}, "terrain_id": "base", "owner_id": None},
            ],
            "units": [
                {
                    "instance_id": "u_underling",
                    "unit_id": "underling",
                    "owner_id": "p1",
                    "position": {"q": 0, "r": 0},
                    "hp": 10,
                },
            ],
        }

        state = build_game_state_from_map(map_payload, player_factions={"p1": "khraleans"})
        state.begin_capture("u_underling", HexCoord(0, 0))

        self.assertEqual(HexCoord(0, 0), state.get_unit("u_underling").capture_target)
        self.assertIsNotNone(state.game_map.get_tile(HexCoord(0, 0)).capture_state)
        self.assertEqual(
            "u_underling",
            state.game_map.get_tile(HexCoord(0, 0)).capture_state.capturing_unit_id,
        )

    def test_move_onto_base_then_capture_is_allowed(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="capture-after-move", name="Capture After Move")
        )
        for coord, terrain_id in (
            (HexCoord(0, 0), "plain"),
            (HexCoord(1, 0), "base"),
        ):
            game_map.add_tile(TileState(coord=coord, terrain_id=terrain_id, owner_id=None))
        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p1",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=12345,
            game_map=game_map,
            metadata={"income_per_base": 100, "income_per_city": 50},
        )
        state.add_player(PlayerState(player_id="p1", faction="khraleans", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="titans", credits=0))
        state.add_unit(
            UnitState(
                instance_id="u_underling",
                unit_id="underling",
                owner_id="p1",
                position=HexCoord(0, 0),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("underling"),
            )
        )

        state.move_unit("u_underling", HexCoord(1, 0))
        self.assertTrue(state.get_current_special_options("u_underling")["can_capture"])

        state.begin_capture("u_underling", HexCoord(1, 0))

        self.assertEqual(HexCoord(1, 0), state.get_unit("u_underling").capture_target)
        self.assertIsNotNone(state.game_map.get_tile(HexCoord(1, 0)).capture_state)

    def test_surface_underling_move_then_attack_requires_atomic_move_flag(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="underling-move-attack", name="Underling Move Attack")
        )
        for coord in (
            HexCoord(0, 0),
            HexCoord(1, 0),
            HexCoord(2, 0),
            HexCoord(0, 1),
            HexCoord(1, 1),
            HexCoord(2, 1),
        ):
            game_map.add_tile(TileState(coord=coord, terrain_id="plain"))
        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p1",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=12345,
            game_map=game_map,
            metadata={"income_per_base": 100, "income_per_city": 50},
        )
        state.add_player(PlayerState(player_id="p1", faction="khraleans", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="sapiens", credits=0))
        state.add_unit(
            UnitState(
                instance_id="u_underling",
                unit_id="underling",
                owner_id="p1",
                position=HexCoord(0, 0),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("underling"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_marine",
                unit_id="marine",
                owner_id="p2",
                position=HexCoord(2, 0),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )

        state.move_unit(
            "u_underling",
            HexCoord(1, 0),
            continue_as_atomic_attack=True,
        )
        move_options = state.get_possible_moves("u_underling")
        self.assertIn("u_marine", move_options["current_attack_targets"])
        self.assertTrue(state.get_unit("u_underling").action.atomic_action_locked)

        state.attack_unit("u_underling", "u_marine")

        self.assertLess(state.get_unit("u_marine").hp, 10)
        self.assertFalse(state.get_unit("u_underling").action.atomic_action_locked)

    def test_underling_can_still_move_attack_same_target_after_swarmer_attacks_first(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="double-attack-sequence", name="Double Attack Sequence")
        )
        for q in range(10):
            for r in range(10):
                game_map.add_tile(
                    TileState(coord=HexCoord(q, r), terrain_id="plain", owner_id=None)
                )
        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p2",
            player_order=["p1", "p2"],
            turn_number=12,
            round_number=12,
            current_rseed=-4193972046270825500,
            game_map=game_map,
            metadata={"income_per_base": 100, "income_per_city": 50},
        )
        state.add_player(PlayerState(player_id="p1", faction="sapiens", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="khraleans", credits=0))
        state.add_unit(
            UnitState(
                instance_id="u_marine",
                unit_id="marine",
                owner_id="p1",
                position=HexCoord(6, 5),
                hp=3,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_swarmer",
                unit_id="swarmer",
                owner_id="p2",
                position=HexCoord(6, 7),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=UnitActionState.from_dict(
                    {
                        **build_default_unit_action_state("swarmer").to_dict(),
                        "attacks_remaining": 0,
                        "has_attacked_this_turn": True,
                    }
                ),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_underling",
                unit_id="underling",
                owner_id="p2",
                position=HexCoord(8, 5),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("underling"),
            )
        )

        move_options = state.get_possible_moves("u_underling")
        self.assertIn("7:5", move_options["legal_move_destinations"])
        self.assertIn("u_marine", move_options["move_attack_targets"]["7:5"])

        state.move_unit("u_underling", HexCoord(7, 5), continue_as_atomic_attack=True)
        self.assertIn("u_marine", state.get_possible_moves("u_underling")["current_attack_targets"])

        state.attack_unit("u_underling", "u_marine")

        self.assertIsNone(state.get_unit("u_marine"))

    def test_partial_damage_without_kill_grants_no_experience(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="xp-no-kill", name="XP No Kill")
        )
        for coord in (HexCoord(0, 0), HexCoord(1, 0)):
            game_map.add_tile(TileState(coord=coord, terrain_id="plain"))
        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p2",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=12345,
            game_map=game_map,
            metadata={"income_per_base": 100, "income_per_city": 50},
        )
        state.add_player(PlayerState(player_id="p1", faction="sapiens", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="khraleans", credits=0))
        state.add_unit(
            UnitState(
                instance_id="u_marine",
                unit_id="marine",
                owner_id="p1",
                position=HexCoord(0, 0),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_swarmer",
                unit_id="swarmer",
                owner_id="p2",
                position=HexCoord(1, 0),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("swarmer"),
            )
        )

        state.attack_unit("u_swarmer", "u_marine", defender_damage=6, attacker_damage=0)

        self.assertEqual(4, state.get_unit("u_marine").hp)
        self.assertEqual(0, state.get_unit("u_swarmer").experience_points)
        self.assertEqual(VeterancyLevel.NONE, state.get_unit("u_swarmer").veterancy_level)

    def test_killing_blow_grants_experience_only_to_the_unit_that_kills(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="xp-kill-credit", name="XP Kill Credit")
        )
        for coord in (
            HexCoord(6, 5),
            HexCoord(6, 7),
            HexCoord(8, 5),
            HexCoord(7, 5),
        ):
            game_map.add_tile(TileState(coord=coord, terrain_id="plain"))
        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p2",
            player_order=["p1", "p2"],
            turn_number=12,
            round_number=12,
            current_rseed=12345,
            game_map=game_map,
            metadata={"income_per_base": 100, "income_per_city": 50},
        )
        state.add_player(PlayerState(player_id="p1", faction="sapiens", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="khraleans", credits=0))
        state.add_unit(
            UnitState(
                instance_id="u_marine",
                unit_id="marine",
                owner_id="p1",
                position=HexCoord(6, 5),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_swarmer",
                unit_id="swarmer",
                owner_id="p2",
                position=HexCoord(6, 7),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("swarmer"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_underling",
                unit_id="underling",
                owner_id="p2",
                position=HexCoord(8, 5),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("underling"),
            )
        )

        state.attack_unit("u_swarmer", "u_marine", defender_damage=6, attacker_damage=0)
        state.move_unit("u_underling", HexCoord(7, 5), continue_as_atomic_attack=True)
        state.attack_unit("u_underling", "u_marine", defender_damage=4, attacker_damage=0)

        self.assertIsNone(state.get_unit("u_marine"))
        self.assertEqual(0, state.get_unit("u_swarmer").experience_points)
        self.assertEqual(40, state.get_unit("u_underling").experience_points)
        self.assertEqual(VeterancyLevel.NONE, state.get_unit("u_underling").veterancy_level)
        self.assertEqual(10, state.get_unit("u_underling").hp)

    def test_experience_reaching_unit_cost_grants_first_veterancy_and_plus_one_hp(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="xp-first-veterancy", name="XP First Veterancy")
        )
        for coord in (HexCoord(0, 0), HexCoord(1, 0)):
            game_map.add_tile(TileState(coord=coord, terrain_id="plain"))
        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p2",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=12345,
            game_map=game_map,
            metadata={"income_per_base": 100, "income_per_city": 50},
        )
        state.add_player(PlayerState(player_id="p1", faction="sapiens", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="khraleans", credits=0))
        state.add_unit(
            UnitState(
                instance_id="u_marine",
                unit_id="marine",
                owner_id="p1",
                position=HexCoord(0, 0),
                hp=4,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_underling",
                unit_id="underling",
                owner_id="p2",
                position=HexCoord(1, 0),
                hp=10,
                veterancy_level=0,
                experience_points=60,
                status=UnitStatusState(),
                action=build_default_unit_action_state("underling"),
            )
        )

        state.attack_unit("u_underling", "u_marine", defender_damage=4, attacker_damage=0)

        underling = state.get_unit("u_underling")
        self.assertEqual(100, underling.experience_points)
        self.assertEqual(VeterancyLevel.ONE, underling.veterancy_level)
        self.assertEqual(11, underling.hp)

    def test_experience_reaching_second_veterancy_adds_one_more_hp_and_then_caps(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="xp-second-veterancy", name="XP Second Veterancy")
        )
        for coord in (HexCoord(0, 0), HexCoord(1, 0), HexCoord(2, 0)):
            game_map.add_tile(TileState(coord=coord, terrain_id="plain"))
        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p2",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=12345,
            game_map=game_map,
            metadata={"income_per_base": 100, "income_per_city": 50},
        )
        state.add_player(PlayerState(player_id="p1", faction="sapiens", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="khraleans", credits=0))
        state.add_unit(
            UnitState(
                instance_id="u_marine_1",
                unit_id="marine",
                owner_id="p1",
                position=HexCoord(0, 0),
                hp=4,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_marine_2",
                unit_id="marine",
                owner_id="p1",
                position=HexCoord(2, 0),
                hp=4,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_underling",
                unit_id="underling",
                owner_id="p2",
                position=HexCoord(1, 0),
                hp=11,
                veterancy_level=1,
                experience_points=160,
                status=UnitStatusState(),
                action=build_default_unit_action_state("underling"),
            )
        )

        state.attack_unit("u_underling", "u_marine_1", defender_damage=4, attacker_damage=0)

        underling = state.get_unit("u_underling")
        self.assertEqual(200, underling.experience_points)
        self.assertEqual(VeterancyLevel.TWO, underling.veterancy_level)
        self.assertEqual(12, underling.hp)

        state.get_unit("u_underling").action.reset_for_new_turn()
        state.attack_unit("u_underling", "u_marine_2", defender_damage=4, attacker_damage=0)

        underling = state.get_unit("u_underling")
        self.assertEqual(240, underling.experience_points)
        self.assertEqual(VeterancyLevel.TWO, underling.veterancy_level)
        self.assertEqual(12, underling.hp)

    def test_retaliation_kill_grants_experience_to_the_defender(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="xp-retaliation-kill", name="XP Retaliation Kill")
        )
        for coord in (HexCoord(0, 0), HexCoord(1, 0)):
            game_map.add_tile(TileState(coord=coord, terrain_id="plain"))
        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p1",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=12345,
            game_map=game_map,
            metadata={"income_per_base": 100, "income_per_city": 50},
        )
        state.add_player(PlayerState(player_id="p1", faction="sapiens", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="sapiens", credits=0))
        state.add_unit(
            UnitState(
                instance_id="u_marine",
                unit_id="marine",
                owner_id="p1",
                position=HexCoord(0, 0),
                hp=1,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_tank",
                unit_id="tank",
                owner_id="p2",
                position=HexCoord(1, 0),
                hp=10,
                veterancy_level=0,
                experience_points=0,
                status=UnitStatusState(),
                action=build_default_unit_action_state("tank"),
            )
        )

        state.attack_unit("u_marine", "u_tank", defender_damage=0, attacker_damage=1)

        self.assertIsNone(state.get_unit("u_marine"))
        self.assertEqual(10, state.get_unit("u_tank").experience_points)

    def test_attack_preview_uses_current_seed_for_direct_and_retaliation_damage(self) -> None:
        payload = json.loads(
            (FIXTURES / "states" / "damage-indication-ready.json").read_text(encoding="utf-8")
        )
        state = GameState.from_dict(dict(payload))

        previews = state.get_possible_moves("u_swarmer_p2")["current_attack_previews"]

        self.assertEqual(
            {"direct_damage": 5, "retaliation_damage": 0},
            previews["u_marine_p1_2"],
        )
        self.assertEqual(
            {"direct_damage": 6, "retaliation_damage": 0},
            previews["u_marine_p1"],
        )

    def test_move_attack_preview_matches_post_move_preview_for_underling_against_marine(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="move-attack-preview-marine", name="Move Attack Preview Marine")
        )
        for q in range(8):
            for r in range(8):
                game_map.add_tile(TileState(coord=HexCoord(q, r), terrain_id="plain"))
        state = GameState(
            ruleset_version="test.preview.v1",
            active_player_id="p2",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=12345,
            game_map=game_map,
            players={
                "p1": PlayerState(player_id="p1", faction="sapiens", credits=0),
                "p2": PlayerState(player_id="p2", faction="khraleans", credits=0),
            },
        )
        state.add_unit(
            UnitState(
                instance_id="u_underling",
                unit_id="underling",
                owner_id="p2",
                position=HexCoord(6, 3),
                hp=10,
                status=UnitStatusState(),
                action=build_default_unit_action_state("underling"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_marine",
                unit_id="marine",
                owner_id="p1",
                position=HexCoord(4, 4),
                hp=10,
                status=UnitStatusState(),
                action=build_default_unit_action_state("marine"),
            )
        )

        move_options = state.get_possible_moves("u_underling")

        self.assertIn("u_marine", move_options["move_attack_targets"]["5:4"])
        preview_before_move = move_options["move_attack_previews"]["5:4"]["u_marine"]

        moved_state = GameState.from_dict(state.to_dict())
        moved_state.move_unit("u_underling", HexCoord(5, 4), continue_as_atomic_attack=True)
        preview_after_move = moved_state.get_possible_moves("u_underling")["current_attack_previews"]["u_marine"]

        self.assertEqual(preview_after_move, preview_before_move)

    def test_move_attack_preview_matches_post_move_preview_for_underling_against_battery(self) -> None:
        game_map = GameMap(
            metadata=MapMetadata(map_id="move-attack-preview-battery", name="Move Attack Preview Battery")
        )
        for q in range(8):
            for r in range(8):
                game_map.add_tile(TileState(coord=HexCoord(q, r), terrain_id="plain"))
        state = GameState(
            ruleset_version="test.preview.v1",
            active_player_id="p2",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=12345,
            game_map=game_map,
            players={
                "p1": PlayerState(player_id="p1", faction="sapiens", credits=0),
                "p2": PlayerState(player_id="p2", faction="khraleans", credits=0),
            },
        )
        state.add_unit(
            UnitState(
                instance_id="u_underling",
                unit_id="underling",
                owner_id="p2",
                position=HexCoord(4, 3),
                hp=10,
                status=UnitStatusState(),
                action=build_default_unit_action_state("underling"),
            )
        )
        state.add_unit(
            UnitState(
                instance_id="u_battery",
                unit_id="battery",
                owner_id="p1",
                position=HexCoord(2, 1),
                hp=10,
                status=UnitStatusState(),
                action=build_default_unit_action_state("battery"),
            )
        )

        move_options = state.get_possible_moves("u_underling")

        self.assertIn("u_battery", move_options["move_attack_targets"]["3:1"])
        preview_before_move = move_options["move_attack_previews"]["3:1"]["u_battery"]

        moved_state = GameState.from_dict(state.to_dict())
        moved_state.move_unit("u_underling", HexCoord(3, 1), continue_as_atomic_attack=True)
        preview_after_move = moved_state.get_possible_moves("u_underling")["current_attack_previews"]["u_battery"]

        self.assertEqual(preview_after_move, preview_before_move)


def _safe_test_name(name: str) -> str:
    normalized = "".join(ch if ch.isalnum() else "_" for ch in name.lower())
    while "__" in normalized:
        normalized = normalized.replace("__", "_")
    normalized = normalized.strip("_")
    return normalized or "scenario"


def _load_all_scenarios() -> list[dict[str, Any]]:
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
        suite_name = payload.get("suite_name")
        case_name = payload.get("case_name")
        if suite_name is not None and case_name is not None:
            payload["name"] = f"{suite_name} :: {case_name}"
        scenarios.append(payload)
    return scenarios


def _install_scenario_tests() -> None:
    seen_names: set[str] = set()
    for index, scenario in enumerate(_load_all_scenarios(), start=1):
        scenario_copy = dict(scenario)
        base_name = _safe_test_name(str(scenario_copy["name"]))
        test_name = f"test_{index:03d}_{base_name}"
        while test_name in seen_names:
            index += 1
            test_name = f"test_{index:03d}_{base_name}"
        seen_names.add(test_name)

        def _test(self: GameStateScenarioTestCase, scenario: dict[str, Any] = scenario_copy) -> None:
            self.run_scenario(scenario)

        _test.__name__ = test_name
        _test.__doc__ = str(scenario_copy["name"])
        setattr(GameStateScenarioTestCase, test_name, _test)


_install_scenario_tests()


if __name__ == "__main__":
    unittest.main()
