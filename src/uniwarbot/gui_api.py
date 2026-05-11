from __future__ import annotations

import json
import math
import re
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from .scenario_inspector import (
    ROOT,
    build_scenario_report,
    compute_possible_moves_at_step,
    list_scenario_summaries,
    load_scenario_by_id,
)
from .state import load_game_dictionary


WEB_DIST = ROOT / "webgui" / "dist"
WEB_APP = ROOT / "webgui"
MAPS_DIR = ROOT / "maps"
EDITOR_FACTIONS = ["sapiens", "khraleans", "titans"]

app = FastAPI(
    title="UniwarBot Scenario Inspector API",
    version="0.1.0",
    description="Local API for browsing UniwarBot scenario fixtures and state transitions.",
)

LANDING_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>UniwarBot</title>
    <style>
      :root {
        font-family: "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #0b1322 0%, #101a2e 100%);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .links {
        display: flex;
        gap: 18px;
        flex-wrap: wrap;
        justify-content: center;
      }
      a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 16px 22px;
        border-radius: 14px;
        color: white;
        text-decoration: none;
        font-weight: 700;
        background: linear-gradient(135deg, #2563eb, #0f766e);
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
      }
    </style>
  </head>
  <body>
    <div class="links">
      <a href="/scenario-inspector/">Scenario Inspector</a>
      <a href="/units-stats/">Units Stats</a>
      <a href="/game-state-editor/">Game State Editor</a>
    </div>
  </body>
