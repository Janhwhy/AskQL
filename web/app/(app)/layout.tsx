import { AppShell } from "@/components/shell/AppShell";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
