from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum, IntEnum
from functools import lru_cache
from pathlib import Path
from typing import Any


def _drop_none(mapping: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in mapping.items() if value is not None}


_MASK_64 = (1 << 64) - 1


def _to_signed_64(value: int) -> int:
    value &= _MASK_64
    if value >= (1 << 63):
        return value - (1 << 64)
    return value


def _java_mod(dividend: int, divisor: int) -> int:
    if divisor == 0:
        raise ZeroDivisionError("Java-style modulo by zero")
    quotient = abs(dividend) // abs(divisor)
    if (dividend < 0) != (divisor < 0):
        quotient = -quotient
    return dividend - quotient * divisor


@lru_cache(maxsize=1)
def _cached_game_dictionary() -> dict[str, Any]:
    return load_game_dictionary()


def _unit_repair_points(unit_id: str) -> int:
    unit_data = _cached_game_dictionary()["units"].get(unit_id, {})
    return int(unit_data.get("repair_points", 0))


def _terrain_repair_multiplier(terrain_id: str) -> int:
    terrain_data = _cached_game_dictionary()["terrains"].get(terrain_id, {})
    return int(terrain_data.get("repair_multiplier", 1))


def _unit_abilities(unit_id: str) -> list[dict[str, Any]]:
    unit_data = _cached_game_dictionary()["units"].get(unit_id, {})
    return [dict(ability) for ability in unit_data.get("abilities", [])]


class LegalFormula:
    """Exact Java-compatible combat RNG and damage calculator."""

    def __init__(self, ceq: int) -> None:
        self.ceq = _to_signed_64(int(ceq))

    def set_seed(self, ceq: int) -> None:
        self.ceq = _to_signed_64(int(ceq))

    def gm(self, n: int) -> int:
        if n <= 0:
            raise ValueError("n must be > 0")
        unsigned = self.ceq & _MASK_64
        self.ceq = _to_signed_64(unsigned ^ ((unsigned << 21) & _MASK_64))
        unsigned = self.ceq & _MASK_64
        self.ceq = _to_signed_64(unsigned ^ (unsigned >> 35))
        unsigned = self.ceq & _MASK_64
        self.ceq = _to_signed_64(unsigned ^ ((unsigned << 4) & _MASK_64))
        remainder = _java_mod(self.ceq, int(n))
        return abs(int(remainder))

    def get_damage(
        self,
        attacker_hp: int,
        attack: int,
        defense: int,
        attack_bonus: int,
        armor_piercing_percent: int,
    ) -> int:
        roll_count = 12
        max_chance = max(
            0,
            min(
                (int(attack) - int(defense) + int(attack_bonus)) * 5
                + 50
                + int(armor_piercing_percent) * int(defense) * 5 // 100,
                100,
            ),
        )
        hit_count = 0
        for _ in range(max(0, int(attacker_hp))):
            for _ in range(roll_count):
                if self.gm(100) < max_chance:
                    hit_count += 1
        return hit_count // roll_count


class VeterancyLevel(IntEnum):
    NONE = 0
    ONE = 1
    TWO = 2


class HiddenMode(str, Enum):
    BURIED = "buried"
    SUBMERGED = "submerged"


