import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto-js';
import { BINANCE_CONFIG } from '../config/constants';
import { logInfo, logDebug, logWarn, logError } from '../utils/logger';
import { sleep } from '../utils/sleep';

export interface BinanceOrder {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide?: 'LONG' | 'SHORT' | 'BOTH';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET';
  quantity: string;
  price?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
  newClientOrderId?: string;
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
}

export interface OrderResponse {
  orderId: number;
  symbol: string;
  status: string;
  side: string;
  type: string;
  origQty: string;
  price: string;
  avgPrice?: string;
  executedQty: string;
  transactTime: number;
}

export interface PositionResponse {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  unrealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin?: string;
  positionSide: string;
}

export interface AccountInfo {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  availableBalance: string;
}

export interface BinanceAccountRaw {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  availableBalance: string;
}

export interface BinancePositionRaw {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  unrealizedProfit: string;
  liquidationPrice: string | null;
  leverage: string;
  marginType: string;
  positionSide: string;
}

export interface BinanceOpenOrderRaw {
  orderId: number;
  symbol: string;
  type: string;
  side: string;
  price: string;
  origQty: string;
  status: string;
}

export interface SymbolFilters {
  minQty: string;
  maxQty: string;
  stepSize: string;
  minNotional: string;
}

export class BinanceService {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private client: AxiosInstance;
  private serverTimeOffset = 0;
  private symbolInfoCache: Map<string, { pricePrecision: number; quantityPrecision: number; filters: SymbolFilters }> = new Map();

