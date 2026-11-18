/** TilHero wordmark of the prototype: «Til» + «Hero» in the pen colour (Unbounded), optional subtitle. */
export function Wordmark({ sub, compact, className }: { sub?: string; compact?: boolean; className?: string }) {
  return (
    <span className={className ? `wordmark ${className}` : "wordmark"} aria-label="TilHero Admin">
      <span className="wm-name" aria-hidden="true">
        {compact ? "T" : "Til"}
        <span className="wm-hero">{compact ? "H" : "Hero"}</span>
      </span>
      {sub && !compact && <span className="wm-sub">{sub}</span>}
    </span>
  );
}
