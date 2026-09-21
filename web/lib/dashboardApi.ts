import type { ChartDecision, Dashboard, DashboardItemLayout, DashboardSummary } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      // body wasn't JSON -- keep statusText
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function listDashboards(): Promise<DashboardSummary[]> {
  return request("/dashboards");
}

export function createDashboard(name: string): Promise<DashboardSummary> {
  return request("/dashboards", { method: "POST", body: JSON.stringify({ name }) });
}

export function deleteDashboard(id: string): Promise<{ deleted: boolean }> {
  return request(`/dashboards/${id}`, { method: "DELETE" });
}

export function getDashboard(id: string): Promise<Dashboard> {
  return request(`/dashboards/${id}`);
}

export interface PinChartInput {
  question: string;
  sql: string;
  chart: ChartDecision;
  narration: string | null;
}

export function pinChart(dashboardId: string, input: PinChartInput) {
  return request(`/dashboards/${dashboardId}/items`, {
    method: "POST",
    body: JSON.stringify({
      question: input.question,
      sql: input.sql,
      chart_type: input.chart.chart_type,
      x: input.chart.x,
      y: input.chart.y,
      series: input.chart.series,
      narration: input.narration,
    }),
  });
}

export function removeDashboardItem(dashboardId: string, itemId: string): Promise<{ deleted: boolean }> {
  return request(`/dashboards/${dashboardId}/items/${itemId}`, { method: "DELETE" });
}

export function updateLayout(
  dashboardId: string,
  items: (DashboardItemLayout & { id: string })[]
): Promise<{ updated: boolean }> {
  return request(`/dashboards/${dashboardId}/layout`, {
    method: "PUT",
    body: JSON.stringify({ items }),
  });
}
