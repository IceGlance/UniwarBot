const { useEffect, useMemo, useRef, useState } = React;

const BASE_HEX_SIZE = 32;
const API_BASE =
  window.location.port === "5173"
    ? `${window.location.protocol}//${window.location.hostname}:8000/api`
    : `${window.location.origin}/api`;
const TERRAIN_FALLBACKS = {
  __void__: "#000000",
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

function compact(value) {
  return JSON.stringify(value ?? null);
}

function terrainAsset(terrainId) {
  if (terrainId === "__void__") {
    return null;
  }
  return `./public/gui-assets/terrains/${terrainId}.png`;
}

function unitAsset(unitId, ownerId) {
  const mapped = unitId === "mecha_ii" ? "mecha_2" : unitId;
  if (ownerId === "p1") {
    return `./public/gui-assets/units-red/${mapped}.png`;
  }
  if (ownerId === "p2") {
    return `./public/gui-assets/units-blue/${mapped}.png`;
  }
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

function unitStatusBadges(unit) {
  const badges = [];
  if (Boolean(unit?.status?.plague_infected)) {
    badges.push({ text: "P", className: "status-badge-plague" });
  }
  if (Number(unit?.status?.emp_disabled_rounds ?? 0) > 0) {
    badges.push({ text: "E", className: "status-badge-emp" });
  }
  return badges;
}

function renderStatusMarker(unit, transform) {
  const badges = unitStatusBadges(unit);
  if (badges.length === 0) {
    return null;
  }
  return (
    <g className="status-marker" transform={transform}>
      {badges.map((badge, index) => (
        <g key={`${badge.text}-${index}`} transform={`translate(${index * 18},0)`}>
          <rect className={`status-badge ${badge.className}`} x="-8" y="-6" width="16" height="12" rx="4" />
          <text className="status-badge-text" x="0" y="1">
            {badge.text}
          </text>
        </g>
      ))}
    </g>
  );
}

function isTeleportDisabled(unit) {
  return String(unit?.status?.teleport_lock_phase ?? "") !== "";
}

function renderTeleportDisabledLabel(unit, transform) {
  if (!isTeleportDisabled(unit)) {
    return null;
  }
  return (
    <g transform={transform} pointerEvents="none">
      <text
        x="0"
        y="0"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="9"
        fontWeight="900"
        fill="#f97316"
        stroke="rgba(255, 247, 237, 0.98)"
        strokeWidth="1.5"
        paintOrder="stroke"
        strokeLinejoin="round"
      >
        TD
      </text>
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
  const [possibleMoves, setPossibleMoves] = useState(null);
  const [possibleMovesError, setPossibleMovesError] = useState("");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(0.9);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanningBoard, setIsPanningBoard] = useState(false);
  const boardViewportRef = useRef(null);
  const boardSvgRef = useRef(null);
  const boardPanRef = useRef({
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    hasDragged: false,
  });
  const suppressBoardClickRef = useRef(false);

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
    setPanOffset({ x: 0, y: 0 });
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

  const groupedScenarios = useMemo(() => {
    const groups = new Map();
    for (const scenario of scenarios) {
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
  }, [scenarios]);

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
  const diffObject = selectedStep == null ? report?.final_changes ?? {} : selectedStep.actual_changes;

  const tiles = currentState?.game_map?.tiles ?? [];
  const units = currentState?.units ?? {};
  const displayTiles = useMemo(() => {
    if (tiles.length === 0) {
      return tiles;
    }
    const tileMap = new Map(tiles.map((tile) => [coordKey(tile.coord), tile]));
    const rows = new Map();
    for (const tile of tiles) {
      const row = rows.get(tile.coord.r) ?? [];
      row.push(tile.coord.q);
      rows.set(tile.coord.r, row);
    }
    const expanded = [];
    const sortedRows = Array.from(rows.keys()).sort((a, b) => a - b);
    for (const r of sortedRows) {
      const qs = rows.get(r) ?? [];
      const minQ = Math.min(...qs);
      const maxQ = Math.max(...qs);
      for (let q = minQ; q <= maxQ; q += 1) {
        const key = `${q}:${r}`;
        expanded.push(
          tileMap.get(key) ?? {
            coord: { q, r },
            terrain_id: "__void__",
            owner_id: null,
            surface_unit_id: null,
            hidden_unit_id: null,
            capture_state: null,
            metadata: { is_void: true },
          },
        );
      }
    }
    return expanded;
  }, [tiles]);
  const hiddenRenderItems = useMemo(
    () =>
      tiles
        .filter((tile) => tile.hidden_unit_id != null && units[tile.hidden_unit_id] != null)
        .map((tile) => ({
          tile,
          unitId: tile.hidden_unit_id,
          unit: units[tile.hidden_unit_id],
        })),
    [tiles, units],
  );

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

  const beginBoardPan = (event) => {
    if (event.button !== 0) {
      return;
    }
    const viewport = boardViewportRef.current;
    if (!viewport) {
      return;
    }
    boardPanRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: panOffset.x,
      startPanY: panOffset.y,
      hasDragged: false,
    };
    suppressBoardClickRef.current = false;
    setIsPanningBoard(true);
  };

  const moveBoardPan = (event) => {
    const viewport = boardViewportRef.current;
    const svg = boardSvgRef.current;
    const session = boardPanRef.current;
    if (!viewport || !svg || session.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - session.startClientX;
    const deltaY = event.clientY - session.startClientY;
    if (!session.hasDragged && Math.hypot(deltaX, deltaY) >= 4) {
      session.hasDragged = true;
      suppressBoardClickRef.current = true;
    }
    if (!session.hasDragged) {
      return;
    }
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    const worldDx = deltaX * (zoomedViewBox.width / width);
    const worldDy = deltaY * (zoomedViewBox.height / height);
    setPanOffset({
      x: session.startPanX - worldDx,
      y: session.startPanY - worldDy,
    });
  };

  const endBoardPan = (event) => {
    const session = boardPanRef.current;
    if (session.pointerId !== event.pointerId) {
      return;
    }
    boardPanRef.current = {
      pointerId: null,
      startClientX: 0,
      startClientY: 0,
      startPanX: 0,
      startPanY: 0,
      hasDragged: false,
    };
    setIsPanningBoard(false);
  };

  const suppressBoardClickIfNeeded = (event) => {
    if (!suppressBoardClickRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressBoardClickRef.current = false;
  };
  const selectedUnitLayer =
    selectedUnitTile == null || selectedUnitId == null
      ? null
      : selectedUnitTile.hidden_unit_id === selectedUnitId
        ? "hidden"
        : "surface";

  useEffect(() => {
    if (!report || !selectedUnit) {
      setPossibleMoves(null);
      setPossibleMovesError("");
      return;
    }
    if (String(selectedUnit.owner_id ?? "") !== String(currentState?.active_player_id ?? "")) {
      setPossibleMoves(null);
      setPossibleMovesError("");
      return;
    }
    const params = new URLSearchParams({
      unit_id: String(selectedUnitId),
      step_index: String(selectedStepIndex),
    });
    fetch(`${API_BASE}/scenarios/${report.scenario_id}/possible-moves?${params.toString()}`)
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const detail = payload?.detail ? `: ${String(payload.detail)}` : "";
          throw new Error(`Failed to load possible moves${detail}`);
        }
        return response.json();
      })
      .then((payload) => {
        setPossibleMoves(payload);
        setPossibleMovesError("");
      })
      .catch((reason) => {
        setPossibleMoves(null);
        setPossibleMovesError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [report, selectedUnit, selectedUnitId, selectedStepIndex, currentState?.active_player_id]);

  const legalMoveKeys = useMemo(
    () => new Set(possibleMoves?.legal_move_destinations ?? []),
    [possibleMoves],
  );
  const currentAttackTargets = possibleMoves?.current_attack_targets ?? [];
  const moveAttackTargets = possibleMoves?.move_attack_targets ?? {};
  const selectedUnitPositionKey = selectedUnitTile ? coordKey(selectedUnitTile.coord) : null;

  const selectTileAndOccupant = (tile) => {
    const key = coordKey(tile.coord);
    const surfaceUnitId = tile.surface_unit_id ?? null;
    const hiddenUnitId = tile.hidden_unit_id ?? null;
    setSelectedTileKey(key);
    if (selectedUnitId && legalMoveKeys.has(key)) {
      return;
    }
    if (surfaceUnitId && hiddenUnitId) {
      if (selectedUnitId === surfaceUnitId || selectedUnitId === hiddenUnitId) {
        if (selectedTileKey === key && selectedUnitId === surfaceUnitId) {
          setSelectedUnitId(hiddenUnitId);
          return;
        }
        if (selectedTileKey === key && selectedUnitId === hiddenUnitId) {
          setSelectedUnitId(surfaceUnitId);
          return;
        }
        return;
      }
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
    if (displayTiles.length === 0) {
      return { minX: 0, minY: 0, width: 600, height: 420 };
    }
    const centers = displayTiles.map((tile) => axialToPixel(tile.coord));
    const minX = Math.min(...centers.map((center) => center.x)) - BASE_HEX_SIZE - 34;
    const maxX = Math.max(...centers.map((center) => center.x)) + BASE_HEX_SIZE + 34;
    const minY = Math.min(...centers.map((center) => center.y)) - BASE_HEX_SIZE - 34;
    const maxY = Math.max(...centers.map((center) => center.y)) + BASE_HEX_SIZE + 34;
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }, [displayTiles]);

  const zoomedViewBox = useMemo(() => {
    const centerX = boardBounds.minX + boardBounds.width / 2;
    const centerY = boardBounds.minY + boardBounds.height / 2;
    const width = boardBounds.width / zoom;
    const height = boardBounds.height / zoom;
    return {
      minX: centerX - width / 2 + panOffset.x,
      minY: centerY - height / 2 + panOffset.y,
      width,
      height,
    };
  }, [boardBounds, panOffset.x, panOffset.y, zoom]);

    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="header-intro">
            <h1>UniwarBot Scenario Inspector</h1>
            <p>Choose a UT scenario, step actions, and inspect the rendered board, units, and state changes.</p>
          </div>
        </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <main className="workspace-grid">
          <section className="panel panel-controls">
            <div className="panel-header">
              <h2>{`Scenario (${scenarios.length})`}</h2>
            </div>

          <div className="control-stack">
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
              ref={boardViewportRef}
              className={`board-viewport ${isPanningBoard ? "panning" : ""}`}
              onWheel={(event) => {
                event.preventDefault();
                adjustZoom(event.deltaY < 0 ? 0.08 : -0.08);
              }}
              onPointerDown={beginBoardPan}
              onPointerMove={moveBoardPan}
              onPointerUp={endBoardPan}
              onPointerCancel={endBoardPan}
              onPointerLeave={endBoardPan}
            >
            <svg
              ref={boardSvgRef}
              className="board-svg"
              viewBox={`${zoomedViewBox.minX} ${zoomedViewBox.minY} ${zoomedViewBox.width} ${zoomedViewBox.height}`}
              onClickCapture={suppressBoardClickIfNeeded}
            >
              <defs>
                {displayTiles.map((tile) => {
                  return (
                    <clipPath id={clipPathId(tile.coord)} key={clipPathId(tile.coord)} clipPathUnits="userSpaceOnUse">
                      <polygon points={hexPoints(0, 0, BASE_HEX_SIZE)} />
                    </clipPath>
                  );
                })}
              </defs>
              {displayTiles.map((tile) => {
                const center = axialToPixel(tile.coord);
                const surfaceUnitId = tile.surface_unit_id;
                const surfaceUnit = surfaceUnitId ? units[surfaceUnitId] : null;
                const key = coordKey(tile.coord);
                const isVoidTile = tile.terrain_id === "__void__";
                const terrainHref = terrainAsset(tile.terrain_id);
                return (
                  <g
                    key={key}
                    className="hex-group"
                    onClick={isVoidTile ? undefined : () => selectTileAndOccupant(tile)}
                    transform={`translate(${center.x}, ${center.y})`}
                  >
                    <polygon
                      points={hexPoints(0, 0, BASE_HEX_SIZE)}
                      fill={TERRAIN_FALLBACKS[tile.terrain_id] ?? "#d8d8d8"}
                      stroke="#22304a"
                      strokeWidth="2"
                    />
                    {terrainHref ? (
                      <image
                        href={terrainHref}
                        x={-34}
                        y={-34}
                        width={68}
                        height={68}
                        clipPath={`url(#${clipPathId(tile.coord)})`}
                        preserveAspectRatio="xMidYMid meet"
                      />
                    ) : null}

                    {selectedUnitPositionKey === key && possibleMoves && !isVoidTile ? (
                      <>
                        {currentAttackTargets.length > 0 ? (
                          <g className="current-attack-overlay" transform="translate(0,-18)" opacity="0.85">
                            <circle className="move-overlay-disc" cx="0" cy="0" r="8" />
                            <text className="move-overlay-count" x="0" y="1">
                              {String(currentAttackTargets.length)}
                            </text>
                          </g>
                        ) : null}
                        <g className="action-badges" transform="translate(0,18)">
                        {possibleMoves.can_bury ? (
                          <g transform="translate(-12,0)">
                            <rect className="action-badge action-bury" x="-9" y="-7" width="18" height="14" rx="6" />
                            <text className="action-badge-text" x="0" y="1">
                              B
                            </text>
                          </g>
                        ) : null}
                        {possibleMoves.can_resurface ? (
                          <g transform={`translate(${possibleMoves.can_bury ? 12 : 0},0)`}>
                            <rect
                              className="action-badge action-resurface"
                              x="-9"
                              y="-7"
                              width="18"
                              height="14"
                              rx="6"
                            />
                            <text className="action-badge-text" x="0" y="1">
                              R
                            </text>
                          </g>
                        ) : null}
                        </g>
                      </>
                    ) : null}

                    {tile.owner_id ? (
                      <g transform="translate(0,-24)">
                        <circle r="8" className={`owner-disc owner-${tile.owner_id}`} />
                        <text className="owner-text" x="0" y="1">
                          {tile.owner_id.toUpperCase()}
                        </text>
                      </g>
                    ) : null}

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
                          href={unitAsset(String(surfaceUnit.unit_id ?? ""), String(surfaceUnit.owner_id ?? ""))}
                          x={-23}
                          y={-18}
                          width={46}
                          height={36}
                          draggable="false"
                          preserveAspectRatio="xMidYMid slice"
                        />
                        {renderTeleportDisabledLabel(surfaceUnit, "translate(0,-16)")}
                        {renderStatusMarker(surfaceUnit, "translate(-18,-14)")}
                        {renderVeterancy(surfaceUnit)}
                        <g transform="translate(18,13)">
                          <text className="hp-text" x="0" y="1">
                            {String(surfaceUnit.hp)}
                          </text>
                        </g>
                      </g>
                    ) : null}
                    <g key={`coord-${key}`} className="coord-overlay">
                      <text className={`coord-label ${isVoidTile ? "coord-label-void" : ""}`} x="0" y="22">
                        {key}
                      </text>
                    </g>
                  </g>
                );
              })}
              {tiles.map((tile) => {
                const key = coordKey(tile.coord);
                if (!legalMoveKeys.has(key)) {
                  return null;
                }
                const center = axialToPixel(tile.coord);
                return (
                  <g
                    key={`move-${key}`}
                    className="move-overlay"
                    transform={`translate(${center.x}, ${center.y})`}
                    opacity="0.75"
                  >
                    <polygon points={hexPoints(0, 0, BASE_HEX_SIZE)} className="move-overlay-outline" />
                    <polygon points={hexPoints(0, 0, BASE_HEX_SIZE)} className="move-overlay-fill" />
                    {Array.isArray(moveAttackTargets[key]) && moveAttackTargets[key].length > 0 ? (
                      <>
                        <circle className="move-overlay-disc" cx="0" cy="0" r="8" />
                        <text className="move-overlay-count" x="0" y="1">
                          {String(moveAttackTargets[key].length)}
                        </text>
                      </>
                    ) : null}
                  </g>
                );
              })}
              {hiddenRenderItems.map(({ tile, unitId, unit }) => {
                const center = axialToPixel(tile.coord);
                const key = coordKey(tile.coord);
                return (
                  <g
                    key={`hidden-${unitId}`}
                    className="unit-token hidden-token-layer"
                    transform={`translate(${center.x}, ${center.y + 24})`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedTileKey(key);
                      setSelectedUnitId(unitId);
                    }}
                    opacity="0.65"
                  >
                    <ellipse className="hidden-ring" cx="0" cy="0" rx="19" ry="14" />
                    <image
                      className="unit-sprite hidden"
                      href={unitAsset(String(unit.unit_id ?? ""), String(unit.owner_id ?? ""))}
                      x={-17}
                      y={-13}
                      width={34}
                      height={27}
                      draggable="false"
                      preserveAspectRatio="xMidYMid slice"
                    />
                    {renderTeleportDisabledLabel(unit, "translate(0,-12)")}
                    {renderStatusMarker(unit, "translate(-15,-11)")}
                    {renderVeterancy(unit)}
                    <g transform="translate(-13,-9)">
                      <rect className="hidden-flag" x="-6" y="-6" width="12" height="12" rx="4" />
                      <text className="hidden-flag-text" x="0" y="1">
                        H
                      </text>
                    </g>
                    <g transform="translate(13,10)">
                      <text className="hp-text" x="0" y="1">
                        {String(unit.hp)}
                      </text>
                    </g>
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
              {Object.keys(diffObject).length === 0 ? (
                <span className="muted">No changes for the selected view.</span>
              ) : (
                <pre>{pretty(diffObject)}</pre>
              )}
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
                  <img
                    className="unit-inspector-icon"
                    src={unitAsset(selectedUnitGameId, String(selectedUnit.owner_id ?? ""))}
                    alt={selectedUnitGameId}
                  />
                  <div className="visual-copy">
                    <strong>{selectedUnitGameId}</strong>
                    <span>Owner: {String(selectedUnit.owner_id ?? "-")}</span>
                    <span>HP: {String(selectedUnit.hp ?? "-")}</span>
                    <span>
                      Layer: {selectedUnitLayer ?? "unknown"}
                      {selectedUnit?.status?.hidden_mode ? ` (${String(selectedUnit.status.hidden_mode)})` : ""}
                    </span>
                    {selectedUnit?.status?.teleport_lock_phase ? (
                      <span>
                        Teleport lock: {String(selectedUnit.status.teleport_lock_phase)} / cooldown{" "}
                        {String(selectedUnit.status.teleport_cooldown_rounds ?? 0)}
                      </span>
                    ) : null}
                    {Number(selectedUnit?.status?.emp_disabled_rounds ?? 0) > 0 ? (
                      <span>EMP disabled: {String(selectedUnit.status.emp_disabled_rounds)} rounds</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <pre>{pretty(selectedUnit ?? null)}</pre>
            </div>

            <div className="detail-card">
              <h2>Possible Moves</h2>
              {selectedUnit == null ? (
                <span className="muted">Select a unit to inspect its legal move set.</span>
              ) : possibleMovesError ? (
                <span className="muted">{possibleMovesError}</span>
              ) : (
                <pre>{pretty(possibleMoves ?? null)}</pre>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
