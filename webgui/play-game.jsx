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
const DELETE_NONE = "__none__";

function coordKey(coord) {
  return `${coord.q}:${coord.r}`;
}

function parseCoordKey(value) {
  const [qText, rText] = String(value).split(":");
  return { q: Number(qText), r: Number(rText) };
}

function clipPathId(coord) {
  return `play-tile-clip-${coord.q}-${coord.r}`;
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

function pretty(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function compact(value) {
  return JSON.stringify(value ?? null);
}

function nullableInt(value) {
  return value === "" ? null : Number(value);
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

function renderTeleportDisabledLabel(unit, transform) {
  if (!String(unit?.status?.teleport_lock_phase ?? "")) {
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

function stateMarker(state) {
  if (!state) {
    return "";
  }
  return `${state.active_player_id}|${state.turn_number}|${state.round_number}`;
}

function findTurnStartIndex(history, index) {
  if (!Array.isArray(history) || history.length === 0 || index < 0) {
    return -1;
  }
  const clampedIndex = Math.min(index, history.length - 1);
  const marker = stateMarker(history[clampedIndex]?.state);
  let startIndex = clampedIndex;
  while (startIndex > 0 && stateMarker(history[startIndex - 1]?.state) === marker) {
    startIndex -= 1;
  }
  return startIndex;
}

function findNextTurnStartIndex(history, index) {
  if (!Array.isArray(history) || history.length === 0 || index < 0 || index >= history.length - 1) {
    return -1;
  }
  const currentStart = findTurnStartIndex(history, index);
  const marker = stateMarker(history[currentStart]?.state);
  let cursor = currentStart + 1;
  while (cursor < history.length && stateMarker(history[cursor]?.state) === marker) {
    cursor += 1;
  }
  return cursor < history.length ? cursor : -1;
}

function buildDisplayTiles(tiles) {
  if (!Array.isArray(tiles) || tiles.length === 0) {
    return [];
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
          metadata: {},
        },
      );
    }
  }
  return expanded;
}

function App() {
  const [config, setConfig] = useState(null);
  const [mapFileName, setMapFileName] = useState("");
  const [mapData, setMapData] = useState(null);
  const [playerFactions, setPlayerFactions] = useState({});
  const [seedOverride, setSeedOverride] = useState("");
  const [saveFileName, setSaveFileName] = useState("new-game.json");
  const [savedGameFileName, setSavedGameFileName] = useState("");
  const [gameState, setGameState] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [selectedTileKey, setSelectedTileKey] = useState(null);
  const [selectedUnitId, setSelectedUnitId] = useState(null);
  const [playOptions, setPlayOptions] = useState(null);
  const [mode, setMode] = useState(null);
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
    fetch(`${API_BASE}/play-game/config`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load play-game config: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        setConfig(payload);
        if (payload.maps?.length > 0) {
          setMapFileName(String(payload.maps[0].file_name));
        }
        if (payload.saved_games?.length > 0) {
          setSavedGameFileName(String(payload.saved_games[0].file_name));
        }
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    if (!mapFileName) {
      setMapData(null);
      return;
    }
    fetch(`${API_BASE}/maps/${encodeURIComponent(mapFileName)}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load map: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        setMapData(payload);
        setPlayerFactions((previous) => {
          const next = {};
          for (const player of payload.players ?? []) {
            const allowed = Array.isArray(player.allowed_factions) && player.allowed_factions.length > 0
              ? player.allowed_factions
              : config?.factions ?? [];
            next[player.player_id] = previous[player.player_id] ?? allowed[0] ?? "sapiens";
          }
          return next;
        });
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [config, mapFileName]);

  useEffect(() => {
    if (!gameState) {
      setPlayOptions(null);
      return;
    }
    fetch(`${API_BASE}/play-game/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: gameState,
        selected_unit_id: selectedUnitId,
        selected_tile: selectedTileKey ? parseCoordKey(selectedTileKey) : null,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail ?? `Failed to load options: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => setPlayOptions(payload))
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [gameState, selectedTileKey, selectedUnitId]);

  const currentState = historyIndex >= 0 ? history[historyIndex]?.state ?? gameState : gameState;
  const currentStateValue = currentState ?? gameState;

  useEffect(() => {
    if (currentStateValue !== gameState && currentStateValue != null) {
      setGameState(currentStateValue);
    }
  }, [currentStateValue]);

  const tiles = currentStateValue?.game_map?.tiles ?? [];
  const units = currentStateValue?.units ?? {};
  const displayTiles = useMemo(() => buildDisplayTiles(tiles), [tiles]);
  const tileByKey = useMemo(
    () => new Map(tiles.map((tile) => [coordKey(tile.coord), tile])),
    [tiles],
  );
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
  const selectedTile = selectedTileKey ? tileByKey.get(selectedTileKey) ?? null : null;
  const selectedUnit = selectedUnitId ? units[selectedUnitId] ?? null : null;
  const moveInfo = playOptions?.possible_moves ?? null;
  const specialOptions = playOptions?.special_options ?? null;
  const moveDestinations = new Set(moveInfo?.legal_move_destinations ?? []);
  const moveAttackTargets = moveInfo?.move_attack_targets ?? {};
  const attackTargetIds = new Set(moveInfo?.current_attack_targets ?? []);
  const plagueTargetIds = new Set(specialOptions?.plague_targets ?? []);
  const teleportDestinations = new Set(specialOptions?.teleport_destinations ?? []);
  const transformTargets = specialOptions?.transform_targets ?? {};
  const buyableUnits = playOptions?.buyable_units ?? [];
  const activePlayerId = currentStateValue?.active_player_id ?? null;
  const playerSummaries = useMemo(() => {
    const statePlayers = currentStateValue?.players ?? {};
    const playerEntries = Object.entries(statePlayers)
      .map(([playerId, player]) => ({ playerId, ...(player ?? {}) }))
      .sort((left, right) => String(left.playerId).localeCompare(String(right.playerId)));
    const mapMetadata = currentStateValue?.game_map?.metadata ?? {};
    const incomePerBase = Number(mapMetadata.income_per_base ?? 100);
    const incomePerCity = Number(mapMetadata.income_per_city ?? 50);
    const terrainConfig = config?.terrains ?? {};
    const incomeForTerrain = (terrainId) => {
      if (terrainId === "base") {
        return incomePerBase;
      }
      if (terrainId === "city") {
        return incomePerCity;
      }
      const terrain = terrainConfig?.[terrainId] ?? {};
      if (!terrain.provides_income) {
        return 0;
      }
      if (terrain.income_amount != null) {
        return Number(terrain.income_amount);
      }
      return incomePerBase;
    };
    return playerEntries.map((player) => {
      const income = tiles.reduce((total, tile) => {
        if (tile.owner_id !== player.playerId) {
          return total;
        }
        const amount = incomeForTerrain(tile.terrain_id);
        return amount > 0 ? total + amount : total;
      }, 0);
      return {
        playerId: player.playerId,
        faction: player.faction ?? "-",
        credits: Number(player.credits ?? 0),
        income,
        isActive: currentStateValue?.active_player_id === player.playerId,
      };
    });
  }, [config?.terrains, currentStateValue, tiles]);

  function refreshSavedGames() {
    return fetch(`${API_BASE}/play-game/config`)
      .then(async (response) => response.json())
      .then((payload) => {
        setConfig(payload);
        if (!savedGameFileName && payload.saved_games?.length > 0) {
          setSavedGameFileName(String(payload.saved_games[0].file_name));
        }
      });
  }

  function resetInteraction(nextState, { nextSelectedUnitId = null, nextSelectedTileKey = null, nextMode = null } = {}) {
    setGameState(nextState);
    setSelectedUnitId(nextSelectedUnitId);
    setSelectedTileKey(nextSelectedTileKey);
    setMode(nextMode);
  }

  function pushHistory(nextState, label) {
    setHistory((previous) => {
      const base = previous.slice(0, historyIndex + 1);
      const next = [...base, { state: nextState, label }];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }

  function handleNewGame() {
    if (!mapFileName) {
      setError("Choose a map first.");
      return;
    }
    setError("");
    fetch(`${API_BASE}/play-game/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        map_file_name: mapFileName,
        player_factions: playerFactions,
        seed_override: nullableInt(seedOverride),
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail ?? `Failed to start game: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        const nextState = payload.state;
        setHistory([{ state: nextState, label: "new_game" }]);
        setHistoryIndex(0);
        resetInteraction(nextState);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }

  function handleSaveGame() {
    if (!currentStateValue) {
      setError("No game to save.");
      return;
    }
    const historyToSave = history.length > 0
      ? history.map((entry) => ({
        state: entry.state,
        label: entry.label ?? "",
      }))
      : [{ state: currentStateValue, label: "save_game" }];
    const historyIndexToSave = history.length > 0
      ? Math.max(0, Math.min(historyIndex, history.length - 1))
      : 0;
    fetch(`${API_BASE}/saved-games/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_name: saveFileName,
        name: saveFileName.replace(/\.json$/i, ""),
        state: currentStateValue,
        history: historyToSave,
        history_index: historyIndexToSave,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail ?? `Failed to save game: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        setSaveFileName(String(payload.file_name));
        setSavedGameFileName(String(payload.file_name));
        return refreshSavedGames();
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }

  function handleLoadGame() {
    if (!savedGameFileName) {
      setError("Choose a saved game first.");
      return;
    }
    fetch(`${API_BASE}/saved-games/${encodeURIComponent(savedGameFileName)}`)
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail ?? `Failed to load game: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        const nextState = payload.state;
        const nextHistory = Array.isArray(payload.history) && payload.history.length > 0
          ? payload.history.map((entry) => ({
            state: entry?.state ?? nextState,
            label: entry?.label ?? "",
          }))
          : [{ state: nextState, label: "load_game" }];
        const nextHistoryIndex = Math.max(
          0,
          Math.min(
            Number.isFinite(Number(payload.history_index)) ? Number(payload.history_index) : nextHistory.length - 1,
            nextHistory.length - 1,
          ),
        );
        const restoredState = nextHistory[nextHistoryIndex]?.state ?? nextState;
        setHistory(nextHistory);
        setHistoryIndex(nextHistoryIndex);
        resetInteraction(restoredState);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }

  function handleDeleteSavedGame() {
    if (!savedGameFileName) {
      setError("Choose a saved game first.");
      return;
    }
    if (!window.confirm(`Delete saved game "${savedGameFileName}"?`)) {
      return;
    }
    fetch(`${API_BASE}/saved-games/delete-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_name: savedGameFileName }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail ?? `Failed to delete saved game: ${response.status}`);
        }
        return response.json();
      })
      .then(async () => {
        setSavedGameFileName("");
        await refreshSavedGames();
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }

  function applyAction(action, options = {}) {
    if (!currentStateValue) {
      return;
    }
    setError("");
    fetch(`${API_BASE}/play-game/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: currentStateValue,
        action,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail ?? `Failed to apply action: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        const nextState = payload.state;
        pushHistory(nextState, action.type);
        resetInteraction(nextState, options);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }

  function selectTileAndUnit(tileKey, preferredUnitId = null) {
    setSelectedTileKey(tileKey);
    if (preferredUnitId) {
      setSelectedUnitId(preferredUnitId);
      return;
    }
    const tile = tileByKey.get(tileKey);
    if (!tile) {
      setSelectedUnitId(null);
      return;
    }
    const unitId = tile.surface_unit_id ?? tile.hidden_unit_id ?? null;
    setSelectedUnitId(unitId);
  }

  function targetUnitAtTile(tile) {
    if (!tile) {
      return null;
    }
    if (tile.surface_unit_id && units[tile.surface_unit_id]) {
      return units[tile.surface_unit_id];
    }
    if (tile.hidden_unit_id && units[tile.hidden_unit_id]) {
      return units[tile.hidden_unit_id];
    }
    return null;
  }

  function handleTileClick(tile, clickedUnitOverride = null) {
    const tileKey = coordKey(tile.coord);
    const clickedUnit = clickedUnitOverride ?? targetUnitAtTile(tile);
    if (mode === "teleport" && selectedUnitId && teleportDestinations.has(tileKey)) {
      applyAction(
        { type: "teleport_unit", unit_id: selectedUnitId, destination: tile.coord },
        { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: tileKey, nextMode: null },
      );
      return;
    }
    if (mode === "plague" && clickedUnit == null) {
      selectTileAndUnit(tileKey);
      return;
    }
    if (mode === "plague" && clickedUnit && plagueTargetIds.has(clickedUnit.instance_id)) {
      applyAction(
        { type: "use_plague", unit_id: selectedUnitId, target_id: clickedUnit.instance_id },
        { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey, nextMode: null },
      );
      return;
    }
    if (String(mode || "").startsWith("transform:") && clickedUnit) {
      const abilityId = String(mode).slice("transform:".length);
      const allowedTargets = new Set(transformTargets?.[abilityId] ?? []);
      if (allowedTargets.has(clickedUnit.instance_id)) {
        applyAction(
          {
            type: "transform_unit",
            unit_id: selectedUnitId,
            target_id: clickedUnit.instance_id,
            ability_id: abilityId,
          },
          { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey, nextMode: null },
        );
        return;
      }
    }
    if (
      selectedUnitId &&
      clickedUnit &&
      clickedUnit.instance_id !== selectedUnitId &&
      attackTargetIds.has(clickedUnit.instance_id)
    ) {
      applyAction(
        { type: "attack_unit", attacker_id: selectedUnitId, defender_id: clickedUnit.instance_id },
        { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey, nextMode: null },
      );
      return;
    }
    if (selectedUnitId && moveDestinations.has(tileKey)) {
      const destinationAttackTargets = Array.isArray(moveAttackTargets?.[tileKey])
        ? moveAttackTargets[tileKey]
        : [];
      applyAction(
        {
          type: "move_unit",
          unit_id: selectedUnitId,
          destination: tile.coord,
          continue_as_atomic_attack: destinationAttackTargets.length > 0,
        },
        { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: tileKey, nextMode: null },
      );
      return;
    }
    selectTileAndUnit(tileKey);
  }

  function handleHistoryUndo() {
    if (historyIndex <= 0) {
      return;
    }
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    resetInteraction(history[nextIndex].state);
  }

  function handleHistoryRedo() {
    if (historyIndex < 0 || historyIndex >= history.length - 1) {
      return;
    }
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    resetInteraction(history[nextIndex].state);
  }

  function handleTurnUndo() {
    if (historyIndex <= 0) {
      return;
    }
    const currentTurnStart = findTurnStartIndex(history, historyIndex);
    let nextIndex = currentTurnStart;
    if (currentTurnStart === historyIndex || historyIndex === currentTurnStart) {
      const previousTurnProbe = currentTurnStart - 1;
      if (previousTurnProbe >= 0) {
        nextIndex = findTurnStartIndex(history, previousTurnProbe);
      }
    }
    setHistoryIndex(nextIndex);
    resetInteraction(history[nextIndex].state);
  }

  function handleTurnRedo() {
    if (historyIndex < 0 || historyIndex >= history.length - 1) {
      return;
    }
    const nextIndex = findNextTurnStartIndex(history, historyIndex);
    if (nextIndex < 0) {
      return;
    }
    setHistoryIndex(nextIndex);
    resetInteraction(history[nextIndex].state);
  }

  const clampZoom = (value) => Math.max(0.45, Math.min(2.2, value));
  const adjustZoom = (delta) => setZoom((current) => clampZoom(Number((current + delta).toFixed(2))));

  function suppressBoardClickIfNeeded(event) {
    if (!suppressBoardClickRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressBoardClickRef.current = false;
  }

  function beginBoardPan(event) {
    boardPanRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: panOffset.x,
      startPanY: panOffset.y,
      hasDragged: false,
    };
    setIsPanningBoard(false);
  }

  function moveBoardPan(event) {
    const current = boardPanRef.current;
    if (current.pointerId == null || event.pointerId !== current.pointerId) {
      return;
    }
    const dx = event.clientX - current.startClientX;
    const dy = event.clientY - current.startClientY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      current.hasDragged = true;
      suppressBoardClickRef.current = true;
      setIsPanningBoard(true);
    }
    const viewport = boardViewportRef.current;
    if (!viewport) {
      return;
    }
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    const worldDx = dx * (zoomedViewBox.width / width);
    const worldDy = dy * (zoomedViewBox.height / height);
    setPanOffset({
      x: current.startPanX - worldDx,
      y: current.startPanY - worldDy,
    });
  }

  function endBoardPan(event) {
    const current = boardPanRef.current;
    if (current.pointerId == null || event.pointerId !== current.pointerId) {
      return;
    }
    boardPanRef.current.pointerId = null;
    setIsPanningBoard(false);
    if (!current.hasDragged) {
      suppressBoardClickRef.current = false;
    } else {
      window.setTimeout(() => {
        suppressBoardClickRef.current = false;
      }, 0);
    }
  }

  function headerInline(title, description) {
    return (
      <div className="header-intro">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        {headerInline(
          "UniwarBot Play Game",
          "Start from a saved map, play a full game state locally, and save or reload detailed game snapshots.",
        )}
      </header>

      <main className="workspace-grid editor-workspace-grid">
        <section className="panel panel-controls">
          <div className="panel-header">
            <h2>Play Controls</h2>
          </div>
          <div className="control-stack editor-control-stack">
            <div className="editor-tab-panel">
              <div className="detail-card">
                <h2>New Game</h2>
                <div className="control-stack" style={{ padding: 0 }}>
                  <label>
                    <div className="field-label">Map</div>
                    <select value={mapFileName} onChange={(event) => setMapFileName(event.target.value)}>
                      {(config?.maps ?? []).map((item) => (
                        <option key={item.file_name} value={item.file_name}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(mapData?.players ?? []).map((player) => (
                    <label key={player.player_id}>
                      <div className="field-label">{player.player_id} Faction</div>
                      <select
                        value={playerFactions[player.player_id] ?? ""}
                        onChange={(event) =>
                          setPlayerFactions((previous) => ({
                            ...previous,
                            [player.player_id]: event.target.value,
                          }))
                        }
                      >
                        {(player.allowed_factions ?? []).map((faction) => (
                          <option key={faction} value={faction}>
                            {faction}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label>
                    <div className="field-label">Seed Override</div>
                    <input
                      type="number"
                      value={seedOverride}
                      placeholder="blank = map/random seed"
                      onChange={(event) => setSeedOverride(event.target.value)}
                    />
                  </label>
                  <div className="editor-button-row playgame-single-button-row">
                    <button className="step-chip" type="button" onClick={handleNewGame}>
                      Start New Game
                    </button>
                  </div>
                </div>
              </div>

              <div className="detail-card">
                <h2>Save</h2>
                <div className="control-stack" style={{ padding: 0 }}>
                  <input
                    value={saveFileName}
                    placeholder="file name"
                    onChange={(event) => setSaveFileName(event.target.value)}
                  />
                  <div className="editor-button-row playgame-single-button-row">
                    <button className="step-chip" type="button" onClick={handleSaveGame}>
                      Save Game
                    </button>
                  </div>
                </div>
              </div>

              <div className="detail-card">
                <h2>Load</h2>
                <div className="control-stack" style={{ padding: 0 }}>
                  <select
                    value={savedGameFileName}
                    onChange={(event) => setSavedGameFileName(event.target.value)}
                  >
                    <option value="">Choose saved game</option>
                    {(config?.saved_games ?? []).map((item) => (
                      <option key={item.file_name} value={item.file_name}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <div className="editor-button-row playgame-single-button-row">
                    <button className="step-chip" type="button" onClick={handleLoadGame}>
                      Load Game
                    </button>
                  </div>
                </div>
              </div>

              <div className="detail-card">
                <h2>Delete Save</h2>
                <div className="control-stack" style={{ padding: 0 }}>
                  <select
                    value={savedGameFileName}
                    onChange={(event) => setSavedGameFileName(event.target.value)}
                  >
                    <option value="">Choose saved game</option>
                    {(config?.saved_games ?? []).map((item) => (
                      <option key={item.file_name} value={item.file_name}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <div className="editor-button-row playgame-single-button-row">
                    <button className="step-chip" type="button" onClick={handleDeleteSavedGame}>
                      Delete Saved Game
                    </button>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </section>

        <section className="panel panel-board">
          {mode ? (
            <div className="panel-header">
              <div className="meta-line">
                {mode ? <span>Special mode: {mode}</span> : null}
              </div>
            </div>
          ) : null}
          <div className="playgame-status-panel">
            <div className="playgame-state-card">
              <span className="summary-label">Current State</span>
              {currentStateValue ? (
                <>
                  <div className="playgame-state-active">
                    <svg className="playgame-owner-badge" viewBox="-10 -10 20 20" aria-hidden="true">
                      <circle r="8" className={`owner-disc owner-${activePlayerId}`} />
                      <text className="owner-text playgame-owner-text" x="0" y="1">
                        {String(activePlayerId).toUpperCase()}
                      </text>
                    </svg>
                    <div className="playgame-state-active-copy">
                      <strong>{playerSummaries.find((player) => player.playerId === activePlayerId)?.faction ?? activePlayerId}</strong>
                      <span>to move</span>
                    </div>
                  </div>
                  <div className="playgame-state-meta">
                    <span>{`Turn ${currentStateValue.turn_number}`}</span>
                    <span>{`Round ${currentStateValue.round_number}`}</span>
                    <span>{`Seed ${currentStateValue.current_rseed}`}</span>
                  </div>
                </>
              ) : (
                <strong>No game started</strong>
              )}
            </div>
            <div className="playgame-history-panel">
              <div className="playgame-history-head">
                <span className="summary-label">History</span>
                <span className="muted playgame-history-label">
                  {historyIndex >= 0 ? `${historyIndex + 1} / ${history.length}` : "No history"}
                </span>
              </div>
              <div className="playgame-history-buttons">
                <button className="step-chip" type="button" title="Undo" onClick={handleHistoryUndo}>
                  {"<"}
                </button>
                <button className="step-chip" type="button" title="Undo Turn" onClick={handleTurnUndo}>
                  {"<<"}
                </button>
                <button className="step-chip" type="button" title="Redo" onClick={handleHistoryRedo}>
                  {">"}
                </button>
                <button className="step-chip" type="button" title="Redo Turn" onClick={handleTurnRedo}>
                  {">>"}
                </button>
              </div>
            </div>
            <div className="playgame-player-row">
              {playerSummaries.map((player) => (
                <div key={player.playerId} className={`playgame-player-card ${player.isActive ? "active" : ""}`}>
                  <div className="playgame-player-head">
                    <svg className="playgame-owner-badge" viewBox="-10 -10 20 20" aria-hidden="true">
                      <circle r="8" className={`owner-disc owner-${player.playerId}`} />
                      <text className="owner-text playgame-owner-text" x="0" y="1">
                        {player.playerId.toUpperCase()}
                      </text>
                    </svg>
                    <strong>{player.faction}</strong>
                  </div>
                  <div className="playgame-player-stats">
                    <span>{player.credits}</span>
                    <span>{`(+${player.income})`}</span>
                  </div>
                </div>
              ))}
            </div>
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
                    if (tile.terrain_id === "__void__") {
                      return null;
                    }
                    return (
                      <clipPath key={clipPathId(tile.coord)} id={clipPathId(tile.coord)} clipPathUnits="userSpaceOnUse">
                        <polygon points={hexPoints(0, 0, BASE_HEX_SIZE)} />
                      </clipPath>
                    );
                  })}
                </defs>

                {displayTiles.map((tile) => {
                  const center = axialToPixel(tile.coord);
                  const tileKey = coordKey(tile.coord);
                  const terrainImage = terrainAsset(tile.terrain_id);
                  const isVoidTile = tile.terrain_id === "__void__";
                  return (
                    <g
                      key={tileKey}
                      className="hex-group"
                      transform={`translate(${center.x}, ${center.y})`}
                      onClick={isVoidTile ? undefined : () => handleTileClick(tile)}
                    >
                      <polygon
                        points={hexPoints(0, 0, BASE_HEX_SIZE)}
                        fill={TERRAIN_FALLBACKS[tile.terrain_id] ?? "#d7c7a1"}
                        stroke="#22304a"
                        strokeWidth="2"
                      />
                      {terrainImage ? (
                        <image
                          href={terrainImage}
                          x={-34}
                          y={-34}
                          width={68}
                          height={68}
                          clipPath={`url(#${clipPathId(tile.coord)})`}
                          preserveAspectRatio="xMidYMid meet"
                          pointerEvents="none"
                        />
                      ) : null}
                      {tile.owner_id ? (
                        <g transform="translate(0,-24)">
                          <circle r="8" className={`owner-disc owner-${tile.owner_id}`} />
                          <text className="owner-text" x="0" y="1">
                            {tile.owner_id.toUpperCase()}
                          </text>
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
                    <polygon
                      points={hexPoints(0, 0, BASE_HEX_SIZE)}
                      fill="rgba(0,0,0,0)"
                      strokeWidth="5"
                    />
                  </g>
                ) : null}

                {moveInfo?.legal_move_destinations?.map((destinationKey) => {
                  const coord = parseCoordKey(destinationKey);
                  const center = axialToPixel(coord);
                  const targetCount = (moveAttackTargets[destinationKey] ?? []).length;
                  return (
                    <g
                      key={`move-${destinationKey}`}
                      className="move-overlay"
                      transform={`translate(${center.x}, ${center.y})`}
                      pointerEvents="none"
                      opacity="0.75"
                    >
                      <polygon
                        className="move-overlay-outline"
                        points={hexPoints(0, 0, BASE_HEX_SIZE)}
                      />
                      <polygon
                        className="move-overlay-fill"
                        points={hexPoints(0, 0, BASE_HEX_SIZE)}
                      />
                      {targetCount > 0 ? (
                        <g>
                          <circle className="move-overlay-disc" cx="0" cy="0" r="8" />
                          <text className="move-overlay-count" x="0" y="1">
                            {targetCount}
                          </text>
                        </g>
                      ) : null}
                    </g>
                  );
                })}

                {selectedUnitId ? Array.from(attackTargetIds).map((targetId) => {
                  const unit = units[targetId];
                  if (!unit) {
                    return null;
                  }
                  const center = axialToPixel(unit.position);
                  return (
                    <g key={`attack-${targetId}`} transform={`translate(${center.x}, ${center.y})`} pointerEvents="none">
                      <polygon
                        points={hexPoints(0, 0, BASE_HEX_SIZE)}
                        fill="rgba(0,0,0,0)"
                        stroke="rgba(220, 38, 38, 0.95)"
                        strokeWidth="3.2"
                      />
                    </g>
                  );
                }) : null}

                {(mode === "teleport" ? Array.from(teleportDestinations) : []).map((destinationKey) => {
                  const coord = parseCoordKey(destinationKey);
                  const center = axialToPixel(coord);
                  return (
                    <g
                      key={`teleport-${destinationKey}`}
                      transform={`translate(${center.x}, ${center.y})`}
                      pointerEvents="none"
                    >
                      <polygon
                        points={hexPoints(0, 0, BASE_HEX_SIZE)}
                        fill="rgba(0,0,0,0)"
                        stroke="rgba(56, 189, 248, 0.95)"
                        strokeWidth="3.2"
                      />
                    </g>
                  );
                })}

                {(mode === "plague" ? Array.from(plagueTargetIds) : []).map((targetId) => {
                  const unit = units[targetId];
                  if (!unit) {
                    return null;
                  }
                  const center = axialToPixel(unit.position);
                  return (
                    <g
                      key={`plague-${targetId}`}
                      transform={`translate(${center.x}, ${center.y})`}
                      pointerEvents="none"
                    >
                      <polygon
                        points={hexPoints(0, 0, BASE_HEX_SIZE)}
                        fill="rgba(0,0,0,0)"
                        stroke="rgba(34, 197, 94, 0.95)"
                        strokeWidth="3.2"
                      />
                    </g>
                  );
                })}

                {displayTiles.map((tile) => {
                  const tileKey = coordKey(tile.coord);
                  const surfaceUnit = tile.surface_unit_id ? units[tile.surface_unit_id] ?? null : null;
                  const hiddenUnit = tile.hidden_unit_id ? units[tile.hidden_unit_id] ?? null : null;
                  const center = axialToPixel(tile.coord);
                  return (
                    <React.Fragment key={`unit-layer-${tileKey}`}>
                      {surfaceUnit ? (
                        <g
                          key={surfaceUnit.instance_id}
                          className="unit-token"
                          transform={`translate(${center.x}, ${center.y}) translate(0,-2)`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleTileClick(tile, surfaceUnit);
                          }}
                        >
                          <image
                            className={`unit-sprite ${String(surfaceUnit?.status?.teleport_lock_phase ?? "") ? "teleport-disabled" : ""}`}
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
                      {hiddenUnit ? (
                        <g
                          key={hiddenUnit.instance_id}
                          className="unit-token hidden-token-layer"
                          transform={`translate(${center.x}, ${center.y + 24})`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleTileClick(tile, hiddenUnit);
                          }}
                          opacity="0.65"
                        >
                          <ellipse className="hidden-ring" cx="0" cy="0" rx="19" ry="14" />
                          <image
                            className="unit-sprite hidden"
                            href={unitAsset(String(hiddenUnit.unit_id ?? ""), String(hiddenUnit.owner_id ?? ""))}
                            x={-17}
                            y={-13}
                            width={34}
                            height={27}
                            draggable="false"
                            preserveAspectRatio="xMidYMid slice"
                          />
                          {renderTeleportDisabledLabel(hiddenUnit, "translate(0,-12)")}
                          {renderStatusMarker(hiddenUnit, "translate(-15,-11)")}
                          {renderVeterancy(hiddenUnit)}
                          <g transform="translate(-13,-9)">
                            <rect className="hidden-flag" x="-6" y="-6" width="12" height="12" rx="4" />
                            <text className="hidden-flag-text" x="0" y="1">
                              H
                            </text>
                          </g>
                          <g transform="translate(13,10)">
                            <text className="hp-text" x="0" y="1">
                              {String(hiddenUnit.hp)}
                            </text>
                          </g>
                        </g>
                      ) : null}
                    </React.Fragment>
                  );
                })}

                {displayTiles.map((tile) => {
                  const center = axialToPixel(tile.coord);
                  return (
                    <text
                      key={`coord-${coordKey(tile.coord)}`}
                      className="coord-label"
                      x={center.x}
                      y={center.y + 22}
                      pointerEvents="none"
                    >
                      {coordKey(tile.coord)}
                    </text>
                  );
                })}
              </svg>
            </div>
          </div>
        </section>

        <section className="panel panel-detail">
          <div className="detail-stack">
            <div className="detail-card">
              <h2>Actions</h2>
              {error ? <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div> : null}
              <div className="muted" style={{ marginBottom: 8 }}>
                Move by clicking a highlighted hex. Attack by clicking a highlighted enemy unit.
              </div>
              <div className="editor-button-row">
                {specialOptions?.can_heal ? (
                  <button className="step-chip" type="button" onClick={() => applyAction({ type: "heal_unit", unit_id: selectedUnitId }, { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey })}>
                    Heal
                  </button>
                ) : null}
                {specialOptions?.can_capture ? (
                  <button className="step-chip" type="button" onClick={() => applyAction({ type: "begin_capture", unit_id: selectedUnitId }, { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey })}>
                    Capture
                  </button>
                ) : null}
              </div>
              <div className="editor-button-row">
                {specialOptions?.can_bury ? (
                  <button className="step-chip" type="button" onClick={() => applyAction({ type: "bury_unit", unit_id: selectedUnitId }, { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey })}>
                    Bury
                  </button>
                ) : null}
                {specialOptions?.can_resurface ? (
                  <button className="step-chip" type="button" onClick={() => applyAction({ type: "resurface_unit", unit_id: selectedUnitId }, { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey })}>
                    Resurface
                  </button>
                ) : null}
                {specialOptions?.can_submerge ? (
                  <button className="step-chip" type="button" onClick={() => applyAction({ type: "submerge_unit", unit_id: selectedUnitId }, { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey })}>
                    Submerge
                  </button>
                ) : null}
                {specialOptions?.can_surface ? (
                  <button className="step-chip" type="button" onClick={() => applyAction({ type: "surface_unit", unit_id: selectedUnitId }, { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey })}>
                    Surface
                  </button>
                ) : null}
                {(specialOptions?.teleport_destinations ?? []).length ? (
                  <button className={mode === "teleport" ? "step-chip selected" : "step-chip"} type="button" onClick={() => setMode(mode === "teleport" ? null : "teleport")}>
                    Teleport
                  </button>
                ) : null}
                {(specialOptions?.plague_targets ?? []).length ? (
                  <button className={mode === "plague" ? "step-chip selected" : "step-chip"} type="button" onClick={() => setMode(mode === "plague" ? null : "plague")}>
                    Plague
                  </button>
                ) : null}
                {specialOptions?.can_emp ? (
                  <button className="step-chip" type="button" onClick={() => applyAction({ type: "use_emp", unit_id: selectedUnitId }, { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey })}>
                    EMP
                  </button>
                ) : null}
                {specialOptions?.can_uv ? (
                  <button className="step-chip" type="button" onClick={() => applyAction({ type: "use_uv", unit_id: selectedUnitId }, { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey })}>
                    UV
                  </button>
                ) : null}
              </div>
              <div className="editor-button-row">
                {Object.entries(transformTargets ?? {}).map(([abilityId, targetIds]) =>
                  Array.isArray(targetIds) && targetIds.length > 0 ? (
                    <button
                      key={abilityId}
                      className={mode === `transform:${abilityId}` ? "step-chip selected" : "step-chip"}
                      type="button"
                      onClick={() => setMode(mode === `transform:${abilityId}` ? null : `transform:${abilityId}`)}
                    >
                      {abilityId}
                    </button>
                  ) : null,
                )}
              </div>
              <div className="editor-button-row">
                <button className="step-chip" type="button" onClick={() => applyAction({ type: "end_turn" }, {})}>
                  End Turn
                </button>
                {mode ? (
                  <button className="step-chip" type="button" onClick={() => setMode(null)}>
                    Clear Mode
                  </button>
                ) : null}
              </div>
            </div>

            <div className="detail-card">
              <h2>Production</h2>
              <div className="editor-button-row">
                {buyableUnits.length === 0 ? (
                  <span className="muted">No buy options on selected tile.</span>
                ) : (
                  buyableUnits.map((unitId) => (
                    <button
                      key={unitId}
                      className="step-chip"
                      type="button"
                      onClick={() =>
                        applyAction(
                          {
                            type: "buy_unit",
                            tile_coord: selectedTile?.coord,
                            unit_id: unitId,
                          },
                          { nextSelectedTileKey: selectedTileKey },
                        )
                      }
                    >
                      {config?.units?.[unitId]?.display_name ?? unitId}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="detail-card">
              <h2>Tile Inspector</h2>
              {selectedTile ? (
                <>
                  <div className="visual-inspector">
                    <img className="terrain-inspector-sprite" src={terrainAsset(selectedTile.terrain_id)} alt={selectedTile.terrain_id} />
                    <div className="visual-copy">
                      <strong>{config?.terrains?.[selectedTile.terrain_id]?.display_name ?? selectedTile.terrain_id}</strong>
                      <span>{coordKey(selectedTile.coord)}</span>
                      <span>Owner: {selectedTile.owner_id ?? "-"}</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="muted">null</div>
              )}
            </div>

            <div className="detail-card">
              <h2>Unit Inspector</h2>
              {selectedUnit ? (
                <>
                  <div className="visual-inspector">
                    <img className="unit-inspector-icon" src={unitAsset(selectedUnit.unit_id, selectedUnit.owner_id)} alt={selectedUnit.unit_id} />
                    <div className="visual-copy">
                      <strong>{config?.units?.[selectedUnit.unit_id]?.display_name ?? selectedUnit.unit_id}</strong>
                      <span>Owner: {selectedUnit.owner_id}</span>
                      <span>HP: {selectedUnit.hp}</span>
                      <span>Layer: {selectedUnit.status?.hidden_mode ?? "surface"}</span>
                    </div>
                  </div>
                  <pre>{pretty(selectedUnit)}</pre>
                </>
              ) : (
                <div className="muted">null</div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
