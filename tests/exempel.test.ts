import { describe, expect, it } from "vitest";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import type { AppData } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

describe("exempelmeningar", () => {
  it("slår upp på ord- och form-id, med och utan svensk översättning", () => {
    const store = new Store(new MemAdapter());
    store.data = emptyData();
    store.examples = new Map([
      ["poder|v", ["No va a poder ser."]],
      ["poder|v#pres.1s", ["¿Puedo comer esto?", "Får jag äta detta?"]],
    ]);
    expect(store.exampleFor("poder|v")).toEqual({ es: "No va a poder ser.", sv: undefined });
    expect(store.exampleFor("poder|v#pres.1s")).toEqual({ es: "¿Puedo comer esto?", sv: "Får jag äta detta?" });
    expect(store.exampleFor("saknas|n")).toBeNull();
  });
});
