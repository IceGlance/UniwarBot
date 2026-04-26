from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


from uniwarbot import (  # noqa: E402
    CaptureState,
    GameMap,
    GameState,
    HexCoord,
    MapMetadata,
    PlayerState,
    TileState,
    UnitActionState,
    UnitState,
    UnitStatusState,
)


class GameStateTestCase(unittest.TestCase):
    def build_state(self) -> GameState:
        game_map = GameMap(
            metadata=MapMetadata(map_id="test-map", name="Test Map", width=3, height=3)
        )
        game_map.add_tile(TileState(coord=HexCoord(0, 0), terrain_id="base", owner_id="p1"))
        game_map.add_tile(TileState(coord=HexCoord(1, 0), terrain_id="plain"))
        game_map.add_tile(TileState(coord=HexCoord(2, 0), terrain_id="harbor", owner_id="p1"))
        game_map.add_tile(TileState(coord=HexCoord(0, 1), terrain_id="medical"))
        game_map.add_tile(TileState(coord=HexCoord(1, 1), terrain_id="base", owner_id="p2"))
        game_map.add_tile(TileState(coord=HexCoord(2, 1), terrain_id="harbor", owner_id="p2"))
        game_map.add_tile(TileState(coord=HexCoord(0, 2), terrain_id="plain"))
        game_map.add_tile(TileState(coord=HexCoord(1, 2), terrain_id="plain"))
        game_map.add_tile(TileState(coord=HexCoord(2, 2), terrain_id="plain"))

        state = GameState(
            ruleset_version="test-v1",
            active_player_id="p1",
            player_order=["p1", "p2"],
            turn_number=1,
            round_number=1,
            current_rseed=42,
            game_map=game_map,
            metadata={"income_per_base": 100},
        )
        state.add_player(PlayerState(player_id="p1", faction="sapiens", credits=0))
        state.add_player(PlayerState(player_id="p2", faction="titans", credits=0))
        return state

    def test_map_creation_and_tile_lookup(self) -> None:
        state = self.build_state()

        self.assertEqual(state.game_map.metadata.name, "Test Map")
        self.assertEqual(state.game_map.get_tile(HexCoord(0, 0)).terrain_id, "base")
        self.assertEqual(state.game_map.get_tile(HexCoord(2, 0)).terrain_id, "harbor")
        self.assertIsNone(state.game_map.get_tile(HexCoord(9, 9)))

    def test_unit_creation_updates_tile_occupancy(self) -> None:
        state = self.build_state()
        marine = UnitState(
            instance_id="u_marine",
            unit_id="marine",
            owner_id="p1",
            position=HexCoord(0, 0),
            hp=10,
        )

        state.add_unit(marine)

        self.assertEqual(state.get_unit("u_marine").unit_id, "marine")
        self.assertEqual(
            state.game_map.get_tile(HexCoord(0, 0)).occupying_unit_id, "u_marine"
        )
        self.assertEqual(state.get_unit_at(HexCoord(0, 0)).instance_id, "u_marine")

    def test_unit_move_updates_position_and_occupancy(self) -> None:
        state = self.build_state()
        marine = UnitState(
            instance_id="u_marine",
            unit_id="marine",
            owner_id="p1",
            position=HexCoord(0, 0),
            hp=10,
        )
        state.add_unit(marine)

        state.move_unit("u_marine", HexCoord(1, 0))

        self.assertEqual(state.get_unit("u_marine").position, HexCoord(1, 0))
        self.assertIsNone(state.game_map.get_tile(HexCoord(0, 0)).occupying_unit_id)
        self.assertEqual(
            state.game_map.get_tile(HexCoord(1, 0)).occupying_unit_id, "u_marine"
        )
        self.assertTrue(state.get_unit("u_marine").action.has_moved_this_turn)

    def test_attack_updates_hp_and_fight_context(self) -> None:
        state = self.build_state()
        attacker = UnitState(
            instance_id="u_attacker",
            unit_id="marine",
            owner_id="p1",
            position=HexCoord(0, 0),
            hp=10,
        )
        defender = UnitState(
            instance_id="u_defender",
            unit_id="mecha",
            owner_id="p2",
            position=HexCoord(1, 0),
            hp=10,
        )
        state.add_unit(attacker)
        state.add_unit(defender)

        state.attack_unit("u_attacker", "u_defender", defender_damage=3)

        self.assertEqual(state.get_unit("u_defender").hp, 7)
        self.assertEqual(state.fight_context.last_attacked_unit_id, "u_defender")
        self.assertEqual(state.fight_context.previous_attack_origin, HexCoord(0, 0))
        self.assertTrue(state.fight_context.previous_attack_was_melee)
        self.assertTrue(state.get_unit("u_attacker").action.has_attacked_this_turn)

    def test_end_turn_auto_heal_only_unused_units(self) -> None:
        state = self.build_state()
        idle_marine = UnitState(
            instance_id="u_idle",
            unit_id="marine",
            owner_id="p1",
            position=HexCoord(0, 0),
            hp=8,
        )
        moved_marine = UnitState(
            instance_id="u_moved",
            unit_id="marine",
            owner_id="p1",
            position=HexCoord(1, 0),
            hp=8,
            action=UnitActionState(is_available=True, has_moved_this_turn=True),
        )
        state.add_unit(idle_marine)
        state.add_unit(moved_marine)

        state.end_turn()

        self.assertEqual(state.get_unit("u_idle").hp, 9)
        self.assertEqual(state.get_unit("u_moved").hp, 8)

    def test_end_turn_applies_start_of_turn_effects(self) -> None:
        state = self.build_state()
        plagued_titan = UnitState(
            instance_id="u_titan",
            unit_id="mecha",
            owner_id="p2",
            position=HexCoord(1, 1),
            hp=6,
            status=UnitStatusState(
                plague_infected=True,
                emp_disabled_rounds=2,
                teleport_disabled_rounds=1,
                ability_cooldowns={"uv": 3},
            ),
        )
        state.add_unit(plagued_titan)

        next_player = state.end_turn()

        self.assertEqual(next_player, "p2")
        self.assertEqual(state.active_player_id, "p2")
        self.assertEqual(state.players["p2"].credits, 100)
        self.assertEqual(state.get_unit("u_titan").hp, 5)
        self.assertEqual(state.get_unit("u_titan").status.emp_disabled_rounds, 1)
        self.assertEqual(state.get_unit("u_titan").status.teleport_disabled_rounds, 0)
        self.assertEqual(state.get_unit("u_titan").status.ability_cooldowns["uv"], 2)

    def test_end_turn_processes_capture_completion(self) -> None:
        state = self.build_state()
        capturer = UnitState(
            instance_id="u_capture",
            unit_id="marine",
            owner_id="p2",
            position=HexCoord(2, 0),
            hp=10,
        )
        state.add_unit(capturer)

        harbor_tile = state.game_map.get_tile(HexCoord(2, 0))
        harbor_tile.capture_state = CaptureState(
            tile=HexCoord(2, 0),
            structure_owner_id="p1",
            capturing_player_id="p2",
            capturing_unit_id="u_capture",
            rounds_remaining=1,
        )
        capturer.capture_target = HexCoord(2, 0)

        state.end_turn()

        self.assertEqual(state.active_player_id, "p2")
        self.assertEqual(harbor_tile.owner_id, "p2")
        self.assertIsNone(harbor_tile.capture_state)
        self.assertIsNone(harbor_tile.occupying_unit_id)
        self.assertIsNone(state.get_unit("u_capture"))


if __name__ == "__main__":
    unittest.main()
