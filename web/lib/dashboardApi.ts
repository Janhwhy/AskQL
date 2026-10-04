import { request } from "./http";
import type {
  ChartDecision,
  Dashboard,
  DashboardItem,
  DashboardItemLayout,
  DashboardSummary,
  ReportPage,
  TileConfig,
} from "./types";

export function listDashboards(): Promise<DashboardSummary[]> {
  return request("/dashboards");
}

export function createDashboard(name: string): Promise<DashboardSummary> {
  return request("/dashboards", { method: "POST", body: JSON.stringify({ name }) });
}

export function updateDashboard(id: string, patch: { name?: string; description?: string }) {
  return request<{ updated: boolean }>(`/dashboards/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
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

export function pinChart(dashboardId: string, input: PinChartInput, pageId?: string): Promise<DashboardItem> {
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
      page_id: pageId ?? null,
    }),
  });
}

export function addTextBox(
  dashboardId: string,
  input: { text: string; page_id: string; rect?: { x: number; y: number; w: number; h: number } }
): Promise<DashboardItem> {
  return request(`/dashboards/${dashboardId}/text`, { method: "POST", body: JSON.stringify(input) });
}

export function addPage(dashboardId: string, name?: string): Promise<ReportPage> {
  return request(`/dashboards/${dashboardId}/pages`, { method: "POST", body: JSON.stringify({ name }) });
}

export function updatePage(
  dashboardId: string,
  pageId: string,
  patch: { name?: string; width?: number; height?: number; background?: string; reset_background?: boolean }
): Promise<ReportPage> {
  return request(`/dashboards/${dashboardId}/pages/${pageId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deletePage(dashboardId: string, pageId: string): Promise<{ deleted: boolean }> {
  return request(`/dashboards/${dashboardId}/pages/${pageId}`, { method: "DELETE" });
}

export function updateItem(
  dashboardId: string,
  itemId: string,
  patch: { config?: TileConfig; text?: string },
  /** keepalive: the request outlives the page -- for a final save fired
   * while navigating away or closing the tab. */
  opts?: { keepalive?: boolean }
): Promise<DashboardItem> {
  return request(`/dashboards/${dashboardId}/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    keepalive: opts?.keepalive,
  });
}

export function duplicateItem(dashboardId: string, itemId: string): Promise<DashboardItem> {
  return request(`/dashboards/${dashboardId}/items/${itemId}/duplicate`, { method: "POST" });
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
