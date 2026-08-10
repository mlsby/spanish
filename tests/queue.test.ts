import { describe, expect, it } from "vitest";
import { insertSpaced, spaceSiblings } from "../src/lib/queue";
import { newCardRec } from "../src/lib/scheduler";
import type { CardRec } from "../src/lib/types";

const card = (wordId: string, dir: "es2sv" | "sv2es"): CardRec =>
  newCardRec(wordId, dir, new Date("2026-08-10T10:00:00"));

const key = (c: CardRec) => `${c.wordId}:${c.dir}`;

/** Minsta indexavstånd mellan två kort som delar ord. */
function minSiblingGap(queue: CardRec[]): number {
  let min = Infinity;
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      if (queue[i].wordId === queue[j].wordId) min = Math.min(min, j - i);
    }
  }
  return min;
}

describe("spaceSiblings — syskonkort hålls isär", () => {
  it("intilliggande syskon separeras med minst 3 positioner", () => {
    const q = [
      card("que|conj", "es2sv"), card("que|conj", "sv2es"),
      card("de|prep", "es2sv"), card("de|prep", "sv2es"),
      card("no|adv", "es2sv"), card("no|adv", "sv2es"),
    ];
    const out = spaceSiblings(q);
    expect(out).toHaveLength(6);
    expect(new Set(out.map(key)).size).toBe(6); // inga kort tappas eller dubblas
    expect(minSiblingGap(out)).toBeGreaterThanOrEqual(3);
  });

  it("typiskt introduktionsmönster (alla es→sv följt av alla sv→es) berörs inte", () => {
    const q = [
      card("a|x", "es2sv"), card("b|x", "es2sv"), card("c|x", "es2sv"),
      card("a|x", "sv2es"), card("b|x", "sv2es"), card("c|x", "sv2es"),
    ];
    expect(spaceSiblings(q).map(key)).toEqual(q.map(key));
  });

  it("olöslig kö (bara ett ords två kort) släpps igenom istället för att fastna", () => {
    const q = [card("solo|adj", "es2sv"), card("solo|adj", "sv2es")];
    const out = spaceSiblings(q);
    expect(out).toHaveLength(2);
    expect(new Set(out.map(key)).size).toBe(2);
  });
});

describe("insertSpaced — omkösning efter fel", () => {
  it("skjuter fram insättningen förbi syskonet", () => {
    const queue = [card("x|n", "es2sv"), card("y|n", "es2sv"), card("z|n", "es2sv"),
                   card("fel|v", "sv2es"), card("w|n", "es2sv"), card("v|n", "es2sv"),
                   card("u|n", "es2sv")];
    const requeued = card("fel|v", "es2sv");
    insertSpaced(queue, requeued, 3);
    const idx = queue.findIndex((c) => key(c) === "fel|v:es2sv");
    const sib = queue.findIndex((c) => key(c) === "fel|v:sv2es");
    expect(Math.abs(idx - sib)).toBeGreaterThanOrEqual(3);
  });

  it("räcker inte kön ut läggs kortet sist (närhet hellre än tappat kort)", () => {
    const queue = [card("x|n", "es2sv"), card("y|n", "es2sv"), card("z|n", "es2sv"),
                   card("fel|v", "sv2es"), card("w|n", "es2sv")];
    const requeued = card("fel|v", "es2sv");
    insertSpaced(queue, requeued, 3);
    expect(queue).toHaveLength(6);
    expect(key(queue[5])).toBe("fel|v:es2sv"); // sist — bästa möjliga plats
  });

  it("utan konflikt hamnar kortet på startIdx", () => {
    const queue = [card("x|n", "es2sv"), card("y|n", "es2sv"), card("z|n", "es2sv"), card("w|n", "es2sv")];
    const requeued = card("fel|v", "es2sv");
    insertSpaced(queue, requeued, 3);
    expect(key(queue[3])).toBe("fel|v:es2sv");
  });

  it("kort kö: kortet läggs sist hellre än tappas", () => {
    const queue = [card("fel|v", "sv2es")];
    const requeued = card("fel|v", "es2sv");
    insertSpaced(queue, requeued, 3);
    expect(queue).toHaveLength(2);
  });
});
