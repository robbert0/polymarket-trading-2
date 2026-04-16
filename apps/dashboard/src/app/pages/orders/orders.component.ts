import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, retry, timer } from 'rxjs';
import {
  OrderRecord,
  OrdersService,
  OrdersStreamEvent,
  Position,
  TradingStatus,
} from '../../services/orders.service';

@Component({
  selector: 'app-orders',
  imports: [CommonModule],
  templateUrl: './orders.component.html',
})
export class OrdersComponent implements OnInit, OnDestroy {
  private readonly ordersService = inject(OrdersService);
  private readonly cdr = inject(ChangeDetectorRef);

  orders: OrderRecord[] = [];
  positions: Position[] = [];
  status: TradingStatus | null = null;
  connected = false;
  streamError: string | null = null;
  closing = new Set<string>();
  private sub?: Subscription;
  private pollSub?: Subscription;

  ngOnInit(): void {
    this.refreshStatus();
    this.loadRecent();
    this.loadPositions();
    this.connect();

    // Poll status every 10s (killswitch + bankroll staleness).
    this.pollSub = timer(10_000, 10_000).subscribe(() => {
      this.refreshStatus();
      this.loadPositions();
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.pollSub?.unsubscribe();
  }

  private loadRecent(): void {
    this.ordersService.listRecent(100).subscribe({
      next: (rows) => {
        this.orders = rows;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.streamError = err.message ?? 'Failed to load orders';
        this.cdr.detectChanges();
      },
    });
  }

  private loadPositions(): void {
    this.ordersService.listPositions().subscribe({
      next: (rows) => {
        this.positions = rows;
        this.cdr.detectChanges();
      },
      error: () => undefined,
    });
  }

  closePosition(p: Position): void {
    const key = `${p.marketId}:${p.side}`;
    if (this.closing.has(key)) return;
    this.closing.add(key);
    this.cdr.detectChanges();
    this.ordersService.closePosition(p.marketId, p.side).subscribe({
      next: () => {
        // Position will disappear from the list once the exit fill is recorded.
        // We refresh positions after a short delay.
        setTimeout(() => {
          this.closing.delete(key);
          this.loadPositions();
        }, 1500);
      },
      error: () => {
        this.closing.delete(key);
        this.cdr.detectChanges();
      },
    });
  }

  isClosing(p: Position): boolean {
    return this.closing.has(`${p.marketId}:${p.side}`);
  }

  private refreshStatus(): void {
    this.ordersService.getStatus().subscribe({
      next: (s) => {
        this.status = s;
        this.cdr.detectChanges();
      },
      error: () => undefined,
    });
  }

  private connect(): void {
    this.sub?.unsubscribe();
    this.sub = this.ordersService
      .streamOrders()
      .pipe(retry({ delay: () => timer(2000) }))
      .subscribe({
        next: (ev: OrdersStreamEvent) => {
          this.connected = true;
          this.streamError = null;
          this.onEvent(ev);
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.connected = false;
          this.streamError = err.message ?? 'disconnected';
          this.cdr.detectChanges();
        },
      });
  }

  private onEvent(ev: OrdersStreamEvent): void {
    if (ev.type === 'keepalive') return;
    if (ev.type === 'order_executed' || ev.type === 'order_failed') {
      this.orders = [ev.data, ...this.orders].slice(0, 200);
      // Any fill (ENTRY or EXIT) changes position state — re-pull.
      this.loadPositions();
    } else if (ev.type === 'bankroll' && this.status) {
      this.status = { ...this.status, bankroll: ev.data };
    } else if (ev.type === 'killswitch' && this.status) {
      this.status = { ...this.status, killswitch: ev.data.active };
    }
  }

  pauseTrading(): void {
    this.ordersService.pause().subscribe(() => this.refreshStatus());
  }

  resumeTrading(): void {
    this.ordersService.resume().subscribe(() => this.refreshStatus());
  }

  statusClass(status: string): string {
    switch (status) {
      case 'filled':
        return 'text-green-400';
      case 'partially_filled':
        return 'text-yellow-400';
      case 'rejected':
      case 'failed':
        return 'text-red-400';
      default:
        return 'text-gray-400';
    }
  }

  sideClass(side: string): string {
    return side === 'YES' ? 'text-green-400' : 'text-red-400';
  }

  formatPrice(v: number | null | undefined): string {
    if (v == null) return '-';
    return '$' + Number(v).toFixed(4);
  }

  formatTime(ts: number | null | undefined): string {
    if (!ts) return '-';
    return new Date(ts).toLocaleTimeString();
  }

  formatMoney(v: number | null | undefined, digits = 2): string {
    if (v == null) return '-';
    return '$' + Number(v).toFixed(digits);
  }

  formatPercent(v: number | null | undefined): string {
    if (v == null) return '-';
    return (Number(v) * 100).toFixed(2) + '%';
  }

  bankrollAgo(): string {
    const ts = this.status?.bankroll?.fetchedAt;
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }
}
