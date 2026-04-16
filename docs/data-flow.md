# Data Flow

How a byte travels from an external source to the dashboard — and back into an order on Polymarket.

Every annotation uses `file:line` so you can cmd-click straight to the source in VS Code.

---

## 1. System overview

```mermaid
flowchart LR
  subgraph EXT[External]
    RTDS[Polymarket RTDS WS]
    CLOBWS[Polymarket CLOB WS]
    GAMMA[Polymarket Gamma REST]
    CLOBR[Polymarket CLOB REST]
    DERI[Deribit WS]
    BIN[Binance WS]
  end

  subgraph API[NestJS API apps/api]
    ADAPT[Adapter services]
    EVT(((EventEmitter2 bus)))
    QUE[/BullMQ queues/]
    REDIS[(Redis)]
    PG[(Postgres)]
    OUT[SSE + WS + REST]
  end

  subgraph DASH[Angular dashboard apps/dashboard]
    DSVC[HTTP + EventSource services]
    PAGES[Pages / components]
  end

  EXT --> ADAPT --> EVT
  EVT --> QUE
  QUE --> REDIS
  QUE --> PG
  QUE --> EVT
  EVT --> OUT
  OUT --> DSVC --> PAGES

  CLOBR -. on-demand .-> ADAPT
  GAMMA -. on-demand .-> ADAPT
  OUT -. POST orders .-> CLOBR
```

---

## 2. Ingest & derivation pipeline

Raw market data → events → BullMQ queues → derived events.

```mermaid
flowchart TB
  classDef src fill:#1e3a5f,stroke:#4b8bcf,color:#fff
  classDef svc fill:#2d4a2b,stroke:#6bbd4e,color:#fff
  classDef evt fill:#4a2e5c,stroke:#b06bd4,color:#fff
  classDef q fill:#5c4a2e,stroke:#d4a66b,color:#fff
  classDef store fill:#5c2e2e,stroke:#d46b6b,color:#fff

  RTDS[Polymarket RTDS WS]:::src
  CLOBWS[Polymarket CLOB WS]:::src
  BIN[Binance WS]:::src
  DERI[Deribit WS]:::src

  RtdsSvc[RtdsService<br/>rtds.service.ts:24]:::svc
  ClobWsSvc[ClobWsService<br/>clob-ws.service.ts:90]:::svc
  BinSvc[BinanceWsService<br/>binance-ws.service.ts:49]:::svc
  DeriSvc[DeribitWsService<br/>deribit-ws.service.ts:104]:::svc

  RTDS --> RtdsSvc
  CLOBWS --> ClobWsSvc
  BIN --> BinSvc
  DERI --> DeriSvc

  EV_PT[polymarket.trade]:::evt
  EV_PCP[polymarket.crypto_price]:::evt
  EV_PEP[polymarket.equity_price]:::evt
  EV_PC[polymarket.comment]:::evt
  EV_PBU[polymarket.book_update]:::evt
  EV_PPC[polymarket.price_change]:::evt
  EV_PLT[polymarket.last_trade_price]:::evt
  EV_DT[deribit.ticker]:::evt
  EV_DO[deribit.options]:::evt

  RtdsSvc --> EV_PT & EV_PCP & EV_PEP & EV_PC
  ClobWsSvc --> EV_PBU & EV_PPC & EV_PLT
  BinSvc --> EV_PCP
  DeriSvc --> EV_DT & EV_DO

  EnqSvc[EnqueueService<br/>enqueue.service.ts:38]:::svc
  EV_PT --> EnqSvc
  EV_PCP --> EnqSvc
  EV_DT --> EnqSvc
  EV_PBU --> EnqSvc

  RP[[RAW_PRICES]]:::q
  RT[[RAW_TRADES]]:::q
  RO[[RAW_ORDERBOOK]]:::q

  EnqSvc -->|crypto_price + deribit.ticker| RP
  EnqSvc -->|trade| RT
  EnqSvc -->|book_update 1s debounced| RO

  PCP[PriceCorrelationProcessor<br/>price-correlation.processor.ts]:::svc
  TEP[TradeEnrichmentProcessor<br/>trade-enrichment.processor.ts]:::svc

  RP --> PCP
  RT --> TEP

  LP[("Redis<br/>latest-prices:SYMBOL:SOURCE<br/>HASH, TTL 60s")]:::store
  PCP -->|HSET| LP
  TEP -.HGETALL.-> LP

  PC[[PRICE_CORRELATION]]:::q
  PCP --> PC

  CCP[CorrelationCombinerProcessor]:::svc
  PC --> CCP

  EV_DPC[derived.price_correlation]:::evt
  EV_DET[derived.enriched_trade]:::evt
  CCP --> EV_DPC
  TEP --> EV_DET

  subgraph sched[Scheduled repeatable jobs]
    MSQ[[MARKET_SNAPSHOT<br/>every 30s]]:::q
    ECQ[[EDGE_CALCULATION<br/>every 60s]]:::q
  end

  MSP[MarketSnapshotProcessor]:::svc
  ECP[EdgeCalculationProcessor<br/>concurrency=1, 1 job/10s]:::svc
  MSQ --> MSP
  ECQ --> ECP
  MSP -.HGETALL.-> LP
  EV_DMS[derived.market_snapshot]:::evt
  MSP --> EV_DMS

  ECP --> EdgeSvc[EdgeService.refreshMarkets<br/>edge.service.ts]:::svc
  EdgeSvc -. GET /markets .-> GAMMA[Polymarket Gamma REST]:::src
```

