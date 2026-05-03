const { useEffect, useMemo, useState } = React;

const BASE_HEX_SIZE = 32;
const API_BASE =
  window.location.port === "5173"
    ? `${window.location.protocol}//${window.location.hostname}:8000/api`
    : `${window.location.origin}/api`;
const TERRAIN_FALLBACKS = {
  plain: "#d7c7a1",
  base: "#d9c7ae",
  forest: "#6f8f5f",
  mountain: "#9da0a6",
  swamp: "#617e4b",
  desert: "#dbc38d",
  water: "#6bb4d6",
  ocean: "#2b6892",
  harbor: "#8bc4d9",
  medical: "#dce7d9",
  reef: "#55a5b1",
  road_water: "#a0bac3",
  road_land: "#c9bb9f",
  city: "#b8b0b4",
  chasm: "#6d5f57",
};

function coordKey(coord) {
  return `${coord.q}:${coord.r}`;
}

function clipPathId(coord) {
  return `tile-clip-${coord.q}-${coord.r}`;
}

function titleFromAction(action) {
  const type = String(action?.type ?? "action");
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

function axialToPixel(coord) {
  const x = BASE_HEX_SIZE * Math.sqrt(3) * (coord.q + coord.r / 2);
  const y = BASE_HEX_SIZE * 1.5 * coord.r;
  return { x, y };
}

function hexPoints(centerX, centerY, hexSize) {
  const points = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((60 * i) - 30) * (Math.PI / 180);
    const x = centerX + hexSize * Math.cos(angle);
    const y = centerY + hexSize * Math.sin(angle);
    points.push(`${x},${y}`);
  }
  return points.join(" ");
}

