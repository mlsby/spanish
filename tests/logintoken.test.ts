import { describe, expect, it } from "vitest";
import { parseLoginInput } from "../src/lib/logintoken";

describe("parseLoginInput", () => {
  it("tolkar en inklistrad Supabase-länk", () => {
    const url = "https://aszqdjakksvrusmtmjtn.supabase.co/auth/v1/verify?token=pkce_abc123&type=magiclink&redirect_to=https://mlsby.github.io/spanish/";
    expect(parseLoginInput(url)).toEqual({ kind: "link", tokenHash: "pkce_abc123", type: "magiclink" });
  });
  it("hittar länken även med text runt omkring (mejl-kopiering)", () => {
    const messy = "Logga in: https://x.supabase.co/auth/v1/verify?token=h4sh&type=signup se länken ovan";
    expect(parseLoginInput(messy)).toEqual({ kind: "link", tokenHash: "h4sh", type: "signup" });
  });
  it("stödjer token_hash-parametern också", () => {
    expect(parseLoginInput("https://x.co/verify?token_hash=zzz")).toEqual({ kind: "link", tokenHash: "zzz", type: "magiclink" });
  });
  it("tolkar en sexsiffrig kod, även med mellanslag", () => {
    expect(parseLoginInput("123456")).toEqual({ kind: "code", code: "123456" });
    expect(parseLoginInput("123 456")).toEqual({ kind: "code", code: "123456" });
  });
  it("avvisar skräp och länkar utan token", () => {
    expect(parseLoginInput("hejsan")).toBeNull();
    expect(parseLoginInput("")).toBeNull();
    expect(parseLoginInput("https://example.com/ingen-token")).toBeNull();
  });
});
