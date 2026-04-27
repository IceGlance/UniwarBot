from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
FIXTURES = ROOT / "tests" / "fixtures"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


from uniwarbot import (  # noqa: E402
    GameState,
    HexCoord,
    UnitState,
    game_state_to_json,
    json_to_game_state,
)


class GameStateTestCase(unittest.TestCase):
    def load_fixture_text(self, *parts: str) -> str:
        return (FIXTURES.joinpath(*parts)).read_text(encoding="utf-8")

    def load_state(self, name: str) -> GameState:
        return json_to_game_state(self.load_fixture_text("states", name))

    def load_json_object(self, *parts: str) -> dict[str, object]:
        return json.loads(self.load_fixture_text(*parts))

    def test_map_creation_and_tile_lookup(self) -> None:
        state = self.load_state("map-only.json")

        self.assertEqual(state.game_map.metadata.name, "Test Map")
        self.assertEqual(state.game_map.get_tile(HexCoord(0, 0)).terrain_id, "base")
        self.assertEqual(state.game_map.get_tile(HexCoord(2, 0)).terrain_id, "harbor")
        self.assertIsNone(state.game_map.get_tile(HexCoord(9, 9)))

    def test_unit_creation_updates_tile_occupancy(self) -> None:
        state = self.load_state("map-only.json")
        marine = UnitState.from_dict(self.load_json_object("units", "marine.json"))

        state.add_unit(marine)

        self.assertEqual(state.get_unit("u_marine").unit_id, "marine")
        self.assertEqual(
            state.game_map.get_tile(HexCoord(0, 0)).occupying_unit_id, "u_marine"
        )
        self.assertEqual(state.get_unit_at(HexCoord(0, 0)).instance_id, "u_marine")

    def test_unit_move_updates_position_and_occupancy(self) -> None:
        state = self.load_state("move-ready.json")

        state.move_unit("u_marine", HexCoord(1, 0))

        self.assertEqual(state.get_unit("u_marine").position, HexCoord(1, 0))
        self.assertIsNone(state.game_map.get_tile(HexCoord(0, 0)).occupying_unit_id)
        self.assertEqual(
            state.game_map.get_tile(HexCoord(1, 0)).occupying_unit_id, "u_marine"
        )
        self.assertTrue(state.get_unit("u_marine").action.has_moved_this_turn)

    def test_attack_updates_hp_and_fight_context(self) -> None:
        state = self.load_state("attack-ready.json")

        state.attack_unit("u_attacker", "u_defender", defender_damage=3)

        self.assertEqual(state.get_unit("u_defender").hp, 7)
        self.assertEqual(state.fight_context.last_attacked_unit_id, "u_defender")
        self.assertEqual(state.fight_context.previous_attack_origin, HexCoord(0, 0))
        self.assertTrue(state.fight_context.previous_attack_was_melee)
        self.assertTrue(state.get_unit("u_attacker").action.has_attacked_this_turn)

    def test_end_turn_auto_heal_only_unused_units(self) -> None:
        state = self.load_state("end-turn-heal.json")

        state.end_turn()

        self.assertEqual(state.get_unit("u_idle").hp, 9)
        self.assertEqual(state.get_unit("u_moved").hp, 8)

    def test_end_turn_applies_start_of_turn_effects(self) -> None:
        state = self.load_state("end-turn-status-income.json")

        next_player = state.end_turn()

        self.assertEqual(next_player, "p2")
        self.assertEqual(state.active_player_id, "p2")
        self.assertEqual(state.players["p2"].credits, 150)
        self.assertEqual(state.get_unit("u_titan").hp, 5)
        self.assertEqual(state.get_unit("u_titan").status.emp_disabled_rounds, 1)
        self.assertEqual(state.get_unit("u_titan").status.teleport_disabled_rounds, 0)
        self.assertEqual(state.get_unit("u_titan").status.ability_cooldowns["uv"], 2)

    def test_city_income_uses_separate_metadata_setting(self) -> None:
        state = self.load_state("end-turn-status-income.json")
        state.metadata["income_per_city"] = 35

        state.end_turn()

        self.assertEqual(state.players["p2"].credits, 135)

    def test_end_turn_processes_capture_completion(self) -> None:
        state = self.load_state("capture-ready.json")

        state.end_turn()

        harbor_tile = state.game_map.get_tile(HexCoord(2, 0))
        self.assertEqual(state.active_player_id, "p2")
        self.assertEqual(harbor_tile.owner_id, "p2")
        self.assertIsNone(harbor_tile.capture_state)
        self.assertIsNone(harbor_tile.occupying_unit_id)
        self.assertIsNone(state.get_unit("u_capture"))

    def test_json_to_game_state_round_trip_preserves_nested_state(self) -> None:
        payload = self.load_fixture_text("states", "serialization-rich.json")

        state = json_to_game_state(payload)
        reloaded_state = json_to_game_state(game_state_to_json(state))

        self.assertEqual(reloaded_state.to_dict(), state.to_dict())
        self.assertEqual(reloaded_state.fight_context.chain_index, 2)
        self.assertTrue(reloaded_state.get_unit("u_wyrm").action.has_atomic_window_lock)
        self.assertEqual(
            reloaded_state.get_unit("u_mecha").status.hidden_mode.value, "buried"
        )
        self.assertEqual(reloaded_state.metadata["income_per_city"], 50)
        self.assertEqual(
            reloaded_state.game_map.get_tile(HexCoord(2, 0)).capture_state.rounds_remaining,
            2,
        )


if __name__ == "__main__":
    unittest.main()
