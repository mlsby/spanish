import { describe, expect, it } from "vitest";
import { cardStamp, mergeCloudIntoLocal, newerThan, type CloudRows } from "../src/lib/sync";
import { emptyData } from "../src/lib/storage";
import { newCardRec } from "../src/lib/scheduler";
import { dayKey } from "../src/lib/time";

const empty: CloudRows = { cards: [], userWords: [], settings: null, snapshots: [], reviewTs: [] };

describe("newerThan (last-write-wins)", () => {
  it("saknad tidsstämpel räknas som äldst", () => {
    expect(newerThan("2026-01-02", undefined)).toBe(true);
    expect(newerThan(undefined, "2026-01-02")).toBe(false);
    expect(newerThan("2026-01-03", "2026-01-02")).toBe(true);
    expect(newerThan("2026-01-01", "2026-01-02")).toBe(false);
  });
});

describe("mergeCloudIntoLocal", () => {
  it("adopterar molnkort som saknas lokalt", () => {
    const data = emptyData();
    const rec = newCardRec("empezar|v", "es2sv", new Date("2026-01-01"));
    const n = mergeCloudIntoLocal(data, {
      ...empty,
      cards: [{
        word_id: "empezar|v", dir: "es2sv", fsrs: rec.fsrs,
        fail_count: 2, introduced_at: rec.introducedAt, updated_at: "2026-01-05T00:00:00Z",
      }],
    });
    expect(n).toBe(1);
    expect(data.cards["empezar|v:es2sv"].failCount).toBe(2);
  });

  it("nyare lokalt kort vinner över äldre molnrad", () => {
    const data = emptyData();
    const local = newCardRec("empezar|v", "es2sv", new Date("2026-01-01"));
    local.failCount = 7;
    local.updatedAt = "2026-01-10T00:00:00Z";
    data.cards["empezar|v:es2sv"] = local;
    mergeCloudIntoLocal(data, {
      ...empty,
      cards: [{
        word_id: "empezar|v", dir: "es2sv", fsrs: local.fsrs,
        fail_count: 1, introduced_at: local.introducedAt, updated_at: "2026-01-05T00:00:00Z",
      }],
    });
    expect(data.cards["empezar|v:es2sv"].failCount).toBe(7); // lokal behölls
  });

  it("äldre lokalt kort utan tidsstämpel förlorar mot molnet", () => {
    const data = emptyData();
    const local = newCardRec("empezar|v", "es2sv", new Date("2026-01-01"));
    delete local.updatedAt; // data från före synken fanns
    delete local.fsrs.last_review;
    data.cards["empezar|v:es2sv"] = local;
    mergeCloudIntoLocal(data, {
      ...empty,
      cards: [{
        word_id: "empezar|v", dir: "es2sv", fsrs: local.fsrs,
        fail_count: 3, introduced_at: local.introducedAt, updated_at: "2026-06-01T00:00:00Z",
      }],
    });
    expect(data.cards["empezar|v:es2sv"].failCount).toBe(3); // molnet vann
  });

  it("minnesregler mergas med last-write-wins", () => {
    const data = emptyData();
    data.userWords["feliz|adj"] = { syn: ["glad"], mnem: "gammal regel", updatedAt: "2026-01-01T00:00:00Z" };
    mergeCloudIntoLocal(data, {
      ...empty,
      userWords: [{ word_id: "feliz|adj", syn: ["glad", "nöjd"], mnem: "ny regel", updated_at: "2026-02-01T00:00:00Z" }],
    });
    expect(data.userWords["feliz|adj"].mnem).toBe("ny regel");
    expect(data.userWords["feliz|adj"].syn).toContain("nöjd");
  });

  it("kalenderdagar tar max av lokalt och molnhärlett", () => {
    const data = emptyData();
    data.days["2026-08-01"] = 5;
    const ts = Array.from({ length: 9 }, (_, i) => `2026-08-01T10:0${i}:00`);
    mergeCloudIntoLocal(data, { ...empty, reviewTs: ts });
    expect(data.days["2026-08-01"]).toBe(9);
  });

  it("dagens snapshot skrivs inte över av molnet", () => {
    const data = emptyData();
    const today = dayKey();
    data.snapshots[today] = { kan: 5, lar: 10 };
    mergeCloudIntoLocal(data, {
      ...empty,
      snapshots: [{ day: today, kan: 1, lar: 1 }, { day: "2026-01-15", kan: 2, lar: 3 }],
    });
    expect(data.snapshots[today]).toEqual({ kan: 5, lar: 10 });
    expect(data.snapshots["2026-01-15"]).toEqual({ kan: 2, lar: 3 });
  });

  it("cardStamp faller tillbaka på last_review och introducedAt", () => {
    const rec = newCardRec("x|n", "es2sv", new Date("2026-03-01"));
    delete rec.fsrs.last_review;
    expect(cardStamp(rec)).toBe(rec.updatedAt ?? rec.introducedAt);
    delete rec.updatedAt;
    expect(cardStamp(rec)).toBe(rec.introducedAt);
  });
});
