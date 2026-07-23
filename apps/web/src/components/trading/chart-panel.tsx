"use client";

import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useTicks } from "@/lib/hooks";
import type { Candle } from "@/lib/types";
import { ColorType, createChart, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";

export function ChartPanel() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: ticks } = useTicks();
  const [symbol, setSymbol] = useState("EURUSD");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  const symbols = (ticks ?? []).map((t) => t.symbol);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(248,250,252,0.55)",
        fontFamily: "IBM Plex Mono, monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)" },
      width: containerRef.current.clientWidth,
      height: 360,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#22C55E",
      downColor: "#EF4444",
      borderVisible: false,
      wickUpColor: "#22C55E",
      wickDownColor: "#EF4444",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const onResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!token || !seriesRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const candles = await api<Candle[]>(
          `/market-data/${encodeURIComponent(symbol)}/candles?timeframe=1h&limit=120`,
          { token },
        );
        if (cancelled || !seriesRef.current) return;
        seriesRef.current.setData(
          candles.map((c) => ({
            time: (Math.floor(new Date(c.openTime).getTime() / 1000) as unknown as string),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
          })) as never,
        );
        chartRef.current?.timeScale().fitContent();
      } catch {
        // chart stays empty on failure
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, token]);

  return (
    <Panel
      title="Market Chart"
      delay={0.08}
      action={
        <Select
          className="h-8 w-32"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
        >
          {(symbols.length ? symbols : ["EURUSD", "XAUUSD", "BTCUSD", "NAS100"]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      }
    >
      <div ref={containerRef} className="w-full" />
    </Panel>
  );
}
