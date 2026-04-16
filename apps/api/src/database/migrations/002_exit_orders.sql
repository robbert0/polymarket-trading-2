-- Phase 4: support EXIT orders (sells that close a position).
-- - Adds `kind` (ENTRY/EXIT) and `close_reason` columns on orders.
-- - Rewrites position_state VIEW so total_size = Σ(ENTRY.size) − Σ(EXIT.size).
--   avg_entry_price stays derived from ENTRY fills only (cost basis shouldn't
--   move because we sold part of the position).
-- - HAVING filter keeps fully-closed positions out of the view.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ENTRY'
    CHECK (kind IN ('ENTRY','EXIT'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS close_reason TEXT
    CHECK (close_reason IN ('stop_loss','take_profit','edge_reversal','expiry_flat','manual'));

CREATE INDEX IF NOT EXISTS idx_orders_kind ON orders(kind);

DROP VIEW IF EXISTS position_state;

CREATE VIEW position_state AS
  SELECT
    o.market_id,
    o.token_id,
    o.label,
    o.side,
    o.mode,
    -- net contracts held = buys − sells
    SUM(CASE WHEN o.kind = 'ENTRY' THEN e.size ELSE -e.size END) AS total_size,
    -- weighted entry price from ENTRY fills only (cost basis is unchanged by a partial sell)
    SUM(CASE WHEN o.kind = 'ENTRY' THEN e.size * e.price ELSE 0 END)
      / NULLIF(SUM(CASE WHEN o.kind = 'ENTRY' THEN e.size ELSE 0 END), 0) AS avg_entry_price,
    -- total USD put in on the buy side (ignores sell proceeds by design)
    SUM(CASE WHEN o.kind = 'ENTRY' THEN e.size * e.price ELSE 0 END) AS cost_basis_usd,
    -- total USD taken out on the sell side (for realized PnL reporting)
    SUM(CASE WHEN o.kind = 'EXIT'  THEN e.size * e.price ELSE 0 END) AS proceeds_usd,
    MIN(o.created_at) AS opened_at,
    MAX(e.created_at) AS last_fill_at,
    ARRAY_AGG(DISTINCT o.id::text) AS order_ids
  FROM orders o
  JOIN executions e ON e.order_id = o.id
  GROUP BY o.market_id, o.token_id, o.label, o.side, o.mode
  HAVING SUM(CASE WHEN o.kind = 'ENTRY' THEN e.size ELSE -e.size END) > 0;
