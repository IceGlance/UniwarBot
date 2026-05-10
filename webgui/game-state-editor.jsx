const { useEffect, useMemo, useRef, useState } = React;

const BASE_HEX_SIZE = 32;
const MIN_BOARD_WORLD_WIDTH = 880;
const MIN_BOARD_WORLD_HEIGHT = 620;
const DELETE_BRUSH_ID = "__delete__";
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
  return `editor-tile-clip-${coord.q}-${coord.r}`;
}

function axialToPixel(coord) {
  const x = BASE_HEX_SIZE * Math.sqrt(3) * (coord.q + coord.r / 2);
  const y = BASE_HEX_SIZE * 1.5 * coord.r;
  return { x, y };
}

function roundAxial(q, r) {
  let cubeX = q;
  let cubeZ = r;
  let cubeY = -cubeX - cubeZ;

  let rx = Math.round(cubeX);
  let ry = Math.round(cubeY);
  let rz = Math.round(cubeZ);

  const xDiff = Math.abs(rx - cubeX);
  const yDiff = Math.abs(ry - cubeY);
  const zDiff = Math.abs(rz - cubeZ);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
}

function pixelToAxial(pointX, pointY) {
  const q = ((Math.sqrt(3) / 3) * pointX - pointY / 3) / BASE_HEX_SIZE;
  const r = ((2 / 3) * pointY) / BASE_HEX_SIZE;
  return roundAxial(q, r);
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
  return `./public/gui-assets/terrains/${terrainId}.png`;
}

