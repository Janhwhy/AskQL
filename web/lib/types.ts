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