**What the derivation layer does in one sentence:** merge fresh BTC/ETH prices from multiple sources via Redis staging so every downstream consumer (correlation, snapshot, trade enrichment, edge) sees a single-writer latest-price view.

---

## 3. Edge → Trading pipeline

How an edge signal becomes an actual order, with all safety gates and storage side-effects.

```mermaid
flowchart TB
  classDef src fill:#1e3a5f,stroke:#4b8bcf,color:#fff
  classDef svc fill:#2d4a2b,stroke:#6bbd4e,color:#fff
  classDef evt fill:#4a2e5c,stroke:#b06bd4,color:#fff
  classDef q fill:#5c4a2e,stroke:#d4a66b,color:#fff
  classDef store fill:#5c2e2e,stroke:#d46b6b,color:#fff
  classDef gate fill:#5c5c2e,stroke:#d4d46b,color:#fff

  EV_PBU[polymarket.book_update]:::evt
  EV_DT[deribit.ticker]:::evt
  EV_DO[deribit.options]:::evt

  EdgeSvc["EdgeService<br/>edge.service.ts<br/>(REST refresh every BOOK_REFRESH_MS<br/> + trailing 1s throttle)"]:::svc

  EV_PBU --> EdgeSvc
  EV_DT --> EdgeSvc
  EV_DO --> EdgeSvc

  CLOBR[Polymarket CLOB REST]:::src
  EdgeSvc -.GET /book periodic.-> CLOBR

  EV_DE[derived.edge]:::evt
  EdgeSvc --> EV_DE

  OT["OrderTriggerService<br/>order-trigger.service.ts:38"]:::svc
  XT["ExitTriggerService<br/>exit-trigger.service.ts:43"]:::svc
  EV_DE --> OT
  EV_DE --> XT

  PO[("Redis<br/>positions:open<br/>SET")]:::store
  CD[("Redis<br/>trading:cooldown:mkt<br/>STRING+TTL")]:::store
  KS[("Redis<br/>trading:killswitch<br/>STRING")]:::store

  FILT{{"Trigger gates:<br/>killswitch OFF<br/>no existing position<br/>no cooldown<br/>minExecEdge / minFillScore /<br/>minFillableUsd"}}:::gate
  OT --> FILT
  XT --> XFILT{{"Exit gates:<br/>SISMEMBER positions:open<br/>priority: expiry_flat ><br/>stop_loss > take_profit ><br/>edge_reversal"}}:::gate
  FILT -.SISMEMBER.-> PO
  FILT -.EXISTS.-> CD
  FILT -.EXISTS.-> KS
  XFILT -.SISMEMBER.-> PO

  OEQ[["ORDER_EXECUTION queue<br/>concurrency=1<br/>limit 10/min<br/>3 retries exp backoff"]]:::q

  FILT -->|"jobId: order:mkt:minuteBucket<br/>kind=ENTRY"| OEQ
  XFILT -->|"jobId: exit:mkt:side:bucket<br/>priority=1, kind=EXIT<br/>closeReason=stop_loss|take_profit|edge_reversal|expiry_flat"| OEQ

  CTRL["OrderController<br/>POST /positions/:mkt/close<br/>order.controller.ts:154"]:::svc
  CTRL -->|"no jobId (bypass dedup)<br/>priority=1, kind=EXIT<br/>closeReason=manual"| OEQ

  OEP["OrderExecutionProcessor<br/>order-execution.processor.ts:23"]:::svc
  OEQ --> OEP

  RS["RiskService<br/>killswitch, dup position,<br/>cooldown, max positions,<br/>max notional, bankroll"]:::svc
  SZ["SizingService<br/>fixed notional / refPrice"]:::svc

  OEP -->|"ENTRY only"| SZ
  OEP -->|"ENTRY only"| RS
  RS -.-> KS
  RS -.-> PO
  RS -.-> CD

  EX["OrderExecutor (strategy)<br/>PaperExecutor OR<br/>PolymarketExecutor"]:::svc
  OEP --> EX

  CLOB["Polymarket CLOB (live)<br/>EIP-712 signed, FAK + GTC fallback"]:::src
  EX -. placeBuy/placeSell .-> CLOB

  PG[("Postgres<br/>orders + executions<br/>(single txn)")]:::store
  OEP -->|INSERT| PG
  OEP -->|"SADD on ENTRY fill<br/>SREM on EXIT close"| PO
  OEP -->|"SETEX on risk-fail<br/>or exit-fail"| CD

  EV_OE[trading.order_executed]:::evt
  EV_OF[trading.order_failed]:::evt
  EV_PSO[trading.position_opened]:::evt
  EV_PSC[trading.position_closed]:::evt
  OEP --> EV_OE & EV_OF & EV_PSO & EV_PSC

  BC["BankrollCacheService<br/>setInterval refreshMs<br/>bankroll-cache.service.ts:48"]:::svc
  BC -->|live mode| CLOB
  BC -->|paper: synthetic| PAPER[(TRADING_PAPER_BANKROLL_USD)]:::store
  EV_BU[trading.bankroll_updated]:::evt
  BC --> EV_BU
  OEP -.paper fill: applyPaperDelta.-> BC

  CTRL2["POST /trading/pause | resume<br/>order.controller.ts"]:::svc
  EV_KS[trading.killswitch_changed]:::evt
  CTRL2 --> KS
  CTRL2 --> EV_KS
```

