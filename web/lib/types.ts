// Mirrors agent/graph.py's ask_stream() event shapes and api/main.py's
// ChatRequest exactly — keep these two in sync by hand, there's no shared
// schema generation in this project.

/** What the agent's decide_chart can return. */
export type ChartType = "kpi" | "line" | "bar" | "pie" | "table";

/** Everything a dashboard tile can be RENDERED as (Phase 8) — a superset of
 * ChartType. Mirrors api/dashboards.py's DisplayType. Purely presentational:
 * the same rows, a different view. */
export type DisplayType = ChartType | "area" | "hbar" | "donut";

export interface ChartDecision {
  chart_type: ChartType;
  x: string | null;
  y: string | null;
  series: string | null;
}

export type Row = Record<string, string | number | boolean | null>;

export type ChatEvent =
  | { stage: "thinking" }
  | { stage: "sql"; sql: string }
  | { stage: "retrying"; error: string }
  | { stage: "result"; columns: string[]; rows: Row[] }
  | { stage: "chart"; chart: ChartDecision }
  | { stage: "narration"; narration: string }
  | {
      stage: "clarification";
      question: string;
      clarification_needed: string;
      candidates: string[];
    }
  | { stage: "error"; question: string; sql?: string | null; error: string }
  | {
      stage: "done";
      question: string;
      sql: string | null;
      columns: string[] | null;
      rows: Row[];
      chart: ChartDecision | null;
      narration: string | null;
    };

export interface ChatRequest {
  question: string | null;
  thread_id: string | null;
  clarification_answer: string | null;
  /** false = don't file this thread as a saved chat (dashboard ask bar). */
  save?: boolean;
}

// Mirrors api/dashboards.py's response shapes.
export interface DashboardSummary {
  id: string;
  name: string;
  description: string;
  created_at: string;
  item_count: number;
  /** Tile rectangles, for the gallery's blueprint thumbnail. */
  /** The first page's visual rectangles (page px), for the gallery's
   * blueprint thumbnail. */
  thumb?: { x: number; y: number; w: number; h: number; kind: TileKind }[];
  thumb_page?: { w: number; h: number };
}

export type TileKind = "chart" | "text";

export type FontFamily = "geist" | "inter" | "dm_sans" | "manrope" | "space_grotesk" | "plex_sans" | "work_sans";

/** Mirrors api/dashboards.py's TileConfig. Presentation only -- never
 * changes which numbers a visual shows. */
export interface TileConfig {
  // charts
  title: string | null;
  /** 1-8, a --series-N palette slot. null = default colors. */
  color: number | null;
  display_type: DisplayType | null;
  show_narration: boolean;
  show_legend: boolean;
  show_title: boolean;
  // container (both kinds); null = that kind's default
  background: string | null; // "#rrggbb" | "transparent"
  border: boolean | null;
  shadow: boolean | null;
  radius: number | null;
  padding: number | null;
  // text boxes
  font_family: FontFamily;
  font_size: number;
  text_color: string | null;
  align: "left" | "center" | "right" | "justify";
  valign: "top" | "middle" | "bottom";
  line_height: number;
  text_format: "markdown" | "html";
}

/** Page pixels on a report page (Phase 8b canvas), z = stacking order. */
export interface DashboardItemLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface ReportPage {
  id: string;
  name: string;
  position: number;
  width: number;
  height: number;
  background: string | null;
}

// A dashboard item is "live" -- rows/columns are re-queried by the backend
// on every GET, not a stored snapshot, so a stale metric definition shows up
// as `error` on that one tile rather than breaking the whole dashboard.
export interface DashboardItem {
  id: string;
  kind: TileKind;
  page_id: string;
  text: string | null;
  config: TileConfig;
  question: string;
  sql: string;
  chart: ChartDecision;
  narration: string | null;
  layout: DashboardItemLayout;
  columns: string[] | null;
  rows: Row[] | null;
  error: string | null;
}

export interface Dashboard {
  id: string;
  name: string;
  description: string;
  created_at: string;
  pages: ReportPage[];
  items: DashboardItem[];
}

// One turn in the conversation, built up client-side from a stream of
// ChatEvents. "streaming" while events are still arriving for this turn.
export interface Turn {
  id: string;
  question: string;
  status: "streaming" | "clarification" | "error" | "done";
  sql: string | null;
  columns: string[] | null;
  rows: Row[];
  chart: ChartDecision | null;
  narration: string | null;
  clarification: { question: string; candidates: string[] } | null;
  error: string | null;
  retried: boolean;
  /** Arrived during this session (animate its reveal) vs. rehydrated from
   * a saved chat (show it as-is). */
  fresh?: boolean;
  /** Latest pipeline stage while status === "streaming". Null once settled. */
  stage: StageKey | null;
}

export type StageKey = "thinking" | "sql" | "retrying" | "result" | "chart" | "narration";

// Mirrors api/chats.py / chats_db.py (Phase 8 saved chats).
export interface ChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  turn_count: number;
}

export interface SavedTurn {
  id: string;
  question: string;
  status: "clarification" | "error" | "done";
  sql: string | null;
  columns: string[] | null;
  rows: Row[];
  chart: ChartDecision | null;
  narration: string | null;
  clarification: { question: string; candidates: string[] } | null;
  error: string | null;
  created_at: string;
}

export interface Chat extends Omit<ChatSummary, "turn_count"> {
  turns: SavedTurn[];
}
