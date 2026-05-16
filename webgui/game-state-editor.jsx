const { useEffect, useMemo, useRef, useState } = React;

const BASE_HEX_SIZE = 32;
const MIN_BOARD_WORLD_WIDTH = 880;
const MIN_BOARD_WORLD_HEIGHT = 620;
const DELETE_BRUSH_ID = "__delete__";
const DELETE_UNIT_BRUSH_ID = "__delete_unit__";
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

function suggestCityIncome(baseIncome) {
  return Math.ceil((Number(baseIncome || 0) / 2) / 5) * 5;
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

function renderStatusMarkers(unit, transform) {
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
    start_random_seed: config?.defaults?.start_random_seed ?? null,
    units: [],
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

function buildEditorUnit(config, unitId, ownerId, coord, placementMode, instanceId) {
  const unitConfig = config?.units?.[unitId] ?? {};
  return {
    instance_id: instanceId,
    unit_id: unitId,
    owner_id: ownerId,
    position: { q: coord.q, r: coord.r },
    hp: Number(unitConfig.base_max_hp ?? 10),
    veterancy_level: 0,
    experience_points: 0,
    status: {
      plague_infected: false,
      hidden_mode: placementMode === "surface" ? null : placementMode,
      emp_disabled_rounds: 0,
      teleport_disabled_rounds: 0,
      teleport_lock_phase: null,
      teleport_cooldown_rounds: 0,
      buried_resurface_bonus: 0,
      submerged_attack_penalty: 0,
      ability_cooldowns: {},
    },
    action: {
      is_available: true,
      configured_action_count: 1,
      actions_remaining: 1,
      can_interleave_between_action_windows: true,
      move_points_remaining: null,
      attacks_remaining: 1,
      special_actions_remaining: null,
      action_phase_index: 0,
      current_action_index: 0,
      action_windows: [],
      atomic_action_locked: false,
      atomic_action_label: null,
      has_moved_this_turn: false,
      has_attacked_this_turn: false,
      has_used_special_this_turn: false,
    },
    capture_target: null,
    metadata: {},
  };
}

function nullableInt(value) {
  return value === "" ? null : Number(value);
}

function placementModesForUnit(unitConfig) {
  const modes = ["surface"];
  if (unitConfig?.hidden_mode) {
    modes.push(unitConfig.hidden_mode);
  }
  return modes;
}

function encodeUnitBrush(unitId, mode = "surface") {
  return `${unitId}|${mode}`;
}

function decodeUnitBrush(brushValue) {
  if (!brushValue || brushValue === DELETE_UNIT_BRUSH_ID) {
    return null;
  }
  const [unitId, mode = "surface"] = String(brushValue).split("|");
  return { unitId, mode };
}

function allowedTerrainsForMode(unitConfig, mode) {
  if (!unitConfig) {
    return [];
  }
  return mode === "surface"
    ? [...(unitConfig.surface_allowed_terrains ?? [])]
    : [...(unitConfig.hidden_allowed_terrains ?? [])];
}

function jsonValueType(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "object") {
    return "object";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  return "string";
}

function defaultJsonValue(type) {
  switch (type) {
    case "number":
      return 0;
    case "boolean":
      return false;
    case "object":
      return {};
    case "array":
      return [];
    case "null":
      return null;
    case "string":
    default:
      return "";
  }
}

function nextObjectFieldName(objectValue) {
  const taken = new Set(Object.keys(objectValue ?? {}));
  let index = 1;
  while (taken.has(`field_${index}`)) {
    index += 1;
  }
  return `field_${index}`;
}

function JsonValueEditor({ value, onChange, depth = 0 }) {
  const currentType = jsonValueType(value);
  const changeType = (nextType) => {
    onChange(defaultJsonValue(nextType));
  };

  if (currentType === "object") {
    const entries = Object.entries(value ?? {});
    return (
      <div className={`json-editor json-editor-depth-${depth}`}>
        <div className="json-editor-type-row">
          <span className="summary-label">object</span>
          <div className="json-editor-actions">
            <select value="object" onChange={(event) => changeType(event.target.value)}>
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
              <option value="object">Object</option>
              <option value="array">Array</option>
            </select>
            <button
              type="button"
              className="step-chip"
              onClick={() => {
                const nextKey = nextObjectFieldName(value);
                onChange({
                  ...(value ?? {}),
                  [nextKey]: "",
                });
              }}
            >
              Add Field
            </button>
          </div>
        </div>
        {entries.length === 0 ? <span className="muted">No fields.</span> : null}
        <div className="json-editor-stack">
          {entries.map(([entryKey, entryValue]) => (
            <div key={entryKey} className="json-editor-entry">
              <input
                className="json-editor-key"
                value={entryKey}
                onChange={(event) => {
                  const nextKey = event.target.value.trim() || entryKey;
                  if (nextKey === entryKey) {
                    return;
                  }
                  const nextObject = {};
                  Object.entries(value ?? {}).forEach(([candidateKey, candidateValue]) => {
                    nextObject[candidateKey === entryKey ? nextKey : candidateKey] = candidateValue;
                  });
                  onChange(nextObject);
                }}
              />
              <div className="json-editor-value">
                <JsonValueEditor
                  value={entryValue}
                  onChange={(nextEntryValue) =>
                    onChange({
                      ...(value ?? {}),
                      [entryKey]: nextEntryValue,
                    })
                  }
                  depth={depth + 1}
                />
              </div>
              <button
                type="button"
                className="json-editor-remove"
                onClick={() => {
                  const nextObject = { ...(value ?? {}) };
                  delete nextObject[entryKey];
                  onChange(nextObject);
                }}
                title="Remove field"
              >
                X
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (currentType === "array") {
    const arrayValue = Array.isArray(value) ? value : [];
    return (
      <div className={`json-editor json-editor-depth-${depth}`}>
        <div className="json-editor-type-row">
          <span className="summary-label">array</span>
          <div className="json-editor-actions">
            <select value="array" onChange={(event) => changeType(event.target.value)}>
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
              <option value="object">Object</option>
              <option value="array">Array</option>
            </select>
            <button type="button" className="step-chip" onClick={() => onChange([...(arrayValue ?? []), ""])}>
              Add Item
            </button>
          </div>
        </div>
        {arrayValue.length === 0 ? <span className="muted">No items.</span> : null}
        <div className="json-editor-stack">
          {arrayValue.map((itemValue, index) => (
            <div key={index} className="json-editor-entry">
              <span className="json-editor-index">{index + 1}</span>
              <div className="json-editor-value">
                <JsonValueEditor
                  value={itemValue}
                  onChange={(nextItemValue) => {
                    const nextArray = [...arrayValue];
                    nextArray[index] = nextItemValue;
                    onChange(nextArray);
                  }}
                  depth={depth + 1}
                />
              </div>
              <button
                type="button"
                className="json-editor-remove"
                onClick={() => {
                  const nextArray = arrayValue.filter((_, candidateIndex) => candidateIndex !== index);
                  onChange(nextArray);
                }}
                title="Remove item"
              >
                X
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`json-editor json-editor-depth-${depth}`}>
      <div className="json-editor-primitive">
        <select value={currentType} onChange={(event) => changeType(event.target.value)}>
          <option value="string">String</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
          <option value="null">Null</option>
          <option value="object">Object</option>
          <option value="array">Array</option>
        </select>
        {currentType === "string" ? (
          <input value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
        ) : null}
        {currentType === "number" ? (
          <input
            type="number"
            value={Number.isFinite(Number(value)) ? Number(value) : 0}
            onChange={(event) => onChange(Number(event.target.value || 0))}
          />
        ) : null}
        {currentType === "boolean" ? (
          <select value={value ? "true" : "false"} onChange={(event) => onChange(event.target.value === "true")}>
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
        ) : null}
        {currentType === "null" ? <span className="muted">null</span> : null}
      </div>
    </div>
  );
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
  const keptTileKeys = new Set((nextMap.tiles ?? []).map((tile) => coordKey(tile.coord)));
  nextMap.units = (nextMap.units ?? []).filter((unit) => {
    const position = unit?.position ?? {};
    const q = Number(position.q);
    const r = Number(position.r);
    if (!(q >= 0 && q < nextWidth && r >= 0 && r < nextHeight)) {
      return false;
    }
    return keptTileKeys.has(coordKey({ q, r }));
  });
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
  const [selectedUnitId, setSelectedUnitId] = useState(null);
  const [selectedTerrainId, setSelectedTerrainId] = useState("plain");
  const [recreateTerrainId, setRecreateTerrainId] = useState("plain");
  const [selectedUnitBrushId, setSelectedUnitBrushId] = useState(encodeUnitBrush("marine"));
  const [unitBrushOwnerId, setUnitBrushOwnerId] = useState("p1");
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
        setSelectedUnitBrushId(encodeUnitBrush(configPayload.unit_order?.[0] ?? "marine"));
        setFileNameInput("new-map.json");
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const tiles = mapData?.tiles ?? [];
  const units = mapData?.units ?? [];
  const tileByKey = useMemo(() => new Map(tiles.map((tile) => [coordKey(tile.coord), tile])), [tiles]);
  const selectedTile = selectedTileKey ? tileByKey.get(selectedTileKey) ?? null : null;
  const unitsById = useMemo(
    () => new Map(units.map((unit) => [String(unit.instance_id), unit])),
    [units],
  );
  const surfaceUnitsByTile = useMemo(() => {
    const result = new Map();
    units.forEach((unit) => {
      if (!unit?.status?.hidden_mode) {
        result.set(coordKey(unit.position), unit);
      }
    });
    return result;
  }, [units]);
  const hiddenUnitsByTile = useMemo(() => {
    const result = new Map();
    units.forEach((unit) => {
      if (unit?.status?.hidden_mode) {
        result.set(coordKey(unit.position), unit);
      }
    });
    return result;
  }, [units]);
  const selectedUnit = selectedUnitId ? unitsById.get(selectedUnitId) ?? null : null;
  const selectedTileSurfaceUnit = selectedTileKey ? surfaceUnitsByTile.get(selectedTileKey) ?? null : null;
  const selectedTileHiddenUnit = selectedTileKey ? hiddenUnitsByTile.get(selectedTileKey) ?? null : null;
  const selectedUnitConfig = selectedUnit ? config?.units?.[selectedUnit.unit_id] ?? null : null;
  const selectedBrush = useMemo(() => decodeUnitBrush(selectedUnitBrushId), [selectedUnitBrushId]);
  const selectedBrushUnitConfig = selectedBrush ? config?.units?.[selectedBrush.unitId] ?? null : null;
  const hiddenRenderItems = useMemo(
    () =>
      tiles
        .map((tile) => {
          const hiddenUnit = hiddenUnitsByTile.get(coordKey(tile.coord));
          if (!hiddenUnit) {
            return null;
          }
          return {
            key: String(hiddenUnit.instance_id),
            tile,
            unit: hiddenUnit,
          };
        })
        .filter(Boolean),
    [hiddenUnitsByTile, tiles],
  );
  const playerOptions = useMemo(
    () => Array.from({ length: Number(mapData?.player_count ?? 0) }, (_, index) => `p${index + 1}`),
    [mapData?.player_count],
  );
  const unitsGroupedByFaction = useMemo(() => {
    const groups = {};
    (config?.unit_order ?? []).forEach((unitId) => {
      const unitConfig = config?.units?.[unitId];
      const faction = String(unitConfig?.faction ?? "other");
      if (!groups[faction]) {
        groups[faction] = [];
      }
      groups[faction].push(unitConfig);
    });
    return groups;
  }, [config]);

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

  useEffect(() => {
    if (!selectedUnit || !selectedUnitConfig) {
      return;
    }
    const allowedModes = placementModesForUnit(selectedUnitConfig);
    const currentMode = selectedUnit.status?.hidden_mode ?? "surface";
    if (!allowedModes.includes(currentMode)) {
      setSelectedUnitValue(["status", "hidden_mode"], null);
    }
    if (!selectedUnitConfig.can_teleport) {
      if (Number(selectedUnit.status?.teleport_disabled_rounds ?? 0) !== 0) {
        setSelectedUnitValue(["status", "teleport_disabled_rounds"], 0);
      }
      if (selectedUnit.status?.teleport_lock_phase != null) {
        setSelectedUnitValue(["status", "teleport_lock_phase"], null);
      }
      if (Number(selectedUnit.status?.teleport_cooldown_rounds ?? 0) !== 0) {
        setSelectedUnitValue(["status", "teleport_cooldown_rounds"], 0);
      }
    }
    if (!selectedUnitConfig.can_plague && selectedUnit.status?.plague_infected) {
      setSelectedUnitValue(["status", "plague_infected"], false);
    }
  }, [selectedUnit, selectedUnitConfig]);

  useEffect(() => {
    if (playerOptions.length === 0) {
      return;
    }
    if (!playerOptions.includes(unitBrushOwnerId)) {
      setUnitBrushOwnerId(playerOptions[0]);
    }
  }, [playerOptions, unitBrushOwnerId]);

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

  const updateSelectedUnit = (updater) => {
    setMapData((current) => {
      if (!current || !selectedUnitId) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      nextMap.units = (nextMap.units ?? []).map((unit) =>
        String(unit.instance_id) === selectedUnitId ? updater({ ...unit }) : unit,
      );
      return nextMap;
    });
  };

  const removeSelectedUnit = () => {
    if (!selectedUnitId) {
      return;
    }
    setMapData((current) => {
      if (!current) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      nextMap.units = (nextMap.units ?? []).filter(
        (unit) => String(unit.instance_id) !== selectedUnitId,
      );
      return nextMap;
    });
    setSelectedUnitId(null);
  };

  const deleteUnitAtTile = (tileKey) => {
    const targetUnit = surfaceUnitsByTile.get(tileKey) ?? hiddenUnitsByTile.get(tileKey);
    if (!targetUnit) {
      return;
    }
    removeUnitById(String(targetUnit.instance_id));
  };

  const removeUnitById = (targetId) => {
    setMapData((current) => {
      if (!current) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      nextMap.units = (nextMap.units ?? []).filter((unit) => String(unit.instance_id) !== targetId);
      return nextMap;
    });
    if (selectedUnitId === targetId) {
      setSelectedUnitId(null);
    }
  };

  const setSelectedUnitValue = (path, nextValue) => {
    updateSelectedUnit((unit) => {
      const nextUnit = cloneMapPayload(unit);
      let cursor = nextUnit;
      for (let index = 0; index < path.length - 1; index += 1) {
        const key = path[index];
        cursor[key] = cloneMapPayload(cursor[key] ?? {});
        cursor = cursor[key];
      }
      cursor[path[path.length - 1]] = nextValue;
      return nextUnit;
    });
  };

  const moveSelectedUnitTo = (nextCoord, nextHiddenMode = selectedUnit?.status?.hidden_mode ?? null) => {
    if (!selectedUnitId) {
      return;
    }
    const nextKey = coordKey(nextCoord);
    if (!tileByKey.has(nextKey)) {
      setError(`Cannot move unit to ${nextKey}: no hex exists there.`);
      return;
    }
    const destinationTile = tileByKey.get(nextKey);
    const allowedTerrains = new Set(
      allowedTerrainsForMode(selectedUnitConfig, nextHiddenMode ? nextHiddenMode : "surface"),
    );
    if (!allowedTerrains.has(destinationTile.terrain_id)) {
      setError(
        `Cannot move unit to ${nextKey}: ${selectedUnitConfig?.display_name ?? selectedUnit?.unit_id} cannot be on ${destinationTile.terrain_id}.`,
      );
      return;
    }
    const conflictingUnit =
      nextHiddenMode
        ? hiddenUnitsByTile.get(nextKey)
        : surfaceUnitsByTile.get(nextKey);
    if (conflictingUnit && String(conflictingUnit.instance_id) !== selectedUnitId) {
      setError(`Cannot move unit to ${nextKey}: that layer is already occupied.`);
      return;
    }
    setMapData((current) => {
      if (!current) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      nextMap.units = (nextMap.units ?? []).map((unit) => {
        if (String(unit.instance_id) !== selectedUnitId) {
          return unit;
        }
        return {
          ...unit,
          position: { q: nextCoord.q, r: nextCoord.r },
          status: {
            ...(unit.status ?? {}),
            hidden_mode: nextHiddenMode || null,
          },
        };
      });
      return nextMap;
    });
    setSelectedTileKey(nextKey);
    setError("");
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
        nextMap.units = (nextMap.units ?? []).map((unit) => ({
          ...unit,
          position: {
            q: Number(unit.position?.q ?? 0) + shiftQ,
            r: Number(unit.position?.r ?? 0) + shiftR,
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
      nextMap.units = (nextMap.units ?? []).filter((unit) => coordKey(unit.position) !== coordKey(coord));
      if (selectedUnitId) {
        const removed = (current.units ?? []).some(
          (unit) => String(unit.instance_id) === selectedUnitId && coordKey(unit.position) === coordKey(coord),
        );
        if (removed) {
          setSelectedUnitId(null);
        }
      }
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

  const nextUnitInstanceId = (currentMap, unitId) => {
    const base = `u_${unitId}`;
    const existing = new Set((currentMap.units ?? []).map((unit) => String(unit.instance_id)));
    if (!existing.has(base)) {
      return base;
    }
    let index = 2;
    while (existing.has(`${base}_${index}`)) {
      index += 1;
    }
    return `${base}_${index}`;
  };

  const placeUnitOnTile = (tile) => {
    if (!config || !selectedBrush || selectedUnitBrushId === DELETE_UNIT_BRUSH_ID) {
      return;
    }
    const key = coordKey(tile.coord);
    const allowedTerrains = new Set(
      allowedTerrainsForMode(selectedBrushUnitConfig, selectedBrush.mode),
    );
    if (!allowedTerrains.has(tile.terrain_id)) {
      setError(
        `Cannot place ${selectedBrushUnitConfig?.display_name ?? selectedBrush.unitId} on ${tile.terrain_id}.`,
      );
      return;
    }
    const existingSurface = surfaceUnitsByTile.get(key);
    const existingHidden = hiddenUnitsByTile.get(key);
    const instanceId = nextUnitInstanceId(mapData ?? { units: [] }, selectedBrush.unitId);
    setMapData((current) => {
      if (!current) {
        return current;
      }
      const nextMap = cloneMapPayload(current);
      if (selectedBrush.mode === "surface" && existingSurface) {
        nextMap.units = (nextMap.units ?? []).filter(
          (unit) => String(unit.instance_id) !== String(existingSurface.instance_id),
        );
      }
      if (selectedBrush.mode !== "surface" && existingHidden) {
        nextMap.units = (nextMap.units ?? []).filter(
          (unit) => String(unit.instance_id) !== String(existingHidden.instance_id),
        );
      }
      const nextUnit = buildEditorUnit(
        config,
        selectedBrush.unitId,
        unitBrushOwnerId,
        tile.coord,
        selectedBrush.mode,
        instanceId,
      );
      nextMap.units = [...(nextMap.units ?? []), nextUnit];
      return nextMap;
    });
    setSelectedUnitId(instanceId);
    setSelectedTileKey(key);
    setError("");
  };

  const selectAndPaintTile = (tile) => {
    const key = coordKey(tile.coord);
    setSelectedTileKey(selectedTerrainId === DELETE_BRUSH_ID ? null : key);
    if (activeControlsTab === "terrain" && selectedTerrainId) {
      applyTerrainToTile(key, selectedTerrainId);
    }
  };

  const handleTileClick = (tile) => {
    const key = coordKey(tile.coord);
    if (activeControlsTab === "terrain") {
      selectAndPaintTile(tile);
      return;
    }
    setSelectedTileKey(key);
    if (activeControlsTab === "units") {
      if (selectedUnitBrushId === DELETE_UNIT_BRUSH_ID) {
        deleteUnitAtTile(key);
        return;
      }
      placeUnitOnTile(tile);
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
      nextMap.units = nextMap.units.map((unit) => ({
        ...unit,
        owner_id: validOwners.has(unit.owner_id) ? unit.owner_id : "p1",
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
        setSelectedUnitId(null);
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
    setSelectedUnitId(null);
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
    recreated.start_random_seed = mapData?.start_random_seed ?? null;
    recreated.players = cloneMapPayload(
      normalizePlayers(mapData?.players, recreated.player_count, config.factions),
    );
    setMapAndSyncDrafts(recreated);
    setSelectedTileKey(null);
    setSelectedUnitId(null);
    setError("");
  };

    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="header-intro">
            <h1>UniwarBot Game State Editor</h1>
            <p>Create and save map JSON locally with terrain painting, player settings, ownership, and economy controls.</p>
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
              className={`editor-tab ${activeControlsTab === "units" ? "selected" : ""}`}
              onClick={() => setActiveControlsTab("units")}
            >
              Units
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

                <label className="field-label">Start Random Seed</label>
                <input
                  type="number"
                  step="1"
                  value={mapData?.start_random_seed ?? ""}
                  placeholder="blank = random each game"
                  onChange={(event) =>
                    setMapData((current) => (
                      current
                        ? {
                            ...current,
                            start_random_seed: nullableInt(event.target.value),
                          }
                        : current
                    ))
                  }
                />

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

            {activeControlsTab === "units" ? (
              <div className="editor-tab-panel">
                <div className="editor-section editor-section-first">
                  <span className="field-label">Placement Owner</span>
                  <div className="checkbox-chip-row">
                    {playerOptions.map((playerId) => {
                      const checked = unitBrushOwnerId === playerId;
                      return (
                        <label key={playerId} className={`checkbox-chip ${checked ? "checked" : ""}`}>
                          <input
                            type="radio"
                            name="unit-brush-owner"
                            checked={checked}
                            onChange={() => setUnitBrushOwnerId(playerId)}
                          />
                          <span>{playerId}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="terrain-help-copy">
                    Click an existing hex to place the selected unit brush. Click a unit sprite on the map to edit that unit.
                  </div>
                </div>

                <div className="editor-section">
                  <span className="field-label">Unit Palette</span>
                  <div className="unit-palette-grid unit-palette-grid-delete">
                    <button
                      className={`unit-palette-button unit-palette-button-delete ${selectedUnitBrushId === DELETE_UNIT_BRUSH_ID ? "selected" : ""}`}
                      onClick={() => setSelectedUnitBrushId(DELETE_UNIT_BRUSH_ID)}
                      title="Delete unit"
                    >
                      <div className="terrain-delete-glyph terrain-delete-glyph-small">X</div>
                      <span>Delete</span>
                    </button>
                  </div>
                  {Object.entries(unitsGroupedByFaction).map(([faction, factionUnits]) => (
                    <div key={faction} className="unit-palette-section">
                      <div className="summary-label">{faction}</div>
                      <div className="unit-palette-grid">
                        {factionUnits.flatMap((unitConfig) =>
                          placementModesForUnit(unitConfig).map((mode) => {
                            const brushKey = encodeUnitBrush(unitConfig.unit_id, mode);
                            const isHidden = mode !== "surface";
                            return (
                              <button
                                key={brushKey}
                                className={`unit-palette-button unit-palette-button-plain ${selectedUnitBrushId === brushKey ? "selected" : ""}`}
                                onClick={() => setSelectedUnitBrushId(brushKey)}
                                title={isHidden ? `${unitConfig.display_name} (${mode})` : unitConfig.display_name}
                              >
                                <div className="unit-palette-icon-wrap">
                                  {isHidden ? <div className="unit-palette-hidden-ring" /> : null}
                                  <img
                                    src={unitAsset(unitConfig.unit_id, unitBrushOwnerId)}
                                    alt={unitConfig.display_name}
                                    className={isHidden ? "unit-palette-image-hidden" : ""}
                                  />
                                  {isHidden ? (
                                    <div className="unit-palette-hidden-badge">
                                      {mode === "buried" ? "B" : "S"}
                                    </div>
                                  ) : null}
                                </div>
                                <span>{isHidden ? `${unitConfig.display_name} ${mode}` : unitConfig.display_name}</span>
                              </button>
                            );
                          }),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel panel-board">
          <div className="panel-header">
            <h2>{mapData?.name ?? "Map"}</h2>
            <div className="meta-line">
              <span>
                Terrain brush: {config?.terrains?.[selectedTerrainId]?.display_name ?? selectedTerrainId}
              </span>
              <span>
                Unit brush:{" "}
                {selectedUnitBrushId === DELETE_UNIT_BRUSH_ID
                  ? "Delete"
                  : `${selectedBrushUnitConfig?.display_name ?? selectedBrush?.unitId ?? "-"} (${selectedBrush?.mode ?? "surface"})`}{" "}
                / {unitBrushOwnerId}
              </span>
              <span>Base income: {mapData?.economy?.base_income ?? "-"}</span>
              <span>City income: {mapData?.economy?.city_income ?? "-"}</span>
              <span>Start income: {mapData?.economy?.starting_credits ?? "-"}</span>
              <span>
                Start seed:{" "}
                {mapData?.start_random_seed == null ? "random each game" : String(mapData.start_random_seed)}
              </span>
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
                  const surfaceUnit = surfaceUnitsByTile.get(key);
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
                        onClick={() => handleTileClick(tile)}
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
                      {surfaceUnit ? (
                        <g
                          className="unit-token"
                          transform="translate(0,-2)"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (activeControlsTab === "units" && selectedUnitBrushId === DELETE_UNIT_BRUSH_ID) {
                              removeUnitById(String(surfaceUnit.instance_id));
                              return;
                            }
                            setSelectedTileKey(key);
                            setSelectedUnitId(String(surfaceUnit.instance_id));
                            setActiveControlsTab("units");
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
                          {renderStatusMarkers(surfaceUnit, "translate(-18,-14)")}
                          {renderVeterancy(surfaceUnit)}
                          <g transform="translate(18,13)">
                            <text className="hp-text" x="0" y="1">
                              {String(surfaceUnit.hp)}
                            </text>
                          </g>
                        </g>
                      ) : null}
                      <text className="coord-label" x="0" y="22" pointerEvents="none">
                        {key}
                      </text>
                    </g>
                  );
                })}

                {hiddenRenderItems.map(({ key: unitKey, tile, unit }) => {
                  const center = axialToPixel(tile.coord);
                  const tileKey = coordKey(tile.coord);
                  return (
                  <g
                    key={`hidden-${unitKey}`}
                    className="unit-token hidden-token-layer"
                    transform={`translate(${center.x}, ${center.y + 24})`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (activeControlsTab === "units" && selectedUnitBrushId === DELETE_UNIT_BRUSH_ID) {
                        removeUnitById(String(unit.instance_id));
                        return;
                      }
                      setSelectedTileKey(tileKey);
                      setSelectedUnitId(String(unit.instance_id));
                      setActiveControlsTab("units");
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
                      {renderStatusMarkers(unit, "translate(-15,-11)")}
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
            </div>

            <div className="detail-card">
              <h2>Unit Inspector</h2>
              {selectedUnit ? (
                <>
                  <div className="visual-inspector">
                    <img
                      className="unit-inspector-icon"
                      src={unitAsset(selectedUnit.unit_id, selectedUnit.owner_id)}
                      alt={selectedUnit.unit_id}
                    />
                    <div className="visual-copy">
                      <strong>{config?.units?.[selectedUnit.unit_id]?.display_name ?? selectedUnit.unit_id}</strong>
                      <span>{String(selectedUnit.instance_id)}</span>
                      <span>
                        {selectedUnit.owner_id} / {selectedUnit.status?.hidden_mode ?? "surface"} / {coordKey(selectedUnit.position)}
                      </span>
                    </div>
                  </div>

                  <div className="editor-section editor-section-first">
                    <span className="field-label">Core</span>
                    <div className="editor-inline-grid">
                      <label>
                        <span>Instance Id</span>
                        <input
                          value={String(selectedUnit.instance_id ?? "")}
                          onChange={(event) => setSelectedUnitValue(["instance_id"], event.target.value)}
                        />
                      </label>
                      <label>
                        <span>Unit Type</span>
                        <select
                          value={selectedUnit.unit_id}
                          onChange={(event) => {
                            const nextUnitId = event.target.value;
                            const nextUnitConfig = config?.units?.[nextUnitId] ?? null;
                            const nextMode = placementModesForUnit(nextUnitConfig).includes(selectedUnit.status?.hidden_mode ?? "surface")
                              ? selectedUnit.status?.hidden_mode ?? "surface"
                              : "surface";
                            const allowedTerrains = new Set(allowedTerrainsForMode(nextUnitConfig, nextMode));
                            const currentTerrainId = selectedTile?.terrain_id ?? tileByKey.get(coordKey(selectedUnit.position))?.terrain_id;
                            if (currentTerrainId && !allowedTerrains.has(currentTerrainId)) {
                              setError(
                                `Cannot change unit to ${nextUnitConfig?.display_name ?? nextUnitId}: ${currentTerrainId} is not allowed.`,
                              );
                              return;
                            }
                            updateSelectedUnit((unit) => ({
                              ...unit,
                              unit_id: nextUnitId,
                              hp: Number(nextUnitConfig?.base_max_hp ?? unit.hp ?? 10),
                              status: {
                                ...(unit.status ?? {}),
                                hidden_mode: nextMode === "surface" ? null : nextMode,
                                plague_infected: nextUnitConfig?.can_plague ? Boolean(unit.status?.plague_infected) : false,
                                teleport_disabled_rounds: nextUnitConfig?.can_teleport
                                  ? Number(unit.status?.teleport_disabled_rounds ?? 0)
                                  : 0,
                                teleport_lock_phase: nextUnitConfig?.can_teleport ? unit.status?.teleport_lock_phase ?? null : null,
                                teleport_cooldown_rounds: nextUnitConfig?.can_teleport
                                  ? Number(unit.status?.teleport_cooldown_rounds ?? 0)
                                  : 0,
                              },
                            }));
                            setError("");
                          }}
                        >
                          {(config?.unit_order ?? []).map((unitId) => (
                            <option key={unitId} value={unitId}>
                              {config?.units?.[unitId]?.display_name ?? unitId}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Owner</span>
                        <select
                          value={selectedUnit.owner_id}
                          onChange={(event) => setSelectedUnitValue(["owner_id"], event.target.value)}
                        >
                          {playerOptions.map((playerId) => (
                            <option key={playerId} value={playerId}>
                              {playerId}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>HP</span>
                        <input
                          type="number"
                          min="0"
                          value={Number(selectedUnit.hp ?? 0)}
                          onChange={(event) => setSelectedUnitValue(["hp"], Number(event.target.value || 0))}
                        />
                      </label>
                      <label>
                        <span>Veterancy</span>
                        <select
                          value={Number(selectedUnit.veterancy_level ?? 0)}
                          onChange={(event) => setSelectedUnitValue(["veterancy_level"], Number(event.target.value))}
                        >
                          {(config?.veterancy_levels ?? [0, 1, 2]).map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>XP</span>
                        <input
                          type="number"
                          min="0"
                          value={Number(selectedUnit.experience_points ?? 0)}
                          onChange={(event) => setSelectedUnitValue(["experience_points"], Number(event.target.value || 0))}
                        />
                      </label>
                    </div>
                  </div>

                  <div className="editor-section">
                    <span className="field-label">Position And Layer</span>
                    <div className="editor-inline-grid">
                      <label>
                        <span>Q</span>
                        <input
                          type="number"
                          value={Number(selectedUnit.position?.q ?? 0)}
                          onChange={(event) =>
                            moveSelectedUnitTo(
                              {
                                q: Number(event.target.value || 0),
                                r: Number(selectedUnit.position?.r ?? 0),
                              },
                              selectedUnit.status?.hidden_mode ?? null,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>R</span>
                        <input
                          type="number"
                          value={Number(selectedUnit.position?.r ?? 0)}
                          onChange={(event) =>
                            moveSelectedUnitTo(
                              {
                                q: Number(selectedUnit.position?.q ?? 0),
                                r: Number(event.target.value || 0),
                              },
                              selectedUnit.status?.hidden_mode ?? null,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Layer</span>
                        <select
                          value={selectedUnit.status?.hidden_mode ?? "surface"}
                          onChange={(event) =>
                            moveSelectedUnitTo(
                              {
                                q: Number(selectedUnit.position?.q ?? 0),
                                r: Number(selectedUnit.position?.r ?? 0),
                              },
                              event.target.value === "surface" ? null : event.target.value,
                            )
                          }
                        >
                          {placementModesForUnit(selectedUnitConfig).map((mode) => (
                            <option key={mode} value={mode}>
                              {mode}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <button
                      className="step-chip"
                      onClick={() => {
                        if (!selectedTile) {
                          return;
                        }
                        moveSelectedUnitTo(
                          selectedTile.coord,
                          selectedUnit.status?.hidden_mode ?? null,
                        );
                      }}
                      disabled={!selectedTile}
                    >
                      Move To Selected Hex
                    </button>
                  </div>

                  <div className="editor-section">
                    <span className="field-label">Status</span>
                    <div className="editor-inline-grid">
                      <label>
                        <span>Plague Infected</span>
                        <input
                          type="checkbox"
                          checked={Boolean(selectedUnit.status?.plague_infected ?? false)}
                          disabled={!selectedUnitConfig?.can_plague}
                          onChange={(event) =>
                            setSelectedUnitValue(["status", "plague_infected"], event.target.checked)
                          }
                        />
                      </label>
                      <label>
                        <span>EMP Disabled Rounds</span>
                        <input
                          type="number"
                          min="0"
                          value={Number(selectedUnit.status?.emp_disabled_rounds ?? 0)}
                          onChange={(event) =>
                            setSelectedUnitValue(["status", "emp_disabled_rounds"], Number(event.target.value || 0))
                          }
                        />
                      </label>
                      <label>
                        <span>Teleport Disabled Rounds</span>
                        <input
                          type="number"
                          min="0"
                          disabled={!selectedUnitConfig?.can_teleport}
                          value={Number(selectedUnit.status?.teleport_disabled_rounds ?? 0)}
                          onChange={(event) =>
                            setSelectedUnitValue(["status", "teleport_disabled_rounds"], Number(event.target.value || 0))
                          }
                        />
                      </label>
                      <label>
                        <span>Teleport Lock Phase</span>
                        <select
                          disabled={!selectedUnitConfig?.can_teleport}
                          value={selectedUnit.status?.teleport_lock_phase ?? ""}
                          onChange={(event) =>
                            setSelectedUnitValue(["status", "teleport_lock_phase"], event.target.value || null)
                          }
                        >
                          <option value="">none</option>
                          {(config?.teleport_lock_phase_values ?? []).map((phase) => (
                            <option key={phase} value={phase}>
                              {phase}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Teleport Cooldown Rounds</span>
                        <input
                          type="number"
                          min="0"
                          disabled={!selectedUnitConfig?.can_teleport}
                          value={Number(selectedUnit.status?.teleport_cooldown_rounds ?? 0)}
                          onChange={(event) =>
                            setSelectedUnitValue(["status", "teleport_cooldown_rounds"], Number(event.target.value || 0))
                          }
                        />
                      </label>
                    </div>
                  </div>

                </>
              ) : (
                <span className="muted">Click a unit on the map to inspect and edit it.</span>
              )}
              <pre>{pretty(selectedUnit ?? null)}</pre>
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
