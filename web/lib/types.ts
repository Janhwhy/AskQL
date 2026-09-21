// Mirrors agent/graph.py's ask_stream() event shapes and api/main.py's
// ChatRequest exactly — keep these two in sync by hand, there's no shared
// schema generation in this project.

export type ChartType = "kpi" | "line" | "bar" | "pie" | "table";

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
}

// Mirrors api/dashboards.py's response shapes.
export interface DashboardSummary {
  id: string;
  name: string;
  created_at: string;
  item_count: number;
}

export interface DashboardItemLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A dashboard item is "live" -- rows/columns are re-queried by the backend
// on every GET, not a stored snapshot, so a stale metric definition shows up
// as `error` on that one tile rather than breaking the whole dashboard.
export interface DashboardItem {
  id: string;
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
  created_at: string;
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
  /** Live label while status === "streaming", e.g. "Running query…". Null once settled. */
  stageLabel: string | null;
}
