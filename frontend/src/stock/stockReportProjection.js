import { computed } from "vue";

export function createStockReportProjection({
  report,
  receivedAt,
  selectedSymbol,
  bucketFilter,
  activeSection,
}) {
  const stockReport = report;
  const stockReportReceivedAt = receivedAt;
  const selectedStockSymbol = selectedSymbol;
  const stockBucketFilter = bucketFilter;
  const stockActiveSection = activeSection;

  const stockRows = computed(() => {
    const rows = Array.isArray(stockReport.value?.stocks) ? stockReport.value.stocks : [];
    return [...rows].sort((left, right) => {
      const rightScore = numericValue(right.attention_score) ?? Number.NEGATIVE_INFINITY;
      const leftScore = numericValue(left.attention_score) ?? Number.NEGATIVE_INFINITY;
      return rightScore - leftScore;
    });
  });
  const stockMarketContext = computed(() => stockReport.value?.market_context || {});
  const marketJudgment = computed(() => stockMarketContext.value?.judgment || null);
  const marketDisplay = computed(() => marketJudgment.value?.display || {});
  const stockMarketSession = computed(() => stockReport.value?.market_session || null);
  const stockMarketSessionText = computed(() => {
    const session = stockMarketSession.value;
    if (!session) {
      return "--";
    }
    return session.label || titleLabel(session.name);
  });
  const marketRegimeLabel = computed(() => marketMoodLabel(stockMarketContext.value?.regime));
  const marketState = computed(() => marketDisplay.value?.market_state || {});
  const marketStateTitle = computed(() => marketState.value?.title || "市场状态");
  const marketStateLabel = computed(() => marketState.value?.label || marketRegimeLabel.value);
  const marketTone = computed(() => marketStateTone(marketState.value?.state || stockMarketContext.value?.regime));
  const showMarketInternalScores = computed(() => marketDisplay.value?.score_policy?.show_internal_scores === true);
  const marketScoreDetail = computed(() => {
    const explanation = marketDisplay.value?.overall_score_explanation || stockMarketContext.value?.risk_score_explanation || {};
    const score = numericValue(explanation.current_score ?? stockMarketContext.value?.risk_score);
    return {
      title: explanation.current_meaning || "综合环境状态",
      reading: [explanation.formula, explanation.how_to_use]
        .filter(Boolean)
        .join("；") || "用于综合指数、波动率和科技领导力，不是概率、收益率或价格目标。",
      audit: score === null ? "" : `内部评分 ${formatSignedNumber(score)}，仅供审计环境构成。`,
    };
  });
  const stockMarketGroups = computed(() => {
    const groups = stockMarketContext.value?.groups || {};
    const reads = marketJudgment.value?.reads || {};
    return Object.entries(groups).map(([key, group]) => {
      const read = reads[key] || {};
      const displayDrivers = marketGroupDrivers(read, group);
      const definition = marketGroupDefinition(key);
      const scoreExplanation = read.score_explanation || {};
      const groupScore = numericValue(scoreExplanation.current_score ?? read.score ?? group.score);
      return {
        key,
        name: read.title || marketGroupName(key),
        definition,
        ...group,
        label: read.label || titleLabel(group.label),
        stateLabel: read.label || titleLabel(group.label),
        tone: marketStateTone(read.state || group.label),
        summary: read.summary || group.notes?.[0] || "",
        displayDrivers,
        coverageLabel:
          Number.isFinite(group.available_symbols) && Number.isFinite(group.configured_symbols)
            ? `${group.available_symbols}/${group.configured_symbols} symbols`
            : "Context input",
        scoreDetail: {
          title: definition.meaning,
          reading: [definition.reading, scoreExplanation.how_to_use || read.summary].filter(Boolean).join("；"),
          audit:
            groupScore === null || scoreExplanation.show_group_score === false
              ? ""
              : `内部评分 ${formatSignedNumber(groupScore)}，仅供审计环境构成。`,
        },
      };
    });
  });
  const marketThemeGroups = computed(() => {
    const judgmentGroups = marketJudgment.value?.reads?.themes?.groups;
    if (Array.isArray(judgmentGroups) && judgmentGroups.length) {
      return judgmentGroups.map((group) => ({ key: group.group, ...group }));
    }
    const groups = stockMarketContext.value?.theme_groups?.groups || {};
    return Object.entries(groups).map(([key, group]) => ({
      key,
      title: group.display_name || key,
      label: titleLabel(group.label),
      state: group.label,
      breadth: `${group.positive_symbols ?? 0}/${group.available_symbols ?? 0}`,
      benchmark_symbol: group.benchmark_symbol,
      benchmark_alignment: group.benchmark_alignment,
    }));
  });
  const marketThemeSummary = computed(() => {
    const state = marketJudgment.value?.reads?.themes?.state;
    const labels = {
      bullish: "多数偏强",
      bearish: "多数偏弱",
      mixed: "方向分化",
    };
    return labels[state] || "观察组分化";
  });
  const marketMacroComponents = computed(() => {
    const components = marketJudgment.value?.reads?.macro?.components;
    return components && typeof components === "object" ? Object.values(components) : [];
  });
  const selectedStock = computed(() => {
    if (!stockRows.value.length) {
      return null;
    }
    return stockRows.value.find((stock) => stock.symbol === selectedStockSymbol.value) || stockRows.value[0];
  });
  const selectedStockJudgment = computed(() => selectedStock.value?.judgment || null);
  const selectedSetupTags = computed(() => selectedStock.value?.setups?.tags || []);
  const selectedStockSignal = computed(() => selectedStockJudgment.value?.signal || selectedStock.value?.signal || null);
  const selectedStockGroupContext = computed(
    () => selectedStockJudgment.value?.group_read || selectedStock.value?.group_context || null,
  );
  const selectedRelativeStrength = computed(
    () => selectedStockJudgment.value?.technical_read?.relative_strength || selectedStock.value?.relative_strength || null,
  );
  const stockHeadline = computed(() => {
    if (!stockReport.value) {
      return "Stock Analysis";
    }
    if (stockActiveSection.value === "market") {
      return `大盘 · ${marketStateLabel.value}`;
    }
    return `个股 · ${stockRows.value.length} 个标的`;
  });
  const stockReportSubhead = computed(() => {
    if (!stockReport.value) {
      return "Waiting for the first JSON report from the analysis service.";
    }
    const mode = stockReport.value.data_mode ? `Mode ${stockReport.value.data_mode}` : "Live report";
    const warnings = Array.isArray(stockReport.value.warnings) ? stockReport.value.warnings.length : 0;
    if (stockActiveSection.value === "market") {
      return `${mode} · ${stockMarketSessionText.value} · ${warnings} warnings`;
    }
    return `${mode} · ${warnings} warnings · 按关注优先级排序`;
  });
  const stockGeneratedAtText = computed(() => formatDateTime(stockReport.value?.generated_at));
  const stockReceivedAtText = computed(() => formatDateTime(stockReportReceivedAt.value));
  const stockMarketSummary = computed(() => {
    const headline = marketJudgment.value?.headline;
    if (headline) {
      return headline;
    }
    const notes = Array.isArray(stockMarketContext.value?.notes) ? stockMarketContext.value.notes : [];
    if (notes.length) {
      return notes.slice(0, 3).join(" · ");
    }
    return "Market context is available, but this report did not include summary notes.";
  });
  const marketStanceLabel = computed(() => stanceLabel(marketJudgment.value?.stance));
  const marketIntelligenceList = computed(() => {
    const intelligence = marketJudgment.value?.key_intelligence;
    if (Array.isArray(intelligence) && intelligence.length) {
      return intelligence.slice(0, 6);
    }
    return marketNoteList.value;
  });
  const marketScenarioCards = computed(() => {
    const scenarios = marketJudgment.value?.scenarios;
    return Array.isArray(scenarios) ? scenarios.slice(0, 5) : [];
  });
  const stockSectionTabs = computed(() => [
    {
      id: "market",
      label: "大盘",
      value: marketStateLabel.value,
      detail: marketStanceLabel.value,
    },
    {
      id: "stocks",
      label: "个股",
      value: String(stockRows.value.length),
      detail: `${stockRows.value.filter((stock) => stock.bucket === "observe").length} observe`,
    },
  ]);
  const marketHeroStats = computed(() => {
    const dataQuality = marketDisplay.value?.data_quality || {};
    const signalQuality = marketDisplay.value?.signal_quality || {};
    return [
      {
        label: "Session",
        value: stockMarketSessionText.value,
        meaning: "本次报告使用的交易时段。",
        reading: "报价和涨跌幅都以这个时段相对最近一次常规收盘价计算。",
      },
      {
        label: dataQuality.title || "数据状态",
        value: dataQuality.label || formatScaledPercent(stockMarketContext.value?.data_coverage, 0, false),
        meaning: "数据状态反映配置的市场代理是否成功加载。",
        reading: "数据不完整时，环境判断应降低优先级；它不是预测准确率。",
      },
      {
        label: signalQuality.title || "环境信号一致性",
        value: signalQuality.label || titleLabel(stockMarketContext.value?.signal_confidence_label),
        meaning: signalQuality.explanation || "环境信号强弱与各区块一致性的启发式质量标签。",
        reading: "它不是上涨或下跌概率，只用于判断是否值得优先观察。",
      },
    ];
  });
  const reportMethodologyNotice = computed(() => {
    const methodology = stockReport.value?.methodology;
    if (!methodology?.status) {
      return null;
    }
    const isHeuristic = methodology.status === "heuristic_not_backtested";
    return {
      label: isHeuristic ? "启发式筛选，尚未回测" : titleLabel(methodology.status),
      summary: isHeuristic
        ? "用于安排观察优先级，不构成买卖或收益预测"
        : methodologyPurposeLabel(methodology.purpose),
      detail: methodology.purpose ? `用途：${methodologyPurposeLabel(methodology.purpose)}` : "分析方法说明未提供。",
      limitation: methodology.not_a_claim
        ? `不代表：${methodologyClaimLabel(methodology.not_a_claim)}`
        : methodology.validation?.next_step || "请结合触发条件和后续回测结果使用。",
    };
  });
  const marketNoteList = computed(() => {
    const notes = Array.isArray(stockMarketContext.value?.notes) ? stockMarketContext.value.notes : [];
    return notes.slice(0, 4);
  });
  const stockQueueSummaryCards = computed(() => [
    {
      label: "Watch now",
      value: String(stockRows.value.filter((stock) => stock.bucket === "watch").length),
      detail: "highest attention",
      tone: "positive",
    },
    {
      label: "Avg session move",
      value: formatPercent(averageSessionMove.value, 2, false),
      detail: stockMarketSessionText.value,
      tone: "warning",
    },
    {
      label: "Top attention",
      value: formatNumber(stockRows.value[0]?.attention_score, 1),
      detail: compactSymbol(stockRows.value[0]?.symbol),
      tone: scoreTone(stockRows.value[0]?.attention_score),
    },
    {
      label: "Option summary",
      value: String(stockRows.value.filter((stock) => stock.options).length),
      detail: "symbols with data",
      tone: "neutral",
    },
  ]);
  const averageSessionMove = computed(() => {
    const moves = stockRows.value
      .map((stock) => numericValue(stockSessionQuote(stock)?.change_pct))
      .filter((value) => value !== null);
    if (!moves.length) {
      return null;
    }
    return moves.reduce((total, value) => total + Math.abs(value), 0) / moves.length;
  });
  const stockBucketFilters = computed(() => {
    const counts = new Map();
    for (const stock of stockRows.value) {
      const bucket = stock.bucket || "unbucketed";
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
    }
    const filters = [{ id: "all", label: "All", count: stockRows.value.length }];
    for (const [bucket, count] of [...counts.entries()].sort()) {
      filters.push({ id: bucket, label: bucketLabel(bucket), count });
    }
    return filters;
  });
  const filteredStockRows = computed(() => {
    if (stockBucketFilter.value === "all") {
      return stockRows.value;
    }
    return stockRows.value.filter((stock) => (stock.bucket || "unbucketed") === stockBucketFilter.value);
  });
  const selectedStockMetrics = computed(() => {
    const stock = selectedStock.value;
    if (!stock) {
      return [];
    }
    return [
      {
        label: "Attention",
        value: formatNumber(stock.attention_score, 1),
        detail: "score",
        tone: scoreTone(stock.attention_score),
      },
      {
        label: "Last",
        value: formatPrice(stock.last_price),
        detail: stock.technicals?.last_bar_date || `Prev ${formatPrice(stock.previous_close)}`,
        tone: scoreTone(stock.technicals?.daily_change_pct),
      },
      {
        label: stockSessionLabel(stock),
        value: formatPrice(stockSessionQuote(stock)?.price),
        detail: `${formatPercent(stockSessionQuote(stock)?.change_pct)} · ${formatVolume(stockSessionQuote(stock)?.volume)}`,
        tone: scoreTone(stockSessionQuote(stock)?.change_pct),
      },
      {
        label: stock.options ? "Implied range" : "Trend",
        value: stock.options
          ? formatPercent(stock.options.straddle_implied_move_pct ?? stock.options.expected_move_pct, 2, false)
          : titleLabel(stock.technicals?.trend),
        detail: stock.options ? stock.options.nearest_expiry || "nearest expiry" : `ATR ${formatPercent(stock.technicals?.atr_pct, 2, false)}`,
        tone: stock.options ? "warning" : scoreTone(stock.technicals?.trend_score),
      },
    ];
  });
  const selectedJudgmentKeyPoints = computed(() => {
    const points = selectedStockJudgment.value?.key_points;
    return Array.isArray(points) ? points.slice(0, 6) : [];
  });
  const selectedJudgmentScenarios = computed(() => {
    const scenarios = selectedStockJudgment.value?.scenarios;
    return Array.isArray(scenarios) ? scenarios.slice(0, 4) : [];
  });
  const selectedTechnicalReadCards = computed(() => {
    const read = selectedStockJudgment.value?.technical_read || {};
    return [
      {
        label: "EMA state",
        title: read.ema?.label,
        summary: read.ema?.summary,
      },
      {
        label: "Bollinger state",
        title: read.bollinger?.label,
        summary: read.bollinger?.summary,
      },
      {
        label: "Level state",
        title: read.levels?.label,
        summary: read.levels?.summary,
      },
    ].filter((item) => item.title || item.summary);
  });
  const selectedTechnicalReadSummary = computed(() =>
    selectedTechnicalReadCards.value
      .map((item) => item.title)
      .filter(Boolean)
      .slice(0, 3)
      .join(" · "),
  );
  const selectedOptionRead = computed(() => selectedStockJudgment.value?.option_read || null);
  const selectedTechnicalMeters = computed(() => {
    const technicals = selectedStock.value?.technicals || {};
    const bollinger = technicals.bollinger || {};
    return [
      {
        label: "RSI 14",
        display: formatNumber(technicals.rsi14, 1),
        fill: clampNumber(numericValue(technicals.rsi14) ?? 0, 0, 100),
        tone: rsiTone(technicals.rsi14),
      },
      {
        label: "Bollinger %B",
        display: formatNumber(bollinger.percent_b, 2),
        fill: clampNumber((numericValue(bollinger.percent_b) ?? 0) * 100, 0, 100),
        tone: scoreTone((numericValue(bollinger.percent_b) ?? 0.5) - 0.5),
      },
      {
        label: "ATR %",
        display: formatPercent(technicals.atr_pct, 2, false),
        fill: clampNumber((numericValue(technicals.atr_pct) ?? 0) * 5, 0, 100),
        tone: "warning",
      },
      {
        label: "Vol / 20D",
        display: formatNumber(technicals.volume_vs_20d, 2),
        fill: clampNumber((numericValue(technicals.volume_vs_20d) ?? 0) * 100, 0, 100),
        tone: "neutral",
      },
    ];
  });
  const selectedOptionMetrics = computed(() => {
    const options = selectedStock.value?.options;
    if (!options) {
      return [];
    }
    return [
      { label: "ATM", value: formatPrice(options.atm_strike) },
      { label: "Straddle", value: formatPrice(options.atm_straddle_mid) },
      { label: "ATM IV", value: formatScaledPercent(options.atm_iv ?? options.average_iv, 0, false) },
      { label: "P/C volume", value: formatNumber(options.put_call_volume_ratio, 2) },
      { label: "P/C OI", value: formatNumber(options.put_call_oi_ratio, 2) },
      { label: "Skew", value: formatScaledPercent(options.skew_put_minus_call_iv, 1) },
    ];
  });

  return {
    stockRows,
    stockMarketContext,
    marketJudgment,
    marketDisplay,
    stockMarketSession,
    stockMarketSessionText,
    marketRegimeLabel,
    marketState,
    marketStateTitle,
    marketStateLabel,
    marketTone,
    showMarketInternalScores,
    marketScoreDetail,
    stockMarketGroups,
    marketThemeGroups,
    marketThemeSummary,
    marketMacroComponents,
    selectedStock,
    selectedStockJudgment,
    selectedSetupTags,
    selectedStockSignal,
    selectedStockGroupContext,
    selectedRelativeStrength,
    stockHeadline,
    stockReportSubhead,
    stockGeneratedAtText,
    stockReceivedAtText,
    stockMarketSummary,
    marketStanceLabel,
    marketIntelligenceList,
    marketScenarioCards,
    stockSectionTabs,
    marketHeroStats,
    reportMethodologyNotice,
    marketNoteList,
    stockQueueSummaryCards,
    averageSessionMove,
    stockBucketFilters,
    filteredStockRows,
    selectedStockMetrics,
    selectedJudgmentKeyPoints,
    selectedJudgmentScenarios,
    selectedTechnicalReadCards,
    selectedTechnicalReadSummary,
    selectedOptionRead,
    selectedTechnicalMeters,
    selectedOptionMetrics,
    numericValue,
    formatNumber,
    formatSignedNumber,
    formatPercent,
    formatScaledPercent,
    formatPrice,
    formatVolume,
    formatDateTime,
    titleLabel,
    marketMoodLabel,
    methodologyPurposeLabel,
    methodologyClaimLabel,
    compactSymbol,
    compactOptionSymbol,
    stanceLabel,
    bucketLabel,
    marketGroupName,
    marketGroupDefinition,
    marketGroupDrivers,
    stockSessionQuote,
    stockSessionLabel,
    stockSignalLabel,
    scoreTone,
    marketStateTone,
    rsiTone,
    clampNumber,
    formatZone,
    priceLevelSummary,
    levelZoneTitle,
    levelMarkerTitle,
    formatOptionReadMetric,
    levelMarkerStyle,
    levelZoneStyle,
    levelPosition,
    levelValues,
  };
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function formatNumber(value, digits = 1) {
  const numberValue = numericValue(value);
  return numberValue === null ? "--" : numberValue.toFixed(digits);
}

function formatSignedNumber(value, digits = 1) {
  const numberValue = numericValue(value);
  if (numberValue === null) {
    return "--";
  }
  return `${numberValue > 0 ? "+" : ""}${numberValue.toFixed(digits)}`;
}

function formatPercent(value, digits = 2, signed = true) {
  const numberValue = numericValue(value);
  if (numberValue === null) {
    return "--";
  }
  const prefix = signed && numberValue > 0 ? "+" : "";
  return `${prefix}${numberValue.toFixed(digits)}%`;
}

function formatScaledPercent(value, digits = 0, signed = true) {
  const numberValue = numericValue(value);
  if (numberValue === null) {
    return "--";
  }
  return formatPercent(numberValue * 100, digits, signed);
}

function formatPrice(value) {
  const numberValue = numericValue(value);
  return numberValue === null ? "--" : numberValue.toFixed(numberValue >= 100 ? 2 : 2);
}

function formatVolume(value) {
  const numberValue = numericValue(value);
  if (numberValue === null) {
    return "--";
  }
  if (numberValue >= 1000000) {
    return `${(numberValue / 1000000).toFixed(1)}M`;
  }
  if (numberValue >= 1000) {
    return `${(numberValue / 1000).toFixed(0)}K`;
  }
  return String(Math.round(numberValue));
}

function formatDateTime(value, { includeSeconds = false } = {}) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    timeZoneName: "short",
  });
}

