import fs from 'fs-extra';
import path from 'path';
import { ProcessedOrder, MirroredTradeRecord } from '../types';
import { DATA_CONFIG } from '../config/constants';
import { logInfo, logDebug, logWarn } from '../utils/logger';

export interface OrderHistoryData {
  processedOrders: ProcessedOrder[];
  mirroredTrades: MirroredTradeRecord[];
  lastUpdated: number;
  createdAt?: number;
}

export class OrderHistoryManager {
  private data: OrderHistoryData;
  private filePath: string;

  constructor(dataDir: string = DATA_CONFIG.DATA_DIR) {
    this.filePath = path.join(dataDir, DATA_CONFIG.ORDER_HISTORY_FILE);
    this.data = {
      processedOrders: [],
      mirroredTrades: [],
      lastUpdated: Date.now(),
      createdAt: Date.now(),
    };
  }

  async load(): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(this.filePath));
      if (await fs.pathExists(this.filePath)) {
        const raw = await fs.readJson(this.filePath);
        this.data = {
          processedOrders: raw.processedOrders || [],
          mirroredTrades: raw.mirroredTrades || [],
          lastUpdated: raw.lastUpdated || Date.now(),
          createdAt: raw.createdAt || Date.now(),
        };
        logInfo(`[History] Loaded ${this.data.processedOrders.length} orders, ${this.data.mirroredTrades.length} trades`);
      }
    } catch (error) {
      logWarn(`[History] Failed to load, starting fresh: ${(error as Error).message}`);
      this.data = {
        processedOrders: [],
        mirroredTrades: [],
        lastUpdated: Date.now(),
        createdAt: Date.now(),
      };
    }
  }

  async save(): Promise<void> {
    this.data.lastUpdated = Date.now();
    await fs.ensureDir(path.dirname(this.filePath));
    const tmpPath = this.filePath + '.tmp';
    await fs.writeJson(tmpPath, this.data, { spaces: 2 });
    await fs.rename(tmpPath, this.filePath);
  }

  isOrderProcessed(symbol: string, side: string, hlFillTime: number): boolean {
    return this.data.processedOrders.some(
      (o) => o.symbol === symbol && o.side === side && o.hlFillTime === hlFillTime,
    );
  }

  addProcessedOrder(order: ProcessedOrder): void {
    if (!this.isOrderProcessed(order.symbol, order.side, order.hlFillTime ?? 0)) {
      this.data.processedOrders.push(order);
    }
  }

  addMirroredTrade(record: MirroredTradeRecord): void {
    this.data.mirroredTrades.push(record);
  }

  cleanupOldOrders(daysToKeep: number = 30): void {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    this.data.processedOrders = this.data.processedOrders.filter((o) => o.timestamp > cutoff);
    this.data.mirroredTrades = this.data.mirroredTrades.filter((o) => o.timestamp > cutoff);
  }

  getProcessedOrders(): ProcessedOrder[] {
    return [...this.data.processedOrders];
  }

  getMirroredTrades(): MirroredTradeRecord[] {
    return [...this.data.mirroredTrades];
  }

  getStats(): { totalOrders: number; totalTrades: number; oldestOrder: number | null } {
    return {
      totalOrders: this.data.processedOrders.length,
      totalTrades: this.data.mirroredTrades.length,
      oldestOrder: this.data.processedOrders.length > 0
        ? Math.min(...this.data.processedOrders.map((o) => o.timestamp))
        : null,
    };
  }

  getCumulativeStats(): { totalPnl: number; totalCommission: number; winCount: number; lossCount: number; totalOrders: number } {
    const orders = this.data.processedOrders;
    let totalPnl = 0;
    let totalCommission = 0;
    let winCount = 0;
    let lossCount = 0;
    for (const o of orders) {
      if (o.pnl !== undefined) {
        totalPnl += o.pnl;
        if (o.pnl > 0) winCount++;
        else if (o.pnl < 0) lossCount++;
      }
      if (o.commission !== undefined) totalCommission += o.commission;
    }
    return { totalPnl, totalCommission, winCount, lossCount, totalOrders: orders.length };
  }

  printStats(): void {
    const stats = this.getStats();
    logInfo(`[History] Orders: ${stats.totalOrders}, Trades: ${stats.totalTrades}`);
  }
}