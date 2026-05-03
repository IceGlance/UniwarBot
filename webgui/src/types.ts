export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Coord {
  q: number;
  r: number;
}

export interface TileState {
  coord: Coord;
  terrain_id: string;
  owner_id: string | null;
  occupying_unit_id?: string | null;
  surface_unit_id: string | null;
  hidden_unit_id: string | null;
  capture_state: JsonValue | null;
  metadata: Record<string, JsonValue>;
}

export interface GameStateSnapshot {
  ruleset_version: string;
  active_player_id: string;
  player_order: string[];
  turn_number: number;
  round_number: number;
  current_rseed: number;
  game_map: {
    metadata: {
      map_id: string;
      name: string;
      width: number | null;
      height: number | null;
      tags: string[];
      notes: string | null;
    };
    tiles: TileState[];
  };
  players: Record<string, JsonValue>;
  units: Record<string, JsonValue>;
  fight_context: Record<string, JsonValue>;
  metadata: Record<string, JsonValue>;
}

export interface ScenarioSummary {
  scenario_id: string;
  name: string;
  suite_name: string | null;
  case_name: string | null;
  relative_file: string;
  action_count: number;
  input_state: string | null;
  has_compact_input_state: boolean;
}

export interface ScenarioStep {
  index: number;
  action: Record<string, JsonValue>;
  before_state: GameStateSnapshot;
  after_state: GameStateSnapshot;
  actual_changes: Record<string, JsonValue>;
  result: Record<string, JsonValue>;
  expected_changes?: Record<string, JsonValue>;
  expected_state?: Record<string, JsonValue>;
}

export interface ScenarioReport {
  scenario_id: string;
  name: string;
  suite_name: string | null;
  case_name: string | null;
  relative_file: string;
  input_state: string | null;
  has_compact_input_state: boolean;
  initial_state: GameStateSnapshot;
  steps: ScenarioStep[];
  final_state: GameStateSnapshot;
  final_changes: Record<string, JsonValue>;
  expected_changes: Record<string, JsonValue>;
  expected_state: Record<string, JsonValue>;
}
