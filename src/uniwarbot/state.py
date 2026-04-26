from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum, IntEnum
from pathlib import Path
from typing import Any


def _drop_none(mapping: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in mapping.items() if value is not None}


class VeterancyLevel(IntEnum):
    NONE = 0
    ONE = 1
    TWO = 2


class HiddenMode(str, Enum):
    BURIED = "buried"
    SUBMERGED = "submerged"


class ActionSegmentKind(str, Enum):
    TOGGLE_STATE = "toggle_state"
    MOVE = "move"
    ATTACK = "attack"
    SPECIAL = "special"


@dataclass(slots=True)
class ActionSegmentConfig:
    segment_id: str
    kind: ActionSegmentKind
    max_uses: int = 1
    mobility_points: int | None = None
    optional: bool = True
    requires_attack_before_use: bool = False
    requires_state_mode: HiddenMode | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "segment_id": self.segment_id,
            "kind": self.kind.value,
            "max_uses": self.max_uses,
            "mobility_points": self.mobility_points,
            "optional": self.optional,
            "requires_attack_before_use": self.requires_attack_before_use,
            "requires_state_mode": (
                self.requires_state_mode.value if self.requires_state_mode else None
            ),
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ActionSegmentConfig":
        state_mode = data.get("requires_state_mode")
        return cls(
            segment_id=str(data["segment_id"]),
            kind=ActionSegmentKind(str(data["kind"])),
            max_uses=int(data.get("max_uses", 1)),
            mobility_points=(
                None if data.get("mobility_points") is None else int(data["mobility_points"])
            ),
            optional=bool(data.get("optional", True)),
            requires_attack_before_use=bool(
                data.get("requires_attack_before_use", False)
            ),
            requires_state_mode=HiddenMode(state_mode) if state_mode else None,
            metadata=dict(data.get("metadata", {})),
        )


@dataclass(slots=True)
class CompositeActionConfig:
    action_id: str
    label: str | None = None
    segments: list[ActionSegmentConfig] = field(default_factory=list)
    is_atomic: bool = True
    move_and_attack_mutually_exclusive: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "label": self.label,
            "segments": [segment.to_dict() for segment in self.segments],
            "is_atomic": self.is_atomic,
            "move_and_attack_mutually_exclusive": self.move_and_attack_mutually_exclusive,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompositeActionConfig":
        return cls(
            action_id=str(data["action_id"]),
            label=None if data.get("label") is None else str(data["label"]),
            segments=[
                ActionSegmentConfig.from_dict(dict(segment))
                for segment in data.get("segments", [])
            ],
            is_atomic=bool(data.get("is_atomic", True)),
            move_and_attack_mutually_exclusive=bool(
                data.get("move_and_attack_mutually_exclusive", False)
            ),
            metadata=dict(data.get("metadata", {})),
        )


@dataclass(slots=True)
class UnitActionConfig:
    action_count: int = 1
    actions: list[CompositeActionConfig] = field(default_factory=list)
    can_interleave_between_action_windows: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action_count": self.action_count,
            "actions": [action.to_dict() for action in self.actions],
            "can_interleave_between_action_windows": self.can_interleave_between_action_windows,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UnitActionConfig":
        return cls(
            action_count=int(data.get("action_count", 1)),
            actions=[
                CompositeActionConfig.from_dict(dict(action))
                for action in data.get("actions", [])
            ],
            can_interleave_between_action_windows=bool(
                data.get("can_interleave_between_action_windows", True)
            ),
            metadata=dict(data.get("metadata", {})),
        )


@dataclass(slots=True, frozen=True)
class HexCoord:
    q: int
    r: int

    @property
    def s(self) -> int:
        return -self.q - self.r

    @property
    def key(self) -> str:
        return f"{self.q}:{self.r}"

    def to_dict(self) -> dict[str, int]:
        return {"q": self.q, "r": self.r}

    @classmethod
    def from_dict(cls, data: dict[str, int]) -> "HexCoord":
        return cls(q=int(data["q"]), r=int(data["r"]))


@dataclass(slots=True)
class AbilityCooldownState:
    ability_id: str
    remaining_rounds: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "ability_id": self.ability_id,
            "remaining_rounds": self.remaining_rounds,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AbilityCooldownState":
        return cls(
            ability_id=str(data["ability_id"]),
            remaining_rounds=int(data["remaining_rounds"]),
        )


