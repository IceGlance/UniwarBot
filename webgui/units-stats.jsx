const { useEffect, useMemo, useState } = React;

const API_BASE =
  window.location.port === "5173"
    ? `${window.location.protocol}//${window.location.hostname}:8000/api`
    : `${window.location.origin}/api`;

const TERRAIN_HEADER_LABELS = {
  plain: "Plain",
  forest: "Forest",
  mountain: "Mt",
  swamp: "Swamp",
  desert: "Des",
  road_land: "RoadL",
  city: "City",
  base: "Base",
  medical: "Med",
  water: "Water",
  ocean: "Ocean",
  reef: "Reef",
  road_water: "RoadW",
  harbor: "Harbor",
  chasm: "Chasm",
};

const TERRAIN_TITLES = {
  plain: "Plain",
  forest: "Forest",
  mountain: "Mountain",
  swamp: "Swamp",
  desert: "Desert",
  road_land: "Road (Land)",
  city: "City",
  base: "Base",
  medical: "Medical",
  water: "Water",
  ocean: "Ocean",
  reef: "Reef",
  road_water: "Road (Water)",
  harbor: "Harbor",
  chasm: "Chasm",
};

const UNIT_TYPE_SHORT = {
  ground_light: "GL",
  ground_heavy: "GH",
  air: "Air",
  aquatic: "Aq",
  amphibian: "Am",
};

const TARGET_CLASS_SHORT = {
  ground_light: "GL",
  ground_heavy: "GH",
  air: "Air",
  aquatic: "Aq",
  amphibian: "Am",
};

function unitAsset(unitId) {
  const mapped = unitId === "mecha_ii" ? "mecha_2" : unitId;
  return `./public/gui-assets/units/${mapped}.png`;
}

