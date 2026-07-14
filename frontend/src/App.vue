<template>
  <div class="app-shell">
    <main class="chat-shell">
      <header class="chat-topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <img :src="anomaloIconUrl" alt="" />
          </div>
          <div class="brand-copy">
            <h1>Anomalo</h1>
            <p>Local harness</p>
          </div>
        </div>

        <nav class="app-nav" aria-label="Primary">
          <button
            class="nav-tab"
            :class="{ active: activeView === 'agent' }"
            type="button"
            @click="setActiveView('agent')"
          >
            Agent
          </button>
          <button
            class="nav-tab"
            :class="{ active: activeView === 'dashboard' }"
            type="button"
            @click="setActiveView('dashboard')"
          >
            Dashboard
          </button>
          <button
            class="nav-tab"
            :class="{ active: activeView === 'stock-analysis' }"
            type="button"
            @click="setActiveView('stock-analysis')"
          >
            Stock Analysis
          </button>
        </nav>

        <div class="header-actions">
          <span class="credits-chip" :class="openrouterCreditsClass" :title="openrouterCreditsTitle">
            <span class="status-dot" aria-hidden="true"></span>
            {{ openrouterCreditsLabel }}
          </span>
          <span id="connectionStatus" class="connection-chip" :class="connectionClass">
            <span class="status-dot" aria-hidden="true"></span>
            {{ connectionStatus }}
          </span>
          <button
            v-if="activeView === 'agent'"
            class="toolbar-button"
            type="button"
            title="Open agent inspector"
            aria-label="Open agent inspector"
            @click="inspectorOpen = true"
          >
            <PanelRightOpen :size="18" />
            <span>Inspector</span>
          </button>
          <button
            v-else-if="activeView === 'dashboard'"
            class="toolbar-button"
            type="button"
            title="Refresh dashboard"
            aria-label="Refresh dashboard"
            :disabled="buddyActionInFlight"
            @click="refreshDashboard"
          >
            <RefreshCw :size="17" />
            <span>Refresh</span>
          </button>
          <button
            v-else-if="activeView === 'stock-analysis'"
            class="toolbar-button"
            type="button"
            title="Refresh stock analysis"
            aria-label="Refresh stock analysis"
            :disabled="stockRefreshInFlight"
            @click="refreshStockReport"
          >
            <RefreshCw :size="17" />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      <section
        v-if="activeView === 'agent'"
        id="conversation"
        ref="conversationEl"
        class="conversation"
      >
        <div v-if="!conversationTurns.length" class="empty-state">
          <div class="empty-emblem" aria-hidden="true">
            <img :src="anomaloIconUrl" alt="" />
          </div>
          <h2>Ready when you are</h2>
          <p>Send a message to start.</p>
        </div>
        <template v-for="(turn, index) in conversationTurns" :key="`${turn.role}-${index}`">
          <article
            v-if="turn.role === 'activity'"
            class="activity-row"
            :class="[`activity-${turn.kind}`, `activity-${turn.status}`]"
            aria-live="polite"
          >
            <span class="activity-icon" aria-hidden="true">
              <LoaderCircle
                v-if="turn.status === 'running'"
                :size="18"
                class="activity-spinner"
              />
              <AlertTriangle v-else-if="turn.status === 'error'" :size="18" />
              <Wrench v-else-if="turn.kind === 'tool'" :size="18" />
              <Search v-else-if="turn.kind === 'context'" :size="18" />
              <CircleCheck v-else :size="18" />
            </span>
            <div class="activity-copy">
              <div class="activity-title">{{ turn.title }}</div>
              <div v-if="turn.body" class="activity-body">{{ turn.body }}</div>
            </div>
          </article>
          <article v-else class="message-row" :class="`message-row-${turn.role}`">
            <div v-if="turn.role === 'assistant'" class="message-bubble message-bubble-assistant">
              <div class="markdown-body" v-html="turn.htmlContent"></div>
              <div v-if="visibleTurnArtifacts(turn).length" class="message-artifacts">
                <a
                  v-for="artifact in visibleTurnArtifacts(turn)"
                  :key="artifact.url"
                  class="message-artifact"
                  :href="artifact.url"
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    v-if="artifact.media_type?.startsWith('image/')"
                    :src="artifact.url"
                    :alt="artifact.name || 'Python output image'"
                    loading="lazy"
                  />
                  <span v-else>{{ artifact.name || "Open artifact" }}</span>
                </a>
              </div>
            </div>
            <div v-else class="message-bubble" :class="`message-bubble-${turn.role}`">
              {{ turn.content }}
            </div>
          </article>
        </template>
      </section>

      <section v-else-if="activeView === 'dashboard'" class="dashboard-view" aria-label="StackChan dashboard">
        <div class="dashboard-hero">
          <span>StackChan Server</span>
          <h2>Dashboard</h2>
          <p>Monitor Buddy transport, audio activity, recent events, and manual state triggers.</p>
        </div>

        <div class="dashboard-grid">
          <section class="dashboard-panel">
            <header>
              <span>Server Status</span>
              <strong>{{ buddyStatusLabel }}</strong>
            </header>
            <div class="metric-grid">
              <div v-for="metric in buddyStatusCards" :key="metric.label" class="metric">
                <span>{{ metric.label }}</span>
                <strong>{{ metric.value }}</strong>
              </div>
            </div>
            <p class="dashboard-note">{{ buddyDashboardStatus }}</p>
          </section>

          <section class="dashboard-panel">
            <header>
              <span>Admin Access</span>
              <strong>{{ managementTokenStatus }}</strong>
            </header>
            <form class="management-token-form" @submit.prevent="saveManagementToken">
              <input
                v-model="managementTokenInput"
                type="password"
                autocomplete="off"
                placeholder="Admin token"
                aria-label="Admin token"
              />
              <button class="control-button" type="submit">Save</button>
              <button
                class="control-button"
                type="button"
                :disabled="!managementToken"
                @click="clearManagementToken"
              >
                Clear
              </button>
            </form>
            <p class="dashboard-note">{{ managementTokenHint }}</p>
          </section>

          <section class="dashboard-panel">
            <header>
              <span>Manual Control</span>
              <strong>{{ buddyActionInFlight ? "Working" : "Ready" }}</strong>
            </header>
            <div class="control-row">
              <button class="control-button" type="button" :disabled="buddyActionInFlight" @click="connectBuddy">
                Connect
              </button>
              <button
                class="control-button"
                type="button"
                :disabled="buddyActionInFlight"
                @click="disconnectBuddy"
              >
                Disconnect
              </button>
            </div>
            <div class="state-actions">
              <button
                v-for="stateAction in buddyStateActions"
                :key="stateAction.state"
                class="state-action"
                type="button"
                :disabled="buddyActionInFlight"
                @click="sendBuddyState(stateAction.state)"
              >
                {{ stateAction.label }}
              </button>
            </div>
          </section>

          <section class="dashboard-panel dashboard-panel-wide">
            <header>
              <span>Recent Events</span>
              <strong>{{ buddyEvents.length }}</strong>
            </header>
            <div v-if="buddyEvents.length" class="dashboard-events">
              <article v-for="event in buddyEvents" :key="event.id" class="dashboard-event">
                <div>
                  <strong>{{ event.type }}</strong>
                  <span>{{ event.received_at || "unknown time" }}</span>
                </div>
                <pre>{{ summarizeBuddyEvent(event) }}</pre>
              </article>
            </div>
            <div v-else class="dashboard-empty">No Buddy events recorded.</div>
          </section>
        </div>
      </section>

      <section
        v-else-if="activeView === 'stock-analysis'"
        class="stock-analysis-view"
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

          <div v-if="stockStatus === 'loading'" class="stock-empty-panel">
            <LoaderCircle :size="22" class="activity-spinner" />
            <strong>Loading stock report</strong>
            <span>{{ stockStatusMessage }}</span>
          </div>

          <div v-else-if="!stockReport" class="stock-empty-panel">
            <Database :size="26" />
            <strong>No stock report loaded</strong>
            <span>{{ stockStatusMessage }}</span>
            <code>POST /api/stocks/reports</code>
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
                @click="stockActiveSection = tab.id"
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
                      @click="selectedStockSymbol = stock.symbol"
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
                        · {{ stockSignalLabel(stock.judgment?.signal?.direction) }}
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

      <form
        v-if="activeView === 'agent'"
        id="chatForm"
        class="composer"
        @submit.prevent="submitMessage"
      >
        <div class="composer-box">
          <div ref="composerActionsEl" class="composer-actions">
            <button
              class="composer-action-trigger"
              type="button"
              title="More actions"
              aria-label="More actions"
              aria-controls="composerActionDrawer"
              :aria-expanded="composerActionsOpen"
              @click="composerActionsOpen = !composerActionsOpen"
            >
              <Plus :size="19" />
            </button>
            <Transition name="composer-drawer">
              <div
                v-if="composerActionsOpen"
                id="composerActionDrawer"
                class="composer-action-drawer"
              >
                <button class="composer-action-item" type="button" @click="startNewConversation">
                  <RefreshCw :size="16" />
                  <span>New Chat</span>
                </button>
              </div>
            </Transition>
          </div>
          <textarea
            id="messageInput"
            ref="messageInputEl"
            class="composer-input"
            v-model="messageInput"
            placeholder="Message Anomalo"
            rows="1"
            @input="resizeComposer"
            @keydown="handleComposerKeydown"
          ></textarea>
          <span class="send-button-wrap" :data-tooltip="sendShortcutTooltip" :title="sendShortcutTooltip">
            <button
              id="sendButton"
              class="send-button"
              type="submit"
              :aria-label="`Send message (${SEND_SHORTCUT})`"
              :disabled="sendDisabled"
            >
              <SendHorizontal :size="19" />
            </button>
          </span>
        </div>
      </form>
    </main>

    <Transition name="fade">
      <button
        v-if="inspectorOpen"
        class="inspector-backdrop"
        type="button"
        aria-label="Close agent inspector"
        @click="inspectorOpen = false"
      ></button>
    </Transition>

    <Transition name="drawer">
      <aside v-if="inspectorOpen" class="inspector-drawer" aria-label="Agent inspector">
        <header class="drawer-header">
          <div>
            <span class="drawer-kicker">Agent Inspector</span>
            <h2>{{ runTitle }}</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            title="Close"
            aria-label="Close agent inspector"
            @click="inspectorOpen = false"
          >
            <X :size="18" />
          </button>
        </header>

        <div class="drawer-summary">
          <div>
            <span>State</span>
            <strong id="agentState" class="state-pill" :data-state="normalizedAgentState">
              {{ agentState }}
            </strong>
          </div>
          <div>
            <span>Run</span>
            <strong id="runId">{{ runId }}</strong>
          </div>
          <div>
            <span>Skills</span>
            <strong>{{ activeSkillCount }}/{{ skills.length }}</strong>
          </div>
          <div>
            <span>MCP</span>
            <strong>{{ activeMcpCount }}/{{ mcpServers.length }}</strong>
          </div>
        </div>

        <div id="stateDetail" class="state-detail">{{ stateDetail }}</div>

        <details class="drawer-card" open>
          <summary>
            <span>Session State</span>
            <SlidersHorizontal :size="16" />
          </summary>
          <div class="state-grid">
            <div>
              <span class="field-label">Profile</span>
              <strong id="promptProfile">{{ promptProfile }}</strong>
            </div>
            <div>
              <span class="field-label">Iteration</span>
              <strong id="iterationCount">{{ iterationCount }}</strong>
            </div>
            <div>
              <span class="field-label">Tools</span>
              <strong>{{ tools.length }}</strong>
            </div>
            <div>
              <span class="field-label">Events</span>
              <strong>{{ events.length }}</strong>
            </div>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>OpenRouter Credits</span>
            <button
              class="mini-icon-button"
              type="button"
              title="Refresh OpenRouter credits"
              aria-label="Refresh OpenRouter credits"
              :disabled="openrouterCreditsRefreshInFlight"
              @click.stop.prevent="refreshOpenRouterCredits"
            >
              <RefreshCw :size="15" />
              <span>{{ openrouterCreditsRefreshLabel }}</span>
            </button>
          </summary>
          <div class="state-grid">
            <div>
              <span class="field-label">Remaining</span>
              <strong>{{ openrouterCreditsRemainingText }}</strong>
            </div>
            <div>
              <span class="field-label">Total</span>
              <strong>{{ openrouterCreditsTotalText }}</strong>
            </div>
            <div>
              <span class="field-label">Used</span>
              <strong>{{ openrouterCreditsUsedText }}</strong>
            </div>
            <div>
              <span class="field-label">Updated</span>
              <strong>{{ openrouterCreditsUpdatedText }}</strong>
            </div>
          </div>
          <div class="panel-note">{{ openrouterCreditsMessage }}</div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Session Skills</span>
            <Layers3 :size="16" />
          </summary>
          <div id="skillStatus" class="panel-note">{{ skillStatus }}</div>
          <div id="skillList" class="stack-list">
            <label
              v-for="skill in skills"
              :key="skill.name"
              class="switch-card"
              :class="{ disabled: !skill.enabled }"
            >
              <input
                v-model="skill.active"
                type="checkbox"
                :data-skill-name="skill.name"
                :disabled="!skill.enabled || skillsUpdateInFlight"
                @change="updateSessionSkills"
              />
              <span class="switch-track" aria-hidden="true"></span>
              <span class="switch-card-body">
                <strong>{{ skill.display_name || skill.name }}</strong>
                <span>{{ skill.description || "No description" }}</span>
                <span>Use when: {{ skill.when_to_use || "No routing hint" }}</span>
                <span>{{ skill.tool_count || 0 }} tools</span>
              </span>
            </label>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Session MCP</span>
            <Database :size="16" />
          </summary>
          <div id="mcpStatus" class="panel-note">{{ mcpStatus }}</div>
          <div id="mcpList" class="stack-list">
            <label
              v-for="server in mcpServers"
              :key="server.name"
              class="switch-card"
              :class="{ disabled: !server.enabled }"
            >
              <input
                v-model="server.active"
                type="checkbox"
                :data-mcp-server-name="server.name"
                :disabled="!server.enabled || mcpUpdateInFlight"
                @change="updateSessionMcpServers"
              />
              <span class="switch-track" aria-hidden="true"></span>
              <span class="switch-card-body">
                <strong>{{ server.name }}</strong>
                <span>{{ server.description || "No description" }}</span>
                <span>Loads this MCP tool pack only for the current session.</span>
              </span>
            </label>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>AGENTS.md Memory</span>
            <Upload :size="16" />
          </summary>
          <form id="memoryForm" class="memory-form" @submit.prevent="uploadMemory">
            <input
              id="memoryFile"
              ref="memoryFileInput"
              type="file"
              accept=".md,text/markdown,text/plain"
            />
            <button
              id="memoryUploadButton"
              class="icon-button"
              type="submit"
              title="Upload memory"
              aria-label="Upload memory"
              :disabled="memoryUploadDisabled"
            >
              <Upload :size="16" />
            </button>
          </form>
          <div id="memoryStatus" class="panel-note">{{ memoryStatus }}</div>
          <pre id="memoryPreview" class="memory-preview">{{ memoryPreview }}</pre>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Context Assembly</span>
            <button
              id="copyMessagesButton"
              class="mini-icon-button"
              type="button"
              title="Copy messages"
              aria-label="Copy messages"
              :disabled="copyMessagesDisabled"
              @click.stop.prevent="copyMessages"
            >
              <Copy :size="15" />
              <span>{{ copyMessagesLabel }}</span>
            </button>
          </summary>
          <div id="contextStats" class="context-stats">
            <template v-if="contextStats.length">
              <div v-for="stat in contextStats" :key="stat.label" class="stat">
                <span>{{ stat.label }}</span>
                <strong>{{ stat.value }}</strong>
              </div>
            </template>
            <template v-else>
              <div class="empty-panel">No LLM request yet.</div>
            </template>
          </div>
          <div id="contextSegments" class="context-segments">
            <div
              v-for="segment in contextSegments"
              :key="segment.name"
              class="segment"
              :class="`segment-${segment.name}`"
            >
              {{ segment.label }}: [{{ segment.start }}, {{ segment.end }}) · {{ segment.count }}
            </div>
          </div>
          <div id="messageArray" class="message-array">
            <article
              v-for="message in contextMessages"
              :key="message.index"
              class="context-message"
              :class="`role-${message.role || 'unknown'}`"
            >
              <div class="context-message-header">
                <strong>#{{ message.index }} · {{ message.role || "unknown" }}</strong>
                <span>{{ message.source }}</span>
              </div>
              <pre>{{ message.summary }}</pre>
            </article>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Raw LLM Request</span>
            <button
              id="copyPromptButton"
              class="mini-icon-button"
              type="button"
              title="Copy prompt"
              aria-label="Copy prompt"
              :disabled="copyPromptDisabled"
              @click.stop.prevent="copyPrompt"
            >
              <Copy :size="15" />
              <span>{{ copyPromptLabel }}</span>
            </button>
          </summary>
          <pre id="promptOutput" class="prompt-output">{{ promptOutput }}</pre>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Tools</span>
            <Wrench :size="16" />
          </summary>
          <div id="toolList" class="stack-list">
            <div v-for="tool in tools" :key="`${tool.source}:${tool.name}`" class="tool">
              <div class="tool-name">{{ tool.name }}</div>
              <div class="tool-source">{{ tool.source }} · {{ tool.description || "" }}</div>
            </div>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Agent Events</span>
            <Activity :size="16" />
          </summary>
          <div id="eventLog" class="event-log">
            <div v-for="event in events" :key="event.id" class="event">
              <div class="event-title" :class="{ error: event.isError }">{{ event.title }}</div>
              <div class="event-body">{{ event.body }}</div>
            </div>
          </div>
        </details>
      </aside>
    </Transition>
  </div>
