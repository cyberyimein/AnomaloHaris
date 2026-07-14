# KabuLens Indicator Glossary

This table explains KabuLens output in human trading language. The goal is not
to predict price directly, but to decide where premarket attention should go.

## Market Context

| Field | Human meaning | How to read it | UI wording |
| --- | --- | --- | --- |
| `market_context.regime` | Today's broad market posture. | `risk_on` means conditions favor offense; `risk_off` means defensive tape; `mixed` means no clear broad signal. | Market mood |
| `risk_score` | Internal composite from equity, short-horizon volatility, and technology leadership. | It has no natural unit. Keep it in tooltips/debug views; primary UI should use `judgment.display.market_state`. | Internal market score |
| `data_coverage` | Fraction of configured regime inputs successfully loaded. | `1.00` means all index, volatility and sector inputs returned data. | Data coverage |
| `signal_confidence` | Internal signal strength multiplied by cross-block agreement. | Never display it as a percentage or score. Use `judgment.display.signal_quality` as “环境信号一致性：低/中/高”. | Internal signal quality |
| `judgment.display.score_policy` | Machine-readable UI rule for internal scores. | `show_internal_scores=false` means block scores and driver scores stay in tooltips/debug views. | Display policy |
| `risk_score_explanation` | Formula, thresholds and weighted contribution from equity, volatility and technology leadership. | Use it in the market-header info panel when the user wants to audit the internal score. | Overall score details |
| `judgment.reads.*.score_explanation` | Card-level score meaning, formula and `-100..100` bands. | Show on demand from the card's info icon, not as the card's primary value. | Card score details |
| `judgment.reads.*.drivers[].score_components` | Per-symbol contribution from current session, five-day move and trend. | Explains why a proxy received its internal score; each component includes input, cap and meaning. | Driver breakdown |
| `groups.equity` | Index direction from SPY, QQQ, IWM. | Weak equity score means broad indexes are dragging; strong score means index backdrop is supportive. | Index tape |
| `groups.volatility` | Short-horizon VIXY change as a futures-based volatility proxy. | Negative score means volatility pressure is rising. VIXY long-run EMA trend is deliberately ignored. | Volatility environment |
| `groups.macro` | Dollar, bonds, gold and oil context. | This block is descriptive and never contributes to `risk_score`; each asset has conditional meanings. | Macro context |
| `groups.sector` | Technology breadth and style relationship from SOXX and IGV. | Same-direction moves confirm broad tech strength/weakness. Material divergence becomes semiconductor/software rotation and contributes zero directional score. | Tech breadth / rotation |
| `theme_groups` | Breadth from the four curated technology watchlist groups. | Useful for peer confirmation and rotation; it is not full-market breadth and never enters `risk_score`. | Group breadth |
| `coverage` | How many configured proxies were available. | `6/6` is complete; `3/6` means interpret that block carefully. | Symbols loaded |

## Stock Rows

| Field | Human meaning | How to read it | UI wording |
| --- | --- | --- | --- |
| `bucket` | Attention category. | `watch` means actively monitor; `observe` means keep on secondary screen; `ignore` means not a priority yet. | Priority |
| `attention_score` | Single triage score from 0 to 100. | A move of at least 1 ATR or 5% is guaranteed `observe` priority for catalyst review. It is not a buy/sell signal. | Attention |
| `attention_components` | Explainable sub-scores for move, setup, participation, options and context. | Move has the largest weight; uncalibrated session volume and options are capped at 10 each. | Score breakdown |
| `session_quote.change_pct` | Change for the selected overnight, premarket, regular or after-hours session. | Extended-hours values are calculated from session price versus the latest regular close. They do not include the prior regular day's move. | Session move |
| `session_quote.reference_price` | Baseline price used for the displayed session move. | Premarket, overnight and after-hours normally reference the latest regular close. | Move baseline |
| `session_quote.change_source` | Calculation method for the displayed move. | Extended hours should say `calculated_from_last_regular_close`. OpenD's raw cumulative rate is retained but never used. | Change source |
| `session_quote.raw_opend_change_pct` | Provider-supplied cumulative change rate. | Kept for auditing only because it can include the preceding regular session. `raw_opend_change_used` must be false. | Raw provider move |
| `session_quote.volume` | Shares traded in the selected session field. | Compare with `participation.fraction_of_adv`; it is not yet adjusted for time of day. | Session volume |
| `premarket` | Raw premarket quote kept for compatibility. | Its `change_pct`/`gap_pct` also references the latest regular close. UI should still prefer `session_quote`. | Raw premarket |
| `technicals.trend` | Price structure versus EMAs. | `uptrend` is constructive, `downtrend` is weak, `mixed` means unclear. | Trend |
| `technicals.adx14` | Strength of the current trend, without direction. | `>=25` means trend behavior deserves more weight; use `technicals.trend` for direction. | Trend strength |
| `technicals.rsi14` | Short-term momentum stretch. | Above `70` is hot/extended; below `30` is washed out; middle is normal. | Momentum |
| `technicals.atr_pct` | Normal daily movement range. | A 3% gap is big for a 2% ATR stock, but less special for a 10% ATR stock. | Normal range |
| `technicals.volume_vs_20d` | Latest completed daily volume versus the prior 20-session average. | The denominator excludes the day being measured. | Completed-day volume |
| `relative_strength` | Stock return versus its group benchmark and SPY over 5 and 20 sessions. | The group benchmark is SOXX, QQQ, or IGV according to configuration. Agreement across both horizons is context, not an entry trigger. | Relative strength |
| `group_context` | Same-group breadth with the current stock excluded. | Confirms whether peers agree without letting the stock confirm itself. Curated groups are still a small sample. | Peer confirmation |
| `levels.yesterday_high` | Yesterday's high. | Break above can show strength; rejection below can cap rallies. | Yesterday high |
| `levels.yesterday_low` | Yesterday's low. | Loss of this level can show weakness. | Yesterday low |
| `levels.support_zone` | Nearby price area where buyers may appear. | If price is near support, watch for hold/break behavior. | Support |
| `levels.resistance_zone` | Nearby price area where sellers may appear. | If price is near resistance, watch for rejection/breakout. | Resistance |
| `reasons` | Plain-language reasons behind the score. | These are the first things to show in UI explanations. | Why it matters |

