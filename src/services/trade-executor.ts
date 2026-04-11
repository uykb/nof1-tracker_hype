import { BinanceService } from './binance-service';
import { PositionDelta, TradeSignal, ExecutionResult, StopOrderResult } from '../types';
import { TRADING_CONFIG } from '../config/constants';
import { logInfo, logDebug, logWarn, logError } from '../utils/logger';

export class TradeExecutor {
  private initializedSymbols: Set<string> = new Set();

  constructor(private binance: BinanceService) {}

  async executeSignal(signal: TradeSignal, dryRun: boolean = false): Promise<ExecutionResult> {
    const { symbol, side, quantity, leverage, marginType, reason } = signal;

    if (dryRun) {
      logInfo(`[Executor] [DRY RUN] Would execute: ${side} ${quantity} ${symbol} @ market (${leverage}x ${marginType}) - ${reason}`);
      return { success: true, symbol, side, quantity, reason: 'dry_run' };
    }

    try {
      await this.ensureSymbolConfig(symbol, leverage, marginType);

      const currentPrice = await this.binance.getMarkPrice(signal.symbol);
      const priceDiff = Math.abs(parseFloat(currentPrice) - (signal.sourceDelta.current?.entryPrice ?? parseFloat(currentPrice)));
      const priceDiffPct = priceDiff / parseFloat(currentPrice) * 100;

      if (signal.priceTolerance && !signal.priceTolerance.shouldExecute) {
        logWarn(`[Executor] Price tolerance check failed for ${symbol}: ${priceDiffPct.toFixed(2)}% > ${signal.priceTolerance.tolerance}%`);
        return { success: false, symbol, side, quantity, error: 'price_tolerance_exceeded' };
      }

      logInfo(`[Executor] Executing: ${side} ${quantity} ${symbol} @ market (${leverage}x ${marginType}) - ${reason}`);

      const formattedQty = this.binance.formatQuantity(quantity, symbol);
      const order = await this.binance.placeOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity: formattedQty,
      });

      logInfo(`[Executor] Order placed: ${order.orderId} status=${order.status}`);

      return {
        success: true,
        orderId: String(order.orderId),
        symbol,
        side,
        quantity,
        price: order.avgPrice ? parseFloat(order.avgPrice) : undefined,
      };
    } catch (error: any) {
      logError(`[Executor] Failed to execute ${side} ${quantity} ${symbol}: ${error.message}`);
      return { success: false, symbol, side, quantity, error: error.message };
    }
  }

  async closePosition(symbol: string, dryRun: boolean = false): Promise<ExecutionResult> {
    try {
      const positions = await this.binance.getPositions();
      const pos = positions.find((p) => p.symbol === symbol);

      if (!pos || parseFloat(pos.positionAmt) === 0) {
        logWarn(`[Executor] No position to close for ${symbol}`);
        return { success: true, symbol, side: 'BUY', quantity: 0, reason: 'no_position' };
      }

      const side = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';
      const quantity = Math.abs(parseFloat(pos.positionAmt));
      const formattedQty = this.binance.formatQuantity(quantity, symbol);

      if (dryRun) {
        logInfo(`[Executor] [DRY RUN] Would close: ${side} ${formattedQty} ${symbol}`);
        return { success: true, symbol, side, quantity, reason: 'dry_run' };
      }

      await this.binance.cancelAllOrders(symbol);

      logInfo(`[Executor] Closing position: ${side} ${formattedQty} ${symbol}`);
      const order = await this.binance.placeOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity: formattedQty,
      });

      return {
        success: true,
        orderId: String(order.orderId),
        symbol,
        side,
        quantity,
      };
    } catch (error: any) {
      logError(`[Executor] Failed to close ${symbol}: ${error.message}`);
      return { success: false, symbol, side: 'BUY', quantity: 0, error: error.message };
    }
  }

  async placeStopOrders(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    takeProfitPrice?: number,
    stopLossPrice?: number,
  ): Promise<StopOrderResult> {
    const result: StopOrderResult = { errors: [] };
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    const formattedQty = this.binance.formatQuantity(quantity, symbol);

    try {
      if (takeProfitPrice) {
        const tpPrice = this.binance.formatPrice(takeProfitPrice, symbol);
        logInfo(`[Executor] Placing take-profit ${closeSide} ${formattedQty} ${symbol} @ ${tpPrice}`);
        const tpOrder = await this.binance.placeOrder({
          symbol,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          quantity: formattedQty,
          stopPrice: tpPrice,
          closePosition: false,
          workingType: 'MARK_PRICE',
        });
        result.takeProfitOrderId = String(tpOrder.orderId);
      }
    } catch (error: any) {
      result.errors.push(`TP order failed: ${error.message}`);
      logWarn(`[Executor] ${result.errors[result.errors.length - 1]}`);
    }

    try {
      if (stopLossPrice) {
        const slPrice = this.binance.formatPrice(stopLossPrice, symbol);
        logInfo(`[Executor] Placing stop-loss ${closeSide} ${formattedQty} ${symbol} @ ${slPrice}`);
        const slOrder = await this.binance.placeOrder({
          symbol,
          side: closeSide,
          type: 'STOP_MARKET',
          quantity: formattedQty,
          stopPrice: slPrice,
          closePosition: false,
          workingType: 'MARK_PRICE',
        });
        result.stopLossOrderId = String(slOrder.orderId);
      }
    } catch (error: any) {
      result.errors.push(`SL order failed: ${error.message}`);
      logWarn(`[Executor] ${result.errors[result.errors.length - 1]}`);
    }

    return result;
  }

  async cleanOrphanedOrders(): Promise<number> {
    try {
      const openOrders = await this.binance.getOpenOrders();
      if (openOrders.length === 0) return 0;

      const positions = await this.binance.getPositions();
      const activeSymbols = new Set(positions.map((p) => p.symbol));

      const orphanedOrders = openOrders.filter((o) => {
        const isStopType = ['TAKE_PROFIT_MARKET', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP'].includes(o.type);
        return isStopType && !activeSymbols.has(o.symbol);
      });

      for (const order of orphanedOrders) {
        try {
          await this.binance.cancelOrder(order.symbol, order.orderId);
          logInfo(`[Executor] Cancelled orphaned order ${order.orderId} on ${order.symbol}`);
        } catch (e) {
          logWarn(`[Executor] Failed to cancel order ${order.orderId}: ${(e as Error).message}`);
        }
      }

      return orphanedOrders.length;
    } catch (error: any) {
      logError(`[Executor] Failed to clean orphaned orders: ${error.message}`);
      return 0;
    }
  }

  private async ensureSymbolConfig(
    symbol: string,
    leverage: number,
    marginType: 'ISOLATED' | 'CROSSED',
  ): Promise<void> {
    const key = `${symbol}-${leverage}-${marginType}`;
    if (this.initializedSymbols.has(key)) return;

    try {
      await this.binance.setMarginType(symbol, marginType);
    } catch (e: any) {
      if (!e.message?.includes('No need to change margin type')) {
        logWarn(`[Executor] Margin type warning for ${symbol}: ${e.message}`);
      }
    }

    try {
      await this.binance.setLeverage(symbol, leverage);
    } catch (e: any) {
      logWarn(`[Executor] Leverage warning for ${symbol}: ${e.message}`);
    }

    try {
      await this.binance.getSymbolInfo(symbol);
    } catch (e: any) {
      logWarn(`[Executor] Failed to cache symbol info for ${symbol}: ${e.message}`);
    }

    this.initializedSymbols.add(key);
    logDebug(`[Executor] Symbol configured: ${symbol} ${leverage}x ${marginType}`);
  }
}