</template>

<script setup>
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  CircleCheck,
  Copy,
  Database,
  Info,
  Layers3,
  LoaderCircle,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  SlidersHorizontal,
  Upload,
  Wrench,
  X,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import anomaloIconUrl from "./assets/anomalo-shrimp.png";

const SEND_SHORTCUT = "Alt+Enter";
const sendShortcutTooltip = SEND_SHORTCUT;

const sessionId = ref(loadSessionId());

const connectionStatus = ref("Disconnected");
const connectionClass = ref("error");
const sendDisabled = ref(true);
const socket = ref(null);
const reconnectTimer = ref(null);
const dashboardRefreshTimer = ref(null);
const creditsRefreshTimer = ref(null);
const stockReportRefreshTimer = ref(null);
const shuttingDown = ref(false);
const inspectorOpen = ref(false);
const composerActionsOpen = ref(false);
const activeView = ref("agent");
const managementToken = ref(loadManagementToken());
const managementTokenInput = ref(managementToken.value);
const managementAccessRequired = ref(false);

const tools = ref([]);
const events = ref([]);
const eventSequence = ref(0);
const conversationTurns = ref([]);
const activeAssistantIndex = ref(null);
const pendingAssistantArtifacts = ref([]);
const activeThinkingActivityIndex = ref(null);
const activeToolActivityIndexes = new Map();
const markdownRenderTimers = new Map();
const conversationEl = ref(null);
const composerActionsEl = ref(null);
const messageInputEl = ref(null);
const messageInput = ref("");