## AI Judgment Layer

| Field | Human meaning | How to read it | UI wording |
| --- | --- | --- | --- |
| `judgment.headline` | One-sentence AI interpretation. | Put this near the top of a stock card; it is the main human-readable summary. | Judgment |
| `judgment.stance` | Recommended attention posture. | `observe_for_confirmation` means watch triggers, not immediate action. | Stance |
| `judgment.signal` | Conditional direction, evidence, trigger and invalidation. | Direction is neutral unless at least two independent categories agree. | Conditional signal |
| `judgment.key_points` | Important reasons in plain language. | Use this instead of showing raw indicator tables first. | Key points |
| `judgment.technical_read.ema` | EMA status translated to human language. | Shows whether price is above/below key EMAs and what that implies. | EMA state |
| `judgment.technical_read.bollinger` | Bollinger position interpreted with trend direction and ADX strength. | A strong uptrend can walk the upper band; a strong downtrend can walk the lower band. Weak-trend lower-band tests are only mean-reversion watches. | Bollinger behavior |
| `judgment.option_read` | Options risk summarized without contract details. | Show implied range, ATM IV, IV/realized and quote quality; hide individual contracts by default. | Option summary |
| `judgment.scenarios` | Possible outcomes and triggers. | Show these as scenario cards: bounce, breakdown, range, squeeze, volatility expansion. | Scenarios |

## Market Judgment Layer

| Field | Human meaning | How to read it | UI wording |
| --- | --- | --- | --- |
| `market_context.judgment.headline` | One-sentence market interpretation. | Put this at the top of the dashboard. | Market read |
| `market_context.judgment.stance` | Suggested market posture. | `cautious_selective` means only take clean triggers; `defensive` means avoid aggressive risk. | Market stance |
| `market_context.judgment.key_intelligence` | Important cross-asset observations. | Show these instead of raw proxy rows. | Key intelligence |
| `market_context.judgment.reads.equity` | Human-readable index tape. | SPY/QQQ/IWM direction and main drivers. | Index tape |
| `market_context.judgment.reads.volatility` | Human-readable fear/volatility pressure. | Rising volatility makes support failures more likely. | Volatility pressure |
| `market_context.judgment.reads.macro` | Human-readable dollar/bond/gold/oil background. | Use `components` for a context strip; do not present its zero score as a directional signal. | Macro context |
| `market_context.judgment.reads.sector` | Human-readable SOXX/IGV breadth or style rotation. | Display “半导体占优”, “软件占优”, “科技同步走强”, or “科技同步承压”; do not collapse opposite moves into “混合领导力”. | Tech style |
| `market_context.judgment.reads.themes` | Human-readable breadth across semiconductors, optical/network, compute/cloud, and software. | Use it to see broad strength, broad weakness, or rotation inside technology. | Group breadth |
| `market_context.judgment.scenarios` | Possible market-level outcomes. | Show as scenario cards: risk-on confirmation, risk-off escalation, macro headwind, sector drag. | Market scenarios |

## Daily Setup Labels

