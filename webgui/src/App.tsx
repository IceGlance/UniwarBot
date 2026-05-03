import { useEffect, useMemo, useState } from "react";
import type { Coord, GameStateSnapshot, JsonValue, ScenarioReport, ScenarioStep, ScenarioSummary, TileState } from "./types";

const HEX_SIZE = 42;

const TERRAIN_COLORS: Record<string, string> = {
  plain: "#d7c7a1",
  base: "#f0d38a",
  forest: "#7ea36e",
  mountain: "#8b8f99",
  swamp: "#728f62",
  desert: "#dbc28a",
  water: "#7db4d8",
  ocean: "#4f8fb9",
  harbor: "#9cc9e3",
  medical: "#d8efe3",
  reef: "#6aa8a2",
  road_water: "#8ec0c7",
  road_land: "#c4b28f",
  city: "#c9b4b8",
  chasm: "#6f6578",
};

function coordKey(coord: Coord): string {
  return `${coord.q}:${coord.r}`;
}

function unitLabel(unitId: string): string {
  return unitId
    .split("_")
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3);
}

function titleFromAction(action: Record<string, JsonValue>): string {
  const type = String(action.type ?? "action");
  if (type === "attack_unit") {
    return `${type} ${String(action.attacker_id)} -> ${String(action.defender_id)}`;
  }
  if (type === "move_unit") {
    return `${type} ${String(action.unit_id)} -> ${String(action.destination)}`;
  }
  if (type === "assert_possible_moves") {
    return `${type} ${String(action.unit_id)}`;
  }
  return type;
}

function axialToPixel(coord: Coord): { x: number; y: number } {
  const x = HEX_SIZE * Math.sqrt(3) * (coord.q + coord.r / 2);
  const y = HEX_SIZE * 1.5 * coord.r;
  return { x, y };
}

function hexPoints(centerX: number, centerY: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((60 * i) - 30) * (Math.PI / 180);
    const x = centerX + HEX_SIZE * Math.cos(angle);
    const y = centerY + HEX_SIZE * Math.sin(angle);
    points.push(`${x},${y}`);
  }
  return points.join(" ");
}

function pretty(value: JsonValue | Record<string, JsonValue> | null | undefined): string {
  return JSON.stringify(value ?? null, null, 2);
}