@dataclass(slots=True)
class UnitStatusState:
    plague_infected: bool = False
    hidden_mode: HiddenMode | None = None
    emp_disabled_rounds: int = 0
    teleport_disabled_rounds: int = 0
    buried_resurface_bonus: int = 0
    submerged_attack_penalty: int = 0
    ability_cooldowns: dict[str, int] = field(default_factory=dict)

    @property
    def is_disabled(self) -> bool:
        return self.emp_disabled_rounds > 0 or self.teleport_disabled_rounds > 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "plague_infected": self.plague_infected,
            "hidden_mode": self.hidden_mode.value if self.hidden_mode else None,
            "emp_disabled_rounds": self.emp_disabled_rounds,
            "teleport_disabled_rounds": self.teleport_disabled_rounds,
            "buried_resurface_bonus": self.buried_resurface_bonus,
            "submerged_attack_penalty": self.submerged_attack_penalty,
            "ability_cooldowns": dict(sorted(self.ability_cooldowns.items())),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UnitStatusState":
        hidden_mode = data.get("hidden_mode")
        return cls(
            plague_infected=bool(data.get("plague_infected", False)),
            hidden_mode=HiddenMode(hidden_mode) if hidden_mode else None,
            emp_disabled_rounds=int(data.get("emp_disabled_rounds", 0)),
            teleport_disabled_rounds=int(data.get("teleport_disabled_rounds", 0)),
            buried_resurface_bonus=int(data.get("buried_resurface_bonus", 0)),
            submerged_attack_penalty=int(data.get("submerged_attack_penalty", 0)),
            ability_cooldowns={
                str(key): int(value)
                for key, value in dict(data.get("ability_cooldowns", {})).items()
            },
        )


@dataclass(slots=True)
class ActionSegmentState:
    segment_id: str
    kind: ActionSegmentKind
    uses_remaining: int = 1
    mobility_points_remaining: int | None = None
    unlocked: bool = True
    completed: bool = False
    requires_attack_before_use: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "segment_id": self.segment_id,
            "kind": self.kind.value,
            "uses_remaining": self.uses_remaining,
            "mobility_points_remaining": self.mobility_points_remaining,
            "unlocked": self.unlocked,
            "completed": self.completed,
            "requires_attack_before_use": self.requires_attack_before_use,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ActionSegmentState":
        return cls(
            segment_id=str(data["segment_id"]),
            kind=ActionSegmentKind(str(data["kind"])),
            uses_remaining=int(data.get("uses_remaining", 1)),
            mobility_points_remaining=(
                None
                if data.get("mobility_points_remaining") is None
                else int(data["mobility_points_remaining"])
            ),
            unlocked=bool(data.get("unlocked", True)),
            completed=bool(data.get("completed", False)),
            requires_attack_before_use=bool(
                data.get("requires_attack_before_use", False)
            ),
            metadata=dict(data.get("metadata", {})),
        )


@dataclass(slots=True)
class CompositeActionState:
    action_id: str
    segments: list[ActionSegmentState] = field(default_factory=list)
    is_atomic: bool = True
    in_progress: bool = False
    attack_occurred: bool = False
    completed: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "segments": [segment.to_dict() for segment in self.segments],
            "is_atomic": self.is_atomic,
            "in_progress": self.in_progress,
            "attack_occurred": self.attack_occurred,
            "completed": self.completed,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CompositeActionState":
        return cls(
            action_id=str(data["action_id"]),
            segments=[
                ActionSegmentState.from_dict(dict(segment))
                for segment in data.get("segments", [])
            ],
            is_atomic=bool(data.get("is_atomic", True)),
            in_progress=bool(data.get("in_progress", False)),
            attack_occurred=bool(data.get("attack_occurred", False)),
            completed=bool(data.get("completed", False)),
            metadata=dict(data.get("metadata", {})),
        )


