from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from .scenario_inspector import ROOT, build_scenario_report, list_scenario_summaries, load_scenario_by_id


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
      a {
        display: inline-block;
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
    <a href="/scenario-inspector/">Scenario Inspector</a>
  </body>
</html>
"""

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


if WEB_DIST.exists():
    app.mount("/scenario-inspector/assets", StaticFiles(directory=WEB_DIST / "assets"), name="webgui-assets")
else:
    app.mount("/scenario-inspector/public", StaticFiles(directory=WEB_APP / "public"), name="webgui-public")
    app.mount("/scenario-inspector/src", StaticFiles(directory=WEB_APP / "src"), name="webgui-src")
    app.mount("/scenario-inspector/vendor", StaticFiles(directory=WEB_APP / "vendor"), name="webgui-vendor")


def main() -> None:
    import uvicorn

    uvicorn.run("uniwarbot.gui_api:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
