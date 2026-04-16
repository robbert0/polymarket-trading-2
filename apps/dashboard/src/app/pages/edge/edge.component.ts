import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, retry, timer } from 'rxjs';
import { EdgeService, EdgeComparison } from '../../services/edge.service';
import { formatDateTime } from '../../utils/format-time';

type SortKey =
  | 'label'
  | 'strike'
  | 'expiry'
  | 'deribitProbability'
  | 'polymarketProbability'
  | 'edge'
  | 'execEdge'
  | 'spread'
  | 'fillable'
  | 'fillScore'
  | 'advice'
  | 'underlyingPrice'
  | 'impliedVolatility';

type SortDir = 'asc' | 'desc';

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
  sortKey: SortKey = 'label';
  sortDir: SortDir = 'asc';
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
    this.resort();
  }

  private resort(): void {
    const dir = this.sortDir === 'asc' ? 1 : -1;
    const key = this.sortKey;
    this.sortedEdges = [...this.edges.values()].sort((a, b) => {
      const av = this.sortValue(a, key);
      const bv = this.sortValue(b, key);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls always last
      if (bv == null) return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * dir;
      }
      return ((av as number) - (bv as number)) * dir;
    });
  }

  private sortValue(
    e: EdgeComparison,
    key: SortKey,
  ): number | string | null | undefined {
    switch (key) {
      case 'label': return e.label;
      case 'strike': return e.strike;
      case 'expiry': return e.expiry;
      case 'deribitProbability': return e.deribitProbability;
      case 'polymarketProbability': return e.polymarketProbability;
      case 'edge': return e.edge;
      case 'execEdge': return e.orderbook?.executableEdge ?? null;
      case 'spread': return e.orderbook?.spread ?? null;
      case 'fillable': return e.orderbook?.fillableAmount ?? null;
      case 'fillScore': return e.orderbook?.fillScore ?? null;
      case 'advice': return e.advice;
      case 'underlyingPrice': return e.underlyingPrice;
      case 'impliedVolatility': return e.impliedVolatility;
    }
  }

  setSort(key: SortKey): void {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      // Numeric/score columns default to descending (biggest first), text to ascending
      this.sortDir = key === 'label' || key === 'expiry' || key === 'advice' ? 'asc' : 'desc';
    }
    this.resort();
  }

  sortArrow(key: SortKey): string {
    if (this.sortKey !== key) return '';
    return this.sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  formatPercent(val: number): string {
    return (val * 100).toFixed(2) + '%';
  }

  formatPrice(price: number): string {
    if (price >= 1000) return '$' + price.toFixed(0);
    return '$' + price.toFixed(2);
  }

  readonly formatTime = formatDateTime;

  adviceClass(advice: string): string {
    if (advice === 'BUY_YES') return 'text-green-400';
    if (advice === 'BUY_NO') return 'text-red-400';
    return 'text-gray-500';
  }

  formatSpread(edge: EdgeComparison): string {
    if (edge.orderbook?.spread == null) return '-';
    return (edge.orderbook.spread * 100).toFixed(1) + 'c';
  }

  formatExecEdge(edge: EdgeComparison): string {
    if (edge.orderbook?.executableEdge == null) return '-';
    const val = edge.orderbook.executableEdge;
    return (val > 0 ? '+' : '') + (val * 100).toFixed(2) + '%';
  }

  formatFillable(edge: EdgeComparison): string {
    if (!edge.orderbook?.fillableAmount) return '-';
    const amt = edge.orderbook.fillableAmount;
    if (amt >= 1000) return '$' + (amt / 1000).toFixed(1) + 'k';
    return '$' + amt.toFixed(0);
  }

  fillScoreClass(edge: EdgeComparison): string {
    const score = edge.orderbook?.fillScore ?? 0;
    if (score >= 70) return 'text-green-400';
    if (score >= 40) return 'text-yellow-400';
    if (score > 0) return 'text-orange-400';
    return 'text-gray-600';
  }

  execEdgeClass(edge: EdgeComparison): string {
    const val = edge.orderbook?.executableEdge;
    if (val == null) return 'text-gray-600';
    if (val > 0.05) return 'text-green-400';
    if (val > 0) return 'text-yellow-400';
    return 'text-red-400';
  }
}