import { Injectable } from '@angular/core';

export interface MarketInfo {
  slug: string;
  question: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  icon: string;
  endDate: string;
}

@Injectable({ providedIn: 'root' })
export class MarketService {
  private readonly baseUrl = '/api';

  async searchMarkets(query: string): Promise<MarketInfo[]> {
    const res = await fetch(`${this.baseUrl}/markets/search/${encodeURIComponent(query)}`);
    return res.json();
  }

  async getMarketBySlug(slug: string): Promise<MarketInfo | null> {
    const res = await fetch(`${this.baseUrl}/markets/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data[0] || null : data;
  }
}
