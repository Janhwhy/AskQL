import { Fragment, type ReactNode } from "react";

/**
 * A deliberately tiny markdown subset for text tiles: `# ` / `## ` headings,
 * `- ` bullets, blank-line paragraphs, **bold**, *italic*. Builds React
 * elements directly -- never dangerouslySetInnerHTML -- so a text tile
 * can't inject markup into the dashboard no matter what's typed into it.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith("**") ? (
        <strong key={m.index} className="font-semibold text-ink-primary">
          {tok.slice(2, -2)}
        </strong>
      ) : (
        <em key={m.index} className="font-display text-[1.08em] text-ink-primary italic">
          {tok.slice(1, -1)}
        </em>
      )
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push(
        <p key={blocks.length} className="text-[14.5px] leading-relaxed text-ink-secondary">
          {para.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {inline(l)}
            </Fragment>
          ))}
        </p>
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="flex flex-col gap-1.5 text-[14.5px] text-ink-secondary">
          {list.map((l, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="beam-gradient mt-[0.6em] h-1 w-1 shrink-0 rounded-full" />
              <span>{inline(l)}</span>
            </li>
          ))}
        </ul>
      );
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line)) {
      flushPara();
      flushList();
      blocks.push(
        <h2 key={blocks.length} className="font-display text-[clamp(1.7rem,3vw,2.4rem)] leading-[1.05] text-ink-primary">
          {inline(line.replace(/^#\s+/, ""))}
        </h2>
      );
    } else if (/^##\s+/.test(line)) {
      flushPara();
      flushList();
      blocks.push(
        <h3 key={blocks.length} className="kicker !text-ink-secondary">
          {line.replace(/^##\s+/, "")}
        </h3>
      );
    } else if (/^[-*]\s+/.test(line)) {
      flushPara();
      list.push(line.replace(/^[-*]\s+/, ""));
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return <div className="flex flex-col gap-3">{blocks}</div>;
}
