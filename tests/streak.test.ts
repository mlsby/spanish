import { describe, expect, it } from "vitest";
import { activityStats } from "../src/lib/streak";

const NOW = new Date("2026-08-09T15:00:00"); // lokal tid

describe("activityStats (streak & dagar totalt)", () => {
  it("tom historik → 0/0", () => {
    expect(activityStats({}, NOW)).toEqual({ streak: 0, totalDays: 0 });
  });

  it("räknar streak t.o.m. idag när dagens pass är gjort", () => {
    const days = { "2026-08-07": 12, "2026-08-08": 20, "2026-08-09": 5 };
    expect(activityStats(days, NOW)).toEqual({ streak: 3, totalDays: 3 });
  });

  it("dagens pass inte gjort än → streaken lever på gårdagen", () => {
    const days = { "2026-08-07": 12, "2026-08-08": 20 };
    expect(activityStats(days, NOW)).toEqual({ streak: 2, totalDays: 2 });
  });

  it("missad dag nollar — stenhårt", () => {
    const days = { "2026-08-05": 8, "2026-08-06": 9, "2026-08-08": 20, "2026-08-09": 3 };
    expect(activityStats(days, NOW).streak).toBe(2); // 8:e + 9:e; hålet 7:e bröt
    expect(activityStats(days, NOW).totalDays).toBe(4);
  });

  it("två dagars uppehåll → streak 0 trots gammal historik", () => {
    const days = { "2026-08-01": 30, "2026-08-02": 12 };
    expect(activityStats(days, NOW)).toEqual({ streak: 0, totalDays: 2 });
  });

  it("dagar med 0 besvarade kort räknas inte", () => {
    const days = { "2026-08-08": 0, "2026-08-09": 4 };
    expect(activityStats(days, NOW)).toEqual({ streak: 1, totalDays: 1 });
  });
});

describe("streaken kräver 20 rätt från 2026-10-20", () => {
  it("en dag med under 20 rätt räknas inte — tidigare dagar räknas som förut", () => {
    const now = new Date("2026-10-21T12:00:00");
    const days = { "2026-10-19": 3, "2026-10-20": 30, "2026-10-21": 25 };
    expect(activityStats(days, now, { "2026-10-20": 20, "2026-10-21": 12 }).streak).toBe(2);
    expect(activityStats(days, now, { "2026-10-20": 19, "2026-10-21": 20 }).streak).toBe(1);
  });
});