const MARKDOWN_RENDER_INTERVAL_MS = 160;
const CREDITS_REFRESH_INTERVAL_MS = 82800000;
const STOCK_REPORT_REFRESH_INTERVAL_MS = 15000;

const openrouterCredits = ref(null);
const openrouterCreditsStatus = ref("loading");
const openrouterCreditsMessage = ref("Loading OpenRouter credits...");
const openrouterCreditsRefreshInFlight = ref(false);

const promptOutput = ref("Loading prompt profile...");
const latestPromptJson = ref("");
const latestMessagesJson = ref("");
const copyPromptDisabled = ref(true);
const copyMessagesDisabled = ref(true);
const copyPromptLabel = ref("Copy");
const copyMessagesLabel = ref("Copy Messages");

const agentState = ref("Idle");
const runStatus = ref("Idle");
const runId = ref("none");
const promptProfile = ref("default");
const iterationCount = ref("0");
const stateDetail = ref("Waiting for input.");
const runTitle = ref("Ready");
const contextStats = ref([]);
const contextSegments = ref([]);
const contextMessages = ref([]);

const skills = ref([]);
const skillStatus = ref("Loading skills...");
const skillsUpdateInFlight = ref(false);
const mcpServers = ref([]);
const mcpStatus = ref("Loading MCP servers...");
const mcpUpdateInFlight = ref(false);

const memoryFileInput = ref(null);
const memoryStatus = ref("No memory loaded.");
const memoryPreview = ref("");
const memoryUploadDisabled = ref(false);

const buddyStatus = ref(null);
const buddyEvents = ref([]);
const buddyDashboardStatus = ref("Dashboard idle.");
const buddyActionInFlight = ref(false);
const buddyStateActions = [
  { state: "idle", label: "Idle" },
  { state: "listening", label: "Listen" },
  { state: "thinking", label: "Think" },
  { state: "speaking", label: "Speak" },
  { state: "done", label: "Done" },
  { state: "stop", label: "Stop" },
];

const stockReport = ref(null);
const stockReportReceivedAt = ref(null);
const stockReportEtag = ref(null);
const stockReportRevision = ref(0);
const stockStatus = ref("idle");
const stockStatusMessage = ref("No stock report loaded yet.");
const stockRefreshInFlight = ref(false);
const selectedStockSymbol = ref("");
const stockBucketFilter = ref("all");
const stockActiveSection = ref("market");

const normalizedAgentState = computed(() => normalizeState(agentState.value));
const normalizedRunStatus = computed(() => normalizeState(runStatus.value));
const activeSkillCount = computed(() => skills.value.filter((skill) => skill.active).length);
const activeMcpCount = computed(() => mcpServers.value.filter((server) => server.active).length);
const openrouterCreditsLabel = computed(() => {
  const remaining = openrouterCredits.value?.remaining_credits;
  if (openrouterCreditsStatus.value === "ready" || openrouterCreditsStatus.value === "stale") {
    return typeof remaining === "number" ? `Credits $${remaining.toFixed(2)}` : "Credits ?";
  }
  if (openrouterCreditsStatus.value === "loading") {
    return "Credits ...";
  }
  return "Credits --";
});
const openrouterCreditsClass = computed(() => {
  if (openrouterCreditsStatus.value === "ready") {
    return "ok";
  }
  if (openrouterCreditsStatus.value === "error") {
    return "error";
  }
  return "muted";
});
const openrouterCreditsTitle = computed(() => {
  const credits = openrouterCredits.value;
  if (!credits) {
    return openrouterCreditsMessage.value;
  }
  const parts = [openrouterCreditsMessage.value];
  if (typeof credits.total_credits === "number") {
    parts.push(`Total: $${credits.total_credits.toFixed(2)}`);
  }
  if (typeof credits.total_usage === "number") {
    parts.push(`Used: $${credits.total_usage.toFixed(2)}`);
  }
  if (credits.updated_at) {
    parts.push(`Updated: ${new Date(credits.updated_at).toLocaleString()}`);
  }
  return parts.join(" · ");
});
const openrouterCreditsRefreshLabel = computed(() =>
  openrouterCreditsRefreshInFlight.value ? "Refreshing" : "Refresh",
);
const openrouterCreditsRemainingText = computed(() =>
  formatCurrency(openrouterCredits.value?.remaining_credits),
);
const openrouterCreditsTotalText = computed(() =>
  formatCurrency(openrouterCredits.value?.total_credits),
);
const openrouterCreditsUsedText = computed(() => formatCurrency(openrouterCredits.value?.total_usage));
const openrouterCreditsUpdatedText = computed(() => {
  const updatedAt = openrouterCredits.value?.updated_at;
  if (!updatedAt) {
    return "--";
  }
  return new Date(updatedAt).toLocaleString();
});
const buddyStatusLabel = computed(() => {
  if (!buddyStatus.value) {
    return "Unknown";
  }
  if (buddyStatus.value.connected) {
    return "Connected";
  }
  if (buddyStatus.value.listening) {
    return "Listening";
  }
  return "Offline";
});
const buddyStatusCards = computed(() => {
  const status = buddyStatus.value || {};
  return [
    { label: "Connection", value: buddyStatusLabel.value },
    { label: "Transport", value: status.transport || "none" },
    { label: "Client", value: status.client_address || status.tcp_client_ip || "none" },
    { label: "Audio", value: status.audio_input_active ? "active" : "idle" },
    { label: "Queued", value: String(status.queued_audio_turns ?? 0) },
    { label: "Events", value: String(status.recent_event_count ?? buddyEvents.value.length) },
  ];
});
const managementTokenStatus = computed(() => (managementToken.value ? "Token saved" : "Token missing"));
const managementTokenHint = computed(() => {
  if (managementAccessRequired.value && !managementToken.value) {
    return "Remote dashboard access needs an admin token.";
  }
  if (managementAccessRequired.value) {
    return "Saved token was rejected by the server.";
  }
  if (managementToken.value) {
    return "Token saved in this browser.";
  }
  return "Set ANOMALO_ADMIN_TOKEN, then save it here.";
});
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