  constructor(apiKey: string, apiSecret: string, testnet: boolean = false) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = testnet ? BINANCE_CONFIG.TESTNET_BASE_URL : BINANCE_CONFIG.MAINNET_BASE_URL;
    logInfo(`[Binance] Initializing with baseUrl=${this.baseUrl} (testnet=${testnet})`);
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
  }

  async syncServerTime(): Promise<void> {
    try {
      logDebug('[Binance] GET /fapi/v1/time...');
      const response = await this.client.get('/fapi/v1/time');
      const serverTime = response.data.serverTime as number;
      this.serverTimeOffset = serverTime - Date.now();
      logInfo(`[Binance] Server time synced, offset=${this.serverTimeOffset}ms`);
    } catch (error: any) {
      logError(`[Binance] syncServerTime FAILED: ${error.message}`);
      throw error;
    }
  }

  private getAdjustedTimestamp(): number {
    return Date.now() + this.serverTimeOffset;
  }

  private createSignature(params: Record<string, unknown>): string {
    const queryString = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return crypto.HmacSHA256(queryString, this.apiSecret).toString(crypto.enc.Hex);
  }

  private async makeSignedRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE',
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const timestamp = this.getAdjustedTimestamp();
    const allParams = { ...params, timestamp };

    const maxAttempts = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const signature = this.createSignature(allParams);
        const url = `${endpoint}?${Object.entries(allParams)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${v}`)
          .join('&')}&signature=${signature}`;

        logDebug(`[Binance] ${method} ${url.substring(0, endpoint.length + 80)}... (attempt ${attempt + 1})`);

        const config =
          method === 'POST'
            ? { method: 'POST' as const, url }
            : method === 'DELETE'
              ? { method: 'DELETE' as const, url }
              : { method: 'GET' as const, url };

        const response = await this.client.request<T>(config);
        logDebug(`[Binance] ${method} ${endpoint} OK`);
        return response.data;
      } catch (error: any) {
        const status = error.response?.status;
        const data = error.response?.data ? JSON.stringify(error.response.data) : '';
        const msg = data || error.message;
        const errorCode = error.response?.data?.code;

        if (errorCode === -1021 && attempt < maxAttempts - 1) {
          logWarn(`[Binance] Timestamp error on ${endpoint}, resyncing... (attempt ${attempt + 1})`);
          await this.syncServerTime();
          lastError = new Error(msg);
          continue;
        }

        if (status === 429 && attempt < maxAttempts - 1) {
          const retryAfter = parseInt(error.response?.headers?.['retry-after'] || '2', 10);
          logWarn(`[Binance] Rate limited on ${endpoint}, retrying after ${retryAfter}s...`);
          await sleep(retryAfter * 1000);
          lastError = new Error(msg);
          continue;
        }

        if (status && status >= 500 && attempt < maxAttempts - 1) {
          const delay = 1000 * Math.pow(2, attempt);
          logWarn(`[Binance] Server error ${status} on ${endpoint}, retrying in ${delay}ms...`);
          await sleep(delay);
          lastError = new Error(msg);
          continue;
        }

        if (errorCode === -4046) {
          logDebug(`[Binance] ${method} ${endpoint} skipped (already set): ${msg}`);
          throw new Error(`Binance API skipped: ${msg}`);
        }

        logError(`[Binance] ${method} ${endpoint} FAILED: status=${status} msg=${msg}`);
        throw new Error(`Binance API error: ${msg}`);
      }
    }
    throw lastError ?? new Error('Binance API: max retries exceeded');
  }

  async getAccountInfo(): Promise<AccountInfo> {
    logDebug('[Binance] getAccountInfo...');
    const data = await this.makeSignedRequest<BinanceAccountRaw>('/fapi/v2/account', 'GET');
    logInfo(`[Binance] getAccountInfo OK: balance=${data.availableBalance} USDT`);
    return {
      totalWalletBalance: data.totalWalletBalance,
      totalUnrealizedProfit: data.totalUnrealizedProfit,
      availableBalance: data.availableBalance,
    };
  }

  async getPositions(): Promise<PositionResponse[]> {
    logDebug('[Binance] getPositions...');
    const data = await this.makeSignedRequest<BinancePositionRaw[]>('/fapi/v2/positionRisk', 'GET');
    return data.filter((p) => parseFloat(p.positionAmt) !== 0).map((p) => ({
      symbol: p.symbol,
      positionAmt: p.positionAmt,
      entryPrice: p.entryPrice,
      unrealizedProfit: p.unrealizedProfit,
      liquidationPrice: p.liquidationPrice ?? '0',
      leverage: p.leverage,
      marginType: p.marginType,
      positionSide: p.positionSide,
    }));
  }

  async placeOrder(order: BinanceOrder): Promise<OrderResponse> {
    const params: Record<string, unknown> = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
    };
    if (order.positionSide) params.positionSide = order.positionSide;
    if (order.price) params.price = order.price;
    if (order.stopPrice) params.stopPrice = order.stopPrice;
    if (order.reduceOnly) params.reduceOnly = true;
    if (order.closePosition) params.closePosition = true;
    if (order.timeInForce) params.timeInForce = order.timeInForce;
    if (order.newClientOrderId) params.newClientOrderId = order.newClientOrderId;
    if (order.workingType) params.workingType = order.workingType;

    logInfo(`[Binance] placeOrder: ${order.side} ${order.type} ${order.quantity} ${order.symbol}`);
    return this.makeSignedRequest<OrderResponse>('/fapi/v1/order', 'POST', params);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    logInfo(`[Binance] setLeverage(${symbol}, ${leverage}x)`);
    try {
      await this.makeSignedRequest('/fapi/v1/leverage', 'POST', { symbol, leverage });
      logInfo(`[Binance] setLeverage OK: ${symbol} ${leverage}x`);
    } catch (error: any) {
      logError(`[Binance] setLeverage FAILED: ${symbol} ${leverage}x - ${error.message}`);
      throw error;
    }
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    logInfo(`[Binance] setMarginType(${symbol}, ${marginType})`);
    try {
      await this.makeSignedRequest('/fapi/v1/marginType', 'POST', { symbol, marginType });
      logInfo(`[Binance] setMarginType OK: ${symbol} ${marginType}`);
    } catch (error: any) {
      if (error.message?.includes('No need to change margin type')) {
        logDebug(`[Binance] Margin type already ${marginType} for ${symbol}`);
        return;
      }
      logError(`[Binance] setMarginType FAILED: ${symbol} ${marginType} - ${error.message}`);
      throw error;
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    logInfo(`[Binance] cancelAllOrders(${symbol})`);
    await this.makeSignedRequest('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    logDebug(`[Binance] cancelOrder(${symbol}, ${orderId})`);
    await this.makeSignedRequest('/fapi/v1/order', 'DELETE', { symbol, orderId });
  }

  async getOpenOrders(symbol?: string): Promise<BinanceOpenOrderRaw[]> {
    const params: Record<string, unknown> = {};
    if (symbol) params.symbol = symbol;
    logDebug(`[Binance] getOpenOrders(${symbol ?? 'all'})`);
    return this.makeSignedRequest<BinanceOpenOrderRaw[]>('/fapi/v1/openOrders', 'GET', params);
  }

  async prefetchExchangeInfo(): Promise<void> {
    logInfo('[Binance] Prefetching exchange info...');
    try {
      const response = await this.client.get('/fapi/v1/exchangeInfo');
      const symbols = (response.data.symbols || []) as Array<Record<string, unknown>>;
      let cached = 0;
      for (const s of symbols) {
        if (s.status !== 'TRADING') continue;
        const filters = this.extractSymbolFilters(s);
        const info = {
          pricePrecision: s.pricePrecision as number,
          quantityPrecision: s.quantityPrecision as number,
          filters,
        };
        this.symbolInfoCache.set(s.symbol as string, info);
        cached++;
      }
      logInfo(`[Binance] Prefetched ${cached} symbols from exchange info`);
    } catch (error: any) {
      logWarn(`[Binance] prefetchExchangeInfo FAILED: ${error.message}. Will fetch per-symbol on demand.`);
    }
  }

  private extractSymbolFilters(symInfo: Record<string, unknown>): SymbolFilters {
    let minQty = '0.001';
    let maxQty = '1000000';
    let stepSize = '0.001';
    let minNotional = '5';
    for (const f of (symInfo.filters || []) as Array<Record<string, unknown>>) {
      if (f.filterType === 'LOT_SIZE') {
        minQty = (f.minQty as string) ?? minQty;
        maxQty = (f.maxQty as string) ?? maxQty;
        stepSize = (f.stepSize as string) ?? stepSize;
      } else if (f.filterType === 'MIN_NOTIONAL') {
        minNotional = ((f.notional ?? f.minNotional) as string) ?? '5';
      } else if (f.filterType === 'MARKET_LOT_SIZE') {
        minQty = (f.minQty as string) ?? minQty;
        maxQty = (f.maxQty as string) ?? maxQty;
        stepSize = (f.stepSize as string) ?? stepSize;
      }
    }
    return { minQty, maxQty, stepSize, minNotional };
  }

  async getSymbolInfo(symbol: string): Promise<{ pricePrecision: number; quantityPrecision: number; filters: SymbolFilters }> {
    if (this.symbolInfoCache.has(symbol)) {
      const info = this.symbolInfoCache.get(symbol)!;
      return { pricePrecision: info.pricePrecision, quantityPrecision: info.quantityPrecision, filters: info.filters };
    }
    logDebug(`[Binance] getSymbolInfo(${symbol}) cache miss, fetching exchangeInfo...`);
    try {
      const response = await this.client.get('/fapi/v1/exchangeInfo');
      const symInfo = (response.data.symbols as Array<Record<string, unknown>>).find((s) => s.symbol === symbol);
      if (!symInfo) {
        logError(`[Binance] getSymbolInfo FAILED: Symbol ${symbol} not found in exchangeInfo`);
        throw new Error(`Symbol ${symbol} not found on Binance`);
      }
      const filters = this.extractSymbolFilters(symInfo);
      const info = {
        pricePrecision: symInfo.pricePrecision as number,
        quantityPrecision: symInfo.quantityPrecision as number,
        filters,
      };
      this.symbolInfoCache.set(symbol, info);
      logInfo(`[Binance] getSymbolInfo OK: ${symbol} pricePrecision=${info.pricePrecision} qtyPrecision=${info.quantityPrecision} minQty=${filters.minQty} minNotional=${filters.minNotional}`);
      return info;
    } catch (error: any) {
      logError(`[Binance] getSymbolInfo FAILED: ${symbol} - ${error.message}`);
      throw error;
    }
  }

  async get24hrTicker(symbol: string): Promise<{ lastPrice: string; markPrice?: string }> {
    logDebug(`[Binance] get24hrTicker(${symbol})`);
    try {
      const response = await this.client.get('/fapi/v1/ticker/24hr', {
        params: { symbol },
      });
      return { lastPrice: response.data.lastPrice };
    } catch (error: any) {
      logError(`[Binance] get24hrTicker FAILED: ${symbol} - ${error.message}`);
      throw error;
    }
  }

  async getMarkPrice(symbol: string): Promise<string> {
    logDebug(`[Binance] getMarkPrice(${symbol})...`);
    // Try /fapi/v1/premiumIndex first (correct Binance endpoint)
    try {
      const response = await this.client.get('/fapi/v1/premiumIndex', {
        params: { symbol },
      });
      if (response.data && response.data.markPrice) {
        logDebug(`[Binance] getMarkPrice OK via premiumIndex: ${symbol}=${response.data.markPrice}`);
        return response.data.markPrice;
      }
      // premiumIndex returned data but no markPrice field, try array format
      if (Array.isArray(response.data) && response.data.length > 0 && response.data[0].markPrice) {
        logDebug(`[Binance] getMarkPrice OK via premiumIndex (array): ${symbol}=${response.data[0].markPrice}`);
        return response.data[0].markPrice;
      }
    } catch (error: any) {
      logWarn(`[Binance] getMarkPrice: premiumIndex failed for ${symbol}: ${error.message}, falling back to 24hrTicker`);
    }
    // Fallback to 24hr ticker
    try {
      const ticker = await this.get24hrTicker(symbol);
      logDebug(`[Binance] getMarkPrice fallback OK via 24hrTicker: ${symbol}=${ticker.lastPrice}`);
      return ticker.lastPrice;
    } catch (error: any) {
      logError(`[Binance] getMarkPrice FAILED completely for ${symbol}: premiumIndex and 24hrTicker both failed`);
      throw error;
    }
  }

  formatQuantity(quantity: number, symbol: string): string {
    const info = this.symbolInfoCache.get(symbol);
    const precision = info?.quantityPrecision ?? 3;
    return quantity.toFixed(precision);
  }

  formatPrice(price: number, symbol: string): string {
    const info = this.symbolInfoCache.get(symbol);
    const precision = info?.pricePrecision ?? 2;
    return price.toFixed(precision);
  }

  getSymbolFilters(symbol: string): SymbolFilters | null {
    const info = this.symbolInfoCache.get(symbol);
    return info?.filters ?? null;
  }

  destroy(): void {
    // No-op: AxiosInstance does not require explicit close
  }
}