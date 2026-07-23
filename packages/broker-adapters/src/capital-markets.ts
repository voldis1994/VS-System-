/**
 * Capital.com epic catalog + alias map.
 * Prefer live GET /markets results; these are fallbacks / search seeds.
 */
export type CapitalMarketInfo = {
  epic: string;
  name: string;
  instrumentType?: string;
  bid?: number;
  offer?: number;
  high?: number;
  low?: number;
  percentageChange?: number;
  marketStatus?: string;
};

/** Map common aliases → Capital.com epic */
export const CAPITAL_EPIC_ALIASES: Record<string, string> = {
  XAUUSD: "GOLD",
  GOLD: "GOLD",
  XAGUSD: "SILVER",
  SILVER: "SILVER",
  BTCUSD: "BITCOIN",
  BTC: "BITCOIN",
  BITCOIN: "BITCOIN",
  ETHUSD: "ETHEREUM",
  ETH: "ETHEREUM",
  ETHEREUM: "ETHEREUM",
  NAS100: "US100",
  NASDAQ100: "US100",
  US100: "US100",
  NDX: "US100",
  US30: "US30",
  DJI: "US30",
  SPX500: "US500",
  US500: "US500",
  GER40: "GERMANY40",
  DAX: "GERMANY40",
  GERMANY40: "GERMANY40",
  UK100: "UK100",
  FTSE: "UK100",
  FRA40: "FRANCE40",
  FRANCE40: "FRANCE40",
  JPN225: "JAPAN225",
  JAPAN225: "JAPAN225",
  OIL: "OIL_CRUDE",
  CRUDE: "OIL_CRUDE",
  OIL_CRUDE: "OIL_CRUDE",
  BRENT: "OIL_BRENT",
  OIL_BRENT: "OIL_BRENT",
  NATGAS: "NATURALGAS",
  NATURALGAS: "NATURALGAS",
};

/** Search seeds to discover Capital markets across asset classes */
export const CAPITAL_SEARCH_SEEDS = [
  // FX majors / crosses
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDCHF",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "EURGBP",
  "EURJPY",
  "GBPJPY",
  "AUDJPY",
  "EURCHF",
  "EURAUD",
  "GBPAUD",
  "USDSEK",
  "USDNOK",
  "USDMXN",
  "USDZAR",
  "USDTRY",
  "USDCNH",
  // Indices
  "US100",
  "US30",
  "US500",
  "GERMANY40",
  "UK100",
  "FRANCE40",
  "JAPAN225",
  "HONGKONG50",
  "SPAIN35",
  "AUSTRALIA200",
  "EU50",
  // Commodities
  "GOLD",
  "SILVER",
  "PLATINUM",
  "PALLADIUM",
  "OIL_CRUDE",
  "OIL_BRENT",
  "NATURALGAS",
  "COPPER",
  "WHEAT",
  "CORN",
  "COFFEE",
  "SUGAR",
  // Crypto
  "BITCOIN",
  "ETHEREUM",
  "LITECOIN",
  "RIPPLE",
  "CARDANO",
  "SOLANA",
  "DOGECOIN",
  "POLKADOT",
  "CHAINLINK",
  "AVALANCHE",
  // Shares / themes (search terms)
  "Apple",
  "Tesla",
  "NVIDIA",
  "Amazon",
  "Microsoft",
  "Meta",
  "Google",
  "Netflix",
  "AMD",
  "Intel",
  "Coca-Cola",
  "Disney",
  "Boeing",
  "JPMorgan",
  "Visa",
];

export function resolveCapitalEpic(symbol: string): string {
  const key = symbol.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  return CAPITAL_EPIC_ALIASES[key] ?? symbol.trim();
}
