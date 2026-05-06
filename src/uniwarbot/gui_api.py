from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
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


if WEB_DIST.exists():
    app.mount("/scenario-inspector/assets", StaticFiles(directory=WEB_DIST / "assets"), name="webgui-assets")
else:
    app.mount("/scenario-inspector/public", StaticFiles(directory=WEB_APP / "public"), name="webgui-public")
    app.mount("/scenario-inspector/src", StaticFiles(directory=WEB_APP / "src"), name="webgui-src")
    app.mount("/scenario-inspector/vendor", StaticFiles(directory=WEB_APP / "vendor"), name="webgui-vendor")
    app.mount("/units-stats/public", StaticFiles(directory=WEB_APP / "public"), name="units-stats-public")
    app.mount("/units-stats/src", StaticFiles(directory=WEB_APP / "src"), name="units-stats-src")
    app.mount("/units-stats/vendor", StaticFiles(directory=WEB_APP / "vendor"), name="units-stats-vendor")


def main() -> None:
    import uvicorn

    uvicorn.run("uniwarbot.gui_api:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