**Dedup semantics in one sentence:** entries dedupe per-minute-per-market to avoid spamming fills while an edge persists; auto-exits dedupe per-cooldown-bucket-per-side so a thrashy book can't fire a hundred closes while one is still in flight; manual close skips dedup entirely because operator intent always wins.

---

## 4. Outbound distribution

Events → SSE / WS / REST → dashboard services.

```mermaid
flowchart LR
  classDef evt fill:#4a2e5c,stroke:#b06bd4,color:#fff
  classDef sse fill:#2e5c4a,stroke:#6bd4a6,color:#fff
  classDef ws fill:#5c2e4a,stroke:#d46ba6,color:#fff
  classDef rest fill:#5c4a2e,stroke:#d4a66b,color:#fff
  classDef dsvc fill:#1e3a5f,stroke:#4b8bcf,color:#fff

  subgraph events[EventEmitter2]
    E1[polymarket.trade]:::evt
    E2[polymarket.crypto_price]:::evt
    E3[polymarket.book_update]:::evt
    E4[polymarket.price_change]:::evt
    E5[polymarket.last_trade_price]:::evt
    E6[deribit.ticker]:::evt
    E7[deribit.options]:::evt
    E8[derived.price_correlation]:::evt
    E9[derived.enriched_trade]:::evt
    E10[derived.market_snapshot]:::evt
    E11[derived.edge]:::evt
    E12[trading.order_executed]:::evt
    E13[trading.order_failed]:::evt
    E14[trading.bankroll_updated]:::evt
    E15[trading.killswitch_changed]:::evt
  end

  subgraph sse[SSE endpoints - sse.controller.ts]
    S1[GET /api/sse/trades]:::sse
    S2[GET /api/sse/crypto-prices]:::sse
    S3[GET /api/sse/market/:assetId]:::sse
    S4[GET /api/sse/deribit]:::sse
    S5[GET /api/sse/correlations]:::sse
    S6[GET /api/sse/edge]:::sse
    S7[GET /api/sse/orders]:::sse
  end

  subgraph ws[WebSocket Gateway /polymarket namespace]
    WSG[subscribe:trades/crypto_prices/<br/>equity_prices/comments/market/<br/>deribit/correlations/edge]:::ws
  end

  subgraph rest[REST controllers]
    R1[/api/orders /api/positions<br/>/api/trading/status<br/>/api/trading/bankroll/]:::rest
    R2[POST /api/trading/pause<br/>POST /api/trading/resume<br/>POST /api/positions/:mkt/close<br/>POST /api/trading/bankroll/refresh]:::rest
    R3[/api/clob/* /api/markets/*/]:::rest
  end

  E1 --> S1
  E2 --> S2
  E3 & E4 & E5 --> S3
  E6 & E7 --> S4
  E8 & E9 & E10 --> S5
  E11 --> S6
  E12 & E13 & E14 & E15 --> S7

  E1 & E2 & E3 & E4 & E5 & E6 & E7 & E8 & E9 & E10 & E11 --> WSG

  subgraph dashsvc[Angular services - apps/dashboard/src/app/services]
    DS1[trades.service]:::dsvc
    DS2[crypto-prices.service]:::dsvc
    DS3[orderbook.service]:::dsvc
    DS4[deribit.service]:::dsvc
    DS5[correlations.service]:::dsvc
    DS6[edge.service]:::dsvc
    DS7[orders.service]:::dsvc
    DS8[market.service]:::dsvc
  end

  S1 --> DS1
  S2 --> DS2
  S3 --> DS3
  S4 --> DS4
  S5 --> DS5
  S6 --> DS6
  S7 --> DS7
  R1 --> DS7
  R2 --> DS7
  R3 --> DS8
```

