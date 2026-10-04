import { ChatShell } from "@/components/chat/ChatShell";

export default async function SavedChatPage({ params }: PageProps<"/c/[id]">) {
  const { id } = await params;
  return <ChatShell key={id} chatId={id} />;
}