function pretty(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function suggestCityIncome(baseIncome) {
  return Math.ceil((Number(baseIncome || 0) / 2) / 5) * 5;
}

function buildBlankMap(config, width, height, playerCount, fillTerrainId = "plain") {
  const factions = config?.factions ?? [];
  return {
    schema_version: "map-editor-v1",
    map_id: "new-map",
    name: "New Map",
    file_name: "",
    size: { width, height },
    player_count: playerCount,
    players: Array.from({ length: playerCount }, (_, index) => ({
      player_id: `p${index + 1}`,
      allowed_factions: [...factions],
    })),
    economy: {
      base_income: config?.defaults?.base_income ?? 100,
      city_income: config?.defaults?.city_income ?? 50,
      starting_credits: config?.defaults?.starting_credits ?? 100,
    },
    tiles: Array.from({ length: height }, (_, r) =>
      Array.from({ length: width }, (_, q) => ({
        coord: { q, r },
        terrain_id: fillTerrainId,
        owner_id: null,
      })),
    ).flat(),
  };
}

function cloneMapPayload(map) {
  return JSON.parse(JSON.stringify(map));
}

function updateMapName(current, nextName) {
  return {
    ...current,
    name: nextName,
    map_id: nextName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-map",
  };
}

function terrainAllowsOwner(terrainConfig, terrainId) {
  return Boolean(terrainConfig?.terrains?.[terrainId]?.capturable);
}

function normalizePlayers(players, playerCount, factions) {
  return Array.from({ length: playerCount }, (_, index) => {
    const source = players?.[index];
    const allowedSet = new Set(
      Array.isArray(source?.allowed_factions) ? source.allowed_factions.filter((item) => factions.includes(item)) : factions,
    );
    if (allowedSet.size === 0) {
      factions.forEach((item) => allowedSet.add(item));
    }
    return {
      player_id: `p${index + 1}`,
      allowed_factions: Array.from(allowedSet),
    };
  });
}

function resizeMapKeepingTiles(map, nextWidth, nextHeight, terrainConfig) {
  const nextMap = cloneMapPayload(map);
  nextMap.size = { width: nextWidth, height: nextHeight };
  nextMap.tiles = (nextMap.tiles ?? [])
    .filter((tile) => tile.coord.q >= 0 && tile.coord.q < nextWidth && tile.coord.r >= 0 && tile.coord.r < nextHeight)
    .map((tile) => ({
      ...tile,
      owner_id: terrainAllowsOwner(terrainConfig, tile.terrain_id) ? tile.owner_id ?? null : null,
    }));
  return nextMap;
}

function editorMapBounds(tiles) {
  if (tiles.length === 0) {
    return { minX: 0, minY: 0, width: MIN_BOARD_WORLD_WIDTH, height: MIN_BOARD_WORLD_HEIGHT };
  }
  const centers = tiles.map((tile) => axialToPixel(tile.coord));
  const minX = Math.min(...centers.map((center) => center.x)) - BASE_HEX_SIZE - 34;
  const maxX = Math.max(...centers.map((center) => center.x)) + BASE_HEX_SIZE + 34;
  const minY = Math.min(...centers.map((center) => center.y)) - BASE_HEX_SIZE - 34;
  const maxY = Math.max(...centers.map((center) => center.y)) + BASE_HEX_SIZE + 34;
  const rawWidth = maxX - minX;
  const rawHeight = maxY - minY;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const width = Math.max(rawWidth, MIN_BOARD_WORLD_WIDTH);
  const height = Math.max(rawHeight, MIN_BOARD_WORLD_HEIGHT);
  return {
    minX: centerX - width / 2,
    minY: centerY - height / 2,
    width,
    height,
  };
}

function App() {
  const [activeControlsTab, setActiveControlsTab] = useState("map");
  const [config, setConfig] = useState(null);
  const [savedMaps, setSavedMaps] = useState([]);
  const [mapData, setMapData] = useState(null);
  const [selectedTileKey, setSelectedTileKey] = useState(null);
  const [selectedTerrainId, setSelectedTerrainId] = useState("plain");
  const [recreateTerrainId, setRecreateTerrainId] = useState("plain");
  const [selectedLoadFile, setSelectedLoadFile] = useState("");
  const [draftWidth, setDraftWidth] = useState(8);
  const [draftHeight, setDraftHeight] = useState(8);
  const [fileNameInput, setFileNameInput] = useState("new-map.json");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(0.9);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanningBoard, setIsPanningBoard] = useState(false);
  const boardSvgRef = useRef(null);
  const boardViewportRef = useRef(null);
  const boardPanRef = useRef({
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
    hasDragged: false,
  });
  const suppressBoardClickRef = useRef(false);

  const refreshSavedMaps = () => {
    fetch(`${API_BASE}/maps`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load maps: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        setSavedMaps(payload);
        if (payload.length > 0 && !selectedLoadFile) {
          setSelectedLoadFile(payload[0].file_name);
        }
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/map-editor/config`).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load editor config: ${response.status}`);
        }
        return response.json();
      }),
      fetch(`${API_BASE}/maps`).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load maps: ${response.status}`);
        }
        return response.json();
      }),
    ])
      .then(([configPayload, mapsPayload]) => {
        setConfig(configPayload);
        setSavedMaps(mapsPayload);
        if (mapsPayload.length > 0) {
          setSelectedLoadFile(mapsPayload[0].file_name);
        }
        const starterMap = buildBlankMap(
          configPayload,
          configPayload.defaults.width,
          configPayload.defaults.height,
          configPayload.defaults.player_count,
        );
        setMapData(starterMap);
        setDraftWidth(starterMap.size.width);
        setDraftHeight(starterMap.size.height);
        setSelectedTerrainId(configPayload.terrain_order?.[0] ?? "plain");
        setRecreateTerrainId(configPayload.terrain_order?.[0] ?? "plain");
        setFileNameInput("new-map.json");
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const tiles = mapData?.tiles ?? [];
  const tileByKey = useMemo(() => new Map(tiles.map((tile) => [coordKey(tile.coord), tile])), [tiles]);
  const selectedTile = selectedTileKey ? tileByKey.get(selectedTileKey) ?? null : null;
  const playerOptions = useMemo(
    () => Array.from({ length: Number(mapData?.player_count ?? 0) }, (_, index) => `p${index + 1}`),
    [mapData?.player_count],
  );

  const boardBounds = useMemo(() => editorMapBounds(tiles), [tiles]);
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
  }, [boardBounds, zoom, panOffset.x, panOffset.y]);

  const setMapAndSyncDrafts = (nextMap) => {
    setMapData(nextMap);
    setDraftWidth(nextMap.size.width);
    setDraftHeight(nextMap.size.height);
  };

  const updateTile = (tileKey, updater) => {
    setMapData((current) => {
      if (!current) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      nextMap.tiles = nextMap.tiles.map((tile) => {
        if (coordKey(tile.coord) !== tileKey) {
          return tile;
        }
        return updater({ ...tile });
      });
      return nextMap;
    });
  };

  const upsertTileAtCoord = (coord, terrainId) => {
    setMapData((current) => {
      if (!current || !config) {
        return current;
      }
      const shiftQ = coord.q < 0 ? -coord.q : 0;
      const shiftR = coord.r < 0 ? -coord.r : 0;
      const targetCoord = {
        q: coord.q + shiftQ,
        r: coord.r + shiftR,
      };
      const nextMap = cloneMapPayload(current);
      if (shiftQ > 0 || shiftR > 0) {
        nextMap.tiles = (nextMap.tiles ?? []).map((tile) => ({
          ...tile,
          coord: {
            q: tile.coord.q + shiftQ,
            r: tile.coord.r + shiftR,
          },
        }));
      }
      nextMap.size = {
        width: Math.max(nextMap.size.width + shiftQ, targetCoord.q + 1),
        height: Math.max(nextMap.size.height + shiftR, targetCoord.r + 1),
      };
      const key = coordKey(targetCoord);
      const nextTiles = [...(nextMap.tiles ?? [])];
      const existingIndex = nextTiles.findIndex((tile) => coordKey(tile.coord) === key);
      const nextTile = {
        coord: { q: targetCoord.q, r: targetCoord.r },
        terrain_id: terrainId,
        owner_id: null,
      };
      if (existingIndex >= 0) {
        nextTiles[existingIndex] = nextTile;
      } else {
        nextTiles.push(nextTile);
      }
      nextTiles.sort((left, right) => left.coord.r - right.coord.r || left.coord.q - right.coord.q);
      nextMap.tiles = nextTiles;
      if (selectedTileKey) {
        const [selectedQ, selectedR] = selectedTileKey.split(":").map((value) => Number(value));
        if (!Number.isNaN(selectedQ) && !Number.isNaN(selectedR) && (shiftQ > 0 || shiftR > 0)) {
          setSelectedTileKey(coordKey({ q: selectedQ + shiftQ, r: selectedR + shiftR }));
        }
      }
      return nextMap;
    });
  };

  const deleteTileAtCoord = (coord) => {
    setMapData((current) => {
      if (!current) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      nextMap.tiles = (nextMap.tiles ?? []).filter((tile) => coordKey(tile.coord) !== coordKey(coord));
      return nextMap;
    });
  };

  const applyTerrainToTile = (tileKey, terrainId) => {
    if (terrainId === DELETE_BRUSH_ID) {
      const tile = tileByKey.get(tileKey);
      if (tile) {
        deleteTileAtCoord(tile.coord);
      }
      if (selectedTileKey === tileKey) {
        setSelectedTileKey(null);
      }
      return;
    }
    updateTile(tileKey, (tile) => ({
      ...tile,
      terrain_id: terrainId,
      owner_id: terrainAllowsOwner(config, terrainId) ? tile.owner_id : null,
    }));
  };

  const selectAndPaintTile = (tile) => {
    const key = coordKey(tile.coord);
    setSelectedTileKey(selectedTerrainId === DELETE_BRUSH_ID ? null : key);
    if (activeControlsTab === "terrain" && selectedTerrainId) {
      applyTerrainToTile(key, selectedTerrainId);
    }
  };

  const createOrPaintHexFromBoardClick = (event) => {
    const svg = boardSvgRef.current;
    if (!svg || activeControlsTab !== "terrain" || selectedTerrainId === DELETE_BRUSH_ID) {
      return;
    }
    if (suppressBoardClickRef.current) {
      return;
    }
    const target = event.target;
    if (target !== event.currentTarget && target?.dataset?.boardCreate !== "1") {
      return;
    }
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = event.clientX;
    screenPoint.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      return;
    }
    const worldPoint = screenPoint.matrixTransform(ctm.inverse());
    const worldX = worldPoint.x;
    const worldY = worldPoint.y;
    const coord = pixelToAxial(worldX, worldY);
    upsertTileAtCoord(coord, selectedTerrainId);
  };

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
    const session = boardPanRef.current;
    if (!viewport || session.pointerId !== event.pointerId) {
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

  const changePlayerCount = (nextCount) => {
    setMapData((current) => {
      if (!current || !config) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      nextMap.player_count = nextCount;
      nextMap.players = normalizePlayers(nextMap.players, nextCount, config.factions);
      const validOwners = new Set(Array.from({ length: nextCount }, (_, index) => `p${index + 1}`));
      nextMap.tiles = nextMap.tiles.map((tile) => ({
        ...tile,
        owner_id: validOwners.has(tile.owner_id) ? tile.owner_id : null,
      }));
      return nextMap;
    });
  };

  const changeBaseIncome = (nextValue) => {
    setMapData((current) => {
      if (!current) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      const previousBase = Number(nextMap.economy.base_income ?? 0);
      const previousSuggested = suggestCityIncome(previousBase);
      nextMap.economy.base_income = nextValue;
      if (Number(nextMap.economy.city_income ?? 0) === previousSuggested) {
        nextMap.economy.city_income = suggestCityIncome(nextValue);
      }
      return nextMap;
    });
  };

  const applyResize = () => {
    setMapData((current) => {
      if (!current || !config) {
        return current;
      }
      return resizeMapKeepingTiles(current, Math.max(1, draftWidth), Math.max(1, draftHeight), config);
    });
    setSelectedTileKey(null);
  };

  const loadSelectedMap = () => {
    if (!selectedLoadFile) {
      return;
    }
    fetch(`${API_BASE}/maps/${encodeURIComponent(selectedLoadFile)}`)
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.detail ? String(payload.detail) : `Failed to load map: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        setMapAndSyncDrafts(payload);
        setSelectedTileKey(null);
        setFileNameInput(payload.file_name ?? selectedLoadFile);
        setError("");
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  const saveMap = (mode) => {
    if (!mapData) {
      return;
    }
    const fileName = mode === "save" ? mapData.file_name || fileNameInput : fileNameInput;
    fetch(`${API_BASE}/maps/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_name: fileName,
        map: mapData,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.detail ? String(payload.detail) : `Failed to save map: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        setMapAndSyncDrafts(payload);
        setFileNameInput(payload.file_name ?? fileName);
        setSelectedLoadFile(payload.file_name ?? fileName);
        setError("");
        refreshSavedMaps();
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  const createNewMap = () => {
    if (!config) {
      return;
    }
    const blank = buildBlankMap(
      config,
      draftWidth,
      draftHeight,
      Number(mapData?.player_count ?? config.defaults.player_count),
      "plain",
    );
    setMapAndSyncDrafts(blank);
    setFileNameInput("new-map.json");
    setSelectedTileKey(null);
    setError("");
  };

  const recreateMapWithTile = () => {
    if (!config) {
      return;
    }
    const recreated = buildBlankMap(
      config,
      Math.max(1, draftWidth),
      Math.max(1, draftHeight),
      Number(mapData?.player_count ?? config.defaults.player_count),
      recreateTerrainId,
    );
    recreated.name = mapData?.name ?? recreated.name;
    recreated.map_id = mapData?.map_id ?? recreated.map_id;
    recreated.economy = cloneMapPayload(mapData?.economy ?? recreated.economy);
    recreated.players = cloneMapPayload(
      normalizePlayers(mapData?.players, recreated.player_count, config.factions),
    );
    setMapAndSyncDrafts(recreated);
    setSelectedTileKey(null);
    setError("");
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>UniwarBot Game State Editor</h1>
          <p>Create and save map JSON locally with terrain painting, player settings, ownership, and economy controls.</p>
        </div>
        <div className="status-cards">
          <div className="status-card">
            <span>Map Size</span>
            <strong>{mapData ? `${mapData.size.width} x ${mapData.size.height}` : "-"}</strong>
          </div>
          <div className="status-card">
            <span>Players</span>
            <strong>{mapData?.player_count ?? "-"}</strong>
          </div>
          <div className="status-card">
            <span>File</span>
            <strong>{mapData?.file_name || "unsaved"}</strong>
          </div>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}
      <main className="workspace-grid editor-workspace-grid">
        <section className="panel panel-controls">
          <div className="panel-header">
            <h2>Map Controls</h2>
          </div>

          <div className="editor-tab-strip">
            <button
              className={`editor-tab ${activeControlsTab === "map" ? "selected" : ""}`}
              onClick={() => setActiveControlsTab("map")}
            >
              Map
            </button>
            <button
              className={`editor-tab ${activeControlsTab === "players" ? "selected" : ""}`}
              onClick={() => setActiveControlsTab("players")}
            >
              Players
            </button>
            <button
              className={`editor-tab ${activeControlsTab === "terrain" ? "selected" : ""}`}
              onClick={() => setActiveControlsTab("terrain")}
            >
              Terrain
            </button>
          </div>

          <div className="control-stack editor-control-stack">
            {activeControlsTab === "map" ? (
              <div className="editor-tab-panel">
                <label className="field-label">Map Name</label>
                <input
                  value={mapData?.name ?? ""}
                  onChange={(event) =>
                    setMapData((current) => (current ? updateMapName(current, event.target.value) : current))
                  }
                  placeholder="Map name"
                />

                <label className="field-label">File Name</label>
                <input value={fileNameInput} onChange={(event) => setFileNameInput(event.target.value)} placeholder="map-file.json" />

                <div className="editor-button-row">
                  <button className="step-chip" onClick={createNewMap}>New</button>
                  <button className="step-chip" onClick={() => saveMap("save")}>Save</button>
                  <button className="step-chip" onClick={() => saveMap("save_as")}>Save As</button>
                </div>

                <label className="field-label">Load Saved Map</label>
                <select value={selectedLoadFile} onChange={(event) => setSelectedLoadFile(event.target.value)}>
                  <option value="">Choose map file</option>
                  {savedMaps.map((item) => (
                    <option key={item.file_name} value={item.file_name}>
                      {item.name} ({item.file_name})
                    </option>
                  ))}
                </select>
                <button className="step-chip" onClick={loadSelectedMap}>Load</button>

                <div className="editor-section">
                  <span className="field-label">Map Size</span>
                  <div className="editor-inline-grid">
                    <label>
                      <span>Width</span>
                      <input type="number" min="1" value={draftWidth} onChange={(event) => setDraftWidth(Number(event.target.value || 1))} />
                    </label>
                    <label>
                      <span>Height</span>
                      <input type="number" min="1" value={draftHeight} onChange={(event) => setDraftHeight(Number(event.target.value || 1))} />
                    </label>
                  </div>
                  <button className="step-chip" onClick={applyResize}>Apply Resize</button>
                </div>

                <div className="editor-section">
                  <span className="field-label">Recreate With Tile</span>
                  <select value={recreateTerrainId} onChange={(event) => setRecreateTerrainId(event.target.value)}>
                    {(config?.terrain_order ?? []).map((terrainId) => (
                      <option key={terrainId} value={terrainId}>
                        {config?.terrains?.[terrainId]?.display_name ?? terrainId}
                      </option>
                    ))}
                  </select>
                  <button className="step-chip" onClick={recreateMapWithTile}>Recreate Map</button>
                </div>

                <div className="editor-section">
                  <span className="field-label">Economy</span>
                  <div className="editor-inline-grid">
                    <label>
                      <span>Base Income</span>
                      <input
                        type="number"
                        min="0"
                        value={mapData?.economy?.base_income ?? 0}
                        onChange={(event) => changeBaseIncome(Number(event.target.value || 0))}
                      />
                    </label>
                    <label>
                      <span>City Income</span>
                      <input
                        type="number"
                        min="0"
                        value={mapData?.economy?.city_income ?? 0}
                        onChange={(event) =>
                          setMapData((current) => (
                            current
                              ? {
                                  ...current,
                                  economy: { ...current.economy, city_income: Number(event.target.value || 0) },
                                }
                              : current
                          ))
                        }
                      />
                    </label>
                    <label>
                      <span>Start Income</span>
                      <input
                        type="number"
                        min="0"
                        value={mapData?.economy?.starting_credits ?? 0}
                        onChange={(event) =>
                          setMapData((current) => (
                            current
                              ? {
                                  ...current,
                                  economy: { ...current.economy, starting_credits: Number(event.target.value || 0) },
                                }
                              : current
                          ))
                        }
                      />
                    </label>
                  </div>
                  <button
                    className="step-chip"
                    onClick={() =>
                      setMapData((current) => (
                        current
                          ? {
                              ...current,
                              economy: {
                                ...current.economy,
                                city_income: suggestCityIncome(current.economy.base_income),
                              },
                            }
                          : current
                      ))
                    }
                  >
                    Use Suggested City Income
                  </button>
                </div>
              </div>
            ) : null}

            {activeControlsTab === "players" ? (
              <div className="editor-tab-panel">
                <div className="editor-section editor-section-first">
                  <span className="field-label">Players Count</span>
                  <input
                    type="number"
                    min="1"
                    max="8"
                    value={mapData?.player_count ?? 2}
                    onChange={(event) => changePlayerCount(Math.max(1, Math.min(8, Number(event.target.value || 1))))}
                  />
                </div>

                <div className="editor-section">
                  <span className="field-label">Allowed Races Per Player</span>
                  <div className="player-slot-stack">
                    {(mapData?.players ?? []).map((player, index) => (
                      <div key={player.player_id} className="player-slot-card">
                        <strong>{player.player_id}</strong>
                        <div className="checkbox-chip-row">
                          {(config?.factions ?? []).map((faction) => {
                            const checked = player.allowed_factions.includes(faction);
                            return (
                              <label key={faction} className={`checkbox-chip ${checked ? "checked" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() =>
                                    setMapData((current) => {
                                      const nextMap = cloneMapPayload(current);
                                      const nextPlayer = nextMap.players[index];
                                      const nextSet = new Set(nextPlayer.allowed_factions);
                                      if (nextSet.has(faction)) {
                                        if (nextSet.size > 1) {
                                          nextSet.delete(faction);
                                        }
                                      } else {
                                        nextSet.add(faction);
                                      }
                                      nextPlayer.allowed_factions = Array.from(nextSet);
                                      return nextMap;
                                    })
                                  }
                                />
                                <span>{faction}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {activeControlsTab === "terrain" ? (
              <div className="editor-tab-panel">
                <div className="editor-section editor-section-first">
                  <span className="field-label">Selected Hex</span>
                  {selectedTile ? (
                    <div className="summary-card">
                      <span className="summary-label">{coordKey(selectedTile.coord)}</span>
                      <strong>{config?.terrains?.[selectedTile.terrain_id]?.display_name ?? selectedTile.terrain_id}</strong>
                    </div>
                  ) : (
                    <span className="muted">Click a hex on the map, then choose a terrain type.</span>
                  )}
                </div>

                <div className="editor-section">
                  <div className="terrain-palette-grid">
                    {(config?.terrain_order ?? []).map((terrainId) => (
                      <button
                        key={terrainId}
                        className={`terrain-palette-button ${selectedTerrainId === terrainId ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedTerrainId(terrainId);
                        }}
                        title={config?.terrains?.[terrainId]?.display_name ?? terrainId}
                      >
                        <img src={terrainAsset(terrainId)} alt={terrainId} />
                        <span>{config?.terrains?.[terrainId]?.display_name ?? terrainId}</span>
                      </button>
                    ))}
                    <button
                      className={`terrain-palette-button terrain-palette-button-delete ${selectedTerrainId === DELETE_BRUSH_ID ? "selected" : ""}`}
                      onClick={() => setSelectedTerrainId(DELETE_BRUSH_ID)}
                      title="Delete hex"
                    >
                      <div className="terrain-delete-glyph">X</div>
                      <span>Delete Hex</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel panel-board">
          <div className="panel-header">
            <h2>{mapData?.name ?? "Map"}</h2>
            <div className="meta-line">
              <span>Brush: {config?.terrains?.[selectedTerrainId]?.display_name ?? selectedTerrainId}</span>
              <span>Base income: {mapData?.economy?.base_income ?? "-"}</span>
              <span>City income: {mapData?.economy?.city_income ?? "-"}</span>
              <span>Start income: {mapData?.economy?.starting_credits ?? "-"}</span>
            </div>
          </div>
          <div className="board-card">
            <div
              ref={boardViewportRef}
              className={`board-viewport ${isPanningBoard ? "panning" : ""}`}
              onWheel={(event) => {
                event.preventDefault();
                setZoom((current) => Math.max(0.45, Math.min(2.2, Number((current + (event.deltaY < 0 ? 0.08 : -0.08)).toFixed(2)))));
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
                onClick={createOrPaintHexFromBoardClick}
              >
                <defs>
                  {tiles.map((tile) => (
                    <clipPath id={clipPathId(tile.coord)} key={clipPathId(tile.coord)} clipPathUnits="userSpaceOnUse">
                      <polygon points={hexPoints(0, 0, BASE_HEX_SIZE)} />
                    </clipPath>
                  ))}
                </defs>
                <rect
                  x={zoomedViewBox.minX}
                  y={zoomedViewBox.minY}
                  width={zoomedViewBox.width}
                  height={zoomedViewBox.height}
                  fill="transparent"
                  data-board-create="1"
                />
                {tiles.map((tile) => {
                  const center = axialToPixel(tile.coord);
                  const key = coordKey(tile.coord);
                  const terrainHref = terrainAsset(tile.terrain_id);
                  return (
                    <g
                      key={key}
                      className="hex-group"
                      transform={`translate(${center.x}, ${center.y})`}
                    >
                      <polygon
                        points={hexPoints(0, 0, BASE_HEX_SIZE)}
                        fill={TERRAIN_FALLBACKS[tile.terrain_id] ?? "#d8d8d8"}
                        stroke="#22304a"
                        strokeWidth="2"
                        onClick={() => selectAndPaintTile(tile)}
                      />
                      <image
                        href={terrainHref}
                        x={-34}
                        y={-34}
                        width={68}
                        height={68}
                        clipPath={`url(#${clipPathId(tile.coord)})`}
                        preserveAspectRatio="xMidYMid meet"
                        pointerEvents="none"
                      />
                      {tile.owner_id ? (
                        <g transform="translate(0,-24)" pointerEvents="none">
                          <circle r="8" className={`owner-disc owner-${tile.owner_id}`} />
                          <text className="owner-text" x="0" y="1">
                            {tile.owner_id.toUpperCase()}
                          </text>
                        </g>
                      ) : null}
                      <text className="coord-label" x="0" y="22" pointerEvents="none">
                        {key}
                      </text>
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
                      <strong>{config?.terrains?.[selectedTile.terrain_id]?.display_name ?? selectedTile.terrain_id}</strong>
                      <span>Coord: {coordKey(selectedTile.coord)}</span>
                    </div>
                  </div>
                  <label className="field-label">Owner</label>
                  <select
                    value={selectedTile.owner_id ?? ""}
                    disabled={!terrainAllowsOwner(config, selectedTile.terrain_id)}
                    onChange={(event) =>
                      updateTile(selectedTileKey, (tile) => ({
                        ...tile,
                        owner_id: event.target.value || null,
                      }))
                    }
                  >
                    <option value="">Neutral</option>
                    {playerOptions.map((playerId) => (
                      <option key={playerId} value={playerId}>
                        {playerId}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <span className="muted">Click a hex to inspect and edit it.</span>
              )}
              <pre>{pretty(selectedTile ?? null)}</pre>
            </div>

            <div className="detail-card">
              <h2>Map Summary</h2>
              <pre>{pretty(mapData ?? null)}</pre>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
