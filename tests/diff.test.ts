import { describe, expect, it } from "vitest";
import { diffTarget } from "../src/lib/diff";

const marks = (user: string, target: string) =>
  diffTarget(user, target).map((m) => (m.diff ? m.ch.toUpperCase() : m.ch)).join("");

describe("diffTarget — markerar stavfelet i facit", () => {
  it("identiskt svar → inget markeras", () => {
    expect(marks("kunna", "kunna")).toBe("kunna");
  });

  it("skiftläge räknas inte som skillnad", () => {
    expect(marks("Kunna", "kunna")).toBe("kunna");
  });

  it("saknat tecken markeras (kuna → kunna)", () => {
    expect(marks("kuna", "kunna")).toBe("kuNna");
  });

  it("utbytt tecken markeras (kanna → kunna)", () => {
    expect(marks("kanna", "kunna")).toBe("kUnna");
  });

  it("extratecken i svaret markerar inget i facit (kunnna → kunna)", () => {
    expect(marks("kunnna", "kunna")).toBe("kunna");
  });

  it("två fel markerar två tecken (empesar → empezar)", () => {
    expect(marks("empesa", "empezar")).toBe("empeZaR");
  });
});
