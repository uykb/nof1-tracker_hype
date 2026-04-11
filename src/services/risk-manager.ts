import { PositionDelta, TradeSignal, MirrorPosition, PriceToleranceCheck } from '../types';
import { logInfo, logWarn } from '../utils/logger';

export class RiskManager {
  private priceTolerancePercent: number;

  constructor(priceTolerancePercent: number = 1.0) {
    this.priceTolerancePercent = priceTolerancePercent;
  }

  checkPriceTolerance(entryPrice: number, currentPrice: number, symbol?: string): PriceToleranceCheck {
    const priceDifference = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
    return {
      entryPrice,
      currentPrice,
      priceDifference,
      tolerance: this.priceTolerancePercent,
      shouldExecute: priceDifference <= this.priceTolerancePercent,
    };
  }

  buildSignalFromDelta(delta: PositionDelta, ratio: number): TradeSignal | null {
    const { type, symbol, previous, current } = delta;

    switch (type) {
      case 'NEW': {
        if (!current) return null;
        const side = current.side === 'LONG' ? 'BUY' : 'SELL';
        return {
          action: 'ENTER',
          symbol: current.symbol,
          side,
          quantity: current.size * ratio,
          leverage: current.leverage,
          marginType: current.marginType,
          reason: `New ${current.side} position on HL: ${current.size} @ ~${current.entryPrice}`,
          sourceDelta: delta,
          ratio,
        };
      }

      case 'CLOSED': {
        if (!previous) return null;
        const side = previous.side === 'LONG' ? 'SELL' : 'BUY';
        return {
          action: 'EXIT',
          symbol: previous.symbol,
          side,
          quantity: previous.size * ratio,
          leverage: previous.leverage,
          marginType: previous.marginType,
          reason: `Closed ${previous.side} position on HL`,
          sourceDelta: delta,
          ratio,
        };
      }

      case 'SIDE_FLIPPED': {
        if (!current) return null;
        const enterSide = current.side === 'LONG' ? 'BUY' : 'SELL';
        return {
          action: 'MODIFY',
          symbol: current.symbol,
          side: enterSide,
          quantity: current.size * ratio,
          leverage: current.leverage,
          marginType: current.marginType,
          reason: `Flipped from ${previous?.side} to ${current.side} on HL`,
          sourceDelta: delta,
          ratio,
        };
      }

      case 'INCREASED': {
        if (!current || !previous) return null;
        const diff = current.size - previous.size;
        const side = current.side === 'LONG' ? 'BUY' : 'SELL';
        return {
          action: 'ENTER',
          symbol: current.symbol,
          side,
          quantity: diff * ratio,
          leverage: current.leverage,
          marginType: current.marginType,
          reason: `Increased ${current.side} position by ${diff.toFixed(4)} on HL`,
          sourceDelta: delta,
          ratio,
        };
      }

      case 'DECREASED': {
        if (!current || !previous) return null;
        const diff = previous.size - current.size;
        const side = previous.side === 'LONG' ? 'SELL' : 'BUY';
        return {
          action: 'EXIT',
          symbol: current.symbol,
          side,
          quantity: diff * ratio,
          leverage: current.leverage,
          marginType: current.marginType,
          reason: `Decreased ${previous.side} position by ${diff.toFixed(4)} on HL`,
          sourceDelta: delta,
          ratio,
        };
      }

      case 'LEVERAGE_CHANGED': {
        if (!current) return null;
        logInfo(`[Risk] Leverage/margin change for ${symbol}: ${previous?.leverage}x ${previous?.marginType} -> ${current.leverage}x ${current.marginType}`);
        return {
          action: 'MODIFY',
          symbol: current.symbol,
          side: current.side === 'LONG' ? 'BUY' : 'SELL',
          quantity: 0,
          leverage: current.leverage,
          marginType: current.marginType,
          reason: `Leverage changed to ${current.leverage}x ${current.marginType} on HL`,
          sourceDelta: delta,
          ratio,
        };
      }

      default:
        return null;
    }
  }

  setPriceTolerance(tolerance: number): void {
    this.priceTolerancePercent = tolerance;
  }
}