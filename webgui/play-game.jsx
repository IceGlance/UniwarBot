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

function hexDistance(left, right) {
  const dq = Number(left.q) - Number(right.q);
  const dr = Number(left.r) - Number(right.r);
  const ds = (Number(left.q) + Number(left.r)) - (Number(right.q) + Number(right.r));
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
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
  if (unit?.capture_target) {
    badges.push({ text: "CA", className: "status-badge-capture" });
  }
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

function ProductionUnitButton({ option, config, ownerId, onBuy }) {
  const unitId = String(option?.unit_id ?? "");
  const unitConfig = config?.units?.[unitId] ?? {};
  const displayName = unitConfig.display_name ?? unitId;
  const cost = Number(option?.cost ?? 0);
  const canAfford = Boolean(option?.can_afford);
  return (
    <button
      className={canAfford ? "production-unit-button" : "production-unit-button disabled"}
      type="button"
      disabled={!canAfford}
      onClick={onBuy}
      title={`${displayName} (${cost})`}
    >
      <img
        className="production-unit-sprite"
        src={unitAsset(unitId, ownerId)}
        alt={displayName}
      />
      <span className="production-unit-cost">{cost}</span>
    </button>
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
  const [lastCompoundMove, setLastCompoundMove] = useState(null);
  const [mode, setMode] = useState(null);
  const [error, setError] = useState("");
  const [seedDraft, setSeedDraft] = useState("");
  const [creditsDrafts, setCreditsDrafts] = useState({});
  const [unitHpDraft, setUnitHpDraft] = useState("");
  const [unitVeterancyDraft, setUnitVeterancyDraft] = useState("0");
  const [zoom, setZoom] = useState(0.9);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanningBoard, setIsPanningBoard] = useState(false);
  const selectedUnitIdRef = useRef(null);
  const selectedTileKeyRef = useRef(null);
  const lastCompoundMoveRef = useRef(null);
  const boardViewportRef = useRef(null);
  const boardSvgRef = useRef(null);
  const playOptionsRequestRef = useRef(0);
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
    const requestId = playOptionsRequestRef.current + 1;
    playOptionsRequestRef.current = requestId;
    setPlayOptions(null);
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
      .then((payload) => {
        if (playOptionsRequestRef.current !== requestId) {
          return;
        }
        setPlayOptions(payload);
      })
      .catch((reason) => {
        if (playOptionsRequestRef.current !== requestId) {
          return;
        }
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

  useEffect(() => {
    setSeedDraft(currentStateValue?.current_rseed == null ? "" : String(currentStateValue.current_rseed));
    const nextCredits = {};
    for (const [playerId, player] of Object.entries(currentStateValue?.players ?? {})) {
      nextCredits[playerId] = String(player?.credits ?? 0);
    }
    setCreditsDrafts(nextCredits);
  }, [currentStateValue?.current_rseed, currentStateValue?.players]);

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
  const selectedTileOccupantIds = selectedTile ? occupantUnitIdsForTile(selectedTile, units) : [];
  const selectedTileOccupants = selectedTileOccupantIds.map((unitId) => units[unitId]).filter(Boolean);
  const moveInfo = playOptions?.possible_moves ?? null;
  const specialOptions = playOptions?.special_options ?? null;
  const moveDestinations = new Set(moveInfo?.legal_move_destinations ?? []);
  const moveAttackTargets = moveInfo?.move_attack_targets ?? {};
  const moveAttackPreviews = moveInfo?.move_attack_previews ?? {};
  const attackTargetIds = new Set(moveInfo?.current_attack_targets ?? []);
  const currentAttackPreviews = moveInfo?.current_attack_previews ?? {};
  const compoundPreviewTargetIds = (
    lastCompoundMove
    && lastCompoundMove.unitId === selectedUnitId
    && Array.isArray(lastCompoundMove.targetIds)
  ) ? [...lastCompoundMove.targetIds] : [];
  const displayedAttackTargetIds = (
    attackTargetIds.size > 0 ? Array.from(attackTargetIds) : compoundPreviewTargetIds
  );
  const displayedAttackPreviews = attackTargetIds.size > 0
    ? currentAttackPreviews
    : (
      lastCompoundMove
      && lastCompoundMove.unitId === selectedUnitId
      && lastCompoundMove.previews
    ) ? lastCompoundMove.previews : {};
  const plagueTargetIds = new Set(specialOptions?.plague_targets ?? []);
  const teleportDestinations = new Set(specialOptions?.teleport_destinations ?? []);
  const transformTargets = specialOptions?.transform_targets ?? {};
  const productionOptions = playOptions?.production_options ?? [];
  const affordableProductionOptions = productionOptions.filter((option) => Boolean(option?.can_afford));
  const unaffordableProductionOptions = productionOptions.filter((option) => !Boolean(option?.can_afford));
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
    const unitsById = currentStateValue?.units ?? {};
    return playerEntries.map((player) => {
      const income = tiles.reduce((total, tile) => {
        if (tile.terrain_id === "city") {
          const occupantId = tile.surface_unit_id;
          const occupant = occupantId ? unitsById?.[occupantId] : null;
          return occupant?.owner_id === player.playerId
            ? total + incomePerCity
            : total;
        }
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

  useEffect(() => {
    if (!selectedUnit) {
      setUnitHpDraft("");
      setUnitVeterancyDraft("0");
      return;
    }
    setUnitHpDraft(String(selectedUnit.hp ?? ""));
    setUnitVeterancyDraft(String(selectedUnit.veterancy_level ?? 0));
  }, [selectedUnitId, selectedUnit?.hp, selectedUnit?.veterancy_level]);

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
    selectedUnitIdRef.current = nextSelectedUnitId;
    selectedTileKeyRef.current = nextSelectedTileKey;
    setGameState(nextState);
    setSelectedUnitId(nextSelectedUnitId);
    setSelectedTileKey(nextSelectedTileKey);
    setMode(nextMode);
  }

  function setCompoundMoveCandidate(candidate) {
    lastCompoundMoveRef.current = candidate;
    setLastCompoundMove(candidate);
  }

  function pushHistory(nextState, label) {
    setHistory((previous) => {
      const base = previous.slice(0, historyIndex + 1);
      const next = [...base, { state: nextState, label }];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }

  function replaceCurrentHistoryEntry(nextState, label) {
    setHistory((previous) => {
      const cutoff = Math.max(0, historyIndex);
      const base = previous.slice(0, cutoff);
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
        setCompoundMoveCandidate(null);
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
        setCompoundMoveCandidate(null);
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

  function handleManualSeedApply() {
    if (!currentStateValue) {
      return;
    }
    const parsedSeed = nullableInt(seedDraft);
    if (parsedSeed == null || Number.isNaN(parsedSeed)) {
      setError("Seed must be a number.");
      return;
    }
    applyAction({ type: "manual_set_seed", seed: parsedSeed }, {}, { clearCompoundMove: true });
  }

  function handleManualCreditsApply(playerId) {
    if (!currentStateValue) {
      return;
    }
    const parsedCredits = nullableInt(creditsDrafts[playerId] ?? "");
    if (parsedCredits == null || Number.isNaN(parsedCredits) || parsedCredits < 0) {
      setError("Credits must be a non-negative number.");
      return;
    }
    applyAction(
      { type: "manual_set_player_credits", player_id: playerId, credits: parsedCredits },
      {},
      { clearCompoundMove: true },
    );
  }

  function handleManualUnitApply() {
    if (!selectedUnitId || !selectedTileKey) {
      return;
    }
    const parsedHp = nullableInt(unitHpDraft);
    const parsedVeterancy = nullableInt(unitVeterancyDraft);
    if (parsedHp == null || Number.isNaN(parsedHp) || parsedHp < 0) {
      setError("HP must be a non-negative number.");
      return;
    }
    if (parsedVeterancy == null || Number.isNaN(parsedVeterancy) || parsedVeterancy < 0 || parsedVeterancy > 2) {
      setError("Veterancy must be 0, 1, or 2.");
      return;
    }
    applyAction(
      {
        type: "manual_set_unit_state",
        unit_id: selectedUnitId,
        hp: parsedHp,
        veterancy_level: parsedVeterancy,
      },
      { nextSelectedUnitId: selectedUnitId, nextSelectedTileKey: selectedTileKey },
      { clearCompoundMove: true },
    );
  }

  function applyAction(action, options = {}, behavior = {}) {
    const {
      stateOverride = null,
      replaceCurrentHistory = false,
      nextCompoundMove = null,
      clearCompoundMove = true,
    } = behavior;
    const baseState = stateOverride ?? currentStateValue;
    if (!baseState) {
      return;
    }
    setError("");
    fetch(`${API_BASE}/play-game/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: baseState,
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
        if (replaceCurrentHistory) {
          replaceCurrentHistoryEntry(nextState, action.type);
        } else {
          pushHistory(nextState, action.type);
        }
        if (clearCompoundMove) {
          setCompoundMoveCandidate(null);
        } else {
          setCompoundMoveCandidate(nextCompoundMove);
        }
        resetInteraction(nextState, options);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }

  function selectTileAndUnit(tileKey, preferredUnitId = null) {
    const previousTileKey = selectedTileKeyRef.current;
    const previousSelectedUnitId = selectedUnitIdRef.current;
    selectedTileKeyRef.current = tileKey;
    setSelectedTileKey(tileKey);
    const compoundCandidate = lastCompoundMoveRef.current;
    if (preferredUnitId) {
      selectedUnitIdRef.current = preferredUnitId;
      setSelectedUnitId(preferredUnitId);
      if (!compoundCandidate || compoundCandidate.unitId !== preferredUnitId) {
        setCompoundMoveCandidate(null);
      }
      return;
    }
    const tile = tileByKey.get(tileKey);
    if (!tile) {
      selectedUnitIdRef.current = null;
      setSelectedUnitId(null);
      setCompoundMoveCandidate(null);
      return;
    }
    const occupantIds = occupantUnitIdsForTile(tile, units);
    let unitId = occupantIds[0] ?? null;
    if (previousTileKey === tileKey && occupantIds.length > 1) {
      const currentIndex = occupantIds.indexOf(previousSelectedUnitId);
      unitId = occupantIds[(currentIndex + 1 + occupantIds.length) % occupantIds.length];
    }
    selectedUnitIdRef.current = unitId;
    setSelectedUnitId(unitId);
    if (!compoundCandidate || compoundCandidate.unitId !== unitId) {
      setCompoundMoveCandidate(null);
    }
  }

  function fetchSelectionOptions(unitId, tileKey = selectedTileKeyRef.current) {
    if (!currentStateValue || !unitId) {
      return Promise.resolve(null);
    }
    return fetch(`${API_BASE}/play-game/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: currentStateValue,
        selected_unit_id: unitId,
        selected_tile: tileKey ? parseCoordKey(tileKey) : null,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.detail ?? `Failed to load options: ${response.status}`);
        }
        return response.json();
      });
  }

  function resolveAttackActionForUnit(attackerId, defender) {
    if (!attackerId || !defender) {
      return Promise.resolve(null);
    }
    const attacker = units[attackerId];
    if (!attacker || attacker.owner_id !== activePlayerId) {
      return Promise.resolve(null);
    }
    const attackerTileKey = coordKey(attacker.position);
    return fetchSelectionOptions(attackerId, attackerTileKey).then((optionsPayload) => {
      if (!optionsPayload) {
        return null;
      }
      const optionMoveInfo = optionsPayload?.possible_moves ?? {};
      const currentTargets = new Set(optionMoveInfo.current_attack_targets ?? []);
      if (currentTargets.has(defender.instance_id)) {
        return {
          action: {
            type: "attack_unit",
            attacker_id: attackerId,
            defender_id: defender.instance_id,
          },
          selection: {
            nextSelectedUnitId: attackerId,
            nextSelectedTileKey: attackerTileKey,
            nextMode: null,
          },
        };
      }
      const optionMoveAttackTargets = optionMoveInfo.move_attack_targets ?? {};
      const destinationEntry = Object.entries(optionMoveAttackTargets).find(([, targets]) =>
        Array.isArray(targets) && targets.includes(defender.instance_id),
      );
      if (!destinationEntry) {
        return null;
      }
      const destination = parseCoordKey(destinationEntry[0]);
      return {
        action: {
          type: "move_then_attack",
          unit_id: attackerId,
          destination,
          defender_id: defender.instance_id,
        },
        selection: {
          nextSelectedUnitId: attackerId,
          nextSelectedTileKey: coordKey(destination),
          nextMode: null,
        },
      };
    });
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

function occupantUnitIdsForTile(tile, unitsById) {
  if (!tile) {
    return [];
  }
  const result = [];
  if (tile.surface_unit_id && unitsById[tile.surface_unit_id]) {
    result.push(tile.surface_unit_id);
  }
  if (tile.hidden_unit_id && unitsById[tile.hidden_unit_id]) {
    result.push(tile.hidden_unit_id);
  }
  return result;
}

  function chooseMoveAttackDestination(targetUnitId) {
    if (!selectedUnitId || !selectedUnit) {
      return null;
    }
    const candidates = Object.entries(moveAttackTargets ?? {})
      .filter(([, targetIds]) => Array.isArray(targetIds) && targetIds.includes(targetUnitId))
      .map(([destinationKey]) => parseCoordKey(destinationKey));
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((left, right) => {
      const byDistance = hexDistance(selectedUnit.position, left) - hexDistance(selectedUnit.position, right);
      if (byDistance !== 0) {
        return byDistance;
      }
      const byQ = Number(left.q) - Number(right.q);
      if (byQ !== 0) {
        return byQ;
      }
      return Number(left.r) - Number(right.r);
    });
    return candidates[0];
  }

  function handleTileClick(tile, clickedUnitOverride = null) {
    const tileKey = coordKey(tile.coord);
    const clickedUnit = clickedUnitOverride ?? targetUnitAtTile(tile);
    const actingUnitId = selectedUnitIdRef.current;
    if (
      clickedUnit &&
      clickedUnit.owner_id === activePlayerId &&
      clickedUnit.instance_id !== actingUnitId
    ) {
      selectTileAndUnit(tileKey, clickedUnit.instance_id);
      setPlayOptions(null);
      setMode(null);
      return;
    }
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
      actingUnitId &&
      clickedUnit &&
      clickedUnit.instance_id !== actingUnitId &&
      clickedUnit.owner_id !== activePlayerId
    ) {
      resolveAttackActionForUnit(actingUnitId, clickedUnit)
        .then((primaryResolution) => {
          if (primaryResolution) {
            applyAction(primaryResolution.action, primaryResolution.selection);
            return;
          }
          const compoundCandidate = lastCompoundMoveRef.current;
          if (
            compoundCandidate
            && compoundCandidate.unitId === actingUnitId
            && Array.isArray(compoundCandidate.targetIds)
            && compoundCandidate.targetIds.includes(clickedUnit.instance_id)
          ) {
            applyAction(
              {
                type: "move_then_attack",
                unit_id: actingUnitId,
                destination: compoundCandidate.destination,
                defender_id: clickedUnit.instance_id,
              },
              {
                nextSelectedUnitId: actingUnitId,
                nextSelectedTileKey: compoundCandidate.destinationKey,
                nextMode: null,
              },
              {
                stateOverride: compoundCandidate.originState,
                replaceCurrentHistory: true,
                clearCompoundMove: true,
              },
            );
            return;
          }
          setError("Selected unit cannot attack the chosen target.");
          selectTileAndUnit(tileKey, clickedUnit.instance_id);
        })
        .catch((reason) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      return;
    }
    if (actingUnitId && moveDestinations.has(tileKey)) {
      const moveAttackTargetIds = Array.isArray(moveAttackTargets?.[tileKey])
        ? [...moveAttackTargets[tileKey]]
        : [];
      const moveAttackPreviewMap = moveAttackPreviews?.[tileKey] ?? {};
      const originState = currentStateValue;
      applyAction(
        {
          type: "move_unit",
          unit_id: actingUnitId,
          destination: tile.coord,
        },
        { nextSelectedUnitId: actingUnitId, nextSelectedTileKey: tileKey, nextMode: null },
        {
          nextCompoundMove: moveAttackTargetIds.length > 0
            ? {
              unitId: actingUnitId,
              destination: tile.coord,
              destinationKey: tileKey,
              targetIds: moveAttackTargetIds,
              previews: moveAttackPreviewMap,
              originState,
            }
            : null,
          clearCompoundMove: moveAttackTargetIds.length === 0,
        },
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
    setCompoundMoveCandidate(null);
    resetInteraction(history[nextIndex].state);
  }

  function handleHistoryRedo() {
    if (historyIndex < 0 || historyIndex >= history.length - 1) {
      return;
    }
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    setCompoundMoveCandidate(null);
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
    setCompoundMoveCandidate(null);
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
    setCompoundMoveCandidate(null);
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
                  </div>
                    <div className="playgame-state-seed">
                      <span>{`Seed ${currentStateValue.current_rseed}`}</span>
                    </div>
                    <div className="playgame-inline-editor">
                      <input
                        type="number"
                        value={seedDraft}
                        onChange={(event) => setSeedDraft(event.target.value)}
                      />
                      <button className="step-chip" type="button" onClick={handleManualSeedApply}>
                        Set Seed
                      </button>
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
                    <div className="playgame-inline-editor">
                      <input
                        type="number"
                        value={creditsDrafts[player.playerId] ?? ""}
                        onChange={(event) =>
                          setCreditsDrafts((previous) => ({
                            ...previous,
                            [player.playerId]: event.target.value,
                          }))
                        }
                      />
                      <button className="step-chip" type="button" onClick={() => handleManualCreditsApply(player.playerId)}>
                        Set
                      </button>
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

                {selectedUnitId ? displayedAttackTargetIds.map((targetId) => {
                  const unit = units[targetId];
                  if (!unit) {
                    return null;
                  }
                  const center = axialToPixel(unit.position);
                  const preview = displayedAttackPreviews[targetId] ?? null;
                  return (
                    <g key={`attack-${targetId}`} transform={`translate(${center.x}, ${center.y})`} pointerEvents="none">
                      <polygon
                        points={hexPoints(0, 0, BASE_HEX_SIZE)}
                        fill="rgba(0,0,0,0)"
                        stroke="rgba(220, 38, 38, 0.95)"
                        strokeWidth="3.2"
                      />
                      {preview ? (
                        <g className="attack-preview" transform="translate(0,18)">
                          <text className="attack-preview-direct" x="-8" y="0">
                            {preview.direct_damage}
                          </text>
                          <text className="attack-preview-retaliation" x="8" y="0">
                            {preview.retaliation_damage}
                          </text>
                        </g>
                      ) : null}
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
              {productionOptions.length === 0 ? (
                <span className="muted">No production on selected tile.</span>
              ) : (
                <div className="production-groups">
                  <div className="production-group">
                    <div className="production-group-label">Can produce</div>
                    {affordableProductionOptions.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      <div className="production-grid">
                        {affordableProductionOptions.map((option) => (
                          <ProductionUnitButton
                            key={String(option.unit_id)}
                            option={option}
                            config={config}
                            ownerId={activePlayerId}
                            onBuy={() =>
                              applyAction(
                                {
                                  type: "buy_unit",
                                  tile_coord: selectedTile?.coord,
                                  unit_id: String(option.unit_id),
                                },
                                { nextSelectedTileKey: selectedTileKey },
                              )
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="production-group blocked">
                    <div className="production-group-label">Not enough credits</div>
                    {unaffordableProductionOptions.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      <div className="production-grid">
                        {unaffordableProductionOptions.map((option) => (
                          <ProductionUnitButton
                            key={String(option.unit_id)}
                            option={option}
                            config={config}
                            ownerId={activePlayerId}
                            onBuy={() => {}}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
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
                    {selectedTileOccupants.length > 1 ? (
                      <div className="occupant-switcher">
                        {selectedTileOccupants.map((unit) => (
                          <button
                            key={unit.instance_id}
                            className={`occupant-chip ${selectedUnitId === unit.instance_id ? "selected" : ""}`}
                            type="button"
                            onClick={() => selectTileAndUnit(coordKey(selectedTile.coord), unit.instance_id)}
                          >
                          <img
                            className="occupant-chip-sprite"
                            src={unitAsset(unit.unit_id, unit.owner_id)}
                            alt={unit.unit_id}
                          />
                          <span>{config?.units?.[unit.unit_id]?.display_name ?? unit.unit_id}</span>
                          <span className="occupant-chip-layer">
                            {unit.status?.hidden_mode ?? "surface"}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
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
                    <div className="playgame-unit-editor">
                      <label>
                        <div className="field-label">HP</div>
                        <input
                          type="number"
                          value={unitHpDraft}
                          onChange={(event) => setUnitHpDraft(event.target.value)}
                        />
                      </label>
                      <label>
                        <div className="field-label">Vet</div>
                        <select
                          value={unitVeterancyDraft}
                          onChange={(event) => setUnitVeterancyDraft(event.target.value)}
                        >
                          <option value="0">0</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                        </select>
                      </label>
                      <button className="step-chip" type="button" onClick={handleManualUnitApply}>
                        Apply
                      </button>
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
