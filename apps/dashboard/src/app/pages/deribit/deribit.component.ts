import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, retry, timer } from 'rxjs';
import {
  DeribitService,
  DeribitTicker,
  DeribitOption,
} from '../../services/deribit.service';

@Component({
  selector: 'app-deribit',
  imports: [CommonModule],
  templateUrl: './deribit.component.html',
})
export class DeribitComponent implements OnInit, OnDestroy {
  tickers = new Map<string, DeribitTicker>();
  sortedTickers: DeribitTicker[] = [];
  options: DeribitOption[] = [];
  connected = false;
  updateCount = 0;
  private sub?: Subscription;

  constructor(
    private deribitService: DeribitService,
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
    this.sub = this.deribitService
      .streamDeribit()
      .pipe(retry({ delay: () => timer(2000) }))
      .subscribe({
        next: ({ type, data }) => {
          this.connected = true;
          this.updateCount++;
          if (type === 'ticker') {
            this.updateTicker(data as DeribitTicker);
          } else {
            this.updateOption(data as DeribitOption);
          }
          this.cdr.detectChanges();
        },
        error: () => {
          this.connected = false;
          this.cdr.detectChanges();
        },
      });
  }

  private updateTicker(ticker: DeribitTicker): void {
    this.tickers.set(ticker.instrument_name, ticker);
    this.sortedTickers = [...this.tickers.values()];
  }

  private updateOption(option: DeribitOption): void {
    const idx = this.options.findIndex(
      (o) => o.instrument_name === option.instrument_name,
    );
    if (idx >= 0) {
      this.options[idx] = option;
    } else {
      this.options = [...this.options, option].slice(-20);
    }
  }

  formatPrice(price: number): string {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(6);
  }

  formatFunding(rate: number): string {
    return (rate * 100).toFixed(4) + '%';
  }

  formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }
}
