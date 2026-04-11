import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto-js';
import { BINANCE_CONFIG, TRADING_CONFIG } from '../config/constants';
import { logInfo, logDebug, logWarn, logError } from '../utils/logger';

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

export class BinanceService {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private client: AxiosInstance;
  private serverTimeOffset = 0;
  private symbolInfoCache: Map<string, { pricePrecision: number; quantityPrecision: number }> = new Map();

  constructor(apiKey: string, apiSecret: string, testnet: boolean = false) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = testnet ? BINANCE_CONFIG.TESTNET_BASE_URL : BINANCE_CONFIG.MAINNET_BASE_URL;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
  }

  async syncServerTime(): Promise<void> {
    try {
      const response = await this.client.get('/fapi/v1/time');
      const serverTime = response.data.serverTime as number;
      this.serverTimeOffset = serverTime - Date.now();
      logDebug(`[Binance] Server time offset: ${this.serverTimeOffset}ms`);
    } catch (error) {
      logWarn('[Binance] Failed to sync server time');
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

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const signature = this.createSignature(allParams);
        const url = `${endpoint}?${Object.entries(allParams)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${v}`)
          .join('&')}&signature=${signature}`;

        const config =
          method === 'POST'
            ? { method: 'POST' as const, url }
            : method === 'DELETE'
              ? { method: 'DELETE' as const, url }
              : { method: 'GET' as const, url };

        const response = await this.client.request<T>(config);
        return response.data;
      } catch (error: any) {
        if (error.response?.data?.code === -1021) {
          logWarn('[Binance] Timestamp error, resyncing...');
          await this.syncServerTime();
          if (attempt < maxRetries - 1) continue;
        }
        const msg = error.response?.data
          ? JSON.stringify(error.response.data)
          : error.message;
        throw new Error(`Binance API error: ${msg}`);
      }
    }
    throw new Error('Binance API: max retries exceeded');
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const data = await this.makeSignedRequest<any>('/fapi/v2/account', 'GET');
    return {
      totalWalletBalance: data.totalWalletBalance,
      totalUnrealizedProfit: data.totalUnrealizedProfit,
      availableBalance: data.availableBalance,
    };
  }

  async getPositions(): Promise<PositionResponse[]> {
    const data = await this.makeSignedRequest<any[]>('/fapi/v2/positionRisk', 'GET');
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

    logInfo(`[Binance] Placing ${order.side} ${order.type} ${order.quantity} ${order.symbol}`);
    return this.makeSignedRequest<OrderResponse>('/fapi/v1/order', 'POST', params);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    logInfo(`[Binance] Setting leverage for ${symbol} to ${leverage}x`);
    await this.makeSignedRequest('/fapi/v1/leverage', 'POST', { symbol, leverage });
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    logInfo(`[Binance] Setting margin type for ${symbol} to ${marginType}`);
    try {
      await this.makeSignedRequest('/fapi/v1/marginType', 'POST', { symbol, marginType });
    } catch (error: any) {
      if (error.message?.includes('No need to change margin type')) {
        logDebug(`[Binance] Margin type already ${marginType} for ${symbol}`);
        return;
      }
      throw error;
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    logInfo(`[Binance] Cancelling all orders for ${symbol}`);
    await this.makeSignedRequest('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    await this.makeSignedRequest('/fapi/v1/order', 'DELETE', { symbol, orderId });
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const params: Record<string, unknown> = {};
    if (symbol) params.symbol = symbol;
    return this.makeSignedRequest<any[]>('/fapi/v1/openOrders', 'GET', params);
  }

  async getSymbolInfo(symbol: string): Promise<{ pricePrecision: number; quantityPrecision: number }> {
    if (this.symbolInfoCache.has(symbol)) {
      return this.symbolInfoCache.get(symbol)!;
    }
    const response = await this.client.get('/fapi/v1/exchangeInfo');
    const symInfo = response.data.symbols.find((s: any) => s.symbol === symbol);
    if (!symInfo) {
      throw new Error(`Symbol ${symbol} not found on Binance`);
    }
    const info = {
      pricePrecision: symInfo.pricePrecision as number,
      quantityPrecision: symInfo.quantityPrecision as number,
    };
    this.symbolInfoCache.set(symbol, info);
    return info;
  }

  async get24hrTicker(symbol: string): Promise<{ lastPrice: string; markPrice?: string }> {
    const response = await this.client.get('/fapi/v1/ticker/24hr', {
      params: { symbol },
    });
    return { lastPrice: response.data.lastPrice };
  }

  async getMarkPrice(symbol: string): Promise<string> {
    const response = await this.client.get('/fapi/v1/premiumMarks', {
      params: { symbol },
    });
    if (response.data && response.data.length > 0) {
      return response.data[0].markPrice;
    }
    const ticker = await this.get24hrTicker(symbol);
    return ticker.lastPrice;
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

  destroy(): void {
    // No-op: AxiosInstance does not require explicit close
  }
}