from __future__ import annotations

import json
import math
import random
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
    compute_state_changes,
    compute_possible_moves_at_step,
    list_scenario_summaries,
    load_scenario_by_id,
)
from .state import (
    GameMap,
    GameState,
    HexCoord,
    MapMetadata,
    PlayerState,
    TileState,
    UnitState,
    UnitStatusState,
    build_default_unit_action_state,
    load_game_dictionary,
)


WEB_DIST = ROOT / "webgui" / "dist"
WEB_APP = ROOT / "webgui"
MAPS_DIR = ROOT / "maps"
SAVED_GAMES_DIR = ROOT / "saved_games"
EDITOR_FACTIONS = ["sapiens", "khraleans", "titans"]
FRONTEND_SHELL_VERSION = "20260514a"
UNIT_FACTION_VARIANT_GROUPS: tuple[dict[str, str], ...] = (
    {"sapiens": "marine", "khraleans": "underling", "titans": "mecha"},
    {"sapiens": "engineer", "khraleans": "infector", "titans": "assimilator"},
    {"sapiens": "mecha_ii", "khraleans": "infected_marine", "titans": "cyber_underling"},
    {"sapiens": "marauder", "khraleans": "swarmer", "titans": "speeder"},
    {"sapiens": "bopper", "khraleans": "borfly", "titans": "guardian"},
    {"sapiens": "tank", "khraleans": "pinzer", "titans": "plasma_tank"},
    {"sapiens": "helicopter", "khraleans": "garuda", "titans": "eclipse"},
    {"sapiens": "battery", "khraleans": "wyrm", "titans": "walker"},
    {"sapiens": "destroyer", "khraleans": "leviathan", "titans": "hydronaut"},
    {"sapiens": "fuze", "khraleans": "salamander", "titans": "mantisse"},
    {"sapiens": "submarine", "khraleans": "kraken", "titans": "skimmer"},
)
UNIT_TO_FACTION_GROUP_INDEX = {
    unit_id: index
    for index, group in enumerate(UNIT_FACTION_VARIANT_GROUPS)
    for unit_id in group.values()
}

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
        color: #e2e8f0;
        background: #0b1727;
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100vh;
        background: linear-gradient(180deg, #0b1727 0%, #132238 100%);
      }
      body {
        display: flex;
        flex-direction: column;
      }
      .shell {
        min-height: 100vh;
        width: 100%;
        display: flex;
        flex-direction: column;
      }
      .tabbar {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        padding: 14px 12px 10px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.16);
        background: rgba(11, 23, 39, 0.92);
        backdrop-filter: blur(10px);
      }
      .tabs {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        gap: 10px;
      }
      .tab {
        appearance: none;
        border: 1px solid rgba(148, 163, 184, 0.26);
        background: rgba(15, 23, 42, 0.55);
        color: #cbd5e1;
        border-radius: 14px;
        padding: 12px 14px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        text-align: left;
      }
      .tab.active {
        background: #f8fafc;
        color: #0f172a;
        border-color: #f8fafc;
      }
      .viewport {
        flex: 1;
        min-height: 0;
        padding: 12px;
      }
      iframe {
        width: 100%;
        height: calc(100vh - 77px);
        border: none;
        border-radius: 18px;
        background: white;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.24);
      }
      @media (max-width: 900px) {
        .tabs {
          gap: 8px;
        }
        iframe {
          height: calc(100vh - 132px);
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="tabbar">
        <div class="tabs" id="tabs"></div>
      </div>
      <div class="viewport">
        <iframe id="content-frame" title="UniwarBot workspace"></iframe>
      </div>
    </div>
    <script>
      const TABS = [
        { id: "scenario-inspector", label: "Scenario Inspector", src: "/scenario-inspector/?v=__FRONTEND_VERSION__" },
        { id: "units-stats", label: "Units Stats", src: "/units-stats/?v=__FRONTEND_VERSION__" },
        { id: "game-state-editor", label: "Game State Editor", src: "/game-state-editor/?v=__FRONTEND_VERSION__" },
        { id: "play-game", label: "Play Game", src: "/play-game/?v=__FRONTEND_VERSION__" },
      ];

      const tabsRoot = document.getElementById("tabs");
      const frame = document.getElementById("content-frame");

      function currentTabId() {
        const params = new URLSearchParams(window.location.search);
        const requested = params.get("tab");
        return TABS.some((item) => item.id === requested) ? requested : TABS[0].id;
      }

      function renderTabs(activeId) {
        tabsRoot.innerHTML = "";
        TABS.forEach((item) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = item.id === activeId ? "tab active" : "tab";
          button.textContent = item.label;
          button.addEventListener("click", () => {
            const url = new URL(window.location.href);
            url.searchParams.set("tab", item.id);
            window.history.replaceState({}, "", url);
            activate(item.id);
          });
          tabsRoot.appendChild(button);
        });
      }

      function activate(tabId) {
        const tab = TABS.find((item) => item.id === tabId) || TABS[0];
        renderTabs(tab.id);
        if (frame.getAttribute("src") !== tab.src) {
          frame.setAttribute("src", tab.src);
        }
      }

      activate(currentTabId());
      window.addEventListener("popstate", () => activate(currentTabId()));
    </script>
  </body>
</html>
""".replace("__FRONTEND_VERSION__", FRONTEND_SHELL_VERSION)

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


NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


def _html_page_response(content: str) -> HTMLResponse:
    return HTMLResponse(content=content, headers=NO_CACHE_HEADERS)


def _file_page_response(path: Path) -> FileResponse:
    return FileResponse(path, headers=NO_CACHE_HEADERS)


def _suggest_city_income(base_income: int) -> int:
    return int(math.ceil((int(base_income) / 2) / 5.0) * 5)


def _normalize_optional_int32(value: object) -> int | None:
    if value in {None, ""}:
        return None
    normalized = int(value)
    return max(-(2**31), min((2**31) - 1, normalized))


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
    start_random_seed = _normalize_optional_int32(payload.get("start_random_seed"))

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
        "start_random_seed": start_random_seed,
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
            "start_random_seed": None,
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


def _list_saved_games() -> list[dict[str, object]]:
    SAVED_GAMES_DIR.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, object]] = []
    for path in sorted(SAVED_GAMES_DIR.glob("*.json")):
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


def _random_int32() -> int:
    return random.SystemRandom().randint(-(2**31), (2**31) - 1)


def _parse_hex_coord(value: object, *, field_name: str = "coord") -> HexCoord:
    if isinstance(value, dict):
        return HexCoord(q=int(value["q"]), r=int(value["r"]))
    if isinstance(value, str):
        q_text, r_text = value.split(":")
        return HexCoord(q=int(q_text), r=int(r_text))
    raise ValueError(f"Invalid {field_name}")


def build_game_state_from_map(
    map_payload: dict[str, object],
    *,
    player_factions: dict[str, str] | None = None,
    seed_override: object = None,
) -> GameState:
    normalized = _normalize_editor_map(map_payload)
    player_entries = list(normalized.get("players") or [])
    player_order = [str(player["player_id"]) for player in player_entries]
    if not player_order:
        raise ValueError("Map must contain at least one player")
    resolved_seed = (
        _normalize_optional_int32(seed_override)
        if seed_override not in {None, ""}
        else _normalize_optional_int32(normalized.get("start_random_seed"))
    )
    if resolved_seed is None:
        resolved_seed = _random_int32()
    size = dict(normalized.get("size") or {})
    game_map = GameMap(
        metadata=MapMetadata(
            map_id=str(normalized.get("map_id", "play-map")),
            name=str(normalized.get("name", "Play Map")),
            width=int(size.get("width", 0)) or None,
            height=int(size.get("height", 0)) or None,
            tags=["play-game"],
            notes=f"source-map:{normalized.get('file_name', '')}",
        )
    )
    for raw_tile in list(normalized.get("tiles") or []):
        coord = _parse_hex_coord(raw_tile.get("coord"), field_name="tile coord")
        game_map.add_tile(
            TileState(
                coord=coord,
                terrain_id=str(raw_tile.get("terrain_id", "plain")),
                owner_id=raw_tile.get("owner_id"),
                metadata={},
            )
        )

    economy = dict(normalized.get("economy") or {})
    state = GameState(
        ruleset_version="play-game-sim.v1",
        active_player_id=player_order[0],
        player_order=player_order,
        turn_number=1,
        round_number=1,
        current_rseed=int(resolved_seed),
        game_map=game_map,
        metadata={
            "income_per_base": int(economy.get("base_income", 100)),
            "income_per_city": int(economy.get("city_income", 50)),
            "source_map_id": str(normalized.get("map_id", "play-map")),
            "source_map_name": str(normalized.get("name", "Play Map")),
        },
    )

    resolved_factions = dict(player_factions or {})
    for raw_player in player_entries:
        player_id = str(raw_player["player_id"])
        allowed_factions = [
            str(item)
            for item in list(raw_player.get("allowed_factions") or EDITOR_FACTIONS)
            if str(item) in EDITOR_FACTIONS
        ]
        if not allowed_factions:
            allowed_factions = list(EDITOR_FACTIONS)
        selected_faction = str(resolved_factions.get(player_id, allowed_factions[0]))
        if selected_faction not in allowed_factions:
            raise ValueError(f"Faction {selected_faction!r} is not allowed for {player_id}")
        state.add_player(
            PlayerState(
                player_id=player_id,
                faction=selected_faction,
                credits=int(economy.get("starting_credits", 100)),
                team_id=None,
                defeated=False,
                has_ended_turn=False,
                metadata={"allowed_factions": allowed_factions},
            )
        )

    for raw_unit in list(normalized.get("units") or []):
        coord = _parse_hex_coord(raw_unit.get("position"), field_name="unit position")
        owner_id = str(raw_unit["owner_id"])
        owner_player = state.players.get(owner_id)
        target_faction = owner_player.faction if owner_player is not None else str(
            load_game_dictionary()["units"].get(str(raw_unit["unit_id"]), {}).get("faction", "")
        )
        mapped_unit_id = remap_unit_id_to_faction(str(raw_unit["unit_id"]), target_faction)
        status = _normalized_mapped_unit_status(
            mapped_unit_id,
            UnitStatusState.from_dict(dict(raw_unit.get("status") or {})),
        )
        unit = UnitState(
            instance_id=str(raw_unit["instance_id"]),
            unit_id=mapped_unit_id,
            owner_id=owner_id,
            position=coord,
            hp=int(raw_unit.get("hp", 10)),
            veterancy_level=int(raw_unit.get("veterancy_level", 0)),
            experience_points=int(raw_unit.get("experience_points", 0)),
            status=status,
            action=build_default_unit_action_state(mapped_unit_id),
            capture_target=None,
            metadata=dict(raw_unit.get("metadata", {})),
        )
        state.add_unit(unit)

    return state


def _build_new_game_state_from_map(
    map_payload: dict[str, object],
    *,
    player_factions: dict[str, str] | None = None,
    seed_override: object = None,
) -> GameState:
    return build_game_state_from_map(
        map_payload,
        player_factions=player_factions,
        seed_override=seed_override,
    )


def _play_state_payload(state: GameState) -> dict[str, object]:
    return state.to_dict()


def _load_state_from_payload(payload: dict[str, object]) -> GameState:
    return GameState.from_dict(dict(payload))


def remap_unit_id_to_faction(unit_id: str, target_faction: str) -> str:
    group_index = UNIT_TO_FACTION_GROUP_INDEX.get(unit_id)
    if group_index is None:
        return unit_id
    return UNIT_FACTION_VARIANT_GROUPS[group_index].get(target_faction, unit_id)


def _unit_has_ability(unit_id: str, ability_id: str) -> bool:
    unit_entry = load_game_dictionary()["units"].get(unit_id, {})
    return any(
        str(ability.get("id", "")) == ability_id
        for ability in list(unit_entry.get("abilities") or [])
        if isinstance(ability, dict)
    )


def _normalized_mapped_unit_status(
    mapped_unit_id: str,
    original_status: UnitStatusState,
) -> UnitStatusState:
    unit_entry = load_game_dictionary()["units"].get(mapped_unit_id, {})
    hidden_config = dict(unit_entry.get("hidden_mode") or {})
    allowed_hidden_mode = str(hidden_config.get("mode") or "")
    mapped_status = UnitStatusState.from_dict(original_status.to_dict())
    if mapped_status.hidden_mode is not None and mapped_status.hidden_mode.value != allowed_hidden_mode:
        mapped_status.hidden_mode = None
        mapped_status.buried_resurface_bonus = 0
        mapped_status.submerged_attack_penalty = 0
    if not _unit_has_ability(mapped_unit_id, "teleport"):
        mapped_status.teleport_disabled_rounds = 0
        mapped_status.teleport_lock_phase = None
        mapped_status.teleport_cooldown_rounds = 0
    mapped_status.ability_cooldowns = {
        str(key): int(value)
        for key, value in mapped_status.ability_cooldowns.items()
        if any(
            str(ability.get("id", "")) == str(key)
            for ability in list(unit_entry.get("abilities") or [])
            if isinstance(ability, dict)
        )
    }
    if str(unit_entry.get("faction", "")) == "titans" or mapped_unit_id in {"engineer", "submarine"}:
        mapped_status.plague_infected = False
    return mapped_status


def _apply_play_action(state: GameState, action: dict[str, object]) -> dict[str, object]:
    action_type = str(action.get("type", ""))
    result: dict[str, object] = {"type": action_type}
    if action_type == "move_unit":
        state.move_unit(
            str(action["unit_id"]),
            _parse_hex_coord(action["destination"], field_name="destination"),
            continue_as_atomic_attack=bool(action.get("continue_as_atomic_attack", False)),
        )
    elif action_type == "move_then_attack":
        state.move_unit(
            str(action["unit_id"]),
            _parse_hex_coord(action["destination"], field_name="destination"),
            continue_as_atomic_attack=True,
        )
        state.attack_unit(str(action["unit_id"]), str(action["defender_id"]))
    elif action_type == "attack_unit":
        state.attack_unit(str(action["attacker_id"]), str(action["defender_id"]))
    elif action_type == "bury_unit":
        state.bury_unit(str(action["unit_id"]))
    elif action_type == "resurface_unit":
        state.resurface_unit(
            str(action["unit_id"]),
            continue_as_atomic_attack=bool(action.get("continue_as_atomic_attack", False)),
        )
    elif action_type == "submerge_unit":
        state.submerge_unit(str(action["unit_id"]))
    elif action_type == "surface_unit":
        state.surface_unit(str(action["unit_id"]))
    elif action_type == "teleport_unit":
        state.teleport_unit(
            str(action["unit_id"]),
            _parse_hex_coord(action["destination"], field_name="destination"),
        )
    elif action_type == "heal_unit":
        state.heal_unit(str(action["unit_id"]))
    elif action_type == "begin_capture":
        unit = state.get_unit(str(action["unit_id"]))
        if unit is None:
            raise KeyError(f"Unknown unit_id: {action['unit_id']}")
        state.begin_capture(unit.instance_id, unit.position)
    elif action_type == "buy_unit":
        result["created_unit_id"] = state.buy_unit(
            _parse_hex_coord(action["tile_coord"], field_name="tile_coord"),
            str(action["unit_id"]),
        )
    elif action_type == "use_plague":
        state.use_plague(str(action["unit_id"]), str(action["target_id"]))
    elif action_type == "use_emp":
        result["affected_unit_ids"] = state.use_emp(str(action["unit_id"]))
    elif action_type == "use_uv":
        result["affected_unit_ids"] = state.use_uv(str(action["unit_id"]))
    elif action_type == "transform_unit":
        result["created_unit_id"] = state.transform_unit(
            str(action["unit_id"]),
            str(action["target_id"]),
            ability_id=str(action["ability_id"]),
        )
    elif action_type == "end_turn":
        result["next_player_id"] = state.end_turn()
    else:
        raise ValueError(f"Unsupported play action type: {action_type}")
    return result


def _play_options_for_selection(
    state: GameState,
    *,
    selected_unit_id: str | None = None,
    selected_tile: HexCoord | None = None,
) -> dict[str, object]:
    options: dict[str, object] = {
        "selected_unit_id": selected_unit_id,
        "selected_tile": None if selected_tile is None else selected_tile.to_dict(),
        "possible_moves": None,
        "special_options": None,
        "buyable_units": [],
    }
    if selected_unit_id:
        options["possible_moves"] = state.get_possible_moves(selected_unit_id)
        options["special_options"] = state.get_current_special_options(selected_unit_id)
    if selected_tile is not None:
        options["buyable_units"] = state.get_buyable_units_for_tile(selected_tile)
    return options


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


@app.get("/api/saved-games")
def list_saved_games() -> list[dict[str, object]]:
    return _list_saved_games()


def _delete_saved_game_by_name(file_name: str) -> dict[str, object]:
    try:
        sanitized = _sanitize_map_file_name(file_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    path = SAVED_GAMES_DIR / sanitized
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Unknown saved game: {sanitized}")
    path.unlink()
    return {"deleted": True, "file_name": sanitized}


def _normalize_saved_game_history(
    history_payload: object,
    fallback_state_payload: dict[str, object],
) -> tuple[list[dict[str, object]], int]:
    normalized_history: list[dict[str, object]] = []
    if isinstance(history_payload, list):
        for entry in history_payload:
            if not isinstance(entry, dict):
                continue
            raw_state = entry.get("state")
            if not isinstance(raw_state, dict):
                continue
            state = _load_state_from_payload(raw_state)
            normalized_history.append(
                {
                    "state": _play_state_payload(state),
                    "label": str(entry.get("label", "")),
                }
            )
    if not normalized_history:
        fallback_state = _load_state_from_payload(fallback_state_payload)
        normalized_history = [{"state": _play_state_payload(fallback_state), "label": "load_game"}]
    return normalized_history, len(normalized_history) - 1


@app.post("/api/saved-games/save")
def save_saved_game(payload: dict[str, object] = Body(...)) -> dict[str, object]:
    try:
        file_name = _sanitize_map_file_name(str(payload.get("file_name", "")))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    state = _load_state_from_payload(dict(payload.get("state") or {}))
    normalized_history, default_index = _normalize_saved_game_history(
        payload.get("history"),
        _play_state_payload(state),
    )
    try:
        history_index = int(payload.get("history_index", default_index))
    except (TypeError, ValueError):
        history_index = default_index
    history_index = max(0, min(history_index, len(normalized_history) - 1))
    SAVED_GAMES_DIR.mkdir(parents=True, exist_ok=True)
    wrapper = {
        "schema_version": "play-game-save-v2",
        "name": str(payload.get("name", file_name.removesuffix(".json"))),
        "state": _play_state_payload(state),
        "history": normalized_history,
        "history_index": history_index,
    }
    path = SAVED_GAMES_DIR / file_name
    path.write_text(json.dumps(wrapper, indent=2) + "\n", encoding="utf-8")
    return {
        "file_name": file_name,
        "name": wrapper["name"],
        "state": wrapper["state"],
        "history": wrapper["history"],
        "history_index": wrapper["history_index"],
    }


@app.post("/api/saved-games/delete-file")
def delete_saved_game_post(payload: dict[str, object] = Body(...)) -> dict[str, object]:
    file_name = str(payload.get("file_name", ""))
    return _delete_saved_game_by_name(file_name)


@app.get("/api/saved-games/{file_name}")
def load_saved_game(file_name: str) -> dict[str, object]:
    try:
        sanitized = _sanitize_map_file_name(file_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    path = SAVED_GAMES_DIR / sanitized
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Unknown saved game: {sanitized}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    state_payload = dict(payload.get("state") or payload)
    state = _load_state_from_payload(state_payload)
    normalized_history, default_index = _normalize_saved_game_history(
        payload.get("history"),
        state_payload,
    )
    try:
        history_index = int(payload.get("history_index", default_index))
    except (TypeError, ValueError):
        history_index = default_index
    history_index = max(0, min(history_index, len(normalized_history) - 1))
    return {
        "file_name": sanitized,
        "name": str(payload.get("name", sanitized.removesuffix(".json"))),
        "state": _play_state_payload(state),
        "history": normalized_history,
        "history_index": history_index,
    }


@app.delete("/api/saved-games/{file_name}")
def delete_saved_game(file_name: str) -> dict[str, object]:
    return _delete_saved_game_by_name(file_name)


@app.get("/api/play-game/config")
def play_game_config() -> dict[str, object]:
    config = _build_map_editor_config()
    return {
        "factions": list(EDITOR_FACTIONS),
        "maps": _list_saved_maps(),
        "saved_games": _list_saved_games(),
        "terrains": config["terrains"],
        "terrain_order": config["terrain_order"],
        "units": config["units"],
        "unit_order": config["unit_order"],
    }


@app.post("/api/play-game/new")
def play_game_new(payload: dict[str, object] = Body(...)) -> dict[str, object]:
    file_name = str(payload.get("map_file_name", ""))
    try:
        sanitized = _sanitize_map_file_name(file_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    path = MAPS_DIR / sanitized
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Unknown map: {sanitized}")
    map_payload = json.loads(path.read_text(encoding="utf-8"))
    state = _build_new_game_state_from_map(
        map_payload,
        player_factions={
            str(key): str(value)
            for key, value in dict(payload.get("player_factions") or {}).items()
        },
        seed_override=payload.get("seed_override"),
    )
    return {
        "map_file_name": sanitized,
        "state": _play_state_payload(state),
    }


@app.post("/api/play-game/options")
def play_game_options(payload: dict[str, object] = Body(...)) -> dict[str, object]:
    state = _load_state_from_payload(dict(payload.get("state") or {}))
    selected_unit_id = payload.get("selected_unit_id")
    selected_tile = payload.get("selected_tile")
    normalized_selected_unit_id = None if selected_unit_id in {None, ""} else str(selected_unit_id)
    normalized_selected_tile = (
        None
        if selected_tile is None or selected_tile == ""
        else _parse_hex_coord(selected_tile, field_name="selected_tile")
    )
    try:
        return _play_options_for_selection(
            state,
            selected_unit_id=normalized_selected_unit_id,
            selected_tile=normalized_selected_tile,
        )
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/play-game/apply")
def play_game_apply(payload: dict[str, object] = Body(...)) -> dict[str, object]:
    try:
        state = _load_state_from_payload(dict(payload.get("state") or {}))
        before = state.to_dict()
        result = _apply_play_action(state, dict(payload.get("action") or {}))
        after = state.to_dict()
        return {
            "state": after,
            "changes": compute_state_changes(before, after),
            "result": result,
        }
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/gui-status", response_model=None)
def gui_status() -> Response:
    if WEB_DIST.exists():
        return JSONResponse({"status": "ok", "mode": "dist", "path": str(WEB_DIST)})
    if WEB_APP.exists():
        return JSONResponse({"status": "ok", "mode": "static-webgui", "path": str(WEB_APP)})
    return JSONResponse({"status": "missing"})


@app.get("/", response_class=HTMLResponse)
def landing() -> str:
    return _html_page_response(LANDING_PAGE)


@app.get("/scenario-inspector", include_in_schema=False)
def scenario_inspector_redirect() -> Response:
    return RedirectResponse(url="/scenario-inspector/")


@app.get("/scenario-inspector/", include_in_schema=False)
def scenario_inspector_index() -> Response:
    base_dir = WEB_DIST if WEB_DIST.exists() else WEB_APP
    return _file_page_response(base_dir / "index.html")


@app.get("/scenario-inspector/app.jsx", include_in_schema=False)
def scenario_inspector_app() -> Response:
    return _file_page_response(WEB_APP / "app.jsx")


@app.get("/units-stats", include_in_schema=False)
def unit_stats_redirect() -> Response:
    return RedirectResponse(url="/units-stats/")


@app.get("/units-stats/", include_in_schema=False)
def unit_stats_index() -> Response:
    return _file_page_response(WEB_APP / "units-stats.html")


@app.get("/units-stats/units-stats.jsx", include_in_schema=False)
def unit_stats_app() -> Response:
    return _file_page_response(WEB_APP / "units-stats.jsx")


@app.get("/game-state-editor", include_in_schema=False)
def game_state_editor_redirect() -> Response:
    return RedirectResponse(url="/game-state-editor/")


@app.get("/game-state-editor/", include_in_schema=False)
def game_state_editor_index() -> Response:
    return _file_page_response(WEB_APP / "game-state-editor.html")


@app.get("/game-state-editor/game-state-editor.jsx", include_in_schema=False)
def game_state_editor_app() -> Response:
    return _file_page_response(WEB_APP / "game-state-editor.jsx")


@app.get("/play-game", include_in_schema=False)
def play_game_redirect() -> Response:
    return RedirectResponse(url="/play-game/")


@app.get("/play-game/", include_in_schema=False)
def play_game_index() -> Response:
    return _file_page_response(WEB_APP / "play-game.html")


@app.get("/play-game/play-game.jsx", include_in_schema=False)
def play_game_app() -> Response:
    return _file_page_response(WEB_APP / "play-game.jsx")


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
    app.mount("/play-game/public", StaticFiles(directory=WEB_APP / "public"), name="play-game-public")
    app.mount("/play-game/src", StaticFiles(directory=WEB_APP / "src"), name="play-game-src")
    app.mount("/play-game/vendor", StaticFiles(directory=WEB_APP / "vendor"), name="play-game-vendor")


def main() -> None:
    import uvicorn

    uvicorn.run("uniwarbot.gui_api:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
