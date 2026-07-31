<template>
<section class="stock-analysis-view"
  aria-label="Stock Analysis"
>
  <div class="stock-shell">
    <header class="stock-page-header">
      <div>
        <span class="stock-kicker">Stock Analysis</span>
        <h2>{{ stockHeadline }}</h2>
        <p>{{ stockReportSubhead }}</p>
      </div>
      <div class="stock-run-meta">
        <span>Generated</span>
        <strong>{{ stockGeneratedAtText }}</strong>
        <span>Session</span>
        <strong>{{ stockMarketSessionText }}</strong>
        <span>Received</span>
        <strong>{{ stockReceivedAtText }}</strong>
      </div>
    </header>

    <div
      v-if="stockStatus === 'error' || managementAccessRequired"
      class="stock-action-notice"
      :data-tone="managementAccessRequired ? 'warning' : 'error'"
      role="alert"
    >
      <span>{{ stockStatusMessage }}</span>
      <form
        v-if="managementAccessRequired"
        class="stock-token-form"
        @submit.prevent="saveManagementToken"
      >
        <input
          v-model="managementTokenInput"
          type="password"
          autocomplete="off"
          placeholder="Admin token"
          aria-label="Admin token for stock scan"
        />
        <button class="control-button" type="submit">Save &amp; Retry</button>
      </form>
    </div>

    <div v-if="stockStatus === 'loading'" class="stock-empty-panel">
      <LoaderCircle :size="22" class="activity-spinner" />
      <strong>Loading stock report</strong>
      <span>{{ stockStatusMessage }}</span>
    </div>

    <div v-else-if="!stockReport" class="stock-empty-panel">
      <Database :size="26" />
      <strong>No stock report loaded</strong>
      <span>{{ stockStatusMessage }}</span>
      <code>POST /api/stocks/scan</code>
    </div>

    <template v-else>
      <div class="stock-mode-tabs" role="tablist" aria-label="Stock analysis sections">
        <button
          v-for="tab in stockSectionTabs"
          :key="tab.id"
          class="stock-mode-tab"
          :class="{ active: stockActiveSection === tab.id }"
          type="button"
          role="tab"
          :aria-selected="stockActiveSection === tab.id"
          @click="selectStockSection(tab.id)"
        >
          <span>{{ tab.label }}</span>
          <strong>{{ tab.value }}</strong>
        </button>
      </div>

      <div v-if="reportMethodologyNotice" class="stock-report-contract" role="status">
        <span>{{ reportMethodologyNotice.label }}</span>
        <strong>{{ reportMethodologyNotice.summary }}</strong>
        <span class="info-anchor">
          <button class="info-button" type="button" aria-label="分析方法说明">
            <Info :size="14" />
          </button>
          <span class="info-popover" role="tooltip">
            <strong>{{ reportMethodologyNotice.detail }}</strong>
            <em>{{ reportMethodologyNotice.limitation }}</em>
          </span>
        </span>
      </div>

      <section
        v-if="stockActiveSection === 'market'"
        class="stock-tab-panel market-tab-panel"
        aria-label="Market context"
      >
        <section class="market-hero" :data-tone="marketTone" aria-label="Market summary">
          <div class="market-hero-copy">
            <span class="stock-kicker">Market posture</span>
            <h3>{{ marketStateLabel }}</h3>
            <p>{{ stockMarketSummary }}</p>
          </div>

          <div class="market-hero-state">
            <span>{{ marketStateTitle }}</span>
            <div>
              <strong v-if="showMarketInternalScores">{{ formatSignedNumber(stockMarketContext?.risk_score) }}</strong>
              <strong v-else>{{ marketStateLabel }}</strong>
              <span class="info-anchor">
                <button class="info-button" type="button" aria-label="市场状态评分说明">
                  <Info :size="14" />
                </button>
                <span class="info-popover info-popover-left" role="tooltip">
                  <strong>{{ marketScoreDetail.title }}</strong>
                  <em>{{ marketScoreDetail.reading }}</em>
                  <small v-if="marketScoreDetail.audit">{{ marketScoreDetail.audit }}</small>
                </span>
              </span>
            </div>
            <em>{{ marketStanceLabel }}</em>
          </div>

          <div class="market-hero-stats">
            <article v-for="stat in marketHeroStats" :key="stat.label">
              <div>
                <span>{{ stat.label }}</span>
                <strong>{{ stat.value }}</strong>
              </div>
              <span class="info-anchor">
                <button class="info-button" type="button" :aria-label="`${stat.label} explanation`">
                  <Info :size="14" />
                </button>
                <span class="info-popover" role="tooltip">
                  <strong>{{ stat.meaning }}</strong>
                  <em>{{ stat.reading }}</em>
                </span>
              </span>
            </article>
          </div>
        </section>

        <section class="market-signal-panel" aria-label="Market signal blocks">
          <header class="market-section-heading">
            <div>
              <span>市场信号</span>
              <strong>影响今天风险偏好的四块输入</strong>
            </div>
          </header>
          <div class="market-signal-rail">
            <article
              v-for="group in stockMarketGroups"
              :key="group.key"
              :data-tone="group.tone"
            >
              <header>
                <div>
                  <span>{{ group.name }}</span>
                  <strong>{{ group.label || group.name }}</strong>
                </div>
                <div class="market-signal-state">
                  <span class="info-anchor">
                    <button
                      class="info-button"
                      type="button"
                      :aria-label="`${group.definition.wording} explanation`"
                    >
                      <Info :size="14" />
                    </button>
                    <span class="info-popover" role="tooltip">
                      <strong>{{ group.scoreDetail.title }}</strong>
                      <em>{{ group.scoreDetail.reading }}</em>
                      <small v-if="group.scoreDetail.audit">{{ group.scoreDetail.audit }}</small>
                    </span>
                  </span>
                </div>
              </header>
              <footer>
                <span>{{ group.coverageLabel }}</span>
                <div class="market-signal-drivers">
                  <span v-for="driver in group.displayDrivers.slice(0, 3)" :key="driver.symbol" :title="driver.meaning">
                    {{ compactSymbol(driver.symbol) }} {{ driver.displayValue }}
                  </span>
                </div>
              </footer>
            </article>
          </div>
        </section>

        <section class="market-detail-grid" aria-label="Market breadth and macro context">
          <article v-if="marketThemeGroups.length" class="market-breadth-panel">
            <header class="market-section-heading">
              <div>
                <span>观察组广度</span>
                <strong>{{ marketThemeSummary }}</strong>
              </div>
              <span class="info-anchor">
                <button class="info-button" type="button" aria-label="观察组广度说明">
                  <Info :size="14" />
                </button>
                <span class="info-popover" role="tooltip">
                  <strong>四个精选科技观察组的同组方向。</strong>
                  <em>用于确认板块轮动和同组共振，不进入大盘风险分，也不是完整市场广度。</em>
                </span>
              </span>
            </header>
            <div class="market-breadth-list">
              <article v-for="group in marketThemeGroups" :key="group.key" :data-tone="marketStateTone(group.state || group.label)">
                <div>
                  <span>{{ group.title }}</span>
                  <strong>{{ group.label }}</strong>
                </div>
                <b>{{ group.breadth }}</b>
                <small>同组确认 · {{ compactSymbol(group.benchmark_symbol) }}</small>
              </article>
            </div>
          </article>

          <article v-if="marketMacroComponents.length" class="market-macro-panel">
            <header class="market-section-heading">
              <div>
                <span>宏观背景</span>
                <strong>黄金 / 美元 / 油 / 债</strong>
              </div>
              <span class="info-anchor">
                <button class="info-button" type="button" aria-label="宏观背景说明">
                  <Info :size="14" />
                </button>
                <span class="info-popover" role="tooltip">
                  <strong>宏观输入帮助解释外部环境。</strong>
                  <em>它们不直接进入大盘风险分，应结合指数、波动率和板块信号一起阅读。</em>
                </span>
              </span>
            </header>
            <div class="market-macro-list">
              <article v-for="component in marketMacroComponents" :key="component.symbol">
                <strong>{{ compactSymbol(component.symbol) }}</strong>
                <b>{{ formatPercent(component.gap_pct) }}</b>
                <span>{{ component.meaning }}</span>
              </article>
            </div>
          </article>
        </section>

        <section
          v-if="marketIntelligenceList.length || marketScenarioCards.length"
          class="judgment-grid market-judgment-grid"
          aria-label="Market judgment"
        >
          <article v-if="marketIntelligenceList.length" class="judgment-panel">
            <header>
              <span>关键观察</span>
              <strong>{{ marketStanceLabel }}</strong>
            </header>
            <ul class="judgment-list">
              <li v-for="item in marketIntelligenceList" :key="item">{{ item }}</li>
            </ul>
          </article>

          <article v-if="marketScenarioCards.length" class="judgment-panel">
            <header>
              <span>市场情景</span>
              <strong>{{ marketScenarioCards.length }}</strong>
            </header>
            <div class="scenario-grid">
              <article
                v-for="scenario in marketScenarioCards"
                :key="scenario.case || scenario.label"
                class="scenario-card"
                :data-direction="scenario.direction"
              >
                <span>{{ scenario.label || titleLabel(scenario.case) }}</span>
                <strong>{{ scenario.trigger }}</strong>
                <p>{{ scenario.meaning }}</p>
              </article>
            </div>
          </article>
        </section>

      </section>

      <section
        v-else
        class="stock-tab-panel stocks-tab-panel"
        aria-label="Stock setup workspace"
      >
        <div class="stock-stat-grid stock-queue-stats">
          <article
            v-for="card in stockQueueSummaryCards"
            :key="card.label"
            class="stock-stat"
            :data-tone="card.tone"
          >
            <span>{{ card.label }}</span>
            <strong>{{ card.value }}</strong>
            <em>{{ card.detail }}</em>
          </article>
        </div>

        <section class="stock-workspace" aria-label="Stock setup workspace">
          <aside class="stock-list-panel">
            <header>
              <div>
                <span class="stock-kicker">Attention queue</span>
                <strong>{{ filteredStockRows.length }} / {{ stockRows.length }}</strong>
              </div>
              <Activity :size="18" />
            </header>

            <div class="stock-segments" aria-label="Filter stock bucket">
              <button
                v-for="filter in stockBucketFilters"
                :key="filter.id"
                class="stock-segment"
                :class="{ active: stockBucketFilter === filter.id }"
                type="button"
                @click="setStockBucketFilter(filter.id)"
              >
                <span>{{ filter.label }}</span>
                <b>{{ filter.count }}</b>
              </button>
            </div>

            <div class="stock-row-list">
              <button
                v-for="stock in filteredStockRows"
                :key="stock.symbol"
                class="stock-row"
                :class="{ active: selectedStock?.symbol === stock.symbol }"
                type="button"
                @click="selectStockSymbol(stock.symbol)"
              >
                <span class="stock-row-main">
                  <strong>{{ compactSymbol(stock.symbol) }}</strong>
                  <em>{{ stock.name || stock.symbol }}</em>
                </span>
                <span class="stock-row-score" :data-tone="scoreTone(stock.attention_score)">
                  {{ formatNumber(stock.attention_score, 1) }}
                </span>
                <span class="stock-row-meta">
                  {{ stockSessionLabel(stock) }} {{ formatPercent(stockSessionQuote(stock)?.change_pct) }}
                  · {{ stockSignalLabel(stock.judgment?.signal?.direction || stock.signal?.direction) }}
                </span>
                <ChevronRight :size="16" />
              </button>
            </div>
          </aside>

          <section v-if="selectedStock" class="stock-detail-panel" aria-label="Selected stock detail">
            <header class="stock-detail-header">
            <div>
              <span class="stock-kicker">Selected setup</span>
              <h3>
                {{ compactSymbol(selectedStock.symbol) }}
                <small>{{ selectedStock.name }}</small>
                </h3>
              </div>
              <span class="bucket-pill" :data-bucket="selectedStock.bucket">
                {{ bucketLabel(selectedStock.bucket) }}
              </span>
            </header>

            <div v-if="selectedStockGroupContext || selectedRelativeStrength" class="stock-context-strip">
              <span v-if="selectedStockGroupContext">
                {{ selectedStockGroupContext.display_name }} · {{ selectedStockGroupContext.peer_label_localized || titleLabel(selectedStockGroupContext.peer_label) }}
              </span>
              <span v-if="selectedRelativeStrength">{{ selectedRelativeStrength.summary }}</span>
            </div>

            <section v-if="selectedStockJudgment?.headline" class="stock-judgment-summary">
              <span>{{ stanceLabel(selectedStockJudgment.stance) }}</span>
              <p>{{ selectedStockJudgment.headline }}</p>
            </section>

            <div class="setup-strip">
              <span
                v-for="tag in selectedSetupTags"
                :key="`${selectedStock.symbol}-${tag.tag}`"
                class="setup-pill"
                :data-severity="tag.severity"
                :title="tag.reason"
              >
                {{ tag.label || tag.tag }}
              </span>
            </div>

            <section v-if="selectedStockSignal" class="stock-signal-grid" aria-label="Conditional signal">
              <article>
                <span>Conditional signal</span>
                <strong :data-direction="selectedStockSignal.direction">{{ stockSignalLabel(selectedStockSignal.direction) }}</strong>
              </article>
              <article>
                <span>Trigger</span>
                <strong>{{ selectedStockSignal.trigger || "等待价格确认" }}</strong>
              </article>
              <article>
                <span>Invalidation</span>
                <strong>{{ selectedStockSignal.invalidation || "--" }}</strong>
              </article>
            </section>

            <div class="stock-detail-metrics">
              <article
                v-for="metric in selectedStockMetrics"
                :key="metric.label"
                :data-tone="metric.tone"
              >
                <span>{{ metric.label }}</span>
                <strong>{{ metric.value }}</strong>
                <em>{{ metric.detail }}</em>
              </article>
            </div>

            <section
              v-if="selectedJudgmentKeyPoints.length || selectedJudgmentScenarios.length"
              class="judgment-grid stock-judgment-grid"
              aria-label="Stock judgment"
            >
              <article v-if="selectedJudgmentKeyPoints.length" class="judgment-panel">
                <header>
                  <span>Key points</span>
                  <strong>{{ selectedJudgmentKeyPoints.length }}</strong>
                </header>
                <ul class="judgment-list compact">
                  <li v-for="point in selectedJudgmentKeyPoints" :key="point">{{ point }}</li>
                </ul>
              </article>

              <article v-if="selectedJudgmentScenarios.length" class="judgment-panel">
                <header>
                  <span>Scenarios</span>
                  <strong>{{ selectedJudgmentScenarios.length }}</strong>
                </header>
                <div class="scenario-grid compact">
                  <article
                    v-for="scenario in selectedJudgmentScenarios"
                    :key="scenario.case || scenario.label"
                    class="scenario-card"
                    :data-direction="scenario.direction"
                  >
                    <span>{{ scenario.label || titleLabel(scenario.case) }}</span>
                    <strong>{{ scenario.trigger }}</strong>
                    <p>{{ scenario.meaning }}</p>
                  </article>
                </div>
              </article>
            </section>

            <section class="stock-section-block">
              <header>
                <span>Price levels</span>
                <strong>{{ selectedStock.technicals?.trend || "unknown trend" }}</strong>
              </header>
              <div
                class="level-track"
                role="group"
                :aria-label="priceLevelSummary(selectedStock)"
              >
                <span
                  class="level-zone support"
                  :style="levelZoneStyle(selectedStock, 'support_zone')"
                  :aria-label="levelZoneTitle(selectedStock, 'support_zone')"
                  :data-tooltip="levelZoneTitle(selectedStock, 'support_zone')"
                  tabindex="0"
                ></span>
                <span
                  class="level-zone resistance"
                  :style="levelZoneStyle(selectedStock, 'resistance_zone')"
                  :aria-label="levelZoneTitle(selectedStock, 'resistance_zone')"
                  :data-tooltip="levelZoneTitle(selectedStock, 'resistance_zone')"
                  tabindex="0"
                ></span>
                <span
                  class="level-marker last"
                  :style="levelMarkerStyle(selectedStock, selectedStock.last_price)"
                  :aria-label="levelMarkerTitle(selectedStock, 'last')"
                  :data-tooltip="levelMarkerTitle(selectedStock, 'last')"
                  tabindex="0"
                >
                  <span class="level-marker-dot" aria-hidden="true"></span>
                </span>
                <span
                  v-if="stockSessionQuote(selectedStock)?.price"
                  class="level-marker session"
                  :style="levelMarkerStyle(selectedStock, stockSessionQuote(selectedStock)?.price)"
                  :aria-label="levelMarkerTitle(selectedStock, 'session')"
                  :data-tooltip="levelMarkerTitle(selectedStock, 'session')"
                  tabindex="0"
                >
                  <span class="level-marker-dot" aria-hidden="true"></span>
                </span>
              </div>
              <div class="level-labels">
                <span>Support {{ formatZone(selectedStock.levels?.support_zone) }}</span>
                <span>Last {{ formatPrice(selectedStock.last_price) }}</span>
                <span>Resistance {{ formatZone(selectedStock.levels?.resistance_zone) }}</span>
              </div>
            </section>

            <section class="stock-section-block">
              <header>
                <span>Technicals</span>
                <strong>{{ selectedTechnicalReadSummary || "EMA · RSI · Bollinger" }}</strong>
              </header>
              <div v-if="selectedTechnicalReadCards.length" class="technical-read-grid">
                <article v-for="read in selectedTechnicalReadCards" :key="read.label">
                  <span>{{ read.label }}</span>
                  <strong>{{ read.title }}</strong>
                  <p>{{ read.summary }}</p>
                </article>
              </div>
              <div class="technical-grid">
                <article
                  v-for="meter in selectedTechnicalMeters"
                  :key="meter.label"
                  class="technical-meter"
                  :data-tone="meter.tone"
                >
                  <div>
                    <span>{{ meter.label }}</span>
                    <strong>{{ meter.display }}</strong>
                  </div>
                  <div class="mini-meter" aria-hidden="true">
                    <span :style="{ width: `${meter.fill}%` }"></span>
                  </div>
                </article>
              </div>
            </section>

            <section v-if="selectedOptionRead || selectedStock.options" class="stock-section-block">
              <header>
                <span>Options context</span>
                <strong>{{ selectedOptionRead?.label || selectedStock.options?.nearest_expiry || "无期权摘要" }}</strong>
              </header>
              <div v-if="selectedOptionRead" class="option-summary-panel">
                <p>{{ selectedOptionRead.summary }}</p>
                <div v-if="selectedOptionRead.risk_labels?.length" class="option-risk-labels">
                  <span v-for="label in selectedOptionRead.risk_labels" :key="label">{{ label }}</span>
                </div>
              </div>
              <div v-if="selectedOptionMetrics.length" class="option-metric-grid">
                <article v-for="metric in selectedOptionMetrics" :key="metric.label">
                  <span>{{ metric.label }}</span>
                  <strong>{{ metric.value }}</strong>
                </article>
              </div>
              <div
                v-if="selectedOptionRead?.display_contracts !== false && selectedStock.options?.unusual_activity?.length"
                class="option-flow-table"
              >
                <div class="option-flow-row option-flow-head">
                  <span>Contract</span>
                  <span>Type</span>
                  <span>Vol/OI</span>
                </div>
                <div
                  v-for="contract in selectedStock.options.unusual_activity.slice(0, 5)"
                  :key="contract.symbol"
                  class="option-flow-row"
                >
                  <span>{{ compactOptionSymbol(contract.symbol) }}</span>
                  <span :data-option-type="contract.type">{{ contract.type }}</span>
                  <span>{{ formatNumber(contract.volume_oi_ratio, 2) }}</span>
                </div>
              </div>
            </section>

            <section class="stock-notes-grid">
              <div>
                <header>Reasons</header>
                <ul>
                  <li v-for="reason in selectedStock.reasons || []" :key="reason">{{ reason }}</li>
                </ul>
              </div>
              <div>
                <header>Confirmation</header>
                <ul v-if="selectedStock.setups?.confirmation_needed?.length">
                  <li
                    v-for="item in selectedStock.setups.confirmation_needed"
                    :key="item"
                  >
                    {{ item }}
                  </li>
                </ul>
                <p v-else>No confirmation checklist in this report.</p>
              </div>
            </section>
          </section>
        </section>
      </section>
    </template>
  </div>
</section>
</template>

<script setup>
import {
  Activity,
  ChevronRight,
  Database,
  Info,
  LoaderCircle,
} from "@lucide/vue";
import { onBeforeUnmount, onMounted } from "vue";

const props = defineProps({
  controller: {
    type: Object,
    required: true,
  },
  management: {
    type: Object,
    required: true,
  },
});
const emit = defineEmits(["save-management-token"]);

const {
  report: stockReport,
  status: stockStatus,
  statusMessage: stockStatusMessage,
  selectedSymbol: selectedStockSymbol,
  bucketFilter: stockBucketFilter,
  activeSection: stockActiveSection,
} = props.controller.state;
const {
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
} = props.controller.projection;
const {
  accessRequired: managementAccessRequired,
  input: managementTokenInput,
} = props.management.state;
const setStockBucketFilter = props.controller.selectBucket;
const selectStockSymbol = props.controller.selectSymbol;
const selectStockSection = props.controller.selectSection;

function saveManagementToken() {
  emit("save-management-token");
}

onMounted(() => {
  props.controller.start();
});

onBeforeUnmount(() => {
  props.controller.stop();
});
</script>
