import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, retry, timer } from 'rxjs';
import { Trade, TradesService } from '../../services/trades.service';

@Component({
  selector: 'app-trades',
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './trades.component.html',
})
export class TradesComponent implements OnInit, OnDestroy {
  trades: Trade[] = [];
  tradeCount = 0;
  volume = 0;
  connected = false;
  paused = false;
  marketFilter = '';
  activeFilter = '';
  private sub?: Subscription;
  private buffer: Trade[] = [];
  bufferedCount = 0;
  private readonly maxTrades = 200;

  constructor(
    private tradesService: TradesService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.connect();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  connect(): void {
    this.sub?.unsubscribe();
    this.trades = [];
    this.tradeCount = 0;
    this.volume = 0;
    this.connected = false;

    this.sub = this.tradesService
      .streamTrades(this.activeFilter || undefined)
      .pipe(retry({ delay: () => timer(2000) }))
      .subscribe({
        next: (trade) => {
          this.connected = true;
          this.tradeCount++;
          this.volume += (trade.price || 0) * (trade.size || 0);
          if (this.paused) {
            this.buffer.push(trade);
            this.bufferedCount = this.buffer.length;
          } else {
            this.trades.unshift(trade);
            if (this.trades.length > this.maxTrades) {
              this.trades.length = this.maxTrades;
            }
          }
          this.cdr.detectChanges();
        },
        error: () => {
          this.connected = false;
          this.cdr.detectChanges();
        },
      });
  }

  applyFilter(): void {
    this.activeFilter = this.marketFilter.trim();
    this.connect();
  }

  clearFilter(): void {
    this.marketFilter = '';
    this.activeFilter = '';
    this.connect();
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (!this.paused && this.buffer.length) {
      this.trades.unshift(...this.buffer.reverse());
      if (this.trades.length > this.maxTrades) {
        this.trades.length = this.maxTrades;
      }
      this.buffer = [];
      this.bufferedCount = 0;
      this.cdr.detectChanges();
    }
  }

  formatTime(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString();
  }

  shortTx(hash: string): string {
    return hash ? hash.slice(0, 10) + '...' : '';
  }

  polygonscanUrl(hash: string): string {
    return `https://polygonscan.com/tx/${hash}`;
  }
}
