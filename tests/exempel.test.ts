import { describe, expect, it } from "vitest";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import type { AppData, VerbForm } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

describe("exempelmeningar", () => {
  function makeStore(): Store {
    const store = new Store(new MemAdapter());
    store.data = emptyData();
    store.examples = new Map([
      ["poder|v", ["No va a poder ser."]],
      ["poder|v#pres.1s", ["¿Puedo comer esto?", "Får jag äta detta?"]],
      ["querer|v", ["Quiero un helado.", "", "I want an ice cream."]],
    ]);
    const form: VerbForm = {
      id: "querer|v#pres.3s", parent: "querer|v", es: "quiere",
      person: "3s", svPres: "vill", r: 40, slot: 60,
    };
    store.forms = [form];
    store.formById = new Map([[form.id, form]]);
    return store;
  }

  it("slår upp på ord- och form-id, med och utan svensk översättning", () => {
    const store = makeStore();
    expect(store.exampleFor("poder|v")).toEqual({ es: "No va a poder ser.", sv: undefined, en: undefined });
    expect(store.exampleFor("poder|v#pres.1s")).toMatchObject({ es: "¿Puedo comer esto?", sv: "Får jag äta detta?" });
    expect(store.exampleFor("saknas|n")).toBeNull();
  });

  it("engelska reserven följer med när svensk länk saknas (tom sträng ≠ sv)", () => {
    const store = makeStore();
    expect(store.exampleFor("querer|v")).toEqual({
      es: "Quiero un helado.", sv: undefined, en: "I want an ice cream.",
    });
  });

  it("böjning utan egen mening ärver moderverbets", () => {
    const store = makeStore();
    expect(store.exampleFor("querer|v#pres.3s")).toMatchObject({ es: "Quiero un helado." });
  });
});
