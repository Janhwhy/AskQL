import type { ChatEvent, ChatRequest } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Defense in depth against a raw network stall (not an application error —
// those are caught server-side now and sent as a proper "error" event, see
// agent/graph.py's ask_stream). If the connection itself hangs with no new
// data — a dropped Wi-Fi, a proxy that silently swallows the stream, the
// backend process dying mid-response — the UI should never wait forever.
// Resets on every chunk received, so a genuinely slow-but-progressing
// answer is never killed, only a truly stalled one.
const IDLE_TIMEOUT_MS = 45_000;

/**
 * Streams one turn of the agent's SSE response. Native `EventSource` can't
 * send a POST body, so this parses `text/event-stream` by hand off a
 * `fetch()` body reader — a standard, well-established pattern for SSE with
 * a request body.
 */
export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<ChatEvent> {
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort());

  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };

  try {
    const res = await fetch(`${API_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`chat request failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let done: boolean, value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (e) {
        if (controller.signal.aborted) {
          throw new Error("The agent stopped responding (no data for 45s). Please try again.");
        }
        throw e;
      }
      if (done) break;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; each frame's payload is
      // the (possibly multi-line) text after "data: ".
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        yield JSON.parse(json) as ChatEvent;
      }
    }
  } finally {
    clearTimeout(idleTimer);
  }
}