function pretty(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function terrainAsset(terrainId) {
  return `./public/gui-assets/terrains/${terrainId}.png`;
}

function unitAsset(unitId) {
  const mapped = unitId === "mecha_ii" ? "mecha_2" : unitId;
  return `./public/gui-assets/units/${mapped}.png`;
}

function scenarioGroupName(scenario) {
  return String(scenario?.suite_name ?? scenario?.name ?? "Scenario");
}

function scenarioCaseName(scenario) {
  return String(scenario?.case_name ?? scenario?.name ?? "Scenario");
}

function renderVeterancy(unit) {
  const level = Number(unit?.veterancy_level ?? 0);
  if (level <= 0) {
    return null;
  }
  return (
    <g className="veterancy-badge" transform="translate(-20,-4)">
      {Array.from({ length: Math.min(level, 2) }).map((_, index) => (
        <text key={index} className="veterancy-text" x="0" y={index * -8}>
          ^
        </text>
      ))}
    </g>
  );
}

function App() {
  const [scenarios, setScenarios] = useState([]);
  const [selectedGroupName, setSelectedGroupName] = useState("");
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [report, setReport] = useState(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState(-1);
  const [selectedTileKey, setSelectedTileKey] = useState(null);
  const [selectedUnitId, setSelectedUnitId] = useState(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(0.9);

  useEffect(() => {
    fetch(`${API_BASE}/scenarios`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load scenarios: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        setScenarios(payload);
        if (payload.length > 0) {
          setSelectedGroupName(scenarioGroupName(payload[0]));
          setSelectedScenarioId(payload[0].scenario_id);
        }
      })
      .catch((reason) => {
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
    fetch(`${API_BASE}/scenarios/${selectedScenarioId}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load scenario: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => setReport(payload))
      .catch((reason) => {
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

  const groupedScenarios = useMemo(() => {
    const groups = new Map();
    for (const scenario of filteredScenarios) {
      const groupName = scenarioGroupName(scenario);
      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }
      groups.get(groupName).push(scenario);
    }
    return Array.from(groups.entries())
      .map(([groupName, items]) => ({
        groupName,
        items: items.slice().sort((left, right) =>
          scenarioCaseName(left).localeCompare(scenarioCaseName(right)),
        ),
      }))
      .sort((left, right) => left.groupName.localeCompare(right.groupName));
  }, [filteredScenarios]);

  useEffect(() => {
    if (groupedScenarios.length === 0) {
      if (selectedGroupName !== "") {
        setSelectedGroupName("");
      }
      if (selectedScenarioId !== "") {
        setSelectedScenarioId("");
      }
      return;
    }
    const matchingGroup =
      groupedScenarios.find((group) => group.groupName === selectedGroupName) ?? groupedScenarios[0];
    if (matchingGroup.groupName !== selectedGroupName) {
      setSelectedGroupName(matchingGroup.groupName);
      return;
    }
    const selectedExists = matchingGroup.items.some((scenario) => scenario.scenario_id === selectedScenarioId);
    if (!selectedExists) {
      setSelectedScenarioId(matchingGroup.items[0].scenario_id);
    }
  }, [groupedScenarios, selectedGroupName, selectedScenarioId]);

  const selectedScenarioSummary =
    scenarios.find((scenario) => scenario.scenario_id === selectedScenarioId) ?? null;
  const selectedGroup =
    groupedScenarios.find((group) => group.groupName === selectedGroupName) ?? null;
  const selectedStep = report && selectedStepIndex >= 0 ? report.steps[selectedStepIndex] ?? null : null;
  const currentState =
    report == null ? null : selectedStep == null ? report.initial_state : selectedStep.after_state;
  const diffEntries = Object.entries(
    selectedStep == null ? report?.final_changes ?? {} : selectedStep.actual_changes,
  );

  const tiles = currentState?.game_map?.tiles ?? [];
  const units = currentState?.units ?? {};

  const tileByKey = useMemo(() => {
    const map = new Map();
    for (const tile of tiles) {
      map.set(coordKey(tile.coord), tile);
    }
    return map;
  }, [tiles]);

  const selectedTile = selectedTileKey ? tileByKey.get(selectedTileKey) ?? null : null;
  const selectedUnit = selectedUnitId ? units[selectedUnitId] ?? null : null;
  const selectedUnitGameId = selectedUnit ? String(selectedUnit.unit_id ?? selectedUnitId ?? "") : "";
  const selectedTileSurfaceUnit =
    selectedTile?.surface_unit_id != null ? units[selectedTile.surface_unit_id] ?? null : null;
  const selectedTileHiddenUnit =
    selectedTile?.hidden_unit_id != null ? units[selectedTile.hidden_unit_id] ?? null : null;
  const selectedUnitTile = useMemo(() => {
    if (!selectedUnitId) {
      return null;
    }
    for (const tile of tiles) {
      if (tile.surface_unit_id === selectedUnitId || tile.hidden_unit_id === selectedUnitId) {
        return tile;
      }
    }
    return null;
  }, [selectedUnitId, tiles]);
  const selectedUnitLayer =
    selectedUnitTile == null || selectedUnitId == null
      ? null
      : selectedUnitTile.hidden_unit_id === selectedUnitId
        ? "hidden"
        : "surface";

  const selectTileAndOccupant = (tile) => {
    const key = coordKey(tile.coord);
    const surfaceUnitId = tile.surface_unit_id ?? null;
    const hiddenUnitId = tile.hidden_unit_id ?? null;
    setSelectedTileKey(key);
    if (surfaceUnitId && hiddenUnitId) {
      if (selectedTileKey === key && selectedUnitId === surfaceUnitId) {
        setSelectedUnitId(hiddenUnitId);
        return;
      }
      setSelectedUnitId(surfaceUnitId);
      return;
    }
    if (surfaceUnitId) {
      setSelectedUnitId(surfaceUnitId);
      return;
    }
    if (hiddenUnitId) {
      setSelectedUnitId(hiddenUnitId);
      return;
    }
    setSelectedUnitId(null);
  };

  const clampZoom = (value) => Math.max(0.45, Math.min(2.2, value));
  const adjustZoom = (delta) => setZoom((current) => clampZoom(Number((current + delta).toFixed(2))));

  const boardBounds = useMemo(() => {
    if (tiles.length === 0) {
      return { minX: 0, minY: 0, width: 600, height: 420 };
    }
    const centers = tiles.map((tile) => axialToPixel(tile.coord));
    const minX = Math.min(...centers.map((center) => center.x)) - BASE_HEX_SIZE - 34;
    const maxX = Math.max(...centers.map((center) => center.x)) + BASE_HEX_SIZE + 34;
    const minY = Math.min(...centers.map((center) => center.y)) - BASE_HEX_SIZE - 34;
    const maxY = Math.max(...centers.map((center) => center.y)) + BASE_HEX_SIZE + 34;
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }, [tiles]);

  const zoomedViewBox = useMemo(() => {
    const centerX = boardBounds.minX + boardBounds.width / 2;
    const centerY = boardBounds.minY + boardBounds.height / 2;
    const width = boardBounds.width / zoom;
    const height = boardBounds.height / zoom;
    return {
      minX: centerX - width / 2,
      minY: centerY - height / 2,
      width,
      height,
    };
  }, [boardBounds, zoom]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>UniwarBot Scenario Inspector</h1>
          <p>Choose a UT scenario, step actions, and inspect the rendered board, units, and state changes.</p>
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
        <section className="panel panel-controls">
          <div className="panel-header">
            <h2>Scenario</h2>
            <p className="panel-copy">Use the dropdown to pick a UT case. The board and diff update immediately.</p>
          </div>

          <div className="control-stack">
            <label className="field-label" htmlFor="scenario-filter">
              Filter
            </label>
            <input
              id="scenario-filter"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Type part of a scenario name"
            />

            <label className="field-label" htmlFor="scenario-select">
              Group
            </label>
            <select
              id="scenario-group-select"
              value={selectedGroupName}
              onChange={(event) => {
                const nextGroupName = event.target.value;
                setSelectedGroupName(nextGroupName);
                const nextGroup = groupedScenarios.find((group) => group.groupName === nextGroupName);
                if (nextGroup?.items?.length) {
                  setSelectedScenarioId(nextGroup.items[0].scenario_id);
                }
              }}
            >
              {groupedScenarios.map((group) => (
                <option key={group.groupName} value={group.groupName}>
                  {group.groupName}
                </option>
              ))}
            </select>

            <label className="field-label" htmlFor="scenario-select">
              Subgroup
            </label>
            <select
              id="scenario-select"
              value={selectedScenarioId}
              onChange={(event) => setSelectedScenarioId(event.target.value)}
            >
              {(selectedGroup?.items ?? []).map((scenario) => (
                <option key={scenario.scenario_id} value={scenario.scenario_id}>
                  {scenarioCaseName(scenario)}
                </option>
              ))}
            </select>

            <div className="summary-card">
              <span className="summary-label">Fixture</span>
              <strong>{selectedScenarioSummary?.relative_file ?? "-"}</strong>
              <span className="summary-label">Actions</span>
              <strong>{selectedScenarioSummary?.action_count ?? 0}</strong>
            </div>

            <div className="summary-card">
              <span className="summary-label">Selected Case</span>
              <strong>{selectedScenarioSummary ? scenarioCaseName(selectedScenarioSummary) : "-"}</strong>
              <span className="summary-label">Current View</span>
              <strong>{selectedStep ? titleFromAction(selectedStep.action) : "Initial state"}</strong>
            </div>
          </div>
        </section>

        <section className="panel panel-board">
          <div className="panel-header">
            <h2>{report?.name ?? "Scenario"}</h2>
            <div className="meta-line">
              <span>{report?.relative_file ?? ""}</span>
              <span>Active: {currentState?.active_player_id ?? "-"}</span>
              <span>Turn: {currentState?.turn_number ?? "-"}</span>
              <span>Round: {currentState?.round_number ?? "-"}</span>
              <span>Seed: {currentState?.current_rseed ?? "-"}</span>
            </div>
          </div>

          <div className="step-strip">
            <div className="zoom-controls">
              <button className="zoom-chip" onClick={() => adjustZoom(-0.15)} title="Zoom out">
                -
              </button>
              <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
              <button className="zoom-chip" onClick={() => adjustZoom(0.15)} title="Zoom in">
                +
              </button>
              <button className="zoom-chip" onClick={() => setZoom(0.9)} title="Reset zoom">
                Reset
              </button>
            </div>
            <button
              className={`step-chip ${selectedStepIndex < 0 ? "selected" : ""}`}
              onClick={() => setSelectedStepIndex(-1)}
            >
              Initial
            </button>
            {report?.steps?.map((step, index) => (
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
            <div
              className="board-viewport"
              onWheel={(event) => {
                event.preventDefault();
                adjustZoom(event.deltaY < 0 ? 0.08 : -0.08);
              }}
            >
            <svg
              className="board-svg"
              viewBox={`${zoomedViewBox.minX} ${zoomedViewBox.minY} ${zoomedViewBox.width} ${zoomedViewBox.height}`}
            >
              <defs>
                {tiles.map((tile) => {
                  return (
                    <clipPath id={clipPathId(tile.coord)} key={clipPathId(tile.coord)} clipPathUnits="userSpaceOnUse">
                      <polygon points={hexPoints(0, 0, BASE_HEX_SIZE)} />
                    </clipPath>
                  );
                })}
              </defs>
              {tiles.map((tile) => {
                const center = axialToPixel(tile.coord);
                const surfaceUnitId = tile.surface_unit_id;
                const hiddenUnitId = tile.hidden_unit_id;
                const surfaceUnit = surfaceUnitId ? units[surfaceUnitId] : null;
                const hiddenUnit = hiddenUnitId ? units[hiddenUnitId] : null;
                const key = coordKey(tile.coord);
                return (
                  <g
                    key={key}
                    className="hex-group"
                    onClick={() => selectTileAndOccupant(tile)}
                    transform={`translate(${center.x}, ${center.y})`}
                  >
                    <polygon
                      points={hexPoints(0, 0, BASE_HEX_SIZE)}
                      fill={TERRAIN_FALLBACKS[tile.terrain_id] ?? "#d8d8d8"}
                      stroke="#22304a"
                      strokeWidth="2"
                    />
                    <image
                      href={terrainAsset(tile.terrain_id)}
                      x={-34}
                      y={-34}
                      width={68}
                      height={68}
                      clipPath={`url(#${clipPathId(tile.coord)})`}
                      preserveAspectRatio="xMidYMid meet"
                    />

                    {tile.owner_id ? (
                      <g transform="translate(26,-28)">
                        <circle r="10" className={`owner-disc owner-${tile.owner_id}`} />
                        <text className="owner-text" x="0" y="1">
                          {tile.owner_id.toUpperCase()}
                        </text>
                      </g>
                    ) : null}

                    <text className="coord-label" x="0" y="22">
                      {key}
                    </text>

                    {surfaceUnitId && surfaceUnit ? (
                      <g
                        className="unit-token"
                        transform="translate(0,-2)"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setSelectedTileKey(key);
                          setSelectedUnitId(surfaceUnitId);
                        }}
                      >
                        <image
                          className="unit-sprite"
                          href={unitAsset(String(surfaceUnit.unit_id ?? ""))}
                          x={-23}
                          y={-18}
                          width={46}
                          height={36}
                          draggable="false"
                          preserveAspectRatio="xMidYMid slice"
                        />
                        {renderVeterancy(surfaceUnit)}
                        <g transform="translate(18,13)">
                          <text className="hp-text" x="0" y="1">
                            {String(surfaceUnit.hp)}
                          </text>
                        </g>
                      </g>
                    ) : null}

                    {hiddenUnitId && hiddenUnit ? (
                      <g
                        className="unit-token"
                        transform="translate(0,34)"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setSelectedTileKey(key);
                          setSelectedUnitId(hiddenUnitId);
                        }}
                      >
                        <ellipse className="hidden-ring" cx="0" cy="0" rx="25" ry="19" />
                        <image
                          className="unit-sprite hidden"
                          href={unitAsset(String(hiddenUnit.unit_id ?? ""))}
                          x={-23}
                          y={-18}
                          width={46}
                          height={36}
                          draggable="false"
                          preserveAspectRatio="xMidYMid slice"
                          opacity="0.82"
                        />
                        {renderVeterancy(hiddenUnit)}
                        <g transform="translate(-17,-12)">
                          <rect className="hidden-flag" x="-7" y="-7" width="14" height="14" rx="4" />
                          <text className="hidden-flag-text" x="0" y="1">
                            H
                          </text>
                        </g>
                        <g transform="translate(18,13)">
                          <text className="hp-text" x="0" y="1">
                            {String(hiddenUnit.hp)}
                          </text>
                        </g>
                      </g>
                    ) : null}
                  </g>
                );
              })}
              {selectedTile ? (
                <g
                  className="selected-hex-overlay"
                  transform={`translate(${axialToPixel(selectedTile.coord).x}, ${axialToPixel(selectedTile.coord).y})`}
                >
                  <polygon points={hexPoints(0, 0, BASE_HEX_SIZE)} fill="none" strokeWidth="5" />
                </g>
              ) : null}
            </svg>
            </div>
          </div>
        </section>

        <section className="panel panel-detail">
          <div className="detail-stack">
            <div className="detail-card">
              <h2>Action</h2>
              <pre>{pretty(selectedStep?.action ?? null)}</pre>
              {selectedStep ? <pre>{pretty(selectedStep.result ?? null)}</pre> : null}
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
              {selectedTile ? (
                <>
                  <div className="visual-inspector">
                    <img
                      className="terrain-inspector-sprite"
                      src={terrainAsset(selectedTile.terrain_id)}
                      alt={selectedTile.terrain_id}
                    />
                    <div className="visual-copy">
                      <strong>{selectedTile.terrain_id}</strong>
                      <span>{selectedTile.owner_id ? `Owner: ${selectedTile.owner_id}` : "Neutral terrain"}</span>
                    </div>
                  </div>
                  <div className="occupant-card">
                    <span className="summary-label">Occupants</span>
                    <div className="occupant-list">
                      <button
                        className={`occupant-chip ${selectedTileSurfaceUnit ? "" : "empty"} ${
                          selectedUnitId != null && selectedTile?.surface_unit_id === selectedUnitId ? "selected" : ""
                        }`}
                        disabled={!selectedTileSurfaceUnit}
                        onClick={() => setSelectedUnitId(selectedTile?.surface_unit_id ?? null)}
                      >
                        {selectedTileSurfaceUnit
                          ? `Surface: ${String(selectedTileSurfaceUnit.unit_id ?? selectedTile.surface_unit_id)}`
                          : "Surface: empty"}
                      </button>
                      <button
                        className={`occupant-chip ${selectedTileHiddenUnit ? "" : "empty"} ${
                          selectedUnitId != null && selectedTile?.hidden_unit_id === selectedUnitId ? "selected" : ""
                        }`}
                        disabled={!selectedTileHiddenUnit}
                        onClick={() => setSelectedUnitId(selectedTile?.hidden_unit_id ?? null)}
                      >
                        {selectedTileHiddenUnit
                          ? `Hidden: ${String(selectedTileHiddenUnit.unit_id ?? selectedTile.hidden_unit_id)}`
                          : "Hidden: empty"}
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
              <pre>{pretty(selectedTile ?? null)}</pre>
            </div>

            <div className="detail-card">
              <h2>Unit Inspector</h2>
              {selectedUnit ? (
                <div className="visual-inspector">
                  <img className="unit-inspector-icon" src={unitAsset(selectedUnitGameId)} alt={selectedUnitGameId} />
                  <div className="visual-copy">
                    <strong>{selectedUnitGameId}</strong>
                    <span>Owner: {String(selectedUnit.owner_id ?? "-")}</span>
                    <span>HP: {String(selectedUnit.hp ?? "-")}</span>
                    <span>
                      Layer: {selectedUnitLayer ?? "unknown"}
                      {selectedUnit?.status?.hidden_mode ? ` (${String(selectedUnit.status.hidden_mode)})` : ""}
                    </span>
                  </div>
                </div>
              ) : null}
              <pre>{pretty(selectedUnit ?? null)}</pre>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
