export type OrderSide = 'YES' | 'NO';

export type OrderStatus =
  | 'pending'
  | 'filled'
  | 'partially_filled'
  | 'rejected'
  | 'failed';

export type TradingMode = 'paper' | 'live';

export type OrderKind = 'ENTRY' | 'EXIT';

export type CloseReason =
  | 'stop_loss'
  | 'take_profit'
  | 'edge_reversal'
  | 'expiry_flat'
  | 'manual';

export interface OrderIntent {
  marketId: string;
  tokenId: string;
  side: OrderSide;
  refPrice: number;
  deribitProbability: number;
  edge: number;
  executableEdge: number;
  fillScore: number;
  fillableAmount?: number;
  label: string;
  strike: number;
  expiry: string;
  slug?: string;
  createdAt: number;
  // Phase 4: exit orders
  kind: OrderKind;
  closeReason?: CloseReason;
  // For EXIT orders we need to know how many contracts to sell (paper vs live).
  // On ENTRY this is derived by SizingService from notional.
  exitSize?: number;
}

export interface ExecutionFill {
  tradeId: string;
  price: number;
  size: number;
  feeBps?: number;
  txHash?: string;
  matchedAt?: string;
  priceSource: 'trade' | 'fallback' | 'paper';
}

export interface OrderRecord {
  id: string;
  marketId: string;
  tokenId: string;
  label: string;
  side: OrderSide;
  status: OrderStatus;
  refPrice: number;
  limitPrice: number;
  requestedSize: number;
  filledSize: number;
  avgFillPrice: number;
  fills: ExecutionFill[];
  externalOrderId?: string;
  errorMessage?: string;
  mode: TradingMode;
  edgeAtEntry: number;
  executableEdgeAtEntry: number;
  fillScoreAtEntry: number;
  createdAt: number;
  completedAt?: number;
  // Phase 4: exit orders
  kind: OrderKind;
  closeReason?: CloseReason;
}

export interface Position {
  marketId: string;
  tokenId: string;
  label: string;
  side: OrderSide;
  totalSize: number;
  avgEntryPrice: number;
  costBasisUsd: number;
  orderIds: string[];
  status: 'open' | 'closed';
  openedAt: number;
  lastOrderAt: number;
  mode: TradingMode;
}

export interface BankrollSnapshot {
  usdcBalance: number;
  tokenBalances: Record<string, number>;
  totalEquityUsd: number;
  fetchedAt: number;
  source: TradingMode;
}
