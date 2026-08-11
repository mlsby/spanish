/** Resans nivåer — trösklar i antal ord man KAN (grön nivå i ordlistan). */
export interface Titel {
  min: number;
  name: string;
  sub: string;
}

export const TITLAR: Titel[] = [
  { min: 0, name: "Hola", sub: "första orden" },
  { min: 10, name: "Curioso", sub: "nyfikenheten väckt" },
  { min: 50, name: "Estudiante", sub: "pluggar på riktigt" },
  { min: 100, name: "Turista", sub: "klarar kaféet" },
  { min: 200, name: "Viajero", sub: "klarar resan" },
  { min: 500, name: "Amigo", sub: "håller igång samtalet" },
  { min: 1000, name: "Vecino", sub: "vardagen sitter" },
  { min: 2000, name: "Madrileño", sub: "låter som en local" },
  { min: 3000, name: "Casi nativo", sub: "nästan infödd" },
  { min: 5000, name: "Maestro", sub: "basen erövrad" },
];

export interface Resa {
  titel: Titel;
  next: Titel | null; // null = Maestro, toppen nådd
  nr: number;         // 1-baserad nivåsiffra
  kvar: number;       // ord kvar till nästa nivå (0 på toppen)
}

export function resaFor(kan: number): Resa {
  let i = 0;
  while (i + 1 < TITLAR.length && kan >= TITLAR[i + 1].min) i++;
  const next = TITLAR[i + 1] ?? null;
  return { titel: TITLAR[i], next, nr: i + 1, kvar: next ? Math.max(0, next.min - kan) : 0 };
}
