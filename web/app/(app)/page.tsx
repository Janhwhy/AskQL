import { ChatShell } from "@/components/chat/ChatShell";

/** A brand-new, not-yet-saved chat. The first message creates it server-side
 * and swaps the URL to /c/{id} in place (history.replaceState) -- no remount,
 * so the answer streaming in isn't interrupted. */
export default function NewChatPage() {
  return <ChatShell chatId={null} />;
}