onMounted(() => {
  sendDisabled.value = true;
  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("pointerdown", handleGlobalPointerdown);
  connect();
  void loadTools();
  void loadSkills();
  void loadMcpServers();
  void loadPromptProfile();
  void loadMemory();
  void loadOpenRouterCredits();
  void loadStockReport({ silent: true });
  void refreshDashboard();
  creditsRefreshTimer.value = setInterval(() => {
    void loadOpenRouterCredits({ silent: true });
  }, CREDITS_REFRESH_INTERVAL_MS);
  dashboardRefreshTimer.value = setInterval(() => {
    if (activeView.value === "dashboard" && !buddyActionInFlight.value) {
      void pollDashboard();
    }
  }, 10000);
  stockReportRefreshTimer.value = setInterval(() => {
    if (activeView.value === "stock-analysis" && !stockRefreshInFlight.value) {
      void loadStockReport({ silent: true });
    }
  }, STOCK_REPORT_REFRESH_INTERVAL_MS);
});

onBeforeUnmount(() => {
  shuttingDown.value = true;
  document.removeEventListener("keydown", handleGlobalKeydown);
  document.removeEventListener("pointerdown", handleGlobalPointerdown);
  clearTimeout(reconnectTimer.value);
  clearInterval(dashboardRefreshTimer.value);
  clearInterval(creditsRefreshTimer.value);
  clearInterval(stockReportRefreshTimer.value);
  clearMarkdownRenderTimers();
  socket.value?.close();
});

function handleGlobalKeydown(event) {
  if (event.key === "Escape") {
    inspectorOpen.value = false;
    composerActionsOpen.value = false;
  }
}

function handleGlobalPointerdown(event) {
  if (!composerActionsOpen.value) {
    return;
  }
  if (composerActionsEl.value?.contains(event.target)) {
    return;
  }
  composerActionsOpen.value = false;
}

function setActiveView(view) {
  activeView.value = view;
  inspectorOpen.value = false;
  composerActionsOpen.value = false;
  if (view === "dashboard") {
    void refreshDashboard();
  }
  if (view === "stock-analysis") {
    void loadStockReport({ silent: stockStatus.value === "ready" });
  }
}

function loadManagementToken() {
  return localStorage.getItem("anomalo.adminToken") || "";
}

function saveManagementToken() {
  const nextToken = managementTokenInput.value.trim();
  managementToken.value = nextToken;
  managementAccessRequired.value = false;
  if (nextToken) {
    localStorage.setItem("anomalo.adminToken", nextToken);
    buddyDashboardStatus.value = "Admin token saved.";
  } else {
    localStorage.removeItem("anomalo.adminToken");
    buddyDashboardStatus.value = "Admin token cleared.";
  }
  if (activeView.value === "dashboard") {
    void refreshDashboard();
  }
}

function clearManagementToken() {
  managementTokenInput.value = "";
  saveManagementToken();
}

function loadSessionId() {
  const existing = localStorage.getItem("anomalo.session");
  if (existing) {
    return existing;
  }
  const generated = createSessionId();
  localStorage.setItem("anomalo.session", generated);
  return generated;
}

function createSessionId() {
  return `session_${createUuid().replaceAll("-", "")}`;
}

function createUuid() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }

  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = char === "x" ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const nextSocket = new WebSocket(`${protocol}://${location.host}/ws/chat/${sessionId.value}`);
  socket.value = nextSocket;

  nextSocket.addEventListener("open", () => {
    if (socket.value !== nextSocket) {
      return;
    }
    connectionStatus.value = "Connected";
    connectionClass.value = "ok";
    sendDisabled.value = false;
    setAgentState("Idle", "Connected. Waiting for input.");
  });

  nextSocket.addEventListener("close", () => {
    if (socket.value !== nextSocket || shuttingDown.value) {
      return;
    }
    connectionStatus.value = "Disconnected";
    connectionClass.value = "error";
    sendDisabled.value = true;
    setAgentState("Offline", "WebSocket disconnected. Reconnecting...");
    clearTimeout(reconnectTimer.value);
    reconnectTimer.value = setTimeout(connect, 1000);
  });

  nextSocket.addEventListener("message", (message) => {
    if (socket.value !== nextSocket) {
      return;
    }
    try {
      handleAgentEvent(JSON.parse(message.data));
    } catch (error) {
      addEventLog("ws.error", String(error), true);
    }
  });
}

async function loadTools() {
  const currentSessionId = sessionId.value;
  try {
    const response = await fetch(`/api/tools?session_id=${encodeURIComponent(currentSessionId)}`);
    const data = await response.json();
    if (sessionId.value !== currentSessionId) {
      return;
    }
    tools.value = data.tools || [];
  } catch (error) {
    addEventLog("tools.error", String(error), true);
  }
}

async function loadSkills() {
  const currentSessionId = sessionId.value;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/skills`);
    const data = await response.json();
    if (sessionId.value !== currentSessionId) {
      return;
    }
    renderSkills(data.skills || []);
  } catch (error) {
    skillStatus.value = `Skill load failed: ${error}`;
  }
}

async function loadMcpServers() {
  const currentSessionId = sessionId.value;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/mcp`);
    const data = await response.json();
    if (sessionId.value !== currentSessionId) {
      return;
    }
    renderMcpServers(data.servers || []);
  } catch (error) {
    mcpStatus.value = `MCP load failed: ${error}`;
  }
}

async function loadPromptProfile() {
  try {
    const response = await fetch("/api/prompts");
    const data = await response.json();
    promptProfile.value = data.profile || "default";
    setPromptOutput({
      source: "config",
      profile: data.profile,
      config_path: data.config_path,
      messages: data.messages || [],
    });
  } catch (error) {
    setPromptOutput({ error: String(error) });
  }
}

async function loadMemory() {
  try {
    const response = await fetch("/api/memory");
    renderMemory(await response.json());
  } catch (error) {
    memoryStatus.value = `Memory load failed: ${error}`;
  }
}

async function loadOpenRouterCredits({ silent = false, force = false } = {}) {
  if (!silent) {
    openrouterCreditsStatus.value = "loading";
    openrouterCreditsMessage.value = "Loading OpenRouter credits...";
  }

  try {
    const payload = await fetchJson(force ? "/api/openrouter/credits?force=true" : "/api/openrouter/credits");
    openrouterCredits.value = payload.configured ? payload : null;
    openrouterCreditsStatus.value = payload.status || "error";
    openrouterCreditsMessage.value = openrouterCreditsMessageFor(payload);
  } catch (error) {
    openrouterCreditsStatus.value = "error";
    openrouterCreditsMessage.value = `OpenRouter credits failed: ${formatError(error)}`;
  }
}

