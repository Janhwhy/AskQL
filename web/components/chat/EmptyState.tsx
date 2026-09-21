import { BarChart3, MessagesSquare, TrendingUp, Users } from "lucide-react";

const EXAMPLES = [
  { icon: TrendingUp, text: "What was total revenue yesterday?" },
  { icon: Users, text: "How many active customers do we have by plan tier?" },
  { icon: BarChart3, text: "Show me daily revenue for the last 14 days" },
  { icon: MessagesSquare, text: "How's support doing?" },
];

export function EmptyState({ onPick }: { onPick: (question: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-8 py-16 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">
          Ask Northbeam anything
        </h1>
        <p className="max-w-md text-[15px] text-ink-secondary">
          Revenue, customers, support — governed by a defined set of metrics,
          answered with the query behind every number.
        </p>
      </div>
      <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
        {EXAMPLES.map(({ icon: Icon, text }) => (
          <button
            key={text}
            onClick={() => onPick(text)}
            className="group flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 text-left text-sm text-ink-secondary transition-colors hover:border-accent hover:text-ink-primary"
          >
            <Icon size={16} className="mt-0.5 shrink-0 text-ink-muted group-hover:text-accent" />
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