class TeleportLockPhase(str, Enum):
    OPPONENT_TURN = "opponent_turn"
    OWNER_TURN = "owner_turn"


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
    teleport_lock_phase: TeleportLockPhase | None = None
    teleport_cooldown_rounds: int = 0
    buried_resurface_bonus: int = 0
    submerged_attack_penalty: int = 0
    ability_cooldowns: dict[str, int] = field(default_factory=dict)

    @property
    def is_disabled(self) -> bool:
        return self.emp_disabled_rounds > 0 or self.teleport_lock_phase is not None

    @property
    def retaliation_blocked(self) -> bool:
        return self.emp_disabled_rounds > 0 or (
            self.teleport_lock_phase == TeleportLockPhase.OPPONENT_TURN
        )

    @property
    def control_zones_suppressed(self) -> bool:
        return self.retaliation_blocked

    @property
    def movement_blocked(self) -> bool:
        return self.emp_disabled_rounds > 0 or (
            self.teleport_lock_phase == TeleportLockPhase.OWNER_TURN
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "plague_infected": self.plague_infected,
            "hidden_mode": self.hidden_mode.value if self.hidden_mode else None,
            "emp_disabled_rounds": self.emp_disabled_rounds,
            "teleport_disabled_rounds": self.teleport_disabled_rounds,
            "teleport_lock_phase": (
                self.teleport_lock_phase.value if self.teleport_lock_phase else None
            ),
            "teleport_cooldown_rounds": self.teleport_cooldown_rounds,
            "retaliation_blocked": self.retaliation_blocked,
            "control_zones_suppressed": self.control_zones_suppressed,
            "movement_blocked": self.movement_blocked,
            "buried_resurface_bonus": self.buried_resurface_bonus,
            "submerged_attack_penalty": self.submerged_attack_penalty,
            "ability_cooldowns": dict(sorted(self.ability_cooldowns.items())),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UnitStatusState":
        hidden_mode = data.get("hidden_mode")
        teleport_lock_phase = data.get("teleport_lock_phase")
        return cls(
            plague_infected=bool(data.get("plague_infected", False)),
            hidden_mode=HiddenMode(hidden_mode) if hidden_mode else None,
            emp_disabled_rounds=int(data.get("emp_disabled_rounds", 0)),
            teleport_disabled_rounds=int(data.get("teleport_disabled_rounds", 0)),
            teleport_lock_phase=(
                TeleportLockPhase(teleport_lock_phase) if teleport_lock_phase else None
            ),
            teleport_cooldown_rounds=int(data.get("teleport_cooldown_rounds", 0)),
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
    atomic_action_locked: bool = False
    atomic_action_label: str | None = None
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
            return self.atomic_action_locked
        return (
            current.is_atomic and current.in_progress and not current.completed
        ) or self.atomic_action_locked

    def reset_for_new_turn(self) -> None:
        self.is_available = True
        self.actions_remaining = self.configured_action_count
        self.move_points_remaining = None
        self.attacks_remaining = 1
        self.special_actions_remaining = None
        self.action_phase_index = 0
        self.current_action_index = 0
        self.atomic_action_locked = False
        self.atomic_action_label = None
        self.has_moved_this_turn = False
        self.has_attacked_this_turn = False
        self.has_used_special_this_turn = False
        for action_window in self.action_windows:
            action_window.in_progress = False
            action_window.attack_occurred = False
            action_window.completed = False
            for segment in action_window.segments:
                segment.completed = False
                segment.unlocked = not segment.requires_attack_before_use

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
            "atomic_action_locked": self.atomic_action_locked,
            "atomic_action_label": self.atomic_action_label,
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
            atomic_action_locked=bool(data.get("atomic_action_locked", False)),
            atomic_action_label=(
                None
                if data.get("atomic_action_label") is None
                else str(data["atomic_action_label"])
            ),
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
    surface_unit_id: str | None = None
    hidden_unit_id: str | None = None
    capture_state: CaptureState | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def occupying_unit_id(self) -> str | None:
        return self.surface_unit_id

    @occupying_unit_id.setter
    def occupying_unit_id(self, value: str | None) -> None:
        self.surface_unit_id = value

    def to_dict(self) -> dict[str, Any]:
        return {
            "coord": self.coord.to_dict(),
            "terrain_id": self.terrain_id,
            "owner_id": self.owner_id,
            "occupying_unit_id": self.surface_unit_id,
            "surface_unit_id": self.surface_unit_id,
            "hidden_unit_id": self.hidden_unit_id,
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
            surface_unit_id=(
                None
                if data.get("surface_unit_id", data.get("occupying_unit_id")) is None
                else str(data.get("surface_unit_id", data.get("occupying_unit_id")))
            ),
            hidden_unit_id=(
                None
                if data.get("hidden_unit_id") is None
                else str(data["hidden_unit_id"])
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

    @property
    def income_per_base(self) -> int:
        return int(self.metadata.get("income_per_base", 100))

    @property
    def income_per_city(self) -> int:
        return int(self.metadata.get("income_per_city", 50))

    def add_player(self, player: PlayerState) -> None:
        self.players[player.player_id] = player

    def add_unit(self, unit: UnitState) -> None:
        self.units[unit.instance_id] = unit
        tile = self.game_map.get_tile(unit.position)
        if tile is not None:
            self._place_unit_on_tile(tile, unit, strict=True)

    def remove_unit(self, instance_id: str) -> UnitState | None:
        unit = self.units.pop(instance_id, None)
        if unit is None:
            return None
        tile = self.game_map.get_tile(unit.position)
        if tile is not None:
            if tile.surface_unit_id == instance_id:
                tile.surface_unit_id = None
            if tile.hidden_unit_id == instance_id:
                tile.hidden_unit_id = None
        return unit

    def get_unit(self, instance_id: str) -> UnitState | None:
        return self.units.get(instance_id)

    def get_unit_at(self, coord: HexCoord) -> UnitState | None:
        tile = self.game_map.get_tile(coord)
        if tile is None or tile.surface_unit_id is None:
            return None
        return self.units.get(tile.surface_unit_id)

    def get_hidden_unit_at(self, coord: HexCoord) -> UnitState | None:
        tile = self.game_map.get_tile(coord)
        if tile is None or tile.hidden_unit_id is None:
            return None
        return self.units.get(tile.hidden_unit_id)

    def get_units_at(self, coord: HexCoord) -> list[UnitState]:
        units_at_tile: list[UnitState] = []
        surface_unit = self.get_unit_at(coord)
        hidden_unit = self.get_hidden_unit_at(coord)
        if surface_unit is not None:
            units_at_tile.append(surface_unit)
        if hidden_unit is not None:
            units_at_tile.append(hidden_unit)
        return units_at_tile

    def set_active_player(self, player_id: str) -> None:
        if player_id not in self.players:
            raise KeyError(f"Unknown player_id: {player_id}")
        self.active_player_id = player_id

    def get_possible_moves(self, instance_id: str) -> dict[str, Any]:
        unit = self.get_unit(instance_id)
        if unit is None:
            raise KeyError(f"Unknown unit_id: {instance_id}")

        move_points = self._movement_points_for_unit(unit)
        current_attack_targets = self._current_attack_targets(unit)
        move_destinations = (
            self._reachable_move_destinations(unit, move_points)
            if self._can_query_unit_movement(unit)
            else []
        )
        move_destination_keys = self._sorted_coord_keys(move_destinations)
        move_attack_targets = (
            self._move_attack_targets_for_destinations(
                unit,
                move_destinations,
            )
            if self._can_attack_after_move_in_same_action(unit)
            else {}
        )

        if self._requires_surface_move_attack_lock(unit):
            legal_move_destinations = self._sorted_coord_keys(
                [
                    coord
                    for coord in move_destinations
                    if move_attack_targets.get(coord.key)
                ]
            )
        else:
            legal_move_destinations = move_destination_keys

        resurface_attack_targets: list[str] = []
        if self._can_resurface(unit):
            resurface_attack_targets = [
                target.instance_id
                for target in self._attackable_targets_from_position(
                    unit,
                    position=unit.position,
                    hidden_mode_override=None,
                )
            ]

        return {
            "unit_id": unit.instance_id,
            "move_points": move_points,
            "current_attack_targets": sorted(current_attack_targets),
            "move_destinations": move_destination_keys,
            "legal_move_destinations": legal_move_destinations,
            "move_requires_attack": self._requires_surface_move_attack_lock(unit),
            "move_attack_targets": {
                key: sorted(targets)
                for key, targets in sorted(move_attack_targets.items())
                if targets
            },
            "can_bury": self._can_bury(unit),
            "can_resurface": self._can_resurface(unit),
            "can_resurface_attack": bool(resurface_attack_targets),
            "resurface_attack_targets": sorted(resurface_attack_targets),
        }

    def _require_active_player_unit(self, instance_id: str) -> UnitState:
        unit = self.get_unit(instance_id)
        if unit is None:
            raise KeyError(f"Unknown unit_id: {instance_id}")
        if unit.owner_id != self.active_player_id:
            raise ValueError("Only the active player's units may act")
        return unit

    def _enforce_atomic_action_lock(
        self,
        acting_unit: UnitState,
        *,
        action_kind: str,
    ) -> None:
        if (
            acting_unit.action.atomic_action_locked
            and acting_unit.action.atomic_action_label
            in {"resurface_attack", "surface_move_attack"}
            and action_kind != "attack"
        ):
            raise ValueError("Unit must finish its move-attack or resurface-attack action with an attack")
        for other_unit in self.units.values():
            if other_unit.owner_id != self.active_player_id:
                continue
            if other_unit.instance_id == acting_unit.instance_id:
                continue
            if not other_unit.action.has_atomic_window_lock:
                continue
            raise ValueError(
                f"Unit {other_unit.instance_id} must finish its atomic action before another unit acts"
            )

    def move_unit(
        self,
        instance_id: str,
        destination: HexCoord,
        *,
        continue_as_atomic_attack: bool = False,
    ) -> None:
        unit = self._require_active_player_unit(instance_id)
        self._enforce_atomic_action_lock(unit, action_kind="move")
        if unit.status.movement_blocked:
            raise ValueError("Unit cannot move while teleport-locked or disabled")
        self._consume_action_if_needed(unit)
        destination_tile = self.game_map.get_tile(destination)
        if destination_tile is None:
            raise ValueError("Destination tile does not exist")
        if self._tile_slot_for_unit(destination_tile, unit) is not None:
            raise ValueError("Destination tile is already occupied")

        source_tile = self.game_map.get_tile(unit.position)
        if source_tile is not None:
            if self._uses_hidden_slot(unit):
                if source_tile.hidden_unit_id == instance_id:
                    source_tile.hidden_unit_id = None
            elif source_tile.surface_unit_id == instance_id:
                source_tile.surface_unit_id = None

        unit.position = destination
        self._place_unit_on_tile(destination_tile, unit, strict=True)
        unit.action.has_moved_this_turn = True
        if continue_as_atomic_attack and self._can_surface_move_continue_as_atomic_attack(unit):
            unit.action.atomic_action_locked = True
            unit.action.atomic_action_label = "surface_move_attack"
        elif self._is_underling_family(unit) and unit.status.hidden_mode is None:
            unit.action.attacks_remaining = 0
        current_window = unit.action.current_action_window
        if current_window is not None:
            current_window.in_progress = True
            for segment in current_window.segments:
                if (
                    segment.kind == ActionSegmentKind.MOVE
                    and segment.unlocked
                    and not segment.completed
                ):
                    segment.completed = True
                    segment.mobility_points_remaining = 0
                    break

    def bury_unit(self, instance_id: str) -> None:
        unit = self._require_active_player_unit(instance_id)
        self._enforce_atomic_action_lock(unit, action_kind="special")
        if not self._is_underling_family(unit):
            raise ValueError("Only Underling-family units can bury")
        if unit.status.hidden_mode is not None:
            raise ValueError("Only surface units can bury")

        tile = self.game_map.get_tile(unit.position)
        if tile is None:
            raise ValueError("Unit tile does not exist")
        if tile.hidden_unit_id not in (None, unit.instance_id):
            raise ValueError("Cannot bury into an occupied hidden slot")
        if tile.terrain_id in self._hidden_mode_forbidden_terrains(unit):
            raise ValueError("Unit cannot bury on this terrain")

        self._consume_action_if_needed(unit)
        unit.action.has_used_special_this_turn = True
        unit.action.atomic_action_locked = False
        unit.action.atomic_action_label = None

        if tile.surface_unit_id == unit.instance_id:
            tile.surface_unit_id = None
        tile.hidden_unit_id = unit.instance_id
        unit.status.hidden_mode = HiddenMode.BURIED

    def resurface_unit(
        self,
        instance_id: str,
        *,
        continue_as_atomic_attack: bool = False,
    ) -> None:
        unit = self._require_active_player_unit(instance_id)
        self._enforce_atomic_action_lock(unit, action_kind="special")
        if unit.status.hidden_mode != HiddenMode.BURIED:
            raise ValueError("Only buried units can resurface")

        tile = self.game_map.get_tile(unit.position)
        if tile is None:
            raise ValueError("Unit tile does not exist")
        if tile.surface_unit_id not in (None, unit.instance_id):
            raise ValueError("Cannot resurface onto an occupied surface slot")

        self._consume_action_if_needed(unit)
        unit.action.has_used_special_this_turn = True

        if tile.hidden_unit_id == unit.instance_id:
            tile.hidden_unit_id = None
        tile.surface_unit_id = unit.instance_id

        unit.status.hidden_mode = None
        unit.status.buried_resurface_bonus = 0
        if continue_as_atomic_attack:
            unit.status.buried_resurface_bonus = self._hidden_mode_resurface_bonus(unit)
            unit.action.atomic_action_locked = True
            unit.action.atomic_action_label = "resurface_attack"
        else:
            unit.action.atomic_action_locked = False
            unit.action.atomic_action_label = None

    def attack_unit(
        self,
        attacker_id: str,
        defender_id: str,
        *,
        attack_bonus: int | None = None,
        retaliation_bonus: int = 0,
        defender_damage: int | None = None,
        attacker_damage: int | None = None,
        was_melee: bool | None = None,
    ) -> None:
        attacker = self._require_active_player_unit(attacker_id)
        self._enforce_atomic_action_lock(attacker, action_kind="attack")
        if attacker.action.attacks_remaining <= 0:
            raise ValueError("Unit has no attacks remaining")
        defender = self.get_unit(defender_id)
        if defender is None:
            raise KeyError(f"Unknown defender_id: {defender_id}")
        if not self._can_unit_attack_target(attacker, defender):
            raise ValueError("Attacker cannot attack the selected target")
        self._consume_action_if_needed(attacker)

        attacker.action.has_attacked_this_turn = True
        attacker.action.attacks_remaining = max(0, attacker.action.attacks_remaining - 1)
        current_window = attacker.action.current_action_window
        if current_window is not None:
            current_window.in_progress = True
            current_window.attack_occurred = True
            for segment in current_window.segments:
                if (
                    segment.kind == ActionSegmentKind.ATTACK
                    and segment.unlocked
                    and not segment.completed
                ):
                    segment.completed = True
                    segment.uses_remaining = 0
                if segment.requires_attack_before_use:
                    segment.unlocked = True

        if was_melee is None:
            was_melee = self._hex_distance(attacker.position, defender.position) == 1

        attacker_original_hp = attacker.hp
        defender_original_hp = defender.hp
        defender_can_retaliate = (
            not defender.status.retaliation_blocked
            and self._can_unit_attack_target(defender, attacker)
        )
        resolved_attack_bonus = (
            self._calculate_gang_up_bonus(attacker, defender)
            if attack_bonus is None
            else int(attack_bonus)
        )
        resolved_attack_bonus += int(attacker.status.buried_resurface_bonus)

        self.fight_context.last_attacked_unit_id = defender_id
        self.fight_context.previous_attack_origin = attacker.position
        self.fight_context.previous_attack_was_melee = was_melee
        self.fight_context.acting_player_id = attacker.owner_id
        self.fight_context.chain_index += 1

        formula = LegalFormula(self.current_rseed)
        resolved_defender_damage = (
            self._calculate_combat_damage(
                formula,
                attacker=attacker,
                defender=defender,
                attacker_hp_override=attacker_original_hp,
                attack_bonus=resolved_attack_bonus,
            )
            if defender_damage is None
            else int(defender_damage)
        )

        resolved_attacker_damage = 0
        if (
            attacker_damage is not None
            or defender_can_retaliate
        ):
            resolved_attacker_damage = (
                self._calculate_combat_damage(
                    formula,
                    attacker=defender,
                    defender=attacker,
                    attacker_hp_override=defender_original_hp,
                    attack_bonus=retaliation_bonus,
                )
                if attacker_damage is None
                else int(attacker_damage)
            )

        self.current_rseed = formula.ceq

        defender.hp = max(0, defender_original_hp - max(0, resolved_defender_damage))
        attacker.hp = max(0, attacker_original_hp - max(0, resolved_attacker_damage))
        attacker.status.buried_resurface_bonus = 0
        if attacker.action.atomic_action_label in {
            "resurface_attack",
            "surface_move_attack",
        }:
            attacker.action.atomic_action_locked = False
            attacker.action.atomic_action_label = None

        if defender.hp == 0:
            self.remove_unit(defender.instance_id)
        if attacker.hp == 0:
            self.remove_unit(attacker.instance_id)

    def get_gang_up_bonus(self, attacker_id: str, defender_id: str) -> int:
        attacker = self._require_active_player_unit(attacker_id)
        defender = self.get_unit(defender_id)
        if defender is None:
            raise KeyError(f"Unknown defender_id: {defender_id}")
        return self._calculate_gang_up_bonus(attacker, defender)

    def begin_capture(self, unit_id: str, tile_coord: HexCoord) -> None:
        unit = self._require_active_player_unit(unit_id)
        self._enforce_atomic_action_lock(unit, action_kind="capture")
        tile = self.game_map.get_tile(tile_coord)
        if tile is None:
            raise ValueError("Capture tile does not exist")
        if unit.position != tile_coord:
            raise ValueError("Capturing unit must be on the target tile")
        tile.capture_state = CaptureState(
            tile=tile_coord,
            structure_owner_id=tile.owner_id,
            capturing_player_id=unit.owner_id,
            capturing_unit_id=unit.instance_id,
            rounds_remaining=1,
            defense_penalty_applies=True,
        )
        unit.capture_target = tile_coord
        unit.action.is_available = False
        unit.action.actions_remaining = 0

    def end_turn(self) -> str:
        outgoing_player_id = self.active_player_id
        self._assert_no_pending_atomic_actions(outgoing_player_id)
        self._apply_end_of_turn_effects(outgoing_player_id)
        next_player_id = self._next_player_id(outgoing_player_id)
        self.active_player_id = next_player_id
        self.round_number += 1
        self.turn_number += 1
        self.fight_context.clear()
        self._apply_start_of_turn_effects(next_player_id)
        return next_player_id

    def _apply_end_of_turn_effects(self, player_id: str) -> None:
        for unit in list(self.units.values()):
            if unit.owner_id != player_id:
                continue
            unit.status.buried_resurface_bonus = 0
            unit.action.atomic_action_locked = False
            unit.action.atomic_action_label = None
            if not unit.action.is_available:
                continue
            if unit.action.actions_remaining <= 0:
                continue
            self._auto_heal_unit(unit, heal_actions=unit.action.actions_remaining)
            unit.action.actions_remaining = 0
            unit.action.is_available = False
        self.players[player_id].has_ended_turn = True

    def _apply_start_of_turn_effects(self, player_id: str) -> None:
        self.players[player_id].has_ended_turn = False
        self._advance_teleport_state_for_turn_start(player_id)
        self._process_capture_progress(player_id)
        self.players[player_id].credits += self._income_for_player(player_id)
        infected_units = [
            unit
            for unit in list(self.units.values())
            if unit.owner_id == player_id and unit.status.plague_infected
        ]
        for unit in infected_units:
            if unit.instance_id not in self.units:
                continue
            self._apply_plague_start_of_turn(unit)
        for unit in list(self.units.values()):
            if unit.owner_id != player_id:
                continue
            self._tick_unit_start_of_turn(unit, skip_plague=True)
            if unit.instance_id in self.units:
                unit.action.reset_for_new_turn()

    def _tick_unit_start_of_turn(self, unit: UnitState, *, skip_plague: bool = False) -> None:
        if not skip_plague and unit.status.plague_infected and unit.hp > 1:
            unit.hp -= 1
        unit.status.emp_disabled_rounds = max(0, unit.status.emp_disabled_rounds - 1)
        unit.status.ability_cooldowns = {
            key: max(0, value - 1)
            for key, value in unit.status.ability_cooldowns.items()
        }

    def _advance_teleport_state_for_turn_start(self, active_player_id: str) -> None:
        for unit in self.units.values():
            phase = unit.status.teleport_lock_phase
            if phase == TeleportLockPhase.OPPONENT_TURN:
                if unit.owner_id == active_player_id:
                    unit.status.teleport_lock_phase = TeleportLockPhase.OWNER_TURN
                continue
            if phase == TeleportLockPhase.OWNER_TURN:
                if unit.owner_id != active_player_id:
                    unit.status.teleport_lock_phase = None
                    unit.status.teleport_disabled_rounds = max(
                        0, unit.status.teleport_disabled_rounds - 1
                    )
                    unit.status.teleport_cooldown_rounds = max(
                        0, unit.status.teleport_cooldown_rounds - 1
                    )

    def _apply_plague_start_of_turn(self, unit: UnitState) -> None:
        if self._is_plague_immune(unit):
            unit.status.plague_infected = False
            return
        if unit.hp > 1:
            unit.hp -= 1
        for other in self._adjacent_units(unit):
            if other.instance_id == unit.instance_id:
                continue
            if not self._can_be_infected_by_plague(other):
                continue
            other.status.plague_infected = True

    def _auto_heal_unit(self, unit: UnitState, *, heal_actions: int = 1) -> None:
        repair_points = _unit_repair_points(unit.unit_id)
        tile = self.game_map.get_tile(unit.position)
        terrain_multiplier = (
            _terrain_repair_multiplier(tile.terrain_id) if tile is not None else 1
        )
        support_multiplier = self._support_repair_multiplier(unit)
        heal_amount = repair_points * terrain_multiplier * support_multiplier * max(
            0, heal_actions
        )
        if heal_amount <= 0:
            return
        unit.hp = min(self._unit_max_hp(unit), unit.hp + heal_amount)
        if self._repair_cures_plague(unit):
            unit.status.plague_infected = False

    def _income_for_player(self, player_id: str) -> int:
        total = 0
        for tile in self.game_map.tiles.values():
            if tile.owner_id != player_id:
                continue
            income_amount = self._income_amount_for_terrain(tile.terrain_id)
            if income_amount > 0:
                total += income_amount
        return total

    def _income_amount_for_terrain(self, terrain_id: str) -> int:
        if terrain_id == "base":
            return self.income_per_base
        if terrain_id == "city":
            return self.income_per_city

        terrain_data = _cached_game_dictionary()["terrains"].get(terrain_id, {})
        if not bool(terrain_data.get("provides_income", False)):
            return 0

        configured_amount = terrain_data.get("income_amount")
        if configured_amount is not None:
            return int(configured_amount)
        return self.income_per_base

    def _support_repair_multiplier(self, unit: UnitState) -> int:
        multiplier = 1
        for support_unit in self._adjacent_friendly_units(unit):
            for ability in _unit_abilities(support_unit.unit_id):
                if ability.get("id") == "repair_aura":
                    multiplier = max(multiplier, int(ability.get("multiplier", 1)))
        return multiplier

    def _repair_cures_plague(self, unit: UnitState) -> bool:
        if not unit.status.plague_infected:
            return False
        tile = self.game_map.get_tile(unit.position)
        if tile is not None and tile.terrain_id == "medical":
            return True
        for support_unit in self._adjacent_friendly_units(unit):
            if support_unit.unit_id == "engineer":
                return True
        return False

    def _adjacent_friendly_units(self, unit: UnitState) -> list[UnitState]:
        return [
            other
            for other in self._adjacent_units(unit)
            if other.owner_id == unit.owner_id
        ]

    def _consume_action_if_needed(self, unit: UnitState) -> None:
        current_window = unit.action.current_action_window
        if current_window is not None:
            if not current_window.in_progress and unit.action.actions_remaining > 0:
                unit.action.actions_remaining -= 1
                current_window.in_progress = True
            return

        if unit.action.configured_action_count != 1:
            return

        if unit.action.actions_remaining <= 0:
            return

        if (
            unit.action.has_moved_this_turn
            or unit.action.has_attacked_this_turn
            or unit.action.has_used_special_this_turn
        ):
            return

        unit.action.actions_remaining -= 1

    def _unit_dictionary_entry(self, unit: UnitState) -> dict[str, Any]:
        return dict(_cached_game_dictionary()["units"].get(unit.unit_id, {}))

    def _movement_points_for_unit(self, unit: UnitState) -> int:
        if unit.action.move_points_remaining is not None:
            return max(0, int(unit.action.move_points_remaining))
        unit_data = self._unit_dictionary_entry(unit)
        if unit.status.hidden_mode in {HiddenMode.BURIED, HiddenMode.SUBMERGED}:
            hidden_mode = unit_data.get("hidden_mode") or {}
            return int(hidden_mode.get("mobility", 0))
        movement = unit_data.get("movement") or {}
        return int(movement.get("surface", 0))

    def _can_query_unit_movement(self, unit: UnitState) -> bool:
        return (
            unit.action.is_available
            and unit.action.actions_remaining > 0
            and not unit.status.movement_blocked
            and self._movement_points_for_unit(unit) > 0
        )

    def _can_query_unit_attack(self, unit: UnitState) -> bool:
        return (
            unit.action.is_available
            and unit.action.attacks_remaining > 0
            and not unit.status.movement_blocked
        )

    def _reachable_move_destinations(
        self,
        unit: UnitState,
        move_points: int,
    ) -> list[HexCoord]:
        best_remaining_by_coord: dict[HexCoord, int] = {unit.position: move_points}
        queue: list[tuple[HexCoord, int]] = [(unit.position, move_points)]
        destinations: set[HexCoord] = set()

        while queue:
            current, remaining = queue.pop(0)
            if remaining <= 0:
                continue
            for neighbor in self._adjacent_hexes(current):
                tile = self.game_map.get_tile(neighbor)
                if tile is None:
                    continue
                if not self._can_unit_enter_tile(unit, tile):
                    continue

                movement_cost = self._terrain_movement_cost(unit, tile.terrain_id)
                if movement_cost is None or movement_cost > remaining:
                    continue

                next_remaining = remaining - movement_cost
                can_stop = self._can_unit_stop_on_tile(unit, tile)
                if can_stop and neighbor != unit.position:
                    destinations.add(neighbor)

                if self._tile_is_in_enemy_zoc(unit, neighbor):
                    continue
                if next_remaining <= best_remaining_by_coord.get(neighbor, -1):
                    continue
                best_remaining_by_coord[neighbor] = next_remaining
                queue.append((neighbor, next_remaining))

        return sorted(destinations, key=lambda coord: (coord.q, coord.r))

    def _can_unit_enter_tile(self, unit: UnitState, tile: TileState) -> bool:
        if (
            unit.status.hidden_mode in {HiddenMode.BURIED, HiddenMode.SUBMERGED}
            and tile.terrain_id in self._hidden_mode_forbidden_terrains(unit)
        ):
            return False
        if self._terrain_movement_cost(unit, tile.terrain_id) is None:
            return False
        return not self._tile_has_enemy_unit_blocking_movement(unit, tile)

    def _terrain_movement_cost(self, unit: UnitState, terrain_id: str) -> int | None:
        effect = self._unit_terrain_effect(unit, terrain_id)
        if effect is None:
            return None
        cost = effect.get("mobility_cost")
        return None if cost is None else int(cost)

    def _unit_terrain_effect(
        self,
        unit: UnitState,
        terrain_id: str,
    ) -> dict[str, Any] | None:
        unit_data = self._unit_dictionary_entry(unit)
        if unit.status.hidden_mode in {HiddenMode.BURIED, HiddenMode.SUBMERGED}:
            hidden_mode = unit_data.get("hidden_mode") or {}
            hidden_costs = hidden_mode.get("terrain_movement_costs") or {}
            if terrain_id in hidden_costs:
                cost = hidden_costs.get(terrain_id)
                return {
                    "mobility_cost": cost,
                    "attack_bonus": None,
                    "defense_bonus": None,
                }
        effects = unit_data.get("terrain_effects") or {}
        effect = effects.get(terrain_id)
        return dict(effect) if effect is not None else None

    def _can_unit_stop_on_tile(self, unit: UnitState, tile: TileState) -> bool:
        occupied_slot = self._tile_slot_for_unit(tile, unit)
        return occupied_slot in (None, unit.instance_id)

    def _tile_has_enemy_unit_blocking_movement(
        self,
        unit: UnitState,
        tile: TileState,
    ) -> bool:
        blocking_unit_id = self._tile_slot_for_unit(tile, unit)
        if blocking_unit_id is None or blocking_unit_id == unit.instance_id:
            return False
        other = self.units.get(blocking_unit_id)
        return other is not None and other.owner_id != unit.owner_id

    def _tile_is_in_enemy_zoc(self, unit: UnitState, coord: HexCoord) -> bool:
        if self._uses_hidden_slot(unit):
            return False
        for adjacent in self._adjacent_hexes(coord):
            tile = self.game_map.get_tile(adjacent)
            if tile is None:
                continue
            for other_unit_id in (tile.surface_unit_id, tile.hidden_unit_id):
                if other_unit_id is None or other_unit_id == unit.instance_id:
                    continue
                other = self.units.get(other_unit_id)
                if other is None or other.owner_id == unit.owner_id:
                    continue
                if self._unit_exerts_zoc(other):
                    return True
        return False

    def _unit_exerts_zoc(self, unit: UnitState) -> bool:
        if unit.status.hidden_mode in {HiddenMode.BURIED, HiddenMode.SUBMERGED}:
            return False
        return not unit.status.control_zones_suppressed

    @staticmethod
    def _sorted_coord_keys(coords: list[HexCoord]) -> list[str]:
        return [
            coord.key
            for coord in sorted(coords, key=lambda item: (item.q, item.r))
        ]

    def _move_attack_targets_for_destinations(
        self,
        unit: UnitState,
        destinations: list[HexCoord],
    ) -> dict[str, list[str]]:
        return {
            coord.key: [
                target.instance_id
                for target in self._attackable_targets_from_position(
                    unit,
                    position=coord,
                    hidden_mode_override=unit.status.hidden_mode,
                )
            ]
            for coord in destinations
        }

    def _current_attack_targets(self, unit: UnitState) -> list[str]:
        if not self._can_query_unit_attack(unit):
            return []
        return [
            target.instance_id
            for target in self._attackable_targets_from_position(
                unit,
                position=unit.position,
                hidden_mode_override=unit.status.hidden_mode,
            )
        ]

    def _attackable_targets_from_position(
        self,
        unit: UnitState,
        *,
        position: HexCoord,
        hidden_mode_override: HiddenMode | None,
    ) -> list[UnitState]:
        targets: list[UnitState] = []
        for defender in self.units.values():
            if defender.owner_id == unit.owner_id:
                continue
            if self._can_unit_attack_target_from_position(
                unit,
                defender,
                position=position,
                hidden_mode_override=hidden_mode_override,
            ):
                targets.append(defender)
        return sorted(targets, key=lambda target: target.instance_id)

    def _can_unit_attack_target_from_position(
        self,
        attacker: UnitState,
        defender: UnitState,
        *,
        position: HexCoord,
        hidden_mode_override: HiddenMode | None,
    ) -> bool:
        attack_range = self._attack_range_for_hidden_mode(
            attacker,
            hidden_mode_override,
        )
        if attack_range is None:
            return False
        distance = self._hex_distance(position, defender.position)
        range_min, range_max = attack_range
        same_hex_submerged_override = self._surface_same_hex_submerged_attack_allowed(
            attacker,
            defender,
            hidden_mode_override,
            distance,
        )
        if (distance < range_min or distance > range_max) and not same_hex_submerged_override:
            return False
        if not self._submerged_attacker_can_target(attacker, defender, hidden_mode_override):
            return False
        published_base_attack = self._published_base_attack_strength_for_hidden_mode(
            attacker,
            defender,
            hidden_mode_override,
        )
        if defender.status.hidden_mode == HiddenMode.SUBMERGED:
            return (
                published_base_attack is not None
                and self._can_attack_submerged_target(attacker, hidden_mode_override)
            )
        if published_base_attack is None:
            return False
        return int(published_base_attack) > 0

    def _attack_range_for_hidden_mode(
        self,
        unit: UnitState,
        hidden_mode: HiddenMode | None,
    ) -> tuple[int, int] | None:
        if hidden_mode == HiddenMode.BURIED:
            return None
        attack_range = self._unit_dictionary_entry(unit).get("attack_range", {})
        range_data = (
            attack_range.get("hidden")
            if hidden_mode == HiddenMode.SUBMERGED
            else attack_range.get("surface")
        )
        if not range_data:
            return None
        return int(range_data["min"]), int(range_data["max"])

    def _published_base_attack_strength_for_hidden_mode(
        self,
        attacker: UnitState,
        defender: UnitState,
        hidden_mode: HiddenMode | None,
    ) -> int | None:
        attacker_data = self._unit_dictionary_entry(attacker)
        if defender.status.hidden_mode == HiddenMode.SUBMERGED:
            # Screenshot-derived submerged targeting uses the explicit "Submerged"
            # attack row stored in the dictionary, not a reconstructed range hack.
            submerged_target_attack = attacker_data.get("submerged_target_attack", {})
            if hidden_mode == HiddenMode.SUBMERGED:
                return submerged_target_attack.get("hidden_mode_effective_strength")
            return submerged_target_attack.get("surface_mode_effective_strength")
        if defender.status.hidden_mode == HiddenMode.BURIED:
            return None
        target_class = self._target_class_for_unit(defender)
        return int(attacker_data["attack_strength_by_target_class"][target_class])

    def _can_attack_submerged_target(
        self,
        attacker: UnitState,
        hidden_mode: HiddenMode | None,
    ) -> bool:
        submerged_target_attack = (
            self._unit_dictionary_entry(attacker).get("submerged_target_attack") or {}
        )
        if hidden_mode == HiddenMode.SUBMERGED:
            return bool(submerged_target_attack.get("hidden_mode_can_attack", False))
        return bool(submerged_target_attack.get("surface_mode_can_attack", False))

    def _surface_same_hex_submerged_attack_allowed(
        self,
        attacker: UnitState,
        defender: UnitState,
        hidden_mode: HiddenMode | None,
        distance: int,
    ) -> bool:
        if hidden_mode == HiddenMode.SUBMERGED:
            return False
        if defender.status.hidden_mode != HiddenMode.SUBMERGED:
            return False
        if distance != 0:
            return False
        attacker_data = self._unit_dictionary_entry(attacker)
        surface_range = (attacker_data.get("attack_range") or {}).get("surface") or {}
        range_min = int(surface_range.get("min", 0))
        return range_min <= 1

    def _submerged_attacker_can_target(
        self,
        attacker: UnitState,
        defender: UnitState,
        hidden_mode: HiddenMode | None,
    ) -> bool:
        if hidden_mode != HiddenMode.SUBMERGED:
            return True
        hidden_data = self._unit_dictionary_entry(attacker).get("hidden_mode") or {}
        if hidden_data.get("can_attack_ground_air_from_hidden") is not False:
            return True
        return self._target_class_for_unit(defender) not in {
            "ground_light",
            "ground_heavy",
            "air",
        }

    def _hidden_mode_resurface_bonus(self, unit: UnitState) -> int:
        hidden_mode = self._unit_dictionary_entry(unit).get("hidden_mode") or {}
        return int(hidden_mode.get("resurface_bonus", 0))

    def _hidden_mode_forbidden_terrains(self, unit: UnitState) -> set[str]:
        hidden_mode = self._unit_dictionary_entry(unit).get("hidden_mode") or {}
        return {str(item) for item in hidden_mode.get("forbidden_terrains", [])}

    def _is_underling_family(self, unit: UnitState) -> bool:
        return unit.unit_id in {"underling", "cyber_underling"}

    def _requires_surface_move_attack_lock(self, unit: UnitState) -> bool:
        return False

    def _can_attack_after_move_in_same_action(self, unit: UnitState) -> bool:
        if not self._can_query_unit_attack(unit):
            return False
        if unit.unit_id == "borfly" and unit.status.hidden_mode is None:
            return False
        return True

    def _can_surface_move_continue_as_atomic_attack(self, unit: UnitState) -> bool:
        return self._is_underling_family(unit) and unit.status.hidden_mode is None

    def _can_bury(self, unit: UnitState) -> bool:
        if not self._is_underling_family(unit):
            return False
        if unit.status.hidden_mode is not None:
            return False
        if not unit.action.is_available or unit.action.actions_remaining <= 0:
            return False
        tile = self.game_map.get_tile(unit.position)
        if tile is None:
            return False
        if tile.hidden_unit_id not in (None, unit.instance_id):
            return False
        return tile.terrain_id not in self._hidden_mode_forbidden_terrains(unit)

    def _can_resurface(self, unit: UnitState) -> bool:
        if unit.status.hidden_mode != HiddenMode.BURIED:
            return False
        if not unit.action.is_available or unit.action.actions_remaining <= 0:
            return False
        tile = self.game_map.get_tile(unit.position)
        if tile is None:
            return False
        return tile.surface_unit_id in (None, unit.instance_id)

    def _assert_no_pending_atomic_actions(self, player_id: str) -> None:
        for unit in self.units.values():
            if unit.owner_id != player_id:
                continue
            if not unit.action.atomic_action_locked:
                continue
            if unit.action.atomic_action_label == "surface_move_attack":
                raise ValueError(
                    f"Unit {unit.instance_id} must finish its move+attack action before ending the turn"
                )
            if unit.action.atomic_action_label == "resurface_attack":
                raise ValueError(
                    f"Unit {unit.instance_id} must finish its unbury+attack action before ending the turn"
                )

    def _published_base_attack_strength(
        self,
        attacker: UnitState,
        defender: UnitState,
    ) -> int | None:
        attacker_data = self._unit_dictionary_entry(attacker)
        if defender.status.hidden_mode == HiddenMode.SUBMERGED:
            # Screenshot-derived submerged targeting uses the explicit "Submerged"
            # attack row stored in the dictionary, not a reconstructed range hack.
            submerged_target_attack = attacker_data.get("submerged_target_attack", {})
            if attacker.status.hidden_mode == HiddenMode.SUBMERGED:
                return submerged_target_attack.get("hidden_mode_effective_strength")
            return submerged_target_attack.get("surface_mode_effective_strength")
        if defender.status.hidden_mode == HiddenMode.BURIED:
            return None
        target_class = self._target_class_for_unit(defender)
        return int(attacker_data["attack_strength_by_target_class"][target_class])

    def _terrain_combat_modifiers(self, unit: UnitState) -> tuple[int, int]:
        tile = self.game_map.get_tile(unit.position)
        if tile is None:
            return 0, 0
        unit_effect = self._unit_terrain_effect(unit, tile.terrain_id)
        if unit_effect is not None:
            attack_bonus = unit_effect.get("attack_bonus")
            defense_bonus = unit_effect.get("defense_bonus")
            if attack_bonus is not None or defense_bonus is not None:
                return (
                    0 if attack_bonus is None else int(attack_bonus),
                    0 if defense_bonus is None else int(defense_bonus),
                )
        terrain_data = _cached_game_dictionary()["terrains"].get(tile.terrain_id, {})
        for example in terrain_data.get("community_examples", []):
            if str(example.get("unit_id")) == unit.unit_id:
                return (
                    int(example.get("attack_modifier", 0)),
                    int(example.get("defense_modifier", 0)),
                )
        return 0, 0

    def _target_class_for_unit(self, unit: UnitState) -> str:
        unit_type = str(self._unit_dictionary_entry(unit).get("unit_type", unit.unit_id))
        if unit_type == "air":
            return "air"
        if unit_type in {"ground_light", "ground_heavy", "aquatic", "amphibian"}:
            return unit_type
        raise ValueError(f"Unsupported target class for unit type: {unit_type}")

    def _current_attack_range(self, unit: UnitState) -> tuple[int, int] | None:
        if unit.status.hidden_mode == HiddenMode.BURIED:
            return None
        attack_range = self._unit_dictionary_entry(unit).get("attack_range", {})
        range_data: dict[str, Any] | None
        if unit.status.hidden_mode == HiddenMode.SUBMERGED:
            range_data = attack_range.get("hidden")
        else:
            range_data = attack_range.get("surface")
        if not range_data:
            return None
        return int(range_data["min"]), int(range_data["max"])

    def _current_defense_strength(self, unit: UnitState) -> int:
        unit_data = self._unit_dictionary_entry(unit)
        if unit.status.hidden_mode in {HiddenMode.SUBMERGED, HiddenMode.BURIED}:
            hidden_mode = unit_data.get("hidden_mode") or {}
            base_defense = int(
                hidden_mode.get("defense_strength", unit_data["surface_defense_strength"])
            )
        else:
            base_defense = int(unit_data["surface_defense_strength"])
        _, terrain_defense_bonus = self._terrain_combat_modifiers(unit)
        return base_defense + terrain_defense_bonus

    def _effective_attack_strength(self, attacker: UnitState, defender: UnitState) -> int | None:
        effective = self._published_base_attack_strength(attacker, defender)
        terrain_attack_bonus, _ = self._terrain_combat_modifiers(attacker)
        return None if effective is None else int(effective) + terrain_attack_bonus

    def _effective_armor_piercing_percent(
        self,
        attacker: UnitState,
        defender: UnitState,
    ) -> int:
        attacker_data = self._unit_dictionary_entry(attacker)
        armor_data = attacker_data.get("armor_piercing_percent_by_target_class")
        if not armor_data:
            return 0
        target_class = self._target_class_for_unit(defender)
        return int(armor_data.get(target_class, 0))

    def _calculate_gang_up_bonus(self, attacker: UnitState, defender: UnitState) -> int:
        context = self.fight_context
        if context.acting_player_id != attacker.owner_id:
            return 0
        if context.last_attacked_unit_id != defender.instance_id:
            return 0
        if context.previous_attack_origin is None:
            return 0
        if not context.previous_attack_was_melee:
            return 1
        previous_direction = self._direction_index_around(
            defender.position,
            context.previous_attack_origin,
        )
        current_direction = self._direction_index_around(defender.position, attacker.position)
        delta = (current_direction - previous_direction) % 6
        if delta in {1, 5}:
            return 1
        if delta in {0, 2, 4}:
            return 2
        return 3

    def _direction_index_around(self, center: HexCoord, origin: HexCoord) -> int:
        directions = [
            (1, 0),
            (1, -1),
            (0, -1),
            (-1, 0),
            (-1, 1),
            (0, 1),
        ]
        best_index = 0
        best_distance: int | None = None
        for index, (dq, dr) in enumerate(directions):
            neighbor = HexCoord(center.q + dq, center.r + dr)
            distance = self._hex_distance(neighbor, origin)
            if best_distance is None or distance < best_distance:
                best_distance = distance
                best_index = index
        return best_index

    def _can_unit_attack_target(self, attacker: UnitState, defender: UnitState) -> bool:
        attack_range = self._current_attack_range(attacker)
        if attack_range is None:
            return False
        distance = self._hex_distance(attacker.position, defender.position)
        range_min, range_max = attack_range
        same_hex_submerged_override = self._surface_same_hex_submerged_attack_allowed(
            attacker,
            defender,
            attacker.status.hidden_mode,
            distance,
        )
        if (distance < range_min or distance > range_max) and not same_hex_submerged_override:
            return False
        if not self._submerged_attacker_can_target(
            attacker,
            defender,
            attacker.status.hidden_mode,
        ):
            return False
        published_base_attack = self._published_base_attack_strength(attacker, defender)
        if defender.status.hidden_mode == HiddenMode.SUBMERGED:
            return (
                published_base_attack is not None
                and self._can_attack_submerged_target(attacker, attacker.status.hidden_mode)
            )
        if published_base_attack is None:
            return False
        return int(published_base_attack) > 0

    def _calculate_combat_damage(
        self,
        formula: LegalFormula,
        *,
        attacker: UnitState,
        defender: UnitState,
        attacker_hp_override: int | None = None,
        attack_bonus: int = 0,
    ) -> int:
        effective_attack = self._effective_attack_strength(attacker, defender)
        if effective_attack is None:
            return 0
        defense_strength = self._current_defense_strength(defender)
        armor_piercing = self._effective_armor_piercing_percent(attacker, defender)
        return formula.get_damage(
            attacker_hp=attacker.hp if attacker_hp_override is None else int(attacker_hp_override),
            attack=int(effective_attack),
            defense=defense_strength,
            attack_bonus=int(attack_bonus),
            armor_piercing_percent=armor_piercing,
        )

    def _adjacent_units(self, unit: UnitState) -> list[UnitState]:
        adjacent_units: list[UnitState] = []
        for coord in self._adjacent_hexes(unit.position):
            adjacent_units.extend(self.get_units_at(coord))
        return adjacent_units

    def _is_sapiens_unit(self, unit: UnitState) -> bool:
        player = self.players.get(unit.owner_id)
        return player is not None and player.faction == "sapiens"

    def _is_plague_immune(self, unit: UnitState) -> bool:
        return unit.unit_id in {"engineer", "submarine"}

    def _can_be_infected_by_plague(self, unit: UnitState) -> bool:
        return self._is_sapiens_unit(unit) and not self._is_plague_immune(unit)

    def _uses_hidden_slot(self, unit: UnitState) -> bool:
        return unit.status.hidden_mode is not None

    def _tile_slot_for_unit(self, tile: TileState, unit: UnitState) -> str | None:
        return tile.hidden_unit_id if self._uses_hidden_slot(unit) else tile.surface_unit_id

    def _place_unit_on_tile(
        self, tile: TileState, unit: UnitState, *, strict: bool
    ) -> None:
        if self._uses_hidden_slot(unit):
            if strict and tile.hidden_unit_id not in (None, unit.instance_id):
                raise ValueError("Destination hidden slot is already occupied")
            tile.hidden_unit_id = unit.instance_id
            return
        if strict and tile.surface_unit_id not in (None, unit.instance_id):
            raise ValueError("Destination surface slot is already occupied")
        tile.surface_unit_id = unit.instance_id

    def _process_capture_progress(self, player_id: str) -> None:
        for tile in self.game_map.tiles.values():
            capture_state = tile.capture_state
            if capture_state is None or capture_state.capturing_player_id != player_id:
                continue
            capture_state.rounds_remaining = max(0, capture_state.rounds_remaining - 1)
            if capture_state.rounds_remaining == 0:
                tile.owner_id = player_id
                self.remove_unit(capture_state.capturing_unit_id)
                tile.capture_state = None

    def _next_player_id(self, current_player_id: str) -> str:
        current_index = self.player_order.index(current_player_id)
        return self.player_order[(current_index + 1) % len(self.player_order)]

    @staticmethod
    def _hex_distance(a: HexCoord, b: HexCoord) -> int:
        return max(abs(a.q - b.q), abs(a.r - b.r), abs(a.s - b.s))

    @staticmethod
    def _adjacent_hexes(coord: HexCoord) -> list[HexCoord]:
        directions = [
            (1, 0),
            (1, -1),
            (0, -1),
            (-1, 0),
            (-1, 1),
            (0, 1),
        ]
        return [HexCoord(coord.q + dq, coord.r + dr) for dq, dr in directions]

    @staticmethod
    def _unit_max_hp(unit: UnitState) -> int:
        return 10 + int(unit.veterancy_level)

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
                state._place_unit_on_tile(tile, unit, strict=False)
        return state

    @classmethod
    def from_json(cls, payload: str) -> "GameState":
        return cls.from_dict(json.loads(payload))


def game_state_to_json(state: GameState, *, indent: int = 2) -> str:
    return state.to_json(indent=indent)


def json_to_game_state(payload: str | bytes | bytearray) -> GameState:
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode("utf-8")
    return GameState.from_json(payload)


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