> **Every SSE endpoint** also emits a `keepalive` event every 15 s (`sse.controller.ts:207`) so the dashboard's 30 s staleness-check doesn't false-trip during quiet periods — the dashboard surfaces this as the `LIVE` / `DISCONNECTED` badge on `/orders`.

---

## 5. Storage layout

```mermaid
flowchart LR
  classDef tbl fill:#5c2e2e,stroke:#d46b6b,color:#fff
  classDef view fill:#5c2e4a,stroke:#d46ba6,color:#fff
  classDef rk fill:#2e5c4a,stroke:#6bd4a6,color:#fff

  subgraph PG[Postgres]
    O["<b>orders</b><br/>id UUID PK<br/>market_id, token_id, label<br/>side YES|NO<br/>status pending|filled|partially_filled|<br/>rejected|failed<br/>kind ENTRY|EXIT<br/>close_reason stop_loss|take_profit|<br/>edge_reversal|expiry_flat|manual<br/>ref_price, limit_price, requested_size<br/>edge_at_entry, executable_edge_at_entry,<br/>fill_score_at_entry<br/>mode paper|live<br/>external_order_id, error_message<br/>created_at, completed_at<br/><br/>IDX: market_id, created_at, status, kind"]:::tbl

    E["<b>executions</b><br/>id UUID PK<br/>order_id UUID FK → orders.id<br/>trade_id, price, size<br/>fee_bps, tx_hash, matched_at<br/>price_source trade|fallback|paper<br/>created_at<br/><br/>IDX: order_id"]:::tbl

    V["<b>position_state</b> (VIEW)<br/>SELECT market_id, token_id, label, side, mode,<br/>SUM(CASE kind WHEN ENTRY THEN size ELSE -size END) AS total_size,<br/>avg_entry_price (from ENTRY fills only),<br/>cost_basis_usd, proceeds_usd,<br/>opened_at, last_fill_at, order_ids[]<br/>HAVING total_size > 0"]:::view

    O -->|"1..N"| E
    O --> V
    E --> V
  end

  subgraph R[Redis - non-BullMQ]
    RK1["<b>positions:open</b><br/>SET of marketId<br/><br/>SADD on ENTRY fill<br/>SREM on EXIT close<br/>SISMEMBER hot path<br/>position-tracker.service.ts:147,157,171"]:::rk

    RK2["<b>trading:cooldown:{marketId}</b><br/>STRING = '1', TTL seconds<br/><br/>SETEX on risk-fail / exit-fail<br/>EXISTS check in triggers<br/>position-tracker.service.ts:250"]:::rk

    RK3["<b>trading:killswitch</b><br/>STRING = '1' (or absent)<br/><br/>SET via POST /trading/pause<br/>DEL via POST /trading/resume<br/>EXISTS in risk gate<br/>position-tracker.service.ts:266"]:::rk

    RK4["<b>latest-prices:{symbol}:{source}</b><br/>HASH {price, timestamp}, TTL 60s<br/><br/>HSET by PriceCorrelationProcessor<br/>HGETALL by market-snapshot,<br/>trade-enrichment,<br/>correlation-combiner"]:::rk
  end
```

