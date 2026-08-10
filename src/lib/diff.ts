export interface MarkedChar {
  ch: string;
  diff: boolean;
}

/**
 * Markerar vilka tecken i facit som skiljer sig från det användaren skrev
 * (för "rätt — litet stavfel"-vyn). Klassisk Levenshtein-backtrace:
 * substitutioner och tecken som saknas i svaret markeras i facit; extratecken
 * i svaret har ingen plats i facit och markeras inte. Jämförelsen är
 * skiftlägesokänslig men facit renderas med sina egna tecken.
 */
export function diffTarget(user: string, target: string): MarkedChar[] {
  const a = user.toLowerCase();
  const b = target.toLowerCase();
  const n = a.length, m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  const marked: MarkedChar[] = target.split("").map((ch) => ({ ch, diff: false }));
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      i--; j--;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      marked[j - 1].diff = true; // substitution
      i--; j--;
    } else if (j > 0 && d[i][j] === d[i][j - 1] + 1) {
      marked[j - 1].diff = true; // tecknet saknas i svaret
      j--;
    } else {
      i--; // extratecken i svaret — inget att markera i facit
    }
  }
  return marked;
}