@dataclass(slots=True)
class UnitActionState:
    is_available: bool = True
    configured_action_count: int = 1
    actions_remaining: int = 1
    can_interleave_between_action_windows: bool = True
    move_points_remaining: int | None = None
    attacks_remaining: int = 1
    special_actions_remaining: int | None = None
    action_phase_index: int = 0
    current_action_index: int = 0
    action_windows: list[CompositeActionState] = field(default_factory=list)
    has_moved_this_turn: bool = False
    has_attacked_this_turn: bool = False
    has_used_special_this_turn: bool = False

    @property
    def current_action_window(self) -> CompositeActionState | None:
        if not self.action_windows:
            return None
        if self.current_action_index < 0 or self.current_action_index >= len(
            self.action_windows
        ):
            return None
        return self.action_windows[self.current_action_index]

    @property
    def has_atomic_window_lock(self) -> bool:
        current = self.current_action_window
        if current is None:
            return False
        return current.is_atomic and current.in_progress and not current.completed

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_available": self.is_available,
            "configured_action_count": self.configured_action_count,
            "actions_remaining": self.actions_remaining,
            "can_interleave_between_action_windows": self.can_interleave_between_action_windows,
            "move_points_remaining": self.move_points_remaining,
            "attacks_remaining": self.attacks_remaining,
            "special_actions_remaining": self.special_actions_remaining,
            "action_phase_index": self.action_phase_index,
            "current_action_index": self.current_action_index,
            "action_windows": [action.to_dict() for action in self.action_windows],
            "has_moved_this_turn": self.has_moved_this_turn,
            "has_attacked_this_turn": self.has_attacked_this_turn,
            "has_used_special_this_turn": self.has_used_special_this_turn,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UnitActionState":
        return cls(
            is_available=bool(data.get("is_available", True)),
            configured_action_count=int(data.get("configured_action_count", 1)),
            actions_remaining=int(data.get("actions_remaining", 1)),
            can_interleave_between_action_windows=bool(
                data.get("can_interleave_between_action_windows", True)
            ),
            move_points_remaining=(
                None
                if data.get("move_points_remaining") is None
                else int(data["move_points_remaining"])
            ),
            attacks_remaining=int(data.get("attacks_remaining", 1)),
            special_actions_remaining=(
                None
                if data.get("special_actions_remaining") is None
                else int(data["special_actions_remaining"])
            ),
            action_phase_index=int(data.get("action_phase_index", 0)),
            current_action_index=int(data.get("current_action_index", 0)),
            action_windows=[
                CompositeActionState.from_dict(dict(action))
                for action in data.get("action_windows", [])
            ],
            has_moved_this_turn=bool(data.get("has_moved_this_turn", False)),
            has_attacked_this_turn=bool(data.get("has_attacked_this_turn", False)),
            has_used_special_this_turn=bool(
                data.get("has_used_special_this_turn", False)
            ),
        )


@dataclass(slots=True)
class UnitState:
    instance_id: str
    unit_id: str
    owner_id: str
    position: HexCoord
    hp: int
    veterancy_level: VeterancyLevel = VeterancyLevel.NONE
    experience_points: int = 0
    status: UnitStatusState = field(default_factory=UnitStatusState)
    action: UnitActionState = field(default_factory=UnitActionState)
    capture_target: HexCoord | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "instance_id": self.instance_id,
            "unit_id": self.unit_id,
            "owner_id": self.owner_id,
            "position": self.position.to_dict(),
            "hp": self.hp,
            "veterancy_level": int(self.veterancy_level),
            "experience_points": self.experience_points,
            "status": self.status.to_dict(),
            "action": self.action.to_dict(),
            "capture_target": (
                self.capture_target.to_dict() if self.capture_target else None
            ),
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UnitState":
        capture_target = data.get("capture_target")
        return cls(
            instance_id=str(data["instance_id"]),
            unit_id=str(data["unit_id"]),
            owner_id=str(data["owner_id"]),
            position=HexCoord.from_dict(dict(data["position"])),
            hp=int(data["hp"]),
            veterancy_level=VeterancyLevel(int(data.get("veterancy_level", 0))),
            experience_points=int(data.get("experience_points", 0)),
            status=UnitStatusState.from_dict(dict(data.get("status", {}))),
            action=UnitActionState.from_dict(dict(data.get("action", {}))),
            capture_target=(
                HexCoord.from_dict(dict(capture_target)) if capture_target else None
            ),
            metadata=dict(data.get("metadata", {})),
        )


@dataclass(slots=True)
class CaptureState:
    tile: HexCoord
    structure_owner_id: str | None
    capturing_player_id: str
    capturing_unit_id: str
    rounds_remaining: int = 1
    defense_penalty_applies: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "tile": self.tile.to_dict(),
            "structure_owner_id": self.structure_owner_id,
            "capturing_player_id": self.capturing_player_id,
            "capturing_unit_id": self.capturing_unit_id,
            "rounds_remaining": self.rounds_remaining,
            "defense_penalty_applies": self.defense_penalty_applies,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CaptureState":
        return cls(
            tile=HexCoord.from_dict(dict(data["tile"])),
            structure_owner_id=(
                None
                if data.get("structure_owner_id") is None
                else str(data["structure_owner_id"])
            ),
            capturing_player_id=str(data["capturing_player_id"]),
            capturing_unit_id=str(data["capturing_unit_id"]),
            rounds_remaining=int(data.get("rounds_remaining", 1)),
            defense_penalty_applies=bool(data.get("defense_penalty_applies", True)),
        )


