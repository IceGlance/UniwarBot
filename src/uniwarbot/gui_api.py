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


def _suggest_city_income(base_income: int) -> int:
    return int(math.ceil((int(base_income) / 2) / 5.0) * 5)


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
    terrain_ids = set(load_game_dictionary()["terrains"].keys())
    terrain_map = load_game_dictionary()["terrains"]

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
    }


def _build_map_editor_config() -> dict[str, object]:
    game_dictionary = load_game_dictionary()
    terrains = game_dictionary["terrains"]
    terrain_order = [
        terrain_id for terrain_id in TERRAIN_DISPLAY_ORDER if terrain_id in terrains
    ] + [terrain_id for terrain_id in terrains if terrain_id not in TERRAIN_DISPLAY_ORDER]
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