Migrations live in `apps/api/src/database/migrations/`:

- `001_orders.sql` — base schema + `position_state` view
- `002_exit_orders.sql` — adds `kind` + `close_reason`; rewrites `position_state` VIEW to net ENTRY - EXIT fills

---

## Reference — EventEmitter2 events

Constants in `libs/shared-types/src/lib/events.ts`.

| Event | Emitted by | Notes |
|---|---|---|
| `polymarket.trade` | `rtds.service.ts:120` | Raw Polymarket trades |
| `polymarket.order_matched` | `rtds.service.ts:122` | CLOB match notifications |
| `polymarket.crypto_price` | `rtds.service.ts:127`, `binance-ws.service.ts:92` | BTC/ETH reference prices |
| `polymarket.equity_price` | `rtds.service.ts:130` | Equity indices |
| `polymarket.comment` | `rtds.service.ts:133` | Market comments |
| `polymarket.book_update` | `clob-ws.service.ts:130` | L2 orderbook deltas |
| `polymarket.price_change` | `clob-ws.service.ts:133` | Top-of-book price changes |
| `polymarket.last_trade_price` | `clob-ws.service.ts:136` | Last-trade ticker |
| `polymarket.tick_size_change` | `clob-ws.service.ts:138` | Tick-size updates |
| `polymarket.rtds.status` | `rtds.service.ts:36` | WS health beacon |
| `polymarket.clob_ws.status` | `clob-ws.service.ts:102,113` | WS health beacon |
| `deribit.ticker` | `deribit-ws.service.ts:211` | Perpetual/option mark |
| `deribit.options` | `deribit-ws.service.ts:232` | Greeks + IV |
| `deribit.status` | `deribit-ws.service.ts:114,125` | WS health beacon |
| `derived.price_correlation` | `correlation-combiner.processor.ts` | BTC/ETH cross-source correlation |
| `derived.enriched_trade` | `trade-enrichment.processor.ts:40` | Trade + reference price |
| `derived.market_snapshot` | `market-snapshot.processor.ts:42` | 30 s market roll-up |
| `derived.edge` | `edge.service.ts` | Per-market edge + book depth |
| `trading.order_intent` | `order-trigger.service.ts:101` | ENTRY intent enqueue notification |
| `trading.exit_intent` | `exit-trigger.service.ts:187`, `order.controller.ts:152` | EXIT intent enqueue |
| `trading.order_executed` | `order-execution.processor.ts:142,204` | Fill (ENTRY or EXIT) |
| `trading.order_failed` | `order-execution.processor.ts:149,238` | Order rejected |
| `trading.position_opened` | `order-execution.processor.ts:143` | First ENTRY fill |
| `trading.position_closed` | `order-execution.processor.ts:205` | Fully-closed EXIT |
| `trading.killswitch_changed` | `order.controller.ts:69,78` | Pause/resume toggle |
| `trading.bankroll_updated` | `bankroll-cache.service.ts:72,139,202` | Balance refresh |