</html>
"""

TERRAIN_DISPLAY_ORDER = [
    "plain",
    "forest",
    "mountain",
    "swamp",
    "desert",
    "road_land",
    "city",
    "base",
    "medical",
    "water",
    "ocean",
    "reef",
    "road_water",
    "harbor",
    "chasm",
]

TARGET_CLASS_ORDER = ["ground_light", "ground_heavy", "air", "aquatic", "amphibian"]
FACTION_ORDER = {"sapiens": 0, "khraleans": 1, "titans": 2}
HIDDEN_MODE_VALUES = ["buried", "submerged"]
TELEPORT_LOCK_PHASE_VALUES = ["opponent_turn", "owner_turn"]


def _suggest_city_income(base_income: int) -> int:
    return int(math.ceil((int(base_income) / 2) / 5.0) * 5)


def _unit_sprite_id(unit_id: str) -> str:
    return "mecha_2" if unit_id == "mecha_ii" else unit_id


def _default_editor_unit(
    unit_id: str,
    owner_id: str,
    position: dict[str, int],
    *,
    instance_id: str,
    hidden_mode: str | None = None,
) -> dict[str, object]:
    unit_entry = load_game_dictionary()["units"].get(unit_id, {})
    return {
        "instance_id": instance_id,
        "unit_id": unit_id,
        "owner_id": owner_id,
        "position": {"q": int(position["q"]), "r": int(position["r"])},
        "hp": int(unit_entry.get("base_max_hp", 10)),
        "veterancy_level": 0,
        "experience_points": 0,
        "status": {
            "plague_infected": False,
            "hidden_mode": hidden_mode,
            "emp_disabled_rounds": 0,
            "teleport_disabled_rounds": 0,
            "teleport_lock_phase": None,
            "teleport_cooldown_rounds": 0,
            "buried_resurface_bonus": 0,
            "submerged_attack_penalty": 0,
            "ability_cooldowns": {},
        },
        "action": {
            "is_available": True,
            "configured_action_count": 1,
            "actions_remaining": 1,
            "can_interleave_between_action_windows": True,
            "move_points_remaining": None,
            "attacks_remaining": 1,
            "special_actions_remaining": None,
            "action_phase_index": 0,
            "current_action_index": 0,
            "action_windows": [],
            "atomic_action_locked": False,
            "atomic_action_label": None,
            "has_moved_this_turn": False,
            "has_attacked_this_turn": False,
            "has_used_special_this_turn": False,
        },
        "capture_target": None,
        "metadata": {},
    }


def _sanitize_map_file_name(file_name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(file_name).strip())
    cleaned = cleaned.strip("._")
    if not cleaned:
        raise ValueError("Map file name cannot be empty")
    if not cleaned.lower().endswith(".json"):
        cleaned = f"{cleaned}.json"
    return cleaned


def _normalize_editor_map(payload: dict[str, object] | None) -> dict[str, object]:
    payload = dict(payload or {})
    game_dictionary = load_game_dictionary()
    terrain_ids = set(game_dictionary["terrains"].keys())
    terrain_map = game_dictionary["terrains"]
    unit_ids = set(game_dictionary["units"].keys())

    size = dict(payload.get("size") or {})
    width = max(1, int(size.get("width", payload.get("width", 8) or 8)))
    height = max(1, int(size.get("height", payload.get("height", 8) or 8)))
    player_count = max(1, min(8, int(payload.get("player_count", 2) or 2)))

    players_payload = list(payload.get("players") or [])
    players: list[dict[str, object]] = []
    for index in range(player_count):
        raw_player = dict(players_payload[index]) if index < len(players_payload) else {}
        allowed_factions = [
            faction for faction in list(raw_player.get("allowed_factions") or EDITOR_FACTIONS) if faction in EDITOR_FACTIONS
        ]
        if not allowed_factions:
            allowed_factions = list(EDITOR_FACTIONS)
        players.append(
            {
                "player_id": f"p{index + 1}",
                "allowed_factions": allowed_factions,
            }
        )

    economy_payload = dict(payload.get("economy") or {})
    base_income = max(0, int(economy_payload.get("base_income", 100) or 100))
    city_income_raw = economy_payload.get("city_income")
    city_income = (
        _suggest_city_income(base_income)
        if city_income_raw is None
        else max(0, int(city_income_raw))
    )
    starting_credits = max(0, int(economy_payload.get("starting_credits", 100) or 100))

    tiles: list[dict[str, object]] = []
    valid_owner_ids = {f"p{index + 1}" for index in range(player_count)}
    for raw_tile in list(payload.get("tiles") or []):
        tile = dict(raw_tile)
        coord = dict(tile.get("coord") or {})
        q = int(coord.get("q", -1))
        r = int(coord.get("r", -1))
        if not (0 <= q < width and 0 <= r < height):
            continue
        terrain_id = str(tile.get("terrain_id", "plain"))
        if terrain_id not in terrain_ids:
            terrain_id = "plain"
        owner_id = tile.get("owner_id")
        if owner_id not in valid_owner_ids:
            owner_id = None
        if not bool(terrain_map.get(terrain_id, {}).get("capturable", False)):
            owner_id = None
        tiles.append(
            {
                "coord": {"q": q, "r": r},
                "terrain_id": terrain_id,
                "owner_id": owner_id,
            }
        )
    tiles.sort(key=lambda tile: (int(tile["coord"]["r"]), int(tile["coord"]["q"])))
    tile_keys = {
        (int(tile["coord"]["q"]), int(tile["coord"]["r"]))
        for tile in tiles
    }

    units: list[dict[str, object]] = []
    seen_instance_ids: set[str] = set()
    for index, raw_unit in enumerate(list(payload.get("units") or []), start=1):
        unit = dict(raw_unit)
        unit_id = str(unit.get("unit_id", "marine"))
        if unit_id not in unit_ids:
            continue
        owner_id = str(unit.get("owner_id", "p1"))
        if owner_id not in valid_owner_ids:
            owner_id = "p1"
        position = dict(unit.get("position") or {})
        q = int(position.get("q", -1))
        r = int(position.get("r", -1))
        if not (0 <= q < width and 0 <= r < height):
            continue
        if (q, r) not in tile_keys:
            continue
        raw_status = dict(unit.get("status") or {})
        hidden_mode = raw_status.get("hidden_mode")
        hidden_mode_value = (
            str(hidden_mode) if hidden_mode in HIDDEN_MODE_VALUES else None
        )
        default_unit = _default_editor_unit(
            unit_id,
            owner_id,
            {"q": q, "r": r},
            instance_id=f"u_{unit_id}_{index}",
            hidden_mode=hidden_mode_value,
        )
        instance_id = str(unit.get("instance_id") or default_unit["instance_id"])
        if instance_id in seen_instance_ids:
            suffix = 2
            while f"{instance_id}_{suffix}" in seen_instance_ids:
                suffix += 1
            instance_id = f"{instance_id}_{suffix}"
        seen_instance_ids.add(instance_id)

        status = dict(default_unit["status"])
        status.update(raw_status)
        status["hidden_mode"] = (
            str(status.get("hidden_mode"))
            if status.get("hidden_mode") in HIDDEN_MODE_VALUES
            else None
        )
        status["teleport_lock_phase"] = (
            str(status.get("teleport_lock_phase"))
            if status.get("teleport_lock_phase") in TELEPORT_LOCK_PHASE_VALUES
            else None
        )
        status["plague_infected"] = bool(status.get("plague_infected", False))
        status["emp_disabled_rounds"] = int(status.get("emp_disabled_rounds", 0))
        status["teleport_disabled_rounds"] = int(
            status.get("teleport_disabled_rounds", 0)
        )
        status["teleport_cooldown_rounds"] = int(
            status.get("teleport_cooldown_rounds", 0)
        )
        status["buried_resurface_bonus"] = int(
            status.get("buried_resurface_bonus", 0)
        )
        status["submerged_attack_penalty"] = int(
            status.get("submerged_attack_penalty", 0)
        )
        status["ability_cooldowns"] = {
            str(key): int(value)
            for key, value in dict(status.get("ability_cooldowns", {})).items()
        }

        raw_action = dict(unit.get("action") or {})
        action = dict(default_unit["action"])
        action.update(raw_action)
        action["is_available"] = bool(action.get("is_available", True))
        action["configured_action_count"] = int(
            action.get("configured_action_count", 1)
        )
        action["actions_remaining"] = int(action.get("actions_remaining", 1))
        action["can_interleave_between_action_windows"] = bool(
            action.get("can_interleave_between_action_windows", True)
        )
        action["move_points_remaining"] = (
            None
            if action.get("move_points_remaining") in {None, ""}
            else int(action.get("move_points_remaining"))
        )
        action["attacks_remaining"] = int(action.get("attacks_remaining", 1))
        action["special_actions_remaining"] = (
            None
            if action.get("special_actions_remaining") in {None, ""}
            else int(action.get("special_actions_remaining"))
        )
        action["action_phase_index"] = int(action.get("action_phase_index", 0))
        action["current_action_index"] = int(action.get("current_action_index", 0))
        action["action_windows"] = list(action.get("action_windows", []))
        action["atomic_action_locked"] = bool(
            action.get("atomic_action_locked", False)
        )
        action["atomic_action_label"] = (
            None
            if action.get("atomic_action_label") in {None, ""}
            else str(action.get("atomic_action_label"))
        )
        action["has_moved_this_turn"] = bool(
            action.get("has_moved_this_turn", False)
        )
        action["has_attacked_this_turn"] = bool(
            action.get("has_attacked_this_turn", False)
        )
        action["has_used_special_this_turn"] = bool(
            action.get("has_used_special_this_turn", False)
        )

        capture_target = unit.get("capture_target")
        normalized_capture_target = None
        if isinstance(capture_target, dict):
            capture_q = int(capture_target.get("q", -1))
            capture_r = int(capture_target.get("r", -1))
            if 0 <= capture_q < width and 0 <= capture_r < height:
                normalized_capture_target = {"q": capture_q, "r": capture_r}

        units.append(
            {
                "instance_id": instance_id,
                "unit_id": unit_id,
                "owner_id": owner_id,
                "position": {"q": q, "r": r},
                "hp": int(unit.get("hp", default_unit["hp"])),
                "veterancy_level": max(
                    0, min(2, int(unit.get("veterancy_level", 0)))
                ),
                "experience_points": int(unit.get("experience_points", 0)),
                "status": status,
                "action": action,
                "capture_target": normalized_capture_target,
                "metadata": dict(unit.get("metadata", {})),
            }
        )

    map_name = str(payload.get("name", "New Map") or "New Map")
    map_id = str(payload.get("map_id", re.sub(r"[^a-z0-9]+", "-", map_name.lower()).strip("-") or "new-map"))

    return {
        "schema_version": "map-editor-v1",
        "map_id": map_id,
        "name": map_name,
        "size": {"width": width, "height": height},
        "player_count": player_count,
        "players": players,
        "economy": {
            "base_income": base_income,
            "city_income": city_income,
            "starting_credits": starting_credits,
        },
        "tiles": tiles,
        "units": units,
    }


def _build_map_editor_config() -> dict[str, object]:
    game_dictionary = load_game_dictionary()
    terrains = game_dictionary["terrains"]
    units = game_dictionary["units"]
    terrain_order = [
        terrain_id for terrain_id in TERRAIN_DISPLAY_ORDER if terrain_id in terrains
    ] + [terrain_id for terrain_id in terrains if terrain_id not in TERRAIN_DISPLAY_ORDER]
    unit_order = sorted(
        units.keys(),
        key=lambda unit_id: (
            FACTION_ORDER.get(str(units[unit_id].get("faction")), 99),
            str(units[unit_id].get("display_name", unit_id)).lower(),
        ),
    )
    return {
        "terrain_order": terrain_order,
        "terrains": {
            terrain_id: {
                "terrain_id": terrain_id,
                "display_name": str(terrains[terrain_id].get("display_name", terrain_id)),
                "capturable": bool(terrains[terrain_id].get("capturable", False)),
                "supports_production": bool(terrains[terrain_id].get("supports_production", False)),
                "production_role": terrains[terrain_id].get("production_role"),
                "provides_income": bool(terrains[terrain_id].get("provides_income", False)),
            }
            for terrain_id in terrain_order
        },
        "factions": list(EDITOR_FACTIONS),
        "unit_order": unit_order,
        "units": {
            unit_id: {
                "unit_id": unit_id,
                "display_name": str(units[unit_id].get("display_name", unit_id)),
                "faction": str(units[unit_id].get("faction", "")),
                "unit_type": str(units[unit_id].get("unit_type", "")),
                "base_max_hp": int(units[unit_id].get("base_max_hp", 10)),
                "sprite_unit_id": _unit_sprite_id(unit_id),
                "hidden_mode": (
                    str((units[unit_id].get("hidden_mode") or {}).get("mode"))
                    if units[unit_id].get("hidden_mode")
                    else None
                ),
                "can_teleport": any(
                    str((ability or {}).get("id")) == "teleport"
                    for ability in list(units[unit_id].get("abilities") or [])
                ),
                "can_plague": unit_id not in {"engineer", "submarine"},
                "surface_allowed_terrains": sorted(
                    terrain_id
                    for terrain_id, effects in dict(units[unit_id].get("terrain_effects") or {}).items()
                    if (effects or {}).get("mobility_cost") is not None
                ),
                "hidden_allowed_terrains": sorted(
                    terrain_id
                    for terrain_id, cost in dict(((units[unit_id].get("hidden_mode") or {}).get("terrain_movement_costs") or {})).items()
                    if cost is not None
                    and terrain_id
                    not in {
                        str(item)
                        for item in list(((units[unit_id].get("hidden_mode") or {}).get("forbidden_terrains") or []))
                    }
                ),
            }
            for unit_id in unit_order
        },
        "hidden_mode_values": list(HIDDEN_MODE_VALUES),
        "teleport_lock_phase_values": list(TELEPORT_LOCK_PHASE_VALUES),
        "veterancy_levels": [0, 1, 2],
        "defaults": {
            "width": 8,
            "height": 8,
            "player_count": 2,
            "base_income": 100,
            "city_income": _suggest_city_income(100),
            "starting_credits": 100,
        },
    }


def _list_saved_maps() -> list[dict[str, object]]:
    MAPS_DIR.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, object]] = []
    for path in sorted(MAPS_DIR.glob("*.json")):
        if path.name.startswith("_"):
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            name = str(payload.get("name", path.stem))
        except Exception:
            name = path.stem
        items.append(
            {
                "file_name": path.name,
                "name": name,
                "modified_utc": path.stat().st_mtime,
            }
        )
    return items


def _range_label(range_data: dict[str, object] | None) -> str | None:
    if not range_data:
        return None
    min_range = int(range_data["min"])
    max_range = int(range_data["max"])
    return str(min_range) if min_range == max_range else f"{min_range}-{max_range}"


def build_unit_stats_payload() -> dict[str, object]:
    game_dictionary = load_game_dictionary()
    terrains = game_dictionary["terrains"]
    terrain_order = [
        terrain_id for terrain_id in TERRAIN_DISPLAY_ORDER if terrain_id in terrains
    ] + [terrain_id for terrain_id in terrains if terrain_id not in TERRAIN_DISPLAY_ORDER]

    units_payload: list[dict[str, object]] = []
    for unit_id, unit_data in game_dictionary["units"].items():
        hidden_mode = dict(unit_data.get("hidden_mode") or {})
        attack_range = dict(unit_data.get("attack_range") or {})
        submerged_target_attack = dict(unit_data.get("submerged_target_attack") or {})
        terrain_effects = dict(unit_data.get("terrain_effects") or {})
        units_payload.append(
            {
                "unit_id": unit_id,
                "display_name": str(unit_data.get("display_name", unit_id)),
                "faction": str(unit_data.get("faction", "")),
                "unit_type": str(unit_data.get("unit_type", "")),
                "cost": int(unit_data.get("cost", 0)),
                "base_max_hp": int(unit_data.get("base_max_hp", 0)),
                "moves_per_turn": int((unit_data.get("movement") or {}).get("moves_per_turn", 0)),
                "surface_mobility": int((unit_data.get("movement") or {}).get("surface", 0)),
                "after_attack_mobility": int((unit_data.get("movement") or {}).get("after_attack", 0)),
                "surface_vision": int((unit_data.get("vision") or {}).get("surface", 0)),
                "surface_attack_range": attack_range.get("surface"),
                "surface_attack_range_label": _range_label(attack_range.get("surface")),
                "hidden_attack_range": attack_range.get("hidden"),
                "hidden_attack_range_label": _range_label(attack_range.get("hidden")),
                "surface_defense_strength": int(unit_data.get("surface_defense_strength", 0)),
                "repair_points": int(unit_data.get("repair_points", 0)),
                "attack_strength_by_target_class": {
                    target_class: int((unit_data.get("attack_strength_by_target_class") or {}).get(target_class, 0))
                    for target_class in TARGET_CLASS_ORDER
                },
                "armor_piercing_percent_by_target_class": {
                    target_class: int((unit_data.get("armor_piercing_percent_by_target_class") or {}).get(target_class, 0))
                    for target_class in TARGET_CLASS_ORDER
                },
                "submerged_attack_strength": submerged_target_attack.get("surface_mode_explicit_strength"),
                "submerged_same_hex_allowed": bool(
                    submerged_target_attack.get("surface_same_hex_allowed", False)
                ),
                "hidden_mode": {
                    "enabled": bool(hidden_mode),
                    "mode": hidden_mode.get("mode"),
                    "mobility": hidden_mode.get("mobility"),
                    "vision": hidden_mode.get("vision"),
                    "defense_strength": hidden_mode.get("defense_strength"),
                    "attack_range": hidden_mode.get("attack_range"),
                    "attack_range_label": _range_label(hidden_mode.get("attack_range")),
                    "resurface_bonus": hidden_mode.get("resurface_bonus"),
                    "attack_from_hidden_penalty": hidden_mode.get("attack_from_hidden_penalty"),
                    "can_attack_ground_air_from_hidden": hidden_mode.get(
                        "can_attack_ground_air_from_hidden"
                    ),
                    "forbidden_terrains": hidden_mode.get("forbidden_terrains", []),
                    "terrain_movement_costs": hidden_mode.get("terrain_movement_costs", {}),
                },
                "terrain_effects": {
                    terrain_id: {
                        "mobility_cost": effect.get("mobility_cost"),
                        "attack_bonus": effect.get("attack_bonus"),
                        "defense_bonus": effect.get("defense_bonus"),
                    }
                    for terrain_id, effect in terrain_effects.items()
                },
                "abilities": list(unit_data.get("abilities", [])),
                "notes": list(unit_data.get("notes", [])),
            }
        )

    units_payload.sort(
        key=lambda item: (
            FACTION_ORDER.get(str(item["faction"]), 99),
            str(item["display_name"]).lower(),
        )
    )
    return {
        "terrain_order": terrain_order,
        "target_class_order": TARGET_CLASS_ORDER,
        "units": units_payload,
    }

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/scenarios")
def scenarios() -> list[dict[str, object]]:
    return list_scenario_summaries()


@app.get("/api/scenarios/{scenario_id}")
def scenario_detail(scenario_id: str) -> dict[str, object]:
    try:
        scenario = load_scenario_by_id(scenario_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return build_scenario_report(scenario)


@app.get("/api/scenarios/{scenario_id}/possible-moves")
def scenario_possible_moves(
    scenario_id: str,
    unit_id: str = Query(...),
    step_index: int = Query(-1),
) -> dict[str, object]:
    try:
        return compute_possible_moves_at_step(
            scenario_id,
            step_index=step_index,
            unit_id=unit_id,
        )
    except (KeyError, IndexError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/unit-stats")
def unit_stats() -> dict[str, object]:
    return build_unit_stats_payload()


@app.get("/api/map-editor/config")
def map_editor_config() -> dict[str, object]:
    return _build_map_editor_config()


@app.get("/api/maps")
def list_maps() -> list[dict[str, object]]:
    return _list_saved_maps()


@app.get("/api/maps/{file_name}")
def load_map(file_name: str) -> dict[str, object]:
    try:
        sanitized = _sanitize_map_file_name(file_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    path = MAPS_DIR / sanitized
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Unknown map: {sanitized}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Invalid map JSON: {sanitized}") from exc
    normalized = _normalize_editor_map(payload)
    normalized["file_name"] = sanitized
    return normalized


@app.post("/api/maps/save")
def save_map(payload: dict[str, object] = Body(...)) -> dict[str, object]:
    try:
        file_name = _sanitize_map_file_name(str(payload.get("file_name", "")))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    normalized = _normalize_editor_map(dict(payload.get("map") or {}))
    MAPS_DIR.mkdir(parents=True, exist_ok=True)
    path = MAPS_DIR / file_name
    path.write_text(json.dumps(normalized, indent=2) + "\n", encoding="utf-8")
    normalized["file_name"] = file_name
    return normalized


@app.get("/gui-status", response_model=None)
def gui_status() -> Response:
    if WEB_DIST.exists():
        return JSONResponse({"status": "ok", "mode": "dist", "path": str(WEB_DIST)})
    if WEB_APP.exists():
        return JSONResponse({"status": "ok", "mode": "static-webgui", "path": str(WEB_APP)})
    return JSONResponse({"status": "missing"})


@app.get("/", response_class=HTMLResponse)
def landing() -> str:
    return LANDING_PAGE


@app.get("/scenario-inspector", include_in_schema=False)
def scenario_inspector_redirect() -> Response:
    return RedirectResponse(url="/scenario-inspector/")


@app.get("/scenario-inspector/", include_in_schema=False)
def scenario_inspector_index() -> Response:
    base_dir = WEB_DIST if WEB_DIST.exists() else WEB_APP
    return FileResponse(base_dir / "index.html")


@app.get("/scenario-inspector/app.jsx", include_in_schema=False)
def scenario_inspector_app() -> Response:
    return FileResponse(WEB_APP / "app.jsx")


@app.get("/units-stats", include_in_schema=False)
def unit_stats_redirect() -> Response:
    return RedirectResponse(url="/units-stats/")


@app.get("/units-stats/", include_in_schema=False)
def unit_stats_index() -> Response:
    return FileResponse(WEB_APP / "units-stats.html")


@app.get("/units-stats/units-stats.jsx", include_in_schema=False)
def unit_stats_app() -> Response:
    return FileResponse(WEB_APP / "units-stats.jsx")


@app.get("/game-state-editor", include_in_schema=False)
def game_state_editor_redirect() -> Response:
    return RedirectResponse(url="/game-state-editor/")


@app.get("/game-state-editor/", include_in_schema=False)
def game_state_editor_index() -> Response:
    return FileResponse(WEB_APP / "game-state-editor.html")


@app.get("/game-state-editor/game-state-editor.jsx", include_in_schema=False)
def game_state_editor_app() -> Response:
    return FileResponse(WEB_APP / "game-state-editor.jsx")


if WEB_DIST.exists():
    app.mount("/scenario-inspector/assets", StaticFiles(directory=WEB_DIST / "assets"), name="webgui-assets")
else:
    app.mount("/scenario-inspector/public", StaticFiles(directory=WEB_APP / "public"), name="webgui-public")
    app.mount("/scenario-inspector/src", StaticFiles(directory=WEB_APP / "src"), name="webgui-src")
    app.mount("/scenario-inspector/vendor", StaticFiles(directory=WEB_APP / "vendor"), name="webgui-vendor")
    app.mount("/units-stats/public", StaticFiles(directory=WEB_APP / "public"), name="units-stats-public")
    app.mount("/units-stats/src", StaticFiles(directory=WEB_APP / "src"), name="units-stats-src")
    app.mount("/units-stats/vendor", StaticFiles(directory=WEB_APP / "vendor"), name="units-stats-vendor")
    app.mount("/game-state-editor/public", StaticFiles(directory=WEB_APP / "public"), name="game-state-editor-public")
    app.mount("/game-state-editor/src", StaticFiles(directory=WEB_APP / "src"), name="game-state-editor-src")
    app.mount("/game-state-editor/vendor", StaticFiles(directory=WEB_APP / "vendor"), name="game-state-editor-vendor")


def main() -> None:
    import uvicorn

    uvicorn.run("uniwarbot.gui_api:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
