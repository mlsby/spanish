import type { CardRec } from "./types";

/**
 * Ser till att kort som delar ord (es→sv + sv→es-syskon) inte hamnar rygg i
 * rygg i passkön — då är svaret på kort två gratis. Greedy: behåll ordningen,
 * men dra fram nästa konfliktfria kort när det behövs. Går kön inte att lösa
 * (t.ex. bara syskonen kvar på slutet) får de ligga intill — bättre än att
 * tappa kort.
 */
export function spaceSiblings(cards: CardRec[], minGap = 3): CardRec[] {
  const out: CardRec[] = [];
  const rest = [...cards];
  while (rest.length) {
    const recent = out.slice(-(minGap - 1));
    let idx = rest.findIndex((c) => !recent.some((o) => o.wordId === c.wordId));
    if (idx === -1) idx = 0;
    out.push(rest.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Stoppar in ett omköat kort nära startIdx, men skjuter det framåt tills det
 * inte hamnar inom minGap från sitt syskon. Vid köns slut accepteras närhet.
 */
export function insertSpaced(queue: CardRec[], card: CardRec, startIdx: number, minGap = 3): void {
  const clashes = (pos: number): boolean => {
    const from = Math.max(0, pos - (minGap - 1));
    const to = Math.min(queue.length, pos + (minGap - 1));
    for (let j = from; j < to; j++) {
      if (queue[j].wordId === card.wordId) return true;
    }
    return false;
  };
  let i = Math.min(startIdx, queue.length);
  while (i < queue.length && clashes(i)) i++;
  queue.splice(i, 0, card);
}