| Tag | Human meaning | How to read it | UI wording |
| --- | --- | --- | --- |
| `support_test` | Price is near a support zone. | Watch whether the area holds after the open. | Support test |
| `bounce_candidate` | Price is near support with weak RSI and low Bollinger position. | A possible rebound setup, but it needs confirmation. | Bounce candidate |
| `breakdown_risk` | Price is below support. | Avoid assuming a bottom until price reclaims the zone. | Breakdown risk |
| `breakout_watch` | Price is near resistance. | Watch for a clean break with volume. | Breakout watch |
| `trend_pullback` | Uptrend remains intact and price is near EMA20/EMA50. | A normal pullback candidate, not automatically a buy. | Trend pullback |
| `volatility_squeeze` | Bollinger Bandwidth is unusually narrow. | Volatility may expand soon, but direction is unknown. | Volatility squeeze |
| `overextended` | Price is near the upper Bollinger Band with high RSI. | Chasing risk is elevated. | Overextended |
| `upper_band_trend` | Price walks the upper band while EMA direction and ADX confirm a strong uptrend. | Do not treat the upper-band touch alone as a sell signal. | Upper-band trend |
| `lower_band_trend_risk` | Price walks the lower band while EMA direction and ADX confirm a strong downtrend. | Do not use the lower-band touch alone as a dip-buy signal. | Lower-band trend risk |
| `large_implied_move` | The nearest-expiry ATM straddle is expensive relative to spot. | It predicts magnitude only, never direction. | Large implied range |
| `iv_rich_vs_realized` | ATM IV is high relative to 20-day realized volatility. | Options may be expensive; this does not predict stock direction. | IV premium |
| `short_dated_positioning_watch` | Near-ATM OI is concentrated close to expiry. | It can flag sensitive price levels, but dealer gamma sign remains unknown. | Short-dated sensitivity |
| `relative_band_compression` | Bandwidth is low versus the stock's own history while absolute volatility remains high. | Do not display this as a low-volatility squeeze. | Relative compression |

## Options

| Field | Human meaning | How to read it | UI wording |
| --- | --- | --- | --- |
| `options.atm_strike` | Strike closest to current stock price. | Used as the center point for near-term option expectations. | ATM strike |
| `options.atm_straddle_mid` | Approximate call + put price at ATM. | Higher straddle means market prices a bigger near-term move. | Straddle price |
| `options.straddle_implied_move_pct` | Nearest-expiry ATM call-plus-put cost as a percentage of spot. | It is a rough non-directional range, not a probability interval. `expected_move_pct` is a compatibility alias. | Implied range |
| `options.atm_iv` | Average IV of the ATM call and put. | More stable than averaging the entire selected chain. | ATM IV |
| `options.iv_hv_ratio` | ATM IV divided by annualized 20-day realized volatility. | Above `1` means options imply more volatility than recently realized. | IV / realized |
| `options.quote_quality` | ATM bid/ask spread and timing quality. | Outside regular hours, options are interpreted as prior-session context and receive lower weight. | Quote quality |
| `options.current_move_vs_implied_ratio` | Current extended-hours move divided by the prior-session implied range. | Shows how much of the option-implied range has already been consumed; still non-directional. | Range consumed |
| `options.positioning.dealer_gamma_sign` | Whether dealer gamma direction is known. | It is `unknown` with current US aggregate OI data. | Gamma sign |
| `options.put_call_volume_ratio` | Put volume divided by call volume. | Above `1` means more put volume; below `1` means more call volume. Direction still needs context. | Put/call volume |
| `options.put_call_oi_ratio` | Put open interest divided by call open interest. | Shows existing positioning balance, slower-moving than volume. | Put/call OI |
| `options.skew_put_minus_call_iv` | Put IV minus call IV. | Positive means downside protection is more expensive; negative means call side is richer. | Skew |
| `options.unusual_activity` | Contracts with high volume versus open interest. | Means someone is active there; it does not prove bullish or bearish intent by itself. | Unusual flow |

## Recommended UI Hierarchy

| UI area | What to show first | What to hide behind expand |
| --- | --- | --- |
| Header | Market state, signal quality label, data quality label, market judgment headline | Numeric risk/confidence values |
| Market cards | Equity impact, explicit VIXY risk impact, macro balance, SOXX/IGV style label, actual session moves and meanings | Internal block and proxy scores |
| Group breadth | Four curated group cards, peer breadth, benchmark alignment | Per-stock breadth calculations |
| Macro strip | Dollar, bond, gold, oil component meanings | Raw symbol rows |
| Watchlist table | Symbol, priority, attention score, session move, trend, conditional direction | Levels, options internals, reasons |
| Stock detail | Judgment headline, key points, EMA state, Bollinger state, scenarios | Full option chain-derived metrics |
