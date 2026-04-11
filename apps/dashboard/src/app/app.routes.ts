import { Routes } from '@angular/router';

export const appRoutes: Routes = [
  { path: '', redirectTo: 'trades', pathMatch: 'full' },
  {
    path: 'trades',
    loadComponent: () =>
      import('./pages/trades/trades.component').then((m) => m.TradesComponent),
  },
  {
    path: 'crypto',
    loadComponent: () =>
      import('./pages/crypto-prices/crypto-prices.component').then(
        (m) => m.CryptoPricesComponent,
      ),
  },
  {
    path: 'orderbook',
    loadComponent: () =>
      import('./pages/orderbook/orderbook.component').then(
        (m) => m.OrderbookComponent,
      ),
  },
  {
    path: 'deribit',
    loadComponent: () =>
      import('./pages/deribit/deribit.component').then(
        (m) => m.DeribitComponent,
      ),
  },
  {
    path: 'correlations',
    loadComponent: () =>
      import('./pages/correlations/correlations.component').then(
        (m) => m.CorrelationsComponent,
      ),
  },
  {
    path: 'edge',
    loadComponent: () =>
      import('./pages/edge/edge.component').then(
        (m) => m.EdgeComponent,
      ),
  },
];