async function refreshOpenRouterCredits() {
  openrouterCreditsRefreshInFlight.value = true;
  try {
    await loadOpenRouterCredits({ force: true });
  } finally {
    openrouterCreditsRefreshInFlight.value = false;
  }
}

async function loadStockReport({ silent = false } = {}) {
  if (!silent) {
    stockStatus.value = "loading";
    stockStatusMessage.value = "Fetching the latest stock analysis report.";
  }

  try {
    const headers = stockReportEtag.value ? { "If-None-Match": stockReportEtag.value } : undefined;
    const response = await fetch("/api/stocks/reports/latest", { headers });
    if (response.status === 304) {
      if (stockReport.value) {
        stockStatus.value = "ready";
        stockStatusMessage.value = `Stock report is current (revision ${stockReportRevision.value}).`;
      }
      return;
    }
    const responseText = await response.text();
    let payload = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.detail || payload?.message || responseText || `HTTP ${response.status}`);
    }
    if (!payload) {
      throw new Error("Stock report endpoint returned an empty response.");
    }

    stockReportEtag.value = response.headers.get("etag") || payload.report_id || null;
    stockReportRevision.value = payload.revision || 0;
    stockReportReceivedAt.value = payload.received_at || null;
    if (payload.report) {
      stockReport.value = payload.report;
      stockStatus.value = "ready";
      stockStatusMessage.value = `Loaded ${payload.stock_count ?? stockRows.value.length} stock setups (revision ${stockReportRevision.value}).`;
      if (!selectedStockSymbol.value || !stockRows.value.some((stock) => stock.symbol === selectedStockSymbol.value)) {
        selectedStockSymbol.value = stockRows.value[0]?.symbol || "";
      }
      return;
    }

    stockReport.value = null;
    stockReportEtag.value = null;
    stockReportRevision.value = 0;
    selectedStockSymbol.value = "";
    stockStatus.value = "empty";
    stockStatusMessage.value = "Send a JSON report to the REST endpoint to populate this view.";
  } catch (error) {
    stockStatus.value = "error";
    stockStatusMessage.value = `Stock report load failed: ${formatError(error)}`;
    stockReport.value = null;
  }
}

async function refreshStockReport() {
  stockRefreshInFlight.value = true;
  try {
    await loadStockReport();
  } finally {
    stockRefreshInFlight.value = false;
  }
}

function setStockBucketFilter(filterId) {
  stockBucketFilter.value = filterId;
  const visibleRows =
    filterId === "all" ? stockRows.value : stockRows.value.filter((stock) => (stock.bucket || "unbucketed") === filterId);
  if (!visibleRows.some((stock) => stock.symbol === selectedStockSymbol.value)) {
    selectedStockSymbol.value = visibleRows[0]?.symbol || stockRows.value[0]?.symbol || "";
  }
}

function openrouterCreditsMessageFor(payload) {
  if (payload.status === "ready") {
    return payload.cached ? "OpenRouter credits cached." : "OpenRouter credits updated.";
  }
  if (payload.status === "stale") {
    return payload.message || "OpenRouter credits are stale.";
  }
  if (payload.status === "config_missing") {
    return payload.message || "OpenRouter management key is not configured.";
  }
  return payload.message || "OpenRouter credits unavailable.";
}

