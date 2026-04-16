import { registerAs } from '@nestjs/config';

export const tradingConfig = registerAs('trading', () => ({
  mode: (process.env.TRADING_MODE ?? 'paper') as 'paper' | 'live',
  enabled: (process.env.TRADING_ENABLED ?? 'true') === 'true',

  polymarket: {
    privateKey: process.env.POLYMARKET_PRIVATE_KEY ?? '',
    apiKey: process.env.POLYMARKET_API_KEY ?? '',
    secret: process.env.POLYMARKET_SECRET ?? '',
    passphrase: process.env.POLYMARKET_PASSPHRASE ?? '',
    signatureType:
      parseInt(process.env.POLYMARKET_SIGNATURE_TYPE ?? '', 10) || 0,
    negRisk: (process.env.POLYMARKET_NEG_RISK ?? 'false') === 'true',
  },

  sizing: {
    fixedOrderSizeUsd:
      parseFloat(process.env.TRADING_FIXED_ORDER_SIZE_USD ?? '') || 10,
    maxOrderSizeUsd:
      parseFloat(process.env.TRADING_MAX_ORDER_SIZE_USD ?? '') || 50,
  },

  risk: {
    maxOpenPositions:
      parseInt(process.env.TRADING_MAX_OPEN_POSITIONS ?? '', 10) || 5,
    maxTotalNotionalUsd:
      parseFloat(process.env.TRADING_MAX_TOTAL_NOTIONAL_USD ?? '') || 200,
    minHoursToExpiry:
      parseFloat(process.env.TRADING_MIN_HOURS_TO_EXPIRY ?? '') || 0.5,
    marketCooldownSec:
      parseInt(process.env.TRADING_MARKET_COOLDOWN_SEC ?? '', 10) || 60,
  },

  filters: {
    minExecutableEdge:
      parseFloat(process.env.TRADING_MIN_EXECUTABLE_EDGE ?? '') || 0.02,
    minFillScore:
      parseFloat(process.env.TRADING_MIN_FILL_SCORE ?? '') || 60,
    minFillableUsd:
      parseFloat(process.env.TRADING_MIN_FILLABLE_USD ?? '') || 50,
  },

  maxSlippagePct:
    parseFloat(process.env.TRADING_MAX_SLIPPAGE_PCT ?? '') || 0.03,

  // Phase 4: exit-logica. Each value is a trigger condition; set to a sentinel
  // (e.g. 0 stop-loss, 999 take-profit) in .env to effectively disable one.
  exits: {
    // Stop-loss — sell when the mark price drops this pct below avgEntry.
    // Example: 0.25 = -25% from entry.
    stopLossPct:
      parseFloat(process.env.TRADING_EXIT_STOP_LOSS_PCT ?? '') || 0.25,
    // Take-profit — sell when the mark price rises this pct above avgEntry.
    // Polymarket tokens cap at $1, so this must stay < 1.
    takeProfitPct:
      parseFloat(process.env.TRADING_EXIT_TAKE_PROFIT_PCT ?? '') || 0.4,
    // Edge-reversal — close when executableEdge flips to the opposite side
    // beyond this threshold (0.02 = 2% reversed edge).
    reversalEdgeThreshold:
      parseFloat(process.env.TRADING_EXIT_REVERSAL_EDGE ?? '') || 0.02,
    // Flatten when market expiry is closer than this (hours). Liquidity dies
    // before settlement — better to take whatever bid is left than hold to close.
    flattenHoursBeforeExpiry:
      parseFloat(process.env.TRADING_EXIT_FLATTEN_HOURS ?? '') || 0.25,
    // Cooldown between exit attempts on the same position (prevents a thrashy
    // market from firing 10 EXITs while the first one is still being filled).
    exitCooldownSec:
      parseInt(process.env.TRADING_EXIT_COOLDOWN_SEC ?? '', 10) || 30,
  },

  bankroll: {
    refreshMs:
      parseInt(process.env.TRADING_BANKROLL_REFRESH_MS ?? '', 10) || 300_000,
    maxStaleMs:
      parseInt(process.env.TRADING_BANKROLL_MAX_STALE_MS ?? '', 10) || 900_000,
    staleBlock:
      (process.env.TRADING_BANKROLL_STALE_BLOCK ?? 'true') === 'true',
    paperBankrollUsd:
      parseFloat(process.env.TRADING_PAPER_BANKROLL_USD ?? '') || 500,
  },
}));
