import { request } from "./http";
import type { Chat, ChatSummary } from "./types";

export function listChats(): Promise<ChatSummary[]> {
  return request("/chats");
}

export function getChat(id: string): Promise<Chat> {
  return request(`/chats/${id}`);
}

export function updateChat(id: string, patch: { title?: string; pinned?: boolean }): Promise<ChatSummary> {
  return request(`/chats/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteChat(id: string): Promise<{ deleted: boolean }> {
  return request(`/chats/${id}`, { method: "DELETE" });
}

export function getStats(): Promise<Record<string, number>> {
  return request("/stats");
}
