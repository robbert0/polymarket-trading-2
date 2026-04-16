-- Orders + append-only fills model.
-- position_state is a VIEW so that the source of truth is the immutable fills stream.

CREATE TABLE IF NOT EXISTS orders (
  id                        UUID PRIMARY KEY,
  market_id                 TEXT NOT NULL,
  token_id                  TEXT NOT NULL,
  label                     TEXT NOT NULL,
  side                      TEXT NOT NULL CHECK (side IN ('YES','NO')),
  status                    TEXT NOT NULL CHECK (status IN ('pending','filled','partially_filled','rejected','failed')),
  ref_price                 NUMERIC(18,8),
  limit_price               NUMERIC(18,8),
  requested_size            NUMERIC(18,8),
  edge_at_entry             NUMERIC(18,8),
  executable_edge_at_entry  NUMERIC(18,8),
  fill_score_at_entry       NUMERIC(10,4),
  mode                      TEXT NOT NULL CHECK (mode IN ('paper','live')),
  external_order_id         TEXT,
  error_message             TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_market_id ON orders(market_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS executions (
  id            UUID PRIMARY KEY,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  trade_id      TEXT,
  price         NUMERIC(18,8) NOT NULL,
  size          NUMERIC(18,8) NOT NULL,
  fee_bps       NUMERIC(10,4),
  tx_hash       TEXT,
  matched_at    TIMESTAMPTZ,
  price_source  TEXT NOT NULL CHECK (price_source IN ('trade','fallback','paper')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_executions_order_id ON executions(order_id);

-- position_state: derived from executions. Avoids the mutable-field bug class.
CREATE OR REPLACE VIEW position_state AS
  SELECT
    o.market_id,
    o.token_id,
    o.label,
    o.side,
    o.mode,
    SUM(e.size)                                      AS total_size,
    SUM(e.size * e.price) / NULLIF(SUM(e.size), 0)   AS avg_entry_price,
    SUM(e.size * e.price)                            AS cost_basis_usd,
    MIN(o.created_at)                                AS opened_at,
    MAX(e.created_at)                                AS last_fill_at,
    ARRAY_AGG(DISTINCT o.id::text)                   AS order_ids
  FROM orders o
  JOIN executions e ON e.order_id = o.id
  WHERE o.mode = 'paper' OR o.mode = 'live'
  GROUP BY o.market_id, o.token_id, o.label, o.side, o.mode
  HAVING SUM(e.size) > 0;