function App() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>("");
  const [report, setReport] = useState<ScenarioReport | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number>(-1);
  const [selectedTileKey, setSelectedTileKey] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    void fetch("/api/scenarios")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load scenarios: ${response.status}`);
        }
        return (await response.json()) as ScenarioSummary[];
      })
      .then((payload) => {
        setScenarios(payload);
        if (payload.length > 0) {
          setSelectedScenarioId(payload[0].scenario_id);
        }
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    if (!selectedScenarioId) {
      return;
    }
    setError("");
    setReport(null);
    setSelectedStepIndex(-1);
    setSelectedTileKey(null);
    setSelectedUnitId(null);
    void fetch(`/api/scenarios/${selectedScenarioId}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load scenario: ${response.status}`);
        }
        return (await response.json()) as ScenarioReport;
      })
      .then((payload) => setReport(payload))
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [selectedScenarioId]);

  const filteredScenarios = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return scenarios;
    }
    return scenarios.filter((scenario) =>
      [scenario.name, scenario.relative_file, scenario.suite_name ?? "", scenario.case_name ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [scenarios, search]);

  const selectedStep: ScenarioStep | null =
    report && selectedStepIndex >= 0 ? report.steps[selectedStepIndex] ?? null : null;
  const currentState: GameStateSnapshot | null =
    report == null ? null : selectedStep == null ? report.initial_state : selectedStep.after_state;
  const diffEntries = Object.entries(
    selectedStep == null ? report?.final_changes ?? {} : selectedStep.actual_changes,
  );

  const tiles = currentState?.game_map.tiles ?? [];
  const units = (currentState?.units ?? {}) as Record<string, Record<string, JsonValue>>;
  const tileByKey = useMemo(() => {
    const map = new Map<string, TileState>();
    for (const tile of tiles) {
      map.set(coordKey(tile.coord), tile);
    }
    return map;
  }, [tiles]);

  const selectedTile = selectedTileKey ? tileByKey.get(selectedTileKey) ?? null : null;
  const selectedUnit = selectedUnitId ? units[selectedUnitId] ?? null : null;

  const boardBounds = useMemo(() => {
    if (tiles.length === 0) {
      return { minX: 0, minY: 0, width: 400, height: 300 };
    }
    const centers = tiles.map((tile) => axialToPixel(tile.coord));
    const minX = Math.min(...centers.map((center) => center.x)) - HEX_SIZE - 12;
    const maxX = Math.max(...centers.map((center) => center.x)) + HEX_SIZE + 12;
    const minY = Math.min(...centers.map((center) => center.y)) - HEX_SIZE - 12;
    const maxY = Math.max(...centers.map((center) => center.y)) + HEX_SIZE + 12;
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }, [tiles]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>UniwarBot Scenario Inspector</h1>
          <p>Browse JSON UTs, step actions, inspect state, and compare diffs.</p>
        </div>
        <div className="status-cards">
          <div className="status-card">
            <span>Scenarios</span>
            <strong>{scenarios.length}</strong>
          </div>
          <div className="status-card">
            <span>Selected Step</span>
            <strong>{selectedStepIndex < 0 ? "Initial" : `#${selectedStepIndex + 1}`}</strong>
          </div>
          <div className="status-card">
            <span>Diff Paths</span>
            <strong>{diffEntries.length}</strong>
          </div>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <main className="workspace-grid">
        <section className="panel panel-list">
          <div className="panel-header">
            <h2>Scenarios</h2>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter scenarios"
            />
          </div>
          <div className="scenario-list">
            {filteredScenarios.map((scenario) => (
              <button
                key={scenario.scenario_id}
                className={`scenario-item ${scenario.scenario_id === selectedScenarioId ? "selected" : ""}`}
                onClick={() => setSelectedScenarioId(scenario.scenario_id)}
              >
                <strong>{scenario.name}</strong>
                <span>{scenario.relative_file}</span>
                <span>{scenario.action_count} action(s)</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel panel-board">
          <div className="panel-header">
            <h2>{report?.name ?? "Scenario"}</h2>
            <div className="meta-line">
              <span>{report?.relative_file ?? ""}</span>
              <span>Active: {currentState?.active_player_id ?? "-"}</span>
              <span>Turn: {currentState?.turn_number ?? "-"}</span>
              <span>Seed: {currentState?.current_rseed ?? "-"}</span>
            </div>
          </div>

          <div className="step-strip">
            <button
              className={`step-chip ${selectedStepIndex < 0 ? "selected" : ""}`}
              onClick={() => setSelectedStepIndex(-1)}
            >
              Initial
            </button>
            {report?.steps.map((step, index) => (
              <button
                key={step.index}
                className={`step-chip ${selectedStepIndex === index ? "selected" : ""}`}
                onClick={() => setSelectedStepIndex(index)}
                title={titleFromAction(step.action)}
              >
                {step.index}. {String(step.action.type)}
              </button>
            ))}
          </div>

          <div className="board-card">
            <svg
              className="board-svg"
              viewBox={`${boardBounds.minX} ${boardBounds.minY} ${boardBounds.width} ${boardBounds.height}`}
            >
              {tiles.map((tile) => {
                const center = axialToPixel(tile.coord);
                const surfaceUnitId = tile.surface_unit_id;
                const hiddenUnitId = tile.hidden_unit_id;
                const surfaceUnit = surfaceUnitId ? units[surfaceUnitId] : null;
                const hiddenUnit = hiddenUnitId ? units[hiddenUnitId] : null;
                const key = coordKey(tile.coord);
                const isSelected = selectedTileKey === key;
                return (
                  <g
                    key={key}
                    className="hex-group"
                    onClick={() => setSelectedTileKey(key)}
                    transform={`translate(${center.x}, ${center.y})`}
                  >
                    <polygon
                      points={hexPoints(0, 0)}
                      fill={TERRAIN_COLORS[tile.terrain_id] ?? "#d8d8d8"}
                      stroke={isSelected ? "#091540" : "#3b4556"}
                      strokeWidth={isSelected ? 4 : 2}
                    />
                    <text className="terrain-label" x="0" y="-26">
                      {tile.terrain_id}
                    </text>
                    <text className="coord-label" x="0" y="-8">
                      {key}
                    </text>
                    {surfaceUnit ? (
                      <g onClick={() => setSelectedUnitId(surfaceUnitId)}>
                        <rect className="unit-badge unit-surface" x="-30" y="4" width="60" height="22" rx="6" />
                        <text className="unit-text" x="0" y="19">
                          {unitLabel(surfaceUnitId ?? "")} {String(surfaceUnit.hp)}
                        </text>
                      </g>
                    ) : null}
                    {hiddenUnit ? (
                      <g onClick={() => setSelectedUnitId(hiddenUnitId)}>
                        <rect className="unit-badge unit-hidden" x="-30" y="30" width="60" height="22" rx="6" />
                        <text className="unit-text" x="0" y="45">
                          {unitLabel(hiddenUnitId ?? "")} {String(hiddenUnit.hp)}
                        </text>
                      </g>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
        </section>

        <section className="panel panel-detail">
          <div className="detail-stack">
            <div className="detail-card">
              <h2>Action</h2>
              <pre>{pretty(selectedStep?.action ?? null)}</pre>
              {selectedStep ? <pre>{pretty(selectedStep.result as Record<string, JsonValue>)}</pre> : null}
            </div>

            <div className="detail-card">
              <h2>Changed Fields</h2>
              <div className="diff-list">
                {diffEntries.length === 0 ? (
                  <span className="muted">No changes for the selected view.</span>
                ) : (
                  diffEntries.map(([path, value]) => (
                    <div key={path} className="diff-row">
                      <code>{path}</code>
                      <pre>{pretty(value)}</pre>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="detail-card">
              <h2>Tile Inspector</h2>
              <pre>{pretty(selectedTile as unknown as Record<string, JsonValue> | null)}</pre>
            </div>

            <div className="detail-card">
              <h2>Unit Inspector</h2>
              <pre>{pretty(selectedUnit as Record<string, JsonValue> | null)}</pre>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
