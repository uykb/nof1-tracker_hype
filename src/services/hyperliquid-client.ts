import axios, { AxiosInstance } from 'axios';
import { HlClearinghouseState, HlFill } from '../types';
import { HYPERLIQUID_CONFIG } from '../config/constants';
import { ApiError } from '../utils/errors';
import { logInfo, logDebug, logError, logWarn } from '../utils/logger';
import { retryWithBackoff } from '../utils/errors';

export class HyperliquidClient {
  private client: AxiosInstance;

  constructor(private apiUrl: string = HYPERLIQUID_CONFIG.MAINNET_API_URL) {
    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async getClearinghouseState(address: string): Promise<HlClearinghouseState> {
    return retryWithBackoff(async () => {
      try {
        logDebug(`[HL] Fetching clearinghouse state for ${address}`);
        const response = await this.client.post('/info', {
          type: 'clearinghouseState',
          user: address,
        });
        return response.data as HlClearinghouseState;
      } catch (error: any) {
        if (error.response) {
          throw new ApiError(
            `Hyperliquid API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
            error.response.status,
            error.response.data,
          );
        }
        throw new ApiError(`Hyperliquid request failed: ${error.message}`);
      }
    }, 3);
  }

  async getUserFills(address: string): Promise<HlFill[]> {
    return retryWithBackoff(async () => {
      try {
        logDebug(`[HL] Fetching fills for ${address}`);
        const response = await this.client.post('/info', {
          type: 'userFills',
          user: address,
        });
        return response.data as HlFill[];
      } catch (error: any) {
        if (error.response) {
          throw new ApiError(
            `Hyperliquid API error: ${error.response.status}`,
            error.response.status,
            error.response.data,
          );
        }
        throw new ApiError(`Hyperliquid request failed: ${error.message}`);
      }
    }, 3);
  }

  async getUserFillsByTime(
    address: string,
    startTime: number,
    endTime?: number,
  ): Promise<HlFill[]> {
    return retryWithBackoff(async () => {
      try {
        const body: Record<string, unknown> = {
          type: 'userFillsByTime',
          user: address,
          startTime,
        };
        if (endTime) body.endTime = endTime;
        const response = await this.client.post('/info', body);
        return response.data as HlFill[];
      } catch (error: any) {
        if (error.response) {
          throw new ApiError(
            `Hyperliquid API error: ${error.response.status}`,
            error.response.status,
          );
        }
        throw new ApiError(`Hyperliquid request failed: ${error.message}`);
      }
    }, 3);
  }

  async getOpenOrders(address: string): Promise<unknown[]> {
    return retryWithBackoff(async () => {
      try {
        const response = await this.client.post('/info', {
          type: 'openOrders',
          user: address,
        });
        return response.data;
      } catch (error: any) {
        throw new ApiError(`Hyperliquid request failed: ${error.message}`);
      }
    }, 2);
  }

  async getMeta(): Promise<{ universe: Array<{ name: string; szDecimals: number }> }> {
    try {
      const response = await this.client.post('/info', { type: 'meta' });
      return response.data;
    } catch (error: any) {
      throw new ApiError(`Hyperliquid meta request failed: ${error.message}`);
    }
  }
}