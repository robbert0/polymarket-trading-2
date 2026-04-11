import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, retry, timer } from 'rxjs';
import { CryptoPrice, CryptoPricesService } from '../../services/crypto-prices.service';

interface CryptoRow {
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePercent: number;
  volume: string;
  lastUpdate: number;
  flash: 'up' | 'down' | null;
}

@Component({
  selector: 'app-crypto-prices',
  imports: [CommonModule],
  templateUrl: './crypto-prices.component.html',
})
export class CryptoPricesComponent implements OnInit, OnDestroy {
  prices = new Map<string, CryptoRow>();
  sortedPrices: CryptoRow[] = [];
  connected = false;
  updateCount = 0;
  private sub?: Subscription;

  constructor(
    private cryptoPricesService: CryptoPricesService,
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
    this.sub = this.cryptoPricesService
      .streamPrices()
      .pipe(retry({ delay: () => timer(2000) }))
      .subscribe({
        next: (data) => {
          this.connected = true;
          this.updateCount++;
          this.updatePrice(data);
          this.cdr.detectChanges();
        },
        error: () => {
          this.connected = false;
          this.cdr.detectChanges();
        },
      });
  }

  private updatePrice(data: CryptoPrice): void {
    const price = parseFloat(data.price);
    const open = parseFloat(data.open);
    const existing = this.prices.get(data.symbol);
    const prevPrice = existing?.price ?? price;

    const row: CryptoRow = {
      symbol: data.symbol,
      price,
      open,
      high: parseFloat(data.high),
      low: parseFloat(data.low),
      change: price - open,
      changePercent: ((price - open) / open) * 100,
      volume: this.formatVolume(parseFloat(data.quoteVolume)),
      lastUpdate: data.timestamp,
      flash: price > prevPrice ? 'up' : price < prevPrice ? 'down' : null,
    };

    this.prices.set(data.symbol, row);
    this.sortedPrices = [...this.prices.values()].sort(
      (a, b) => parseFloat(b.volume.replace(/[^0-9.]/g, '')) - parseFloat(a.volume.replace(/[^0-9.]/g, '')),
    );

    if (row.flash) {
      setTimeout(() => {
        row.flash = null;
        this.cdr.detectChanges();
      }, 400);
    }
  }

  private formatVolume(vol: number): string {
    if (vol >= 1_000_000_000) return (vol / 1_000_000_000).toFixed(2) + 'B';
    if (vol >= 1_000_000) return (vol / 1_000_000).toFixed(2) + 'M';
    if (vol >= 1_000) return (vol / 1_000).toFixed(2) + 'K';
    return vol.toFixed(2);
  }

  formatPrice(price: number): string {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(6);
  }

  formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  cleanSymbol(symbol: string): string {
    return symbol.replace('USDT', '');
  }
}
