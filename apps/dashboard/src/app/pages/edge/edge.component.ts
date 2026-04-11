import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, retry, timer } from 'rxjs';
import { EdgeService, EdgeComparison } from '../../services/edge.service';

@Component({
  selector: 'app-edge',
  imports: [CommonModule],
  templateUrl: './edge.component.html',
})
export class EdgeComponent implements OnInit, OnDestroy {
  edges = new Map<string, EdgeComparison>();
  sortedEdges: EdgeComparison[] = [];
  connected = false;
  updateCount = 0;
  lastScan = 0;
  private sub?: Subscription;

  constructor(
    private edgeService: EdgeService,
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
    this.sub = this.edgeService
      .streamEdge()
      .pipe(retry({ delay: () => timer(2000) }))
      .subscribe({
        next: (data) => {
          this.connected = true;
          this.updateCount++;
          this.lastScan = data.timestamp;
          this.updateEdge(data);
          this.cdr.detectChanges();
        },
        error: () => {
          this.connected = false;
          this.cdr.detectChanges();
        },
      });
  }

  private updateEdge(data: EdgeComparison): void {
    this.edges.set(data.marketId, data);
    this.sortedEdges = [...this.edges.values()].sort(
      (a, b) => a.label.localeCompare(b.label),
    );
  }

  formatPercent(val: number): string {
    return (val * 100).toFixed(1) + '%';
  }

  formatPrice(price: number): string {
    if (price >= 1000) return '$' + price.toFixed(0);
    return '$' + price.toFixed(2);
  }

  formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  adviceClass(advice: string): string {
    if (advice === 'BUY_YES') return 'text-green-400';
    if (advice === 'BUY_NO') return 'text-red-400';
    return 'text-gray-500';
  }
}