import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, retry, timer, merge } from 'rxjs';
import { OrderbookService, BookUpdate, PriceChange } from '../../services/orderbook.service';
import { MarketService, MarketInfo } from '../../services/market.service';

interface Level {
  price: number;
  size: number;
  total: number;
  percent: number;
}

interface OutcomeBook {
  label: string;
  assetId: string;
  bids: Level[];
  asks: Level[];
  lastTradePrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  updateCount: number;
}

@Component({
  selector: 'app-orderbook',
  imports: [CommonModule, FormsModule],
  templateUrl: './orderbook.component.html',
})
export class OrderbookComponent implements OnInit, OnDestroy {
  slugInput = '';
  market: MarketInfo | null = null;
  outcomes: OutcomeBook[] = [];
  connected = false;
  loading = false;
  error = '';
  private sub?: Subscription;
  private readonly maxLevels = 15;

  constructor(
    private orderbookService: OrderbookService,
    private marketService: MarketService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.route.queryParams.subscribe((params) => {
      if (params['slug']) {
        this.slugInput = params['slug'];
        this.loadMarket();
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  submit(): void {
    const slug = this.slugInput.trim();
    if (!slug) return;
    this.router.navigate([], { queryParams: { slug } });
  }

  private async loadMarket(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.sub?.unsubscribe();
    this.outcomes = [];
    this.cdr.detectChanges();

    try {
      const market = await this.marketService.getMarketBySlug(this.slugInput);
      if (!market) {
        this.error = 'Market not found';
        this.loading = false;
        this.cdr.detectChanges();
        return;
      }

      this.market = market;
      const labels: string[] = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      const tokenIds: string[] = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;

      this.outcomes = labels.map((label, i) => ({
        label,
        assetId: tokenIds[i],
        bids: [],
        asks: [],
        lastTradePrice: 0,
        bestBid: 0,
        bestAsk: 0,
        spread: 0,
        updateCount: 0,
      }));

      this.loading = false;
      this.cdr.detectChanges();
      this.connectStreams(tokenIds);
    } catch {
      this.error = 'Failed to load market';
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  private connectStreams(tokenIds: string[]): void {
    const streams = tokenIds.map((id) =>
      this.orderbookService.streamMarket(id).pipe(retry({ delay: () => timer(2000) })),
    );

    this.connected = true;
    this.cdr.detectChanges();

    this.sub = merge(...streams).subscribe({
      next: (event) => {
        if (event.type === 'keepalive' as string) return;
        const assetId = event.data.asset_id;
        const outcome = this.outcomes.find((o) => o.assetId === assetId);
        if (!outcome) return;

        outcome.updateCount++;
        if (event.type === 'book') {
          this.handleBook(outcome, event.data as BookUpdate);
        } else {
          this.handlePriceChange(outcome, event.data as PriceChange);
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.connected = false;
        this.cdr.detectChanges();
      },
    });
  }

  private handleBook(outcome: OutcomeBook, book: BookUpdate): void {
    if (book.last_trade_price) {
      outcome.lastTradePrice = parseFloat(book.last_trade_price);
    }

    outcome.bids = this.buildLevels(
      (book.bids || []).map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      'desc',
    );
    outcome.asks = this.buildLevels(
      (book.asks || []).map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
      'asc',
    );

    outcome.bestBid = outcome.bids.length > 0 ? outcome.bids[0].price : 0;
    outcome.bestAsk = outcome.asks.length > 0 ? outcome.asks[0].price : 0;
    outcome.spread = outcome.bestAsk - outcome.bestBid;
  }

  private handlePriceChange(outcome: OutcomeBook, change: PriceChange): void {
    if (change.best_bid) outcome.bestBid = parseFloat(change.best_bid);
    if (change.best_ask) outcome.bestAsk = parseFloat(change.best_ask);
    outcome.spread = outcome.bestAsk - outcome.bestBid;
  }

  private buildLevels(
    entries: { price: number; size: number }[],
    order: 'asc' | 'desc',
  ): Level[] {
    const sorted = entries
      .filter((e) => e.size > 0)
      .sort((a, b) => (order === 'desc' ? b.price - a.price : a.price - b.price))
      .slice(0, this.maxLevels);

    let cumulative = 0;
    const levels = sorted.map((e) => {
      cumulative += e.size;
      return { price: e.price, size: e.size, total: cumulative, percent: 0 };
    });

    const maxTotal = levels.length > 0 ? levels[levels.length - 1].total : 1;
    for (const level of levels) {
      level.percent = (level.total / maxTotal) * 100;
    }
    return levels;
  }

  formatPrice(price: number): string {
    return (price * 100).toFixed(1) + '\u00A2';
  }

  formatSize(size: number): string {
    return size.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  formatTotal(total: number): string {
    return '$' + total.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
}