---

## Reference — BullMQ queues

Constants in `libs/shared-types/src/lib/queues.ts`.

| Queue | Producer | Processor | Concurrency / limit / retry |
|---|---|---|---|
| `RAW_PRICES` | `enqueue.service.ts:38,50` (on crypto_price + deribit.ticker) | `price-correlation.processor.ts:14` | default concurrency; job removal: age 300 s / 1000 on complete |
| `RAW_TRADES` | `enqueue.service.ts:62` (on polymarket.trade) | `trade-enrichment.processor.ts:11` | default; age 3600 s / 5000 on complete |
| `RAW_ORDERBOOK` | `enqueue.service.ts:70` (1 s debounce per asset_id) | consumed internally for snapshot | — |
| `PRICE_CORRELATION` | `price-correlation.processor.ts:77` | `correlation-combiner.processor.ts` | default |
| `MARKET_SNAPSHOT` | `enqueue.service.ts:23` (repeatable, 30 s) | `market-snapshot.processor.ts:11` | default |
| `EDGE_CALCULATION` | `enqueue.service.ts:30` (repeatable, 60 s) | `edge-calculation.processor.ts:7` | **concurrency 1, 1 job / 10 s** |
| `ORDER_EXECUTION` | `order-trigger.service.ts:103`, `exit-trigger.service.ts:189`, `order.controller.ts:154` | `order-execution.processor.ts:23` | **concurrency 1, 10 jobs / 60 s, 3 retries exp backoff (2 s base)** |

Dedup:
- **ENTRY** jobs — `jobId = order:{marketId}:{minuteBucket}` (one per market per minute)
- **Auto-EXIT** jobs — `jobId = exit:{marketId}:{side}:{exitCooldownBucket}`, `priority=1`
- **Manual close** — no `jobId` (operator always wins), `priority=1`

---

## Reference — Redis keys (non-BullMQ)

| Key | Type | Writer | Reader | TTL |
|---|---|---|---|---|
| `positions:open` | SET | `position-tracker.service.ts:147` (SADD on ENTRY), `:157` (SREM on EXIT close) | `:171` (SISMEMBER), `:176` (SCARD), `order-trigger.service.ts`, `exit-trigger.service.ts` | none |
| `trading:cooldown:{marketId}` | STRING | `position-tracker.service.ts:250` (SET EX), `order-execution.processor.ts:96,145,210` | `order-trigger.service.ts`, `exit-trigger.service.ts` | `cfg.risk.marketCooldownSec` (ENTRY fail) / `cfg.exits.exitCooldownSec` (EXIT fail) |
| `trading:killswitch` | STRING | `position-tracker.service.ts:266` (SET=1 on pause), `:268` (DEL on resume) | `order.controller.ts:54`, risk gate | none |
| `latest-prices:{symbol}:{source}` | HASH `{price, timestamp}` | `price-correlation.processor.ts:51` (HSET) | `market-snapshot.processor.ts:51`, `trade-enrichment.processor.ts:48`, `correlation-combiner.processor.ts:77` | 60 s |

---

## Reference — Postgres tables, SSE endpoints, dashboard services

### Postgres (`apps/api/src/database/migrations/*.sql`)

| Object | Role | Writers | Readers |
|---|---|---|---|
| `orders` table | Append-only intent + outcome log | `position-tracker.service.ts:88` (INSERT) | `order.controller.ts` (`GET /orders`) |
| `executions` table | Append-only fills | `position-tracker.service.ts:120` (INSERT, same txn as orders) | join in `position_state` view |
| `position_state` VIEW | Net open position with ENTRY − EXIT math | (derived) | `position-tracker.service.ts:152`, `order.controller.ts` (`GET /positions`, risk checks) |