function titleLabel(value) {
  if (!value) {
    return "--";
  }
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function marketMoodLabel(regime) {
  const labels = {
    risk_on: "Risk on",
    risk_off: "Risk off",
    mixed: "Mixed",
  };
  return labels[regime] || titleLabel(regime);
}

function methodologyPurposeLabel(value) {
  const labels = {
    attention_triage_and_conditional_scenarios: "开盘前注意力分配与条件情景判断",
  };
  return labels[value] || titleLabel(value);
}

function methodologyClaimLabel(value) {
  const labels = {
    buy_sell_or_return_prediction: "买卖建议或收益预测",
  };
  return labels[value] || titleLabel(value);
}

function compactSymbol(symbol) {
  return String(symbol || "--").replace(/^US\./, "");
}

function compactOptionSymbol(symbol) {
  return String(symbol || "--").replace(/^US\./, "");
}

function stanceLabel(stance) {
  const labels = {
    avoid_until_invalidation: "等待失效",
    cautious_selective: "谨慎筛选",
    defensive: "防守",
    low_priority: "低优先级",
    neutral_wait_for_confirmation: "等待确认",
    observe_for_confirmation: "观察确认",
    observe_for_trigger: "等待触发",
    watch_now: "立即关注",
  };
  return labels[stance] || titleLabel(stance || "Wait for confirmation");
}

function bucketLabel(bucket) {
  const labels = {
    ignore: "Ignore",
    observe: "Observe",
    trade: "Trade",
    watch: "Watch",
    unbucketed: "Unbucketed",
  };
  return labels[bucket] || titleLabel(bucket);
}

function marketGroupName(key) {
  const labels = {
    equity: "Equity",
    volatility: "Volatility",
    macro: "Macro",
    sector: "Sector",
  };
  return labels[key] || titleLabel(key);
}

function marketGroupDefinition(key) {
  const definitions = {
    equity: {
      wording: "Index tape",
      meaning: "SPY、QQQ、IWM 组成的指数方向代理。",
      reading: "分数偏弱说明宽基指数拖累风险偏好；分数偏强说明指数背景更支持个股进攻。",
    },
    volatility: {
      wording: "Volatility environment",
      meaning: "VIXY 的短期变化，用作期货型波动率压力代理。",
      reading: "正分代表波动压力缓和；VIXY 的长期 EMA 趋势不会被当作恐慌信号。",
    },
    macro: {
      wording: "Macro context",
      meaning: "美元、债券、黄金、原油等宏观输入。",
      reading: "它只解释背景，不进入 risk score；不要把 0 分解读为中性或看多。",
    },
    sector: {
      wording: "Tech leadership",
      meaning: "SOXX 与 IGV 代表的科技领导力。",
      reading: "科技领导力偏强会提高科技股 setup 的背景质量；它占 risk score 的一部分。",
    },
  };
  return definitions[key] || {
    wording: marketGroupName(key),
    meaning: "Market proxy group.",
    reading: "Use the score as a directional context input, not a standalone trade signal.",
  };
}

function marketGroupDrivers(read, group) {
  let drivers = [];
  if (Array.isArray(read?.display_drivers) && read.display_drivers.length) {
    drivers = read.display_drivers;
  } else if (Array.isArray(read?.drivers) && read.drivers.length) {
    drivers = read.drivers;
  } else if (read?.components && typeof read.components === "object") {
    drivers = Object.values(read.components);
  } else if (Array.isArray(group?.symbols)) {
    drivers = group.symbols;
  }
  return drivers.slice(0, 4).map((driver) => ({
    ...driver,
    displayValue:
      driver.value ||
      formatPercent(driver.session_move_pct ?? driver.gap_pct ?? driver.session_change_pct, 2),
  }));
}

function stockSessionQuote(stock) {
  if (stock?.session_quote?.price !== null && stock?.session_quote?.price !== undefined) {
    return stock.session_quote;
  }
  return stock?.premarket || null;
}

function stockSessionLabel(stock) {
  const session = stockSessionQuote(stock);
  return session?.label || (session?.session ? titleLabel(session.session) : "Session");
}

function stockSignalLabel(direction) {
  const labels = {
    bullish: "偏多条件",
    bearish: "偏空条件",
    neutral: "等待方向",
  };
  return labels[direction] || titleLabel(direction) || "等待方向";
}

function scoreTone(value) {
  const numberValue = numericValue(value);
  if (numberValue === null) {
    return "neutral";
  }
  if (numberValue >= 10) {
    return "positive";
  }
  if (numberValue <= -10) {
    return "negative";
  }
  return "neutral";
}

function marketStateTone(state) {
  const normalized = String(state || "").toLowerCase();
  if (["risk_on", "bullish", "positive", "strong"].includes(normalized)) {
    return "positive";
  }
  if (["risk_off", "bearish", "negative", "weak"].includes(normalized)) {
    return "negative";
  }
  return "neutral";
}

function rsiTone(value) {
  const numberValue = numericValue(value);
  if (numberValue === null) {
    return "neutral";
  }
  if (numberValue <= 35) {
    return "positive";
  }
  if (numberValue >= 70) {
    return "negative";
  }
  return "neutral";
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatZone(zone) {
  if (!zone) {
    return "--";
  }
  return `${formatPrice(zone.low)}-${formatPrice(zone.high)}`;
}

function priceLevelSummary(stock) {
  if (!stock) {
    return "Price level map";
  }
  const parts = [
    `Support ${formatZone(stock.levels?.support_zone)}`,
    `Last ${formatPrice(stock.last_price)}`,
  ];
  const session = stockSessionQuote(stock);
  if (session?.price) {
    parts.push(`${stockSessionLabel(stock)} ${formatPrice(session.price)} (${formatPercent(session.change_pct)})`);
  }
  parts.push(`Resistance ${formatZone(stock.levels?.resistance_zone)}`);
  return parts.join(" · ");
}

function levelZoneTitle(stock, zoneKey) {
  const zoneLabels = {
    support_zone: "Support zone",
    resistance_zone: "Resistance zone",
  };
  const zone = stock?.levels?.[zoneKey];
  const value = formatZone(zone);
  if (zoneKey === "support_zone") {
    return `${zoneLabels[zoneKey]} ${value}: 可能出现买盘的位置；观察价格能否守住，跌破则支撑失效。`;
  }
  return `${zoneLabels[zoneKey] || "Price zone"} ${value}: 可能出现卖压的位置；观察价格是突破还是受阻回落。`;
}

function levelMarkerTitle(stock, marker) {
  if (marker === "session") {
    const session = stockSessionQuote(stock);
    return `${stockSessionLabel(stock)} ${formatPrice(session?.price)} (${formatPercent(session?.change_pct)}): 蓝线表示该交易时段报价相对昨收的位置。`;
  }
  return `Last ${formatPrice(stock?.last_price)}: 最近常规交易参考价，黑线表示当前价在支撑/压力区间中的位置。`;
}

function formatOptionReadMetric(metric) {
  if (!metric) {
    return "--";
  }
  const value = formatNumber(metric.value, metric.unit === "ratio" ? 2 : 1);
  if (metric.unit === "%") {
    return `${value}%`;
  }
  if (metric.unit === "ratio") {
    return value;
  }
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function levelMarkerStyle(stock, value) {
  return { "--position": `${levelPosition(stock, value)}%` };
}

function levelZoneStyle(stock, zoneKey) {
  const zone = stock?.levels?.[zoneKey];
  if (!zone) {
    return { "--start": "0%", "--width": "0%" };
  }
  const low = levelPosition(stock, zone.low);
  const high = levelPosition(stock, zone.high);
  return {
    "--start": `${Math.min(low, high)}%`,
    "--width": `${Math.max(Math.abs(high - low), 1)}%`,
  };
}

function levelPosition(stock, value) {
  const numberValue = numericValue(value);
  const values = levelValues(stock);
  if (numberValue === null || values.length < 2) {
    return 50;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) {
    return 50;
  }
  return clampNumber(((numberValue - min) / (max - min)) * 100, 0, 100);
}

function levelValues(stock) {
  const levels = stock?.levels || {};
  const zones = [levels.support_zone, levels.resistance_zone];
  return [
    stock?.last_price,
    stock?.previous_close,
    stockSessionQuote(stock)?.price,
    levels.yesterday_high,
    levels.yesterday_low,
    levels.last_week_high,
    levels.last_week_low,
    levels.recent_high,
    levels.recent_low,
    ...zones.flatMap((zone) => (zone ? [zone.low, zone.high] : [])),
  ].flatMap((value) => {
    const numberValue = numericValue(value);
    return numberValue === null ? [] : [numberValue];
  });
}
