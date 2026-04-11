import { MirrorPosition, CapitalAllocation } from '../types';
import { logInfo, logDebug } from '../utils/logger';

export class CapitalManager {
  private defaultTotalMarginUsdt: number;

  constructor(defaultTotalMargin: number = 100) {
    this.defaultTotalMarginUsdt = defaultTotalMargin;
  }

  allocateForSinglePosition(
    position: MirrorPosition,
    totalMarginUsdt?: number,
    availableBalance?: number,
  ): CapitalAllocation {
    const totalMargin = totalMarginUsdt ?? this.defaultTotalMarginUsdt;

    let allocatedMargin = totalMargin;
    if (availableBalance !== undefined && allocatedMargin > availableBalance * 0.95) {
      allocatedMargin = availableBalance * 0.95;
      logInfo(`[Capital] Reducing allocation: ${allocatedMargin.toFixed(2)} USDT (balance limited)`);
    }

    const notionalValue = allocatedMargin * position.leverage;
    const adjustedQuantity = this.truncateQuantity(notionalValue / position.entryPrice, position.symbol);

    logInfo(`[Capital] Allocation: ${allocatedMargin.toFixed(2)} USDT, ${position.leverage}x → ${notionalValue.toFixed(2)} USDT notional → ${adjustedQuantity} ${position.symbol}`);

    return {
      totalMargin,
      allocatedMargin,
      allocationRatio: 1.0,
      notionalValue,
      adjustedQuantity,
      leverage: position.leverage,
    };
  }

  allocateForDelta(
    hlPosition: MirrorPosition,
    deltaSize: number,
    totalMarginUsdt?: number,
    availableBalance?: number,
  ): CapitalAllocation {
    const totalMargin = totalMarginUsdt ?? this.defaultTotalMarginUsdt;
    const positionRatio = deltaSize / hlPosition.size;
    const fullAllocation = this.allocateForSinglePosition(hlPosition, totalMargin, availableBalance);

    const allocatedMargin = fullAllocation.allocatedMargin * positionRatio;
    const notionalValue = allocatedMargin * hlPosition.leverage;
    const adjustedQuantity = this.truncateQuantity(notionalValue / hlPosition.entryPrice, hlPosition.symbol);

    logDebug(`[Capital] Delta allocation: ${positionRatio.toFixed(4)} ratio → ${adjustedQuantity} ${hlPosition.symbol}`);

    return {
      totalMargin,
      allocatedMargin,
      allocationRatio: positionRatio,
      notionalValue,
      adjustedQuantity,
      leverage: hlPosition.leverage,
    };
  }

  private truncateQuantity(quantity: number, _symbol: string): number {
    const precision = 3;
    const factor = Math.pow(10, precision);
    return Math.floor(quantity * factor) / factor;
  }

  setDefaultTotalMargin(margin: number): void {
    this.defaultTotalMarginUsdt = margin;
  }

  getDefaultTotalMargin(): number {
    return this.defaultTotalMarginUsdt;
  }
}