function formatCurrency(value) {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "--";
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

function formatDateTime(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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

async function refreshDashboard() {
  buddyActionInFlight.value = true;
  buddyDashboardStatus.value = "Refreshing Buddy dashboard...";
  try {
    await Promise.all([loadBuddyStatus(), loadBuddyEvents()]);
    managementAccessRequired.value = false;
    buddyDashboardStatus.value = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    markManagementAccessError(error);
    buddyDashboardStatus.value = `Dashboard refresh failed: ${formatError(error)}`;
  } finally {
    buddyActionInFlight.value = false;
  }
}

async function pollDashboard() {
  try {
    await Promise.all([loadBuddyStatus(), loadBuddyEvents()]);
    managementAccessRequired.value = false;
    buddyDashboardStatus.value = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    markManagementAccessError(error);
    buddyDashboardStatus.value = `Dashboard refresh failed: ${formatError(error)}`;
  }
}

async function loadBuddyStatus() {
  const payload = await fetchJson("/api/buddy/status");
  buddyStatus.value = payload;
}

async function loadBuddyEvents() {
  const payload = await fetchJson("/api/buddy/events?limit=30");
  buddyEvents.value = payload.events || [];
}

async function connectBuddy() {
  await runBuddyAction("Connecting Buddy...", async () => {
    buddyStatus.value = await fetchJson("/api/buddy/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });
}

async function disconnectBuddy() {
  await runBuddyAction("Disconnecting Buddy...", async () => {
    buddyStatus.value = await fetchJson("/api/buddy/disconnect", { method: "POST" });
  });
}

async function sendBuddyState(state) {
  await runBuddyAction(`Sending ${state} state...`, async () => {
    buddyStatus.value = await fetchJson("/api/buddy/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
  });
}

async function runBuddyAction(progressMessage, action) {
  buddyActionInFlight.value = true;
  buddyDashboardStatus.value = progressMessage;
  try {
    await action();
    await loadBuddyEvents();
    managementAccessRequired.value = false;
    buddyDashboardStatus.value = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    markManagementAccessError(error);
    buddyDashboardStatus.value = formatError(error);
  } finally {
    buddyActionInFlight.value = false;
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, withManagementAccess(url, options));
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON from ${url}: ${error}`);
    }
  }
  if (!response.ok) {
    const error = new Error(payload.detail || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.detail = payload.detail;
    throw error;
  }
  return payload;
}

function withManagementAccess(url, options = {}) {
  if (!requiresManagementAccess(url) || !managementToken.value) {
    return options;
  }
  const headers = new Headers(options.headers || {});
  headers.set("X-Anomalo-Admin-Token", managementToken.value);
  return { ...options, headers };
}

function requiresManagementAccess(url) {
  return url.startsWith("/api/buddy") || url.startsWith("/api/manage") || url.startsWith("/api/copilot-hooks");
}

function markManagementAccessError(error) {
  if (isManagementAccessError(error)) {
    managementAccessRequired.value = true;
  }
}

function isManagementAccessError(error) {
  return (
    error?.status === 403 &&
    String(error?.detail || error?.message || "").includes("Management API requires")
  );
}

function submitMessage() {
  const content = messageInput.value.trim();
  if (!content || socket.value?.readyState !== WebSocket.OPEN) {
    return;
  }

  conversationTurns.value.push({ role: "user", content });
  messageInput.value = "";
  void nextTick(resizeComposer);
  activeAssistantIndex.value = null;
  pendingAssistantArtifacts.value = [];
  activeThinkingActivityIndex.value = null;
  activeToolActivityIndexes.clear();
  setAgentState("Queued", "Message sent. Waiting for run start.");
  socket.value.send(JSON.stringify({ type: "user.message", content }));
  void scrollConversation();
}

function startNewConversation() {
  composerActionsOpen.value = false;
  clearTimeout(reconnectTimer.value);
  clearMarkdownRenderTimers();

  const previousSocket = socket.value;
  socket.value = null;
  previousSocket?.close();

  const nextSessionId = createSessionId();
  sessionId.value = nextSessionId;
  localStorage.setItem("anomalo.session", nextSessionId);

  resetConversationState();
  connectionStatus.value = "Connecting";
  connectionClass.value = "muted";
  sendDisabled.value = true;
  connect();
  void loadTools();
  void loadSkills();
  void loadMcpServers();
  void nextTick(() => messageInputEl.value?.focus());
}

function resetConversationState() {
  messageInput.value = "";
  conversationTurns.value = [];
  activeAssistantIndex.value = null;
  pendingAssistantArtifacts.value = [];
  activeThinkingActivityIndex.value = null;
  activeToolActivityIndexes.clear();
  events.value = [];
  eventSequence.value = 0;
  runId.value = "none";
  runTitle.value = "Ready";
  iterationCount.value = "0";
  latestMessagesJson.value = "";
  copyMessagesDisabled.value = true;
  contextStats.value = [];
  contextSegments.value = [];
  contextMessages.value = [];
  tools.value = [];
  skills.value = [];
  mcpServers.value = [];
  skillStatus.value = "Loading skills...";
  mcpStatus.value = "Loading MCP servers...";
  setAgentState("Idle", "New conversation ready.");
  void nextTick(resizeComposer);
}

function handleComposerKeydown(event) {
  if (event.key === "Enter" && event.altKey && !event.isComposing) {
    event.preventDefault();
    submitMessage();
  }
}

function resizeComposer() {
  const input = messageInputEl.value;
  if (!input) {
    return;
  }
  input.style.height = "42px";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

async function uploadMemory() {
  const file = memoryFileInput.value?.files?.[0];
  if (!file) {
    memoryStatus.value = "Choose an AGENTS.md file first.";
    return;
  }

  memoryUploadDisabled.value = true;
  memoryStatus.value = "Uploading memory...";
  const data = new FormData();
  data.append("file", file);

  try {
    const response = await fetch("/api/memory/upload", {
      method: "POST",
      body: data,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Upload failed.");
    }
    renderMemory(payload);
    memoryFileInput.value.value = "";
  } catch (error) {
    memoryStatus.value = `Memory upload failed: ${error}`;
  } finally {
    memoryUploadDisabled.value = false;
  }
}

async function copyPrompt() {
  await copyToClipboard(latestPromptJson.value, copyPromptLabel, "Copy");
}

async function copyMessages() {
  await copyToClipboard(latestMessagesJson.value, copyMessagesLabel, "Copy Messages");
}

async function copyToClipboard(value, labelRef, defaultText) {
  if (!value) {
    return;
  }
  await navigator.clipboard.writeText(value);
  labelRef.value = "Copied";
  setTimeout(() => {
    labelRef.value = defaultText;
  }, 1200);
}

function handleAgentEvent(event) {
  switch (event.type) {
    case "run.started":
      runId.value = event.run_id;
      runTitle.value = "Running";
      setAgentState("Thinking", "Building context and preparing tools.");
      addEventLog("run.started", event.run_id);
      break;
    case "llm.request":
      renderLlmRequest(event.data.request, event.data.context, event.data.iteration);
      setAgentState("LLM Request", summarizeLlmRequest(event.data.request));
      activeThinkingActivityIndex.value = addConversationActivity({
        kind: "thinking",
        status: "running",
        title: "正在思考",
        body: summarizeLlmRequest(event.data.request),
      });
      addEventLog("llm.request", summarizeLlmRequest(event.data.request));
      break;
    case "message.delta":
      finishThinkingActivity({
        status: "done",
        title: "已开始回答",
      });
      appendAssistantContent(event.data.content || "");
      setAgentState("Streaming", "Receiving assistant output.");
      break;
    case "message.done":
      flushMarkdownRender(activeAssistantIndex.value);
      activeAssistantIndex.value = null;
      setAgentState("Finalizing", "Assistant message completed.");
      break;
    case "tool.started":
      flushMarkdownRender(activeAssistantIndex.value);
      activeAssistantIndex.value = null;
      finishThinkingActivity({
        status: "done",
        title: "已决定使用工具",
      });
      setAgentState("Tool", event.data.tool || "Tool call started.");
      activeToolActivityIndexes.set(
        event.data.tool || "tool",
        addConversationActivity({
          kind: "tool",
          status: "running",
          title: `正在使用 ${event.data.tool || "工具"}`,
          body: summarizeToolArguments(event.data.arguments),
        }),
      );
      addEventLog(`tool.started · ${event.data.tool}`, JSON.stringify(event.data.arguments || {}));
      break;
    case "tool.finished":
      setAgentState("Tool Result", event.data.tool || "Tool call finished.");
      updateToolActivity(event.data.tool || "tool", {
        status: "done",
        title: `已使用 ${event.data.tool || "工具"}`,
        body: summarizeToolResult(event.data.content),
      });
      addEventLog(`tool.finished · ${event.data.tool}`, event.data.content || "");
      queueAssistantArtifacts(event.data.data?.artifacts);
      if (event.data.data?.skill_action) {
        void loadSkills();
        void loadTools();
      }
      if (event.data.data?.mcp_action) {
        void loadMcpServers();
        void loadTools();
      }
      break;
    case "tool.error":
      updateToolActivity(event.data.tool || "tool", {
        status: "error",
        title: `${event.data.tool || "工具"} 失败`,
        body: summarizeToolResult(event.data.content),
      });
      setAgentState("Tool Error", event.data.content || "Tool call failed.");
      addEventLog(event.type, event.data.content || "tool error", true);
      break;
    case "run.error":
      runTitle.value = "Error";
      flushMarkdownRender(activeAssistantIndex.value);
      activeAssistantIndex.value = null;
      finishThinkingActivity({
        status: "error",
        title: "思考中断",
        body: event.data.error || "Run error.",
      });
      activeToolActivityIndexes.clear();
      setAgentState("Error", event.data.error || "Run error.");
      addEventLog(event.type, event.data.error || "error", true);
      break;
    case "run.finished":
      runTitle.value = "Complete";
      reconcileFinalAssistantContent(event.data.final_text || "");
      finishThinkingActivity({
        status: "done",
        title: "已完成思考",
      });
      activeToolActivityIndexes.clear();
      setAgentState("Done", "Run finished.");
      addEventLog("run.finished", "done");
      void loadTools();
      void loadSkills();
      void loadMcpServers();
      break;
    default:
      addEventLog(event.type, JSON.stringify(event.data || {}));
  }
}

async function updateSessionSkills() {
  skillsUpdateInFlight.value = true;
  skillStatus.value = "Updating session skills...";
  const activeSkills = skills.value.filter((skill) => skill.active).map((skill) => skill.name);

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId.value)}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_skills: activeSkills }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Skill update failed.");
    }
    renderSkills(payload.skills || []);
    void loadTools();
  } catch (error) {
    skillStatus.value = `Skill update failed: ${error}`;
    void loadSkills();
  } finally {
    skillsUpdateInFlight.value = false;
  }
}

async function updateSessionMcpServers() {
  mcpUpdateInFlight.value = true;
  mcpStatus.value = "Updating session MCP servers...";
  const activeServers = mcpServers.value
    .filter((server) => server.active)
    .map((server) => server.name);

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId.value)}/mcp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_servers: activeServers }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "MCP update failed.");
    }
    renderMcpServers(payload.servers || []);
    void loadTools();
  } catch (error) {
    mcpStatus.value = `MCP update failed: ${error}`;
    void loadMcpServers();
  } finally {
    mcpUpdateInFlight.value = false;
  }
}

function renderSkills(nextSkills) {
  skills.value = nextSkills;

  if (!nextSkills.length) {
    skillStatus.value = "No skills configured.";
    return;
  }

  const activeCount = nextSkills.filter((skill) => skill.active).length;
  skillStatus.value = `${activeCount} active · ${nextSkills.length} available`;
}

function renderMcpServers(servers) {
  mcpServers.value = servers;

  if (!servers.length) {
    mcpStatus.value = "No MCP servers configured.";
    return;
  }

  const activeCount = servers.filter((server) => server.active).length;
  mcpStatus.value = `${activeCount} active · ${servers.length} available`;
}

function addConversationActivity({ kind, status, title, body = "" }) {
  const index =
    conversationTurns.value.push({
      role: "activity",
      kind,
      status,
      title,
      body,
    }) - 1;
  void scrollConversation();
  return index;
}

function updateConversationActivity(index, updates) {
  if (typeof index !== "number") {
    return;
  }
  const turn = conversationTurns.value[index];
  if (!turn || turn.role !== "activity") {
    return;
  }
  conversationTurns.value[index] = {
    ...turn,
    ...updates,
  };
  void scrollConversation();
}

function finishThinkingActivity(updates) {
  if (typeof activeThinkingActivityIndex.value === "number") {
    updateConversationActivity(activeThinkingActivityIndex.value, updates);
    activeThinkingActivityIndex.value = null;
    return;
  }

  const fallbackIndex = findLatestRunningThinkingActivityIndex();
  if (typeof fallbackIndex === "number") {
    updateConversationActivity(fallbackIndex, updates);
  }
  activeThinkingActivityIndex.value = null;
}

function findLatestRunningThinkingActivityIndex() {
  const latestUserIndex = findLatestUserTurnIndex();
  for (let index = conversationTurns.value.length - 1; index > latestUserIndex; index -= 1) {
    const turn = conversationTurns.value[index];
    if (turn?.role === "activity" && turn.kind === "thinking" && turn.status === "running") {
      return index;
    }
  }
  return null;
}

function updateToolActivity(toolName, updates) {
  const key = toolName || "tool";
  const index = activeToolActivityIndexes.get(key);
  if (typeof index === "number") {
    updateConversationActivity(index, updates);
    activeToolActivityIndexes.delete(key);
    return;
  }
  addConversationActivity({
    kind: "tool",
    ...updates,
  });
}

function appendAssistantContent(content) {
  if (activeAssistantIndex.value === null) {
    const artifacts = consumePendingAssistantArtifacts();
    activeAssistantIndex.value =
      conversationTurns.value.push({ role: "assistant", content: "", htmlContent: "", artifacts }) - 1;
  }
  conversationTurns.value[activeAssistantIndex.value].content += content;
  scheduleMarkdownRender(activeAssistantIndex.value);
  void scrollConversation();
}

function reconcileFinalAssistantContent(content) {
  const finalContent = String(content || "");

  if (typeof activeAssistantIndex.value === "number") {
    attachPendingArtifacts(activeAssistantIndex.value);
    if (finalContent) {
      setAssistantContent(activeAssistantIndex.value, finalContent);
    } else {
      flushMarkdownRender(activeAssistantIndex.value);
    }
    activeAssistantIndex.value = null;
    return;
  }

  if (!finalContent) {
    return;
  }

  const currentAssistantIndex = findLatestAssistantTurnIndexAfterLatestUser();
  if (typeof currentAssistantIndex === "number") {
    attachPendingArtifacts(currentAssistantIndex);
    const turn = conversationTurns.value[currentAssistantIndex];
    if (turn.content === finalContent) {
      flushMarkdownRender(currentAssistantIndex);
      return;
    }
    if (!turn.content || finalContent.startsWith(turn.content)) {
      setAssistantContent(currentAssistantIndex, finalContent);
    } else {
      flushMarkdownRender(currentAssistantIndex);
    }
    return;
  }

  const artifacts = consumePendingAssistantArtifacts();
  conversationTurns.value.push({
    role: "assistant",
    content: finalContent,
    artifacts,
    htmlContent: renderMarkdown(finalContent, artifacts),
  });
  void scrollConversation();
}

function findLatestAssistantTurnIndexAfterLatestUser() {
  const latestUserIndex = findLatestUserTurnIndex();
  for (let index = conversationTurns.value.length - 1; index > latestUserIndex; index -= 1) {
    if (conversationTurns.value[index]?.role === "assistant") {
      return index;
    }
  }
  return null;
}

function findLatestUserTurnIndex() {
  for (let index = conversationTurns.value.length - 1; index >= 0; index -= 1) {
    if (conversationTurns.value[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function setAssistantContent(index, content) {
  const turn = conversationTurns.value[index];
  if (!turn || turn.role !== "assistant") {
    return;
  }

  const timer = markdownRenderTimers.get(index);
  if (timer) {
    clearTimeout(timer);
    markdownRenderTimers.delete(index);
  }

  conversationTurns.value[index] = {
    ...turn,
    content,
    htmlContent: renderMarkdown(content, turn.artifacts),
  };
  void scrollConversation();
}

function scheduleMarkdownRender(index) {
  if (typeof index !== "number" || markdownRenderTimers.has(index)) {
    return;
  }

  const timer = setTimeout(() => {
    markdownRenderTimers.delete(index);
    renderConversationMarkdown(index);
  }, markdownRenderDelay(index));
  markdownRenderTimers.set(index, timer);
}

function flushMarkdownRender(index) {
  if (typeof index !== "number") {
    return;
  }

  const timer = markdownRenderTimers.get(index);
  if (timer) {
    clearTimeout(timer);
    markdownRenderTimers.delete(index);
  }
  renderConversationMarkdown(index);
}

function clearMarkdownRenderTimers() {
  for (const timer of markdownRenderTimers.values()) {
    clearTimeout(timer);
  }
  markdownRenderTimers.clear();
}

function renderConversationMarkdown(index) {
  const turn = conversationTurns.value[index];
  if (!turn || turn.role !== "assistant") {
    return;
  }

  conversationTurns.value[index] = {
    ...turn,
    htmlContent: renderMarkdown(turn.content, turn.artifacts),
  };
  void scrollConversation();
}

function markdownRenderDelay(index) {
  const contentLength = conversationTurns.value[index]?.content?.length || 0;
  if (contentLength > 16000) {
    return 480;
  }
  if (contentLength > 6000) {
    return 280;
  }
  return MARKDOWN_RENDER_INTERVAL_MS;
}

function renderLlmRequest(request, context, iteration) {
  const safeRequest = request || {};
  const messages = Array.isArray(safeRequest.messages) ? safeRequest.messages : [];
  latestMessagesJson.value = JSON.stringify(messages, null, 2);
  copyMessagesDisabled.value = messages.length === 0;
  promptProfile.value = context?.profile || "default";
  iterationCount.value = String(iteration || 0);

  setPromptOutput({
    source: "llm.request",
    iteration,
    context,
    request: safeRequest,
  });
  renderContextStats(safeRequest, context, messages);
  renderContextSegments(context);
  renderMessageArray(messages, context);
}

function renderContextStats(request, context, messages) {
  contextStats.value = [
    { label: "Prompt Parts", value: messages.length },
    { label: "Prompt", value: context?.prompt_message_count ?? 0 },
    { label: "Memory", value: context?.memory_message_count ?? 0 },
    { label: "Skills", value: context?.active_skill_count ?? 0 },
    { label: "MCP", value: context?.active_mcp_server_count ?? 0 },
    { label: "History", value: context?.history_message_count ?? 0 },
    { label: "Tools", value: context?.tool_count ?? request?.tools?.length ?? 0 },
  ];
}

function renderContextSegments(context) {
  contextSegments.value = context?.segments || [];
}

function renderMessageArray(messages, context) {
  contextMessages.value = messages.map((message, index) => ({
    index,
    role: message.role || "unknown",
    source: sourceForIndex(index, context),
    summary: summarizeMessageContent(message),
  }));
}

function sourceForIndex(index, context) {
  const segment = (context?.segments || []).find(
    (candidate) => index >= candidate.start && index < candidate.end,
  );
  return segment?.label || "Unclassified";
}

function summarizeMessageContent(message) {
  const parts = [];
  if (message.content !== null && message.content !== undefined) {
    parts.push(
      typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2),
    );
  }
  if (message.tool_calls) {
    parts.push(`tool_calls:\n${JSON.stringify(message.tool_calls, null, 2)}`);
  }
  if (message.name) {
    parts.push(`name: ${message.name}`);
  }
  if (message.tool_call_id) {
    parts.push(`tool_call_id: ${message.tool_call_id}`);
  }
  return parts.join("\n\n") || "(empty)";
}

function queueAssistantArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) {
    return;
  }
  const accepted = artifacts.filter((artifact) => artifact?.url && artifact?.name);
  const combined = [...pendingAssistantArtifacts.value, ...accepted];
  pendingAssistantArtifacts.value = combined.filter(
    (artifact, index) => combined.findIndex((candidate) => candidate.url === artifact.url) === index,
  );
}

function consumePendingAssistantArtifacts() {
  const artifacts = pendingAssistantArtifacts.value;
  pendingAssistantArtifacts.value = [];
  return artifacts;
}

function attachPendingArtifacts(index) {
  const pending = consumePendingAssistantArtifacts();
  if (!pending.length || !conversationTurns.value[index]) {
    return;
  }
  const existing = conversationTurns.value[index].artifacts || [];
  const combined = [...existing, ...pending];
  conversationTurns.value[index].artifacts = combined.filter(
    (artifact, artifactIndex) =>
      combined.findIndex((candidate) => candidate.url === artifact.url) === artifactIndex,
  );
}

function visibleTurnArtifacts(turn) {
  const referencedSources = Array.from(
    String(turn.content || "").matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/g),
    (match) => match[1],
  );
  return (turn.artifacts || []).filter((artifact) => {
    return !referencedSources.includes(artifact.name) && !referencedSources.includes(artifact.url);
  });
}

function renderMarkdown(value, artifacts = []) {
  const text = String(value || "").replace(/\r\n?/g, "\n");
  if (!text.trim()) {
    return "";
  }

  const lines = text.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = matchCodeFence(line);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence.marker)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const languageClass = fence.language ? ` class="language-${escapeAttribute(fence.language)}"` : "";
      blocks.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim(), artifacts)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"), artifacts)}</blockquote>`);
      continue;
    }

    if (isMarkdownTable(lines, index)) {
      const table = renderMarkdownTable(lines, index, artifacts);
      blocks.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const list = matchListItem(line);
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      const items = [];
      while (index < lines.length) {
        const item = matchListItem(lines[index]);
        if (!item || item.ordered !== list.ordered) {
          break;
        }
        items.push(`<li>${renderInlineMarkdown(item.content.trim(), artifacts)}</li>`);
        index += 1;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (paragraphLines.length) {
      blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(" "), artifacts)}</p>`);
      continue;
    }

    blocks.push(`<p>${renderInlineMarkdown(trimmed, artifacts)}</p>`);
    index += 1;
  }

  return blocks.join("");
}

function renderInlineMarkdown(value, artifacts = []) {
  const codeTokens = [];
  const linkTokens = [];
  const imageTokens = [];
  let html = String(value);

  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = html.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (match, label, source) => {
    const artifact = artifacts.find((candidate) => candidate.name === source || candidate.url === source);
    const url = artifact?.url || (source.startsWith("/api/artifacts/python/") ? source : "");
    if (!url) {
      return match;
    }
    const token = `\u0000IMAGE${imageTokens.length}\u0000`;
    imageTokens.push(
      `<a class="markdown-image-link" href="${escapeAttribute(url)}" target="_blank" rel="noreferrer"><img src="${escapeAttribute(url)}" alt="${escapeAttribute(label || artifact?.name || "Python output image")}" loading="lazy"></a>`,
    );
    return token;
  });

  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_match, label, url) => {
    const token = `\u0000LINK${linkTokens.length}\u0000`;
    linkTokens.push(
      `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`,
    );
    return token;
  });

  html = escapeHtml(html);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");

  return html
    .replace(/\u0000CODE(\d+)\u0000/g, (_match, tokenIndex) => codeTokens[Number(tokenIndex)] || "")
    .replace(/\u0000LINK(\d+)\u0000/g, (_match, tokenIndex) => linkTokens[Number(tokenIndex)] || "")
    .replace(/\u0000IMAGE(\d+)\u0000/g, (_match, tokenIndex) => imageTokens[Number(tokenIndex)] || "");
}

function renderMarkdownTable(lines, startIndex, artifacts = []) {
  const headers = splitMarkdownTableRow(lines[startIndex]);
  const alignments = splitMarkdownTableRow(lines[startIndex + 1]).map(tableAlignment);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].trim().includes("|")) {
    rows.push(splitMarkdownTableRow(lines[index]));
    index += 1;
  }

  const headerHtml = headers
    .map((cell, cellIndex) => {
      const attrs = tableCellAttributes(alignments[cellIndex]);
      return `<th${attrs}>${renderInlineMarkdown(cell, artifacts)}</th>`;
    })
    .join("");
  const bodyHtml = rows
    .map((row) => {
      const cells = headers
        .map((_, cellIndex) => {
          const attrs = tableCellAttributes(alignments[cellIndex]);
          return `<td${attrs}>${renderInlineMarkdown(row[cellIndex] || "", artifacts)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return {
    html: `<div class="markdown-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: index,
  };
}

function isMarkdownBlockStart(lines, index) {
  const line = lines[index] || "";
  return (
    Boolean(matchCodeFence(line)) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    Boolean(matchListItem(line)) ||
    isMarkdownTable(lines, index)
  );
}

function matchCodeFence(line) {
  const match = line.trim().match(/^(```|~~~)\s*([A-Za-z0-9_-]+)?\s*$/);
  if (!match) {
    return null;
  }
  return {
    marker: match[1],
    language: match[2] || "",
  };
}

function matchListItem(line) {
  const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unordered) {
    return { ordered: false, content: unordered[1] };
  }
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) {
    return { ordered: true, content: ordered[1] };
  }
  return null;
}

function isMarkdownTable(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|")) {
    return false;
  }
  const headers = splitMarkdownTableRow(lines[index]);
  const divider = splitMarkdownTableRow(lines[index + 1]);
  return headers.length > 1 && divider.length === headers.length && divider.every(isMarkdownTableDividerCell);
}

function splitMarkdownTableRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|")) {
    row = row.slice(0, -1);
  }
  return row.split("|").map((cell) => cell.trim());
}

function isMarkdownTableDividerCell(cell) {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function tableAlignment(cell) {
  const value = cell.trim();
  if (/^:-{3,}:$/.test(value)) {
    return "center";
  }
  if (/^-{3,}:$/.test(value)) {
    return "right";
  }
  if (/^:-{3,}$/.test(value)) {
    return "left";
  }
  return "";
}

function tableCellAttributes(alignment) {
  return alignment ? ` style="text-align: ${alignment}"` : "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function addEventLog(title, body, isError = false) {
  events.value.unshift({
    id: eventSequence.value++,
    title,
    body: String(body).slice(0, 1000),
    isError,
  });
}

function renderMemory(memory) {
  if (!memory?.exists) {
    memoryStatus.value = "No AGENTS.md uploaded.";
    memoryPreview.value = "";
    return;
  }

  memoryStatus.value = `${memory.size_bytes || 0} bytes · ${memory.path}`;
  memoryPreview.value = String(memory.content || "").trim() || "(empty AGENTS.md)";
}

function setAgentState(state, detail) {
  agentState.value = state;
  runStatus.value = state;
  stateDetail.value = detail || "";
}

function setPromptOutput(value) {
  latestPromptJson.value = JSON.stringify(value, null, 2);
  promptOutput.value = latestPromptJson.value;
  copyPromptDisabled.value = false;
}

function summarizeLlmRequest(request) {
  const messageCount = request?.messages?.length || 0;
  const toolCount = request?.tools?.length || 0;
  return `${messageCount} prompt parts · ${toolCount} tools · ${request?.model || "unknown model"}`;
}

function summarizeToolArguments(argumentsValue) {
  if (!argumentsValue) {
    return "";
  }
  if (typeof argumentsValue === "object" && Object.keys(argumentsValue).length === 0) {
    return "";
  }
  return truncateInline(JSON.stringify(argumentsValue, null, 2), 180);
}

function summarizeToolResult(content) {
  return truncateInline(content || "", 220);
}

function truncateInline(value, maxLength) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function summarizeBuddyEvent(event) {
  const payload = event?.payload || {};
  const summary = Object.keys(payload).length ? JSON.stringify(payload, null, 2) : event?.raw || "";
  return summary || "No payload.";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function scrollConversation() {
  await nextTick();
  if (conversationEl.value) {
    conversationEl.value.scrollTop = conversationEl.value.scrollHeight;
  }
}

function normalizeState(state) {
  return state.toLowerCase().replaceAll(" ", "-");
}
</script>