@dataclass(slots=True)
class TileState:
    coord: HexCoord
    terrain_id: str
    owner_id: str | None = None
    occupying_unit_id: str | None = None
    capture_state: CaptureState | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "coord": self.coord.to_dict(),
            "terrain_id": self.terrain_id,
            "owner_id": self.owner_id,
            "occupying_unit_id": self.occupying_unit_id,
            "capture_state": (
                self.capture_state.to_dict() if self.capture_state else None
            ),
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TileState":
        capture_state = data.get("capture_state")
        return cls(
            coord=HexCoord.from_dict(dict(data["coord"])),
            terrain_id=str(data["terrain_id"]),
            owner_id=None if data.get("owner_id") is None else str(data["owner_id"]),
            occupying_unit_id=(
                None
                if data.get("occupying_unit_id") is None
                else str(data["occupying_unit_id"])
            ),
            capture_state=(
                CaptureState.from_dict(dict(capture_state)) if capture_state else None
            ),
            metadata=dict(data.get("metadata", {})),
        )


@dataclass(slots=True)
class MapMetadata:
    map_id: str
    name: str
    tags: list[str] = field(default_factory=list)
    width: int | None = None
    height: int | None = None
    notes: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "map_id": self.map_id,
            "name": self.name,
            "tags": list(self.tags),
            "width": self.width,
            "height": self.height,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MapMetadata":
        return cls(
            map_id=str(data["map_id"]),
            name=str(data["name"]),
            tags=[str(item) for item in data.get("tags", [])],
            width=None if data.get("width") is None else int(data["width"]),
            height=None if data.get("height") is None else int(data["height"]),
            notes=None if data.get("notes") is None else str(data["notes"]),
        )


