import type { ReactNode } from "react";

/**
 * Minimal, safe Markdown → React (policy text from the BFF): headings, paragraphs,
 * bullet lists and **bold**. No HTML is ever interpreted — React escapes every string.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<strong key={`${key}-b${i++}`}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) {
      const k = `p${blocks.length}`;
      blocks.push(<p key={k}>{inline(para.join(" "), k)}</p>);
      para = [];
    }
    if (list.length) {
      const k = `l${blocks.length}`;
      blocks.push(
        <ul key={k}>
          {list.map((li, i) => (
            <li key={i}>{inline(li, `${k}-${i}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of lines.slice(0, 400)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const k = `h${blocks.length}`;
      blocks.push(<h3 key={k}>{inline(h[1]!, k)}</h3>);
      continue;
    }
    const li = /^[-*•]\s+(.*)$/.exec(line);
    if (li) {
      if (para.length) flush();
      list.push(li[1]!);
      continue;
    }
    if (list.length) flush();
    para.push(line);
  }
  flush();
  return <div className="pol">{blocks}</div>;
}
