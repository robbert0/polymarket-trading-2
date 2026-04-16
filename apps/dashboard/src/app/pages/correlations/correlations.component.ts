import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, retry, timer } from 'rxjs';
import {
  CorrelationsService,
  PriceCorrelation,
  EnrichedTrade,
} from '../../services/correlations.service';
import { formatDateTime } from '../../utils/format-time';

@Component({
  selector: 'app-correlations',
  imports: [CommonModule],
  templateUrl: './correlations.component.html',
})
export class CorrelationsComponent implements OnInit, OnDestroy {
  correlations = new Map<string, PriceCorrelation>();
  sortedCorrelations: PriceCorrelation[] = [];
  enrichedTrades: EnrichedTrade[] = [];
  connected = false;
  updateCount = 0;
  private sub?: Subscription;

  constructor(
    private correlationsService: CorrelationsService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.connect();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private connect(): void {
    this.sub?.unsubscribe();
    this.sub = this.correlationsService
      .streamCorrelations()
      .pipe(retry({ delay: () => timer(2000) }))
      .subscribe({
        next: ({ type, data }) => {
          this.connected = true;
          this.updateCount++;
          if (type === 'price_correlation') {
            this.updateCorrelation(data as PriceCorrelation);
          } else if (type === 'enriched_trade') {
            this.addEnrichedTrade(data as EnrichedTrade);
          }
          this.cdr.detectChanges();
        },
        error: () => {
          this.connected = false;
          this.cdr.detectChanges();
        },
      });
  }

  private updateCorrelation(corr: PriceCorrelation): void {
    this.correlations.set(corr.symbol, corr);
    this.sortedCorrelations = [...this.correlations.values()];
  }

  private addEnrichedTrade(trade: EnrichedTrade): void {
    this.enrichedTrades = [trade, ...this.enrichedTrades].slice(0, 100);
  }

  formatPrice(price: string | number | null): string {
    if (price === null) return '-';
    const num = typeof price === 'string' ? parseFloat(price) : price;
    if (num >= 1000) return num.toFixed(2);
    if (num >= 1) return num.toFixed(4);
    return num.toFixed(6);
  }

  formatPercent(val: number | null): string {
    if (val === null) return '-';
    return val.toFixed(4) + '%';
  }

  readonly formatTime = formatDateTime;
}