### SSE endpoints (`apps/api/src/polymarket/sse/sse.controller.ts`)

| Path | Dashboard consumer | Event types emitted |
|---|---|---|
| `GET /api/sse/trades` | `trades.service.ts` | `polymarket.trade` + `keepalive` |
| `GET /api/sse/crypto-prices` | `crypto-prices.service.ts` | `polymarket.crypto_price` + `keepalive` |
| `GET /api/sse/market/:assetId` | `orderbook.service.ts` | `polymarket.book_update`, `polymarket.price_change`, `polymarket.last_trade_price` + `keepalive` |
| `GET /api/sse/deribit` | `deribit.service.ts` | `deribit.ticker`, `deribit.options` + `keepalive` |
| `GET /api/sse/correlations` | `correlations.service.ts` | `derived.price_correlation`, `derived.enriched_trade`, `derived.market_snapshot` + `keepalive` |
| `GET /api/sse/edge` | `edge.service.ts` | `derived.edge` + `keepalive` |
| `GET /api/sse/orders` | `orders.service.ts` | `order_executed`, `order_failed`, `bankroll`, `killswitch` + `keepalive` |

### REST endpoints (non-SSE)

| Path | Handler |
|---|---|
| `GET /api/orders` (limit) | `order.controller.ts` |
| `GET /api/positions` | `order.controller.ts` |
| `GET /api/trading/status` | `order.controller.ts` |
| `GET /api/trading/bankroll` | `order.controller.ts` |
| `POST /api/trading/pause` | `order.controller.ts` |
| `POST /api/trading/resume` | `order.controller.ts` |
| `POST /api/trading/bankroll/refresh` | `order.controller.ts` |
| `POST /api/positions/:marketId/close` | `order.controller.ts:154` (enqueue EXIT intent) |
| `GET /api/clob/{book,price,midpoint,spread,last-trade-price}/:tokenId` | `clob-rest.controller.ts` |
| `GET /api/markets`, `/api/markets/:slug`, `/api/markets/search/:q` | `gamma.controller.ts` |
| `GET /api/health` | `health.controller.ts` |

---

## Tracing example — paper-mode edge → filled order

Follow one signal end-to-end:

1. Deribit WS pushes BTC ticker → `DeribitWsService` emits `deribit.ticker`.
2. `EdgeService` recomputes edge for every tracked Polymarket market using cached CLOB book + Deribit option surface → emits `derived.edge`.
3. `OrderTriggerService.onEdge` checks gates (killswitch off via `trading:killswitch`, no position via `SISMEMBER positions:open`, no cooldown via `EXISTS trading:cooldown:mkt`, exec-edge/fillScore/fillableUsd thresholds).
4. Passes → enqueues `jobId=order:mkt:minuteBucket` with `kind=ENTRY` on `ORDER_EXECUTION`.
5. `OrderExecutionProcessor` (concurrency=1) picks up → `SizingService` → `RiskService` (max positions, notional, bankroll) → `PaperExecutor.placeBuy` (synthetic fill at `refPrice`).
6. Postgres single txn: INSERT `orders` (status=`filled`, kind=`ENTRY`) + INSERT `executions`.
7. Redis: SADD `positions:open`. Paper bankroll decrements via `BankrollCacheService.applyPaperDelta(-notional)`.
8. Emits `trading.order_executed` + `trading.position_opened`.
9. `SseController` sees `trading.order_executed` → pushes on `/api/sse/orders`.
10. Dashboard `orders.service.ts` EventSource → `orders.component.ts` prepends row, refreshes positions table.

The same trace in reverse for manual close: dashboard POSTs `/api/positions/:mkt/close` → controller enqueues EXIT with `kind=EXIT, closeReason=manual, priority=1, no jobId` → processor runs `placeSell` path → `SREM positions:open` on full close → `trading.position_closed` → SSE → dashboard row disappears.
