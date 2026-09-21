import { ChatShell } from "@/components/chat/ChatShell";
import { Header } from "@/components/Header";

export default function Home() {
  return (
    <div className="flex h-full flex-col bg-plane">
      <Header />
      <main className="min-h-0 flex-1">
        <ChatShell />
      </main>
    </div>
  );
}
