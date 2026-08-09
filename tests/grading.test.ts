import { describe, expect, it } from "vitest";
import { dl, gradeAnswer, normalize } from "../src/lib/grading";

describe("normalisering (kravspec §3 steg 1)", () => {
  it("spanska: accentokänslig men ñ behålls", () => {
    expect(normalize("está", "es")).toBe("esta");
    expect(normalize("AZÚCAR", "es")).toBe("azucar");
    expect(normalize("año", "es")).toBe("año"); // ñ är betydelsebärande
  });
  it("spanska: inledande artikel och ¡¿ skalas bort", () => {
    expect(normalize("la ciudad", "es")).toBe("ciudad");
    expect(normalize("¡Hola!", "es")).toBe("hola");
  });
  it("svenska: å/ä/ö behålls, é→e, 'att ' skalas bort", () => {
    expect(normalize("färdig", "sv")).toBe("färdig");
    expect(normalize("idé", "sv")).toBe("ide");
    expect(normalize("att börja", "sv")).toBe("börja");
  });
});

describe("Damerau-Levenshtein (steg 2)", () => {
  it("räknar substitution, transposition och insättning", () => {
    expect(dl("stad", "stad")).toBe(0);
    expect(dl("stadd", "stad")).toBe(1);
    expect(dl("dtas", "stad")).toBe(2); // hmm — kontrolleras bara att den är ≥1
    expect(dl("satd", "stad")).toBe(1); // transposition
  });
});

describe("gradeAnswer (steg 1–2)", () => {
  it("exakt träff efter normalisering → good/exact", () => {
    expect(gradeAnswer("esta", ["está"], "es")).toMatchObject({ grade: "good", step: "exact" });
    expect(gradeAnswer("  BÖRJA ", ["börja"], "sv")).toMatchObject({ grade: "good", step: "exact" });
    expect(gradeAnswer("att börja", ["börja"], "sv")).toMatchObject({ grade: "good" });
    expect(gradeAnswer("ciudad", ["la ciudad"], "es")).toMatchObject({ grade: "good" });
  });
  it("synonymträff → good/syn", () => {
    expect(gradeAnswer("starta", ["börja", "starta"], "sv")).toMatchObject({ grade: "good", step: "syn" });
  });
  it("stavfel inom tröskeln → hard/fuzzy med närmaste facit", () => {
    expect(gradeAnswer("stadd", ["stad"], "sv")).toMatchObject({ grade: "hard", step: "fuzzy", matched: "stad" });
    expect(gradeAnswer("fardig", ["färdig"], "sv")).toMatchObject({ grade: "hard" }); // åäö normaliseras inte bort
    expect(gradeAnswer("ano", ["año"], "es")).toMatchObject({ grade: "hard" }); // ñ normaliseras inte bort
  });
  it("trösklar: ≤1 för korta svar (≤5 tecken), ≤2 för längre", () => {
    expect(gradeAnswer("stdad", ["stad"], "sv").grade).toBe("hard");   // 5 tecken, avstånd 1 (borttag)... transposition+insert
    expect(gradeAnswer("stddd", ["stad"], "sv").grade).toBe("again");  // 5 tecken, avstånd 2 → över tröskeln
    expect(gradeAnswer("lycklieg", ["lycklig"], "sv").grade).toBe("hard"); // längre, avstånd ≤2
  });
  it("tomt eller långt ifrån → again", () => {
    expect(gradeAnswer("", ["stad"], "sv").grade).toBe("again");
    expect(gradeAnswer("häst", ["stad"], "sv").grade).toBe("again");
  });
});
