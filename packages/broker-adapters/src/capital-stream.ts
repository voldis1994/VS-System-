import type { CapitalMarketInfo } from "./capital-markets";

/** Parse Capital streaming WS quote frame (destination: quote). */
export function parseCapitalStreamQuote(raw: string): CapitalMarketInfo | null {
  let msg: {
    destination?: string;
    payload?: Record<string, unknown>;
  };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return null;
  }
  if (msg.destination !== "quote" || !msg.payload) return null;
  const epic = String(msg.payload.epic ?? "");
  if (!epic) return null;
  const bidRaw = msg.payload.bid;
  const ofrRaw = msg.payload.ofr ?? msg.payload.offer;
  const bid = bidRaw == null || bidRaw === "" ? undefined : Number(bidRaw);
  const ofr = ofrRaw == null || ofrRaw === "" ? undefined : Number(ofrRaw);
  if (
    (bid == null || !Number.isFinite(bid)) &&
    (ofr == null || !Number.isFinite(ofr))
  ) {
    return null;
  }
  const bidN = bid != null && Number.isFinite(bid) ? bid : (ofr as number);
  const ofrN = ofr != null && Number.isFinite(ofr) ? ofr : (bid as number);
  return {
    epic,
    name: epic,
    instrumentType: String(msg.payload.product ?? "CFD"),
    bid: bidN,
    offer: ofrN,
  };
}
