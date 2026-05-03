from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .scenario_inspector import ROOT, build_scenario_report, list_scenario_summaries, load_scenario_by_id


WEB_DIST = ROOT / "webgui" / "dist"
WEB_APP = ROOT / "webgui"

app = FastAPI(
    title="UniwarBot Scenario Inspector API",
    version="0.1.0",
    description="Local API for browsing UniwarBot scenario fixtures and state transitions.",
)

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


if WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="webgui")
elif WEB_APP.exists():
    app.mount("/", StaticFiles(directory=WEB_APP, html=True), name="webgui")


def main() -> None:
    import uvicorn

    uvicorn.run("uniwarbot.gui_api:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
