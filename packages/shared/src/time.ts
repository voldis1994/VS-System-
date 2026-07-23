import { v4 as uuidv4 } from "uuid";

export function newId(): string {
  return uuidv4();
}

export function utcNow(): Date {
  return new Date();
}

export function toUtcIso(date: Date = new Date()): string {
  return date.toISOString();
}

export function formatInTimezone(
  date: Date,
  timeZone: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...options,
  }).format(date);
}

export function startOfDayInTimezone(date: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "01";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  // Approximate: construct UTC midnight for that calendar day in timezone via offset probe
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(probe);
  const localHour = Number(local);
  const offsetHours = 12 - localHour;
  return new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
