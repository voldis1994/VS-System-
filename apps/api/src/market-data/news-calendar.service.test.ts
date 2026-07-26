import { describe, expect, it } from "vitest";
import { NewsCalendarService } from "./news-calendar.service";

describe("NewsCalendarService", () => {
  const news = new NewsCalendarService();

  it("maps FX symbols to currencies", () => {
    expect(news.currenciesForSymbol("EURUSD")).toEqual(["EUR", "USD"]);
    expect(news.currenciesForSymbol("XAUUSD")).toEqual(["USD"]);
  });

  it("ranks impact", () => {
    expect(news.impactRank("High")).toBe(3);
    expect(news.impactRank("Medium")).toBe(2);
    expect(news.impactRank("Low")).toBe(1);
  });

  it("fetches live Forex Factory week feed", async () => {
    const events = await news.getEvents(true);
    expect(Array.isArray(events)).toBe(true);
    // Feed should return events for the week; tolerate empty on outage
    if (events.length > 0) {
      expect(events[0]).toHaveProperty("title");
      expect(events[0]).toHaveProperty("country");
      expect(events[0]).toHaveProperty("date");
    }
  }, 20_000);
});
