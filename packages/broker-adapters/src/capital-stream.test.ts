import { describe, expect, it } from "vitest";
import { parseCapitalStreamQuote } from "./capital-stream";

describe("parseCapitalStreamQuote", () => {
  it("parses quote destination with ofr", () => {
    const q = parseCapitalStreamQuote(
      JSON.stringify({
        status: "OK",
        destination: "quote",
        payload: {
          epic: "OIL_CRUDE",
          product: "CFD",
          bid: 93.87,
          ofr: 93.9,
          timestamp: 1660297190627,
        },
      }),
    );
    expect(q).toEqual({
      epic: "OIL_CRUDE",
      name: "OIL_CRUDE",
      instrumentType: "CFD",
      bid: 93.87,
      offer: 93.9,
    });
  });

  it("ignores non-quote messages", () => {
    expect(
      parseCapitalStreamQuote(
        JSON.stringify({ destination: "ping", payload: {} }),
      ),
    ).toBeNull();
  });
});