@dataclass(slots=True)
class GameMap:
    metadata: MapMetadata
    tiles: dict[HexCoord, TileState] = field(default_factory=dict)

    def add_tile(self, tile: TileState) -> None:
        self.tiles[tile.coord] = tile

    def get_tile(self, coord: HexCoord) -> TileState | None:
        return self.tiles.get(coord)

    def to_dict(self) -> dict[str, Any]:
        return {
            "metadata": self.metadata.to_dict(),
            "tiles": [
                self.tiles[coord].to_dict()
                for coord in sorted(self.tiles, key=lambda item: (item.q, item.r))
            ],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GameMap":
        game_map = cls(metadata=MapMetadata.from_dict(dict(data["metadata"])))
        for tile_data in data.get("tiles", []):
            tile = TileState.from_dict(dict(tile_data))
            game_map.add_tile(tile)
        return game_map


@dataclass(slots=True)
class PlayerState:
    player_id: str
    faction: str
    credits: int = 0
    team_id: str | None = None
    defeated: bool = False
    has_ended_turn: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "player_id": self.player_id,
            "faction": self.faction,
            "credits": self.credits,
            "team_id": self.team_id,
            "defeated": self.defeated,
            "has_ended_turn": self.has_ended_turn,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlayerState":
        return cls(
            player_id=str(data["player_id"]),
            faction=str(data["faction"]),
            credits=int(data.get("credits", 0)),
            team_id=None if data.get("team_id") is None else str(data["team_id"]),
            defeated=bool(data.get("defeated", False)),
            has_ended_turn=bool(data.get("has_ended_turn", False)),
            metadata=dict(data.get("metadata", {})),
        )


@dataclass(slots=True)
class FightContext:
    last_attacked_unit_id: str | None = None
    previous_attack_origin: HexCoord | None = None
    previous_attack_was_melee: bool = False
    acting_player_id: str | None = None
    chain_index: int = 0

    def clear(self) -> None:
        self.last_attacked_unit_id = None
        self.previous_attack_origin = None
        self.previous_attack_was_melee = False
        self.acting_player_id = None
        self.chain_index = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "last_attacked_unit_id": self.last_attacked_unit_id,
            "previous_attack_origin": (
                self.previous_attack_origin.to_dict()
                if self.previous_attack_origin
                else None
            ),
            "previous_attack_was_melee": self.previous_attack_was_melee,
            "acting_player_id": self.acting_player_id,
            "chain_index": self.chain_index,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FightContext":
        origin = data.get("previous_attack_origin")
        return cls(
            last_attacked_unit_id=(
                None
                if data.get("last_attacked_unit_id") is None
                else str(data["last_attacked_unit_id"])
            ),
            previous_attack_origin=(
                HexCoord.from_dict(dict(origin)) if origin else None
            ),
            previous_attack_was_melee=bool(
                data.get("previous_attack_was_melee", False)
            ),
            acting_player_id=(
                None if data.get("acting_player_id") is None else str(data["acting_player_id"])
            ),
            chain_index=int(data.get("chain_index", 0)),
        )


@dataclass(slots=True)
class GameState:
    ruleset_version: str
    active_player_id: str
    player_order: list[str]
    turn_number: int
    round_number: int
    current_rseed: int
    game_map: GameMap
    players: dict[str, PlayerState] = field(default_factory=dict)
    units: dict[str, UnitState] = field(default_factory=dict)
    fight_context: FightContext = field(default_factory=FightContext)
    metadata: dict[str, Any] = field(default_factory=dict)

    def add_player(self, player: PlayerState) -> None:
        self.players[player.player_id] = player

    def add_unit(self, unit: UnitState) -> None:
        self.units[unit.instance_id] = unit
        tile = self.game_map.get_tile(unit.position)
        if tile is not None:
            tile.occupying_unit_id = unit.instance_id

    def get_unit(self, instance_id: str) -> UnitState | None:
        return self.units.get(instance_id)

    def get_unit_at(self, coord: HexCoord) -> UnitState | None:
        tile = self.game_map.get_tile(coord)
        if tile is None or tile.occupying_unit_id is None:
            return None
        return self.units.get(tile.occupying_unit_id)

    def set_active_player(self, player_id: str) -> None:
        if player_id not in self.players:
            raise KeyError(f"Unknown player_id: {player_id}")
        self.active_player_id = player_id

    def to_dict(self) -> dict[str, Any]:
        return {
            "ruleset_version": self.ruleset_version,
            "active_player_id": self.active_player_id,
            "player_order": list(self.player_order),
            "turn_number": self.turn_number,
            "round_number": self.round_number,
            "current_rseed": self.current_rseed,
            "game_map": self.game_map.to_dict(),
            "players": {
                player_id: self.players[player_id].to_dict()
                for player_id in sorted(self.players)
            },
            "units": {
                unit_id: self.units[unit_id].to_dict()
                for unit_id in sorted(self.units)
            },
            "fight_context": self.fight_context.to_dict(),
            "metadata": self.metadata,
        }

    def to_json(self, *, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=True)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GameState":
        state = cls(
            ruleset_version=str(data["ruleset_version"]),
            active_player_id=str(data["active_player_id"]),
            player_order=[str(item) for item in data["player_order"]],
            turn_number=int(data["turn_number"]),
            round_number=int(data["round_number"]),
            current_rseed=int(data["current_rseed"]),
            game_map=GameMap.from_dict(dict(data["game_map"])),
            fight_context=FightContext.from_dict(dict(data.get("fight_context", {}))),
            metadata=dict(data.get("metadata", {})),
        )
        for player_id, player_data in dict(data.get("players", {})).items():
            player = PlayerState.from_dict(dict(player_data))
            state.players[str(player_id)] = player
        for unit_id, unit_data in dict(data.get("units", {})).items():
            unit = UnitState.from_dict(dict(unit_data))
            state.units[str(unit_id)] = unit
            tile = state.game_map.get_tile(unit.position)
            if tile is not None:
                tile.occupying_unit_id = unit.instance_id
        return state

    @classmethod
    def from_json(cls, payload: str) -> "GameState":
        return cls.from_dict(json.loads(payload))


def load_game_dictionary(path: str | Path | None = None) -> dict[str, Any]:
    if path is None:
        path = (
            Path(__file__).resolve().parents[2]
            / "data"
            / "validated"
            / "game-dictionary.json"
        )
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_action_economy_dictionary(path: str | Path | None = None) -> dict[str, Any]:
    if path is None:
        path = (
            Path(__file__).resolve().parents[2]
            / "data"
            / "validated"
            / "action-economy-dictionary.json"
        )
    return json.loads(Path(path).read_text(encoding="utf-8"))
