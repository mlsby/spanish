import { describe, expect, it } from "vitest";
import { resaFor, TITLAR } from "../src/lib/resa";

describe("nivåresan", () => {
  it("trösklarna: 0 Hola · 10 Curioso · 50 Estudiante · … · 5000 Maestro", () => {
    expect(resaFor(0).titel.name).toBe("Hola");
    expect(resaFor(9).titel.name).toBe("Hola");
    expect(resaFor(10).titel.name).toBe("Curioso");
    expect(resaFor(49).titel.name).toBe("Curioso");
    expect(resaFor(50).titel.name).toBe("Estudiante");
    expect(resaFor(133).titel.name).toBe("Turista");
    expect(resaFor(4999).titel.name).toBe("Casi nativo");
    expect(resaFor(5000).titel.name).toBe("Maestro");
    expect(resaFor(6000).titel.name).toBe("Maestro");
  });

  it("nästa nivå och kvar-räknaren", () => {
    const r = resaFor(133);
    expect(r.next?.name).toBe("Viajero");
    expect(r.kvar).toBe(67);
    expect(r.nr).toBe(4);
    const top = resaFor(5000);
    expect(top.next).toBeNull();
    expect(top.kvar).toBe(0);
    expect(top.nr).toBe(TITLAR.length);
  });

  it("trösklarna är strikt stigande", () => {
    for (let i = 1; i < TITLAR.length; i++) {
      expect(TITLAR[i].min).toBeGreaterThan(TITLAR[i - 1].min);
    }
  });
});
