export const EVENTS = {
  POLYMARKET: {
    TRADE: 'polymarket.trade',
    ORDER_MATCHED: 'polymarket.order_matched',
    CRYPTO_PRICE: 'polymarket.crypto_price',
    EQUITY_PRICE: 'polymarket.equity_price',
    COMMENT: 'polymarket.comment',
    BOOK_UPDATE: 'polymarket.book_update',
    PRICE_CHANGE: 'polymarket.price_change',
    LAST_TRADE_PRICE: 'polymarket.last_trade_price',
    TICK_SIZE_CHANGE: 'polymarket.tick_size_change',
    RTDS_STATUS: 'polymarket.rtds.status',
    CLOB_WS_STATUS: 'polymarket.clob_ws.status',
  },
  DERIBIT: {
    TICKER: 'deribit.ticker',
    OPTIONS: 'deribit.options',
    STATUS: 'deribit.status',
  },
  DERIVED: {
    PRICE_CORRELATION: 'derived.price_correlation',
    ENRICHED_TRADE: 'derived.enriched_trade',
    MARKET_SNAPSHOT: 'derived.market_snapshot',
    EDGE: 'derived.edge',
  },
} as const;
