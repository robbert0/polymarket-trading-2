import type {
  ExecutionFill,
  OrderSide,
} from '@polymarket-ws/shared-types';

export interface BuyParams {
  tokenId: string;
  side: OrderSide;
  /** Reference price — midPrice of orderbook at enqueue time. */
  price: number;
  /** Number of contracts to buy. */
  size: number;
  /** Optional max slippage cap; executor should reject if worst fill exceeds. */
  maxSlippagePct?: number;
}

export interface SellParams {
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  maxSlippagePct?: number;
}

export interface OrderExecutionResult {
  filled: boolean;
  avgPrice: number;
  filledContracts: number;
  fills: ExecutionFill[];
  externalOrderId?: string;
  errorMessage?: string;
}

export interface WalletBalance {
  /** USDC available in CLOB collateral wallet. */
  balance: number;
}

/**
 * Trading executor abstraction. Implementations: {@link PaperExecutor},
 * {@link PolymarketExecutor} (phase 3).
 */
export interface OrderExecutor {
  placeBuy(params: BuyParams): Promise<OrderExecutionResult>;
  placeSell(params: SellParams): Promise<OrderExecutionResult>;
  getBalance?(): Promise<WalletBalance>;
  getTokenBalance?(tokenId: string): Promise<number>;
}

export const ORDER_EXECUTOR = Symbol('ORDER_EXECUTOR');