function rangeLabel(value, fallback = "-") {
  if (!value) {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  const minValue = Number(value.min ?? 0);
  const maxValue = Number(value.max ?? 0);
  return minValue === maxValue ? String(minValue) : `${minValue}-${maxValue}`;
}

function signed(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  const number = Number(value);
  return number > 0 ? `+${number}` : String(number);
}

function terrainCell(effect) {
  if (!effect) {
    return "-";
  }
  if (effect.mobility_cost === null || effect.mobility_cost === undefined) {
    return "x";
  }
  return `${effect.mobility_cost}/${signed(effect.attack_bonus)}/${signed(effect.defense_bonus)}`;
}

function factionChoices(units) {
  return ["all"].concat([...new Set(units.map((unit) => unit.faction))]);
}

function shortUnitType(unitType) {
  return UNIT_TYPE_SHORT[unitType] || unitType || "-";
}

function shortTarget(targetClass) {
  return TARGET_CLASS_SHORT[targetClass] || targetClass;
}

function hiddenStateLabel(hiddenMode) {
  if (!hiddenMode?.enabled) {
    return "Surface";
  }
  if (hiddenMode.mode === "buried") {
    return "Buried";
  }
  if (hiddenMode.mode === "submerged") {
    return "Submerged";
  }
  return hiddenMode.mode || "Hidden";
}

function normalizeHiddenTerrainEffects(terrainMovementCosts) {
  const effects = {};
  for (const [terrainId, mobilityCost] of Object.entries(terrainMovementCosts || {})) {
    effects[terrainId] = {
      mobility_cost: mobilityCost,
      attack_bonus: null,
      defense_bonus: null,
    };
  }
  return effects;
}

function buildDisplayRows(units) {
  const rows = [];
  for (const unit of units) {
    rows.push({
      key: `${unit.unit_id}:surface`,
      unit,
      state: "surface",
      stateLabel: "Surface",
      movement: unit.surface_mobility,
      vision: unit.surface_vision,
      rangeLabel: unit.surface_attack_range_label,
      defense: unit.surface_defense_strength,
      terrainEffects: unit.terrain_effects,
      hiddenRuleNotes: [],
    });

    if (unit.hidden_mode?.enabled) {
      rows.push({
        key: `${unit.unit_id}:hidden`,
        unit,
        state: "hidden",
        stateLabel: hiddenStateLabel(unit.hidden_mode),
        movement: unit.hidden_mode.mobility ?? "-",
        vision: unit.hidden_mode.vision ?? "-",
        rangeLabel: unit.hidden_mode.attack_range_label ?? "-",
        defense: unit.hidden_mode.defense_strength ?? "-",
        terrainEffects: normalizeHiddenTerrainEffects(unit.hidden_mode.terrain_movement_costs),
        hiddenRuleNotes: [
          unit.hidden_mode.resurface_bonus !== null && unit.hidden_mode.resurface_bonus !== undefined
            ? `Bonus ${unit.hidden_mode.resurface_bonus >= 0 ? "+" : ""}${unit.hidden_mode.resurface_bonus}`
            : null,
          unit.hidden_mode.attack_from_hidden_penalty !== null &&
          unit.hidden_mode.attack_from_hidden_penalty !== undefined
            ? `Penalty ${unit.hidden_mode.attack_from_hidden_penalty}`
            : null,
        ].filter(Boolean),
      });
    }
  }
  return rows;
}

function UnitStatsApp() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [faction, setFaction] = useState("all");

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/unit-stats`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        if (!active) {
          return;
        }
        setPayload(data);
      })
      .catch((fetchError) => {
        if (!active) {
          return;
        }
        setError(fetchError.message || String(fetchError));
      });
    return () => {
      active = false;
    };
  }, []);

  const filteredUnits = useMemo(() => {
    const units = payload?.units ?? [];
    const searchNeedle = search.trim().toLowerCase();
    return units.filter((unit) => {
      if (faction !== "all" && unit.faction !== faction) {
        return false;
      }
      if (!searchNeedle) {
        return true;
      }
      const haystack = [unit.display_name, unit.unit_id, unit.faction, unit.unit_type]
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchNeedle);
    });
  }, [payload, search, faction]);

  const displayRows = useMemo(() => buildDisplayRows(filteredUnits), [filteredUnits]);

  const terrainOrder = payload?.terrain_order ?? [];
  const targetClassOrder = payload?.target_class_order ?? [];
  const factions = payload ? factionChoices(payload.units) : ["all"];

  return (
    <div className="catalog-shell">
      <header className="catalog-topbar">
        <div>
          <h1>UniwarBot Units Stats</h1>
          <p>
            Machine-readable unit stats from the validated game dictionary. Terrain cells use
            <code> move/atk/def </code>. Hidden-capable units get a dedicated buried or submerged row.
          </p>
        </div>
        <a className="catalog-home-link" href="/">
          Back To Home
        </a>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="catalog-toolbar">
        <label className="catalog-control">
          <span>Search</span>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="marine, titan, aquatic..."
          />
        </label>
        <label className="catalog-control">
          <span>Faction</span>
          <select value={faction} onChange={(event) => setFaction(event.target.value)}>
            {factions.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
        <div className="catalog-summary">
          <span>Rows</span>
          <strong>{displayRows.length}</strong>
        </div>
      </section>

      <section className="catalog-table-wrap">
        <table className="stats-table stats-table-split">
          <thead>
            <tr>
              <th className="sticky-col sticky-col-1" rowSpan="2">
                Unit
              </th>
              <th className="sticky-col sticky-col-2" rowSpan="2">
                Faction
              </th>
              <th rowSpan="2">Type</th>
              <th rowSpan="2">State</th>
              <th rowSpan="2">Cost</th>
              <th rowSpan="2">HP</th>
              <th rowSpan="2">Move</th>
              <th rowSpan="2">Vision</th>
              <th rowSpan="2">Range</th>
              <th rowSpan="2">Def</th>
              <th rowSpan="2">Repair</th>
              <th colSpan={targetClassOrder.length + 1}>Attack</th>
              <th colSpan={targetClassOrder.length}>AP</th>
              <th colSpan={terrainOrder.length}>Terrain</th>
            </tr>
            <tr>
              {targetClassOrder.map((targetClass) => (
                <th key={`attack-${targetClass}`} title={targetClass}>
                  {shortTarget(targetClass)}
                </th>
              ))}
              <th title="Submerged">Sub</th>
              {targetClassOrder.map((targetClass) => (
                <th key={`ap-${targetClass}`} title={`Armor Piercing vs ${targetClass}`}>
                  {shortTarget(targetClass)}
                </th>
              ))}
              {terrainOrder.map((terrainId) => (
                <th key={`terrain-${terrainId}`} title={TERRAIN_TITLES[terrainId] || terrainId}>
                  {TERRAIN_HEADER_LABELS[terrainId] || terrainId}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr key={row.key} className={row.state === "hidden" ? "hidden-state-row" : ""}>
                <td className="sticky-col sticky-col-1 unit-name-cell">
                  <img
                    className={`unit-thumb ${row.state === "hidden" ? "unit-thumb-hidden" : ""}`}
                    src={unitAsset(row.unit.unit_id)}
                    alt={row.unit.display_name}
                  />
                  <div>
                    <strong>{row.unit.display_name}</strong>
                    <div className="unit-id">{row.unit.unit_id}</div>
                  </div>
                </td>
                <td className="sticky-col sticky-col-2">
                  <span className={`faction-badge faction-${row.unit.faction}`}>{row.unit.faction}</span>
                </td>
                <td>
                  <span className="type-chip">{shortUnitType(row.unit.unit_type)}</span>
                </td>
                <td>
                  <span
                    className={`state-chip state-chip-${row.state === "hidden" ? row.unit.hidden_mode.mode : "surface"}`}
                    title={row.hiddenRuleNotes.join(" | ") || row.stateLabel}
                  >
                    {row.stateLabel}
                  </span>
                </td>
                <td>{row.unit.cost}</td>
                <td>{row.unit.base_max_hp}</td>
                <td>{row.movement}</td>
                <td>{row.vision}</td>
                <td>{row.rangeLabel}</td>
                <td>{row.defense}</td>
                <td>{row.unit.repair_points}</td>
                {targetClassOrder.map((targetClass) => (
                  <td key={`${row.key}-atk-${targetClass}`}>
                    {row.unit.attack_strength_by_target_class[targetClass]}
                  </td>
                ))}
                <td>{row.unit.submerged_attack_strength ?? "-"}</td>
                {targetClassOrder.map((targetClass) => (
                  <td key={`${row.key}-ap-${targetClass}`}>
                    {row.unit.armor_piercing_percent_by_target_class[targetClass]}
                  </td>
                ))}
                {terrainOrder.map((terrainId) => (
                  <td key={`${row.key}-terrain-${terrainId}`} className="terrain-stat-cell">
                    {terrainCell(row.terrainEffects[terrainId])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<UnitStatsApp />);
