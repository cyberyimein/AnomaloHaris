import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { createStockReportProjection } from "./stockReportProjection";

function createProjection(report) {
  return createStockReportProjection({
    report: ref(report),
    receivedAt: ref("2026-07-31T02:00:00Z"),
    selectedSymbol: ref("US.LOW"),
    bucketFilter: ref("all"),
    activeSection: ref("stocks"),
  });
}

describe("createStockReportProjection", () => {
  it("sorts the attention queue without treating attention as direction", () => {
    const projection = createProjection({
      market_session: { name: "premarket", label: "Pre-market" },
      stocks: [
        {
          symbol: "US.LOW",
          attention_score: 10,
          signal: { direction: "bullish" },
        },
        {
          symbol: "US.HIGH",
          attention_score: 90,
          signal: { direction: "bearish" },
        },
      ],
    });

    expect(projection.stockRows.value.map((stock) => stock.symbol)).toEqual([
      "US.HIGH",
      "US.LOW",
    ]);
    expect(projection.selectedStock.value.symbol).toBe("US.LOW");
    expect(projection.selectedStockSignal.value.direction).toBe("bullish");
  });

  it("projects session quotes, buckets, methodology, and score visibility", () => {
    const projection = createProjection({
      methodology: {
        status: "heuristic_not_backtested",
        purpose: "attention_triage_and_conditional_scenarios",
        not_a_claim: "buy_sell_or_return_prediction",
      },
      market_context: {
        risk_score: 8,
        judgment: {
          display: {
            score_policy: { show_internal_scores: false },
            market_state: { state: "risk_off", label: "承压" },
          },
        },
      },
      stocks: [
        {
          symbol: "US.LOW",
          bucket: "observe",
          attention_score: 10,
          session_quote: { label: "After hours", price: 11, change_pct: 1.5 },
          premarket: { label: "Pre-market", price: 9, change_pct: -2 },
        },
      ],
    });

    expect(projection.stockSessionQuote(projection.selectedStock.value).price).toBe(11);
    expect(projection.stockBucketFilters.value).toEqual([
      { id: "all", label: "All", count: 1 },
      { id: "observe", label: "Observe", count: 1 },
    ]);
    expect(projection.reportMethodologyNotice.value).toMatchObject({
      label: "启发式筛选，尚未回测",
      summary: "用于安排观察优先级，不构成买卖或收益预测",
    });
    expect(projection.showMarketInternalScores.value).toBe(false);
    expect(projection.marketTone.value).toBe("negative");
  });

  it("clamps level markers to the visible price range", () => {
    const projection = createProjection({
      stocks: [
        {
          symbol: "US.LOW",
          last_price: 120,
          previous_close: 100,
          levels: {
            support_zone: { low: 90, high: 95 },
            resistance_zone: { low: 105, high: 110 },
          },
        },
      ],
    });

    expect(projection.levelMarkerStyle(projection.selectedStock.value, 100)).toEqual({
      "--position": "33.33333333333333%",
    });
    expect(projection.levelMarkerStyle(projection.selectedStock.value, 200)).toEqual({
      "--position": "100%",
    });
  });
});
