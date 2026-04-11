import { EventEmitter } from 'events';
import { HyperliquidClient } from './hyperliquid-client';
import { HyperliquidWs } from './hyperliquid-ws';
import { PositionTracker } from './position-tracker';
import { BinanceService } from './binance-service';
import { TradeExecutor } from './trade-executor';
import { RiskManager } from './risk-manager';
import { CapitalManager } from './capital-manager';
import { OrderHistoryManager } from './order-history';
import { AppConfig, PositionDelta, TradeSignal, HlFill, FollowOptions } from '../types';
import { TRADING_CONFIG } from '../config/constants';
import { logInfo, logDebug, logWarn, logError } from '../utils/logger';

export class MirrorEngine extends EventEmitter {
  private hlClient: HyperliquidClient;
  private hlWs: HyperliquidWs;
  private tracker: PositionTracker;
  private binance: BinanceService;
  private executor: TradeExecutor;
  private riskManager: RiskManager;
  private capitalManager: CapitalManager;
  private orderHistory: OrderHistoryManager;
  private pollTimer: NodeJS.Timer | null = null;
  private isRunning = false;

  constructor(private config: AppConfig) {
    super();
    this.hlClient = new HyperliquidClient(config.hyperliquid.apiUrl);
    this.hlWs = new HyperliquidWs(config.hyperliquid.wsUrl, config.hyperliquid.targetAddress);
    this.tracker = new PositionTracker(this.hlClient);
    this.binance = new BinanceService(config.binance.apiKey, config.binance.apiSecret, config.binance.testnet);
    this.executor = new TradeExecutor(this.binance);
    this.riskManager = new RiskManager(config.trading.priceTolerancePercent, config.trading.maxPositionSizeUsdt);
    this.capitalManager = new CapitalManager(config.trading.totalMarginUsdt);
    this.orderHistory = new OrderHistoryManager();
  }

  async start(options?: FollowOptions): Promise<void> {
    if (this.isRunning) {
      logWarn('[Mirror] Already running');
      return;
    }

    const opts = this.mergeOptions(options);
    logInfo('[Mirror] Starting Hyperliquid → Binance mirror engine');
    logInfo(`[Mirror] Target: ${this.config.hyperliquid.targetAddress}`);
    logInfo(`[Mirror] Binance: ${this.config.binance.testnet ? 'TESTNET' : 'MAINNET'}`);
    logInfo(`[Mirror] Total margin: ${opts.totalMargin} USDT, Margin type: ${opts.marginType}`);

    this.isRunning = true;

    await this.binance.syncServerTime();
    await this.binance.getAccountInfo();
    logInfo('[Mirror] Binance connection verified');

    await this.orderHistory.load();
    await this.tracker.initialize(this.config.hyperliquid.targetAddress);
    logInfo('[Mirror] Position tracker initialized');

    this.setupWsListeners();
    try {
      await this.hlWs.connect();
      this.hlWs.subscribeToFills();
      logInfo('[Mirror] WebSocket connected and subscribed');
    } catch (error) {
      logWarn(`[Mirror] WebSocket connection failed, falling back to polling only: ${(error as Error).message}`);
    }

    this.startPolling(opts);
    logInfo('[Mirror] Polling started');
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.stopPolling();
    this.hlWs.disconnect();

    await this.orderHistory.save();
    logInfo('[Mirror] Stopped');
    this.emit('stopped');
  }

  private setupWsListeners(): void {
    this.hlWs.on('fill', (fill: HlFill) => {
      logInfo(`[Mirror] WS fill: ${fill.coin} ${fill.side} ${fill.sz} @ ${fill.px}`);
      this.tracker.notifyFill(fill);
      this.pollAndProcess().catch((err) => {
        logError(`[Mirror] WS-triggered poll error: ${(err as Error).message}`);
      });
    });

    this.hlWs.on('connected', () => {
      logInfo('[Mirror] WebSocket reconnected');
    });

    this.hlWs.on('disconnected', (reason: string) => {
      logWarn(`[Mirror] WebSocket disconnected: ${reason}`);
    });

    this.hlWs.on('error', (error: Error) => {
      logError(`[Mirror] WebSocket error: ${error.message}`);
    });
  }

  private startPolling(opts: Required<FollowOptions>): void {
    this.stopPolling();
    const interval = this.config.hyperliquid.pollIntervalMs;
    this.pollTimer = setInterval(async () => {
      try {
        await this.pollAndProcess();
      } catch (error) {
        logError(`[Mirror] Poll error: ${(error as Error).message}`);
      }
    }, interval) as unknown as NodeJS.Timer;
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer as unknown as number);
      this.pollTimer = null;
    }
  }

  private async pollAndProcess(): Promise<void> {
    if (!this.tracker.isReady()) return;

    const deltas = await this.tracker.detectChanges(this.config.hyperliquid.targetAddress);

    if (deltas.length === 0) {
      logDebug('[Mirror] No position changes detected');
      return;
    }

    await this.executor.cleanOrphanedOrders();

    for (const delta of deltas) {
      await this.processDelta(delta);
    }

    await this.orderHistory.save();
  }

  private async processDelta(delta: PositionDelta): Promise<void> {
    const signal = this.riskManager.buildSignalFromDelta(delta);
    if (!signal) {
      logDebug(`[Mirror] No signal for delta type ${delta.type} on ${delta.symbol}`);
      return;
    }

    logInfo(`[Mirror] Delta: ${delta.type} ${delta.symbol} → Signal: ${signal.action} ${signal.side} ${signal.quantity}`);

    if (signal.action === 'EXIT') {
      await this.handleExit(signal, delta);
    } else if (signal.action === 'ENTER') {
      await this.handleEnter(signal, delta);
    } else if (signal.action === 'MODIFY') {
      if (delta.type === 'SIDE_FLIPPED') {
        await this.handleSideFlip(signal, delta);
      } else if (delta.type === 'LEVERAGE_CHANGED') {
        await this.handleLeverageChange(signal, delta);
      }
    }
  }

  private async handleEnter(signal: TradeSignal, delta: PositionDelta): Promise<void> {
    const opts = this.mergeOptions();
    if (!delta.current) return;

    const currentPrice = await this.binance.getMarkPrice(signal.symbol);
    const priceCheck = this.riskManager.checkPriceTolerance(
      delta.current.entryPrice,
      parseFloat(currentPrice),
      signal.symbol,
    );
    signal.priceTolerance = priceCheck;

    if (!priceCheck.shouldExecute) {
      logWarn(`[Mirror] Price tolerance exceeded for ${signal.symbol}: ${priceCheck.priceDifference.toFixed(2)}% > ${priceCheck.tolerance}%`);
      return;
    }

    const allocation = this.capitalManager.allocateForSinglePosition(
      delta.current,
      opts.totalMargin,
    );
    signal.capitalAllocation = allocation;

    if (allocation.adjustedQuantity <= 0) {
      logWarn(`[Mirror] Quantity too small after allocation: ${allocation.adjustedQuantity}`);
      return;
    }

    signal.quantity = allocation.adjustedQuantity;

    const risk = this.riskManager.assessRisk(signal, allocation.notionalValue);
    for (const w of risk.warnings) {
      logWarn(`[Mirror] Risk warning: ${w}`);
    }

    const result = await this.executor.executeSignal(signal, opts.dryRun);

    if (result.success) {
      this.orderHistory.addProcessedOrder({
        id: result.orderId ?? `hl-${delta.timestamp}`,
        symbol: signal.symbol,
        side: signal.side,
        quantity: signal.quantity,
        price: result.price,
        hlFillTime: delta.timestamp,
        timestamp: Date.now(),
      });
      logInfo(`[Mirror] Entry executed: ${result.orderId}`);

      if (delta.current.liquidationPrice && !opts.dryRun) {
        const side = delta.current.side === 'LONG' ? 'BUY' : 'SELL';
        await this.executor.placeStopOrders(
          signal.symbol,
          side,
          signal.quantity,
          undefined,
          delta.current.liquidationPrice,
        );
      }
    } else {
      logError(`[Mirror] Entry failed: ${result.error}`);
    }
  }

  private async handleExit(signal: TradeSignal, delta: PositionDelta): Promise<void> {
    const opts = this.mergeOptions();
    const result = await this.executor.closePosition(signal.symbol, opts.dryRun);

    if (result.success) {
      this.orderHistory.addProcessedOrder({
        id: result.orderId ?? `hl-exit-${delta.timestamp}`,
        symbol: signal.symbol,
        side: signal.side,
        quantity: result.quantity,
        timestamp: Date.now(),
        hlFillTime: delta.timestamp,
      });
      logInfo(`[Mirror] Exit executed: ${result.orderId ?? 'ok'}`);
    } else {
      logError(`[Mirror] Exit failed: ${result.error}`);
    }
  }

  private async handleSideFlip(signal: TradeSignal, delta: PositionDelta): Promise<void> {
    logInfo(`[Mirror] Handling side flip: closing then reopening ${signal.symbol}`);

    const closeResult = await this.executor.closePosition(signal.symbol);
    if (!closeResult.success && closeResult.error !== 'no_position') {
      logError(`[Mirror] Failed to close position for flip: ${closeResult.error}`);
      return;
    }

    const currentPrice = await this.binance.getMarkPrice(signal.symbol);
    if (delta.current) {
      const priceCheck = this.riskManager.checkPriceTolerance(
        delta.current.entryPrice,
        parseFloat(currentPrice),
        signal.symbol,
      );
      if (!priceCheck.shouldExecute) {
        logWarn(`[Mirror] Price tolerance exceeded for side flip on ${signal.symbol}`);
        return;
      }

      const allocation = this.capitalManager.allocateForSinglePosition(delta.current);
      signal.quantity = allocation.adjustedQuantity;
      signal.capitalAllocation = allocation;
      signal.priceTolerance = priceCheck;
    }

    const result = await this.executor.executeSignal(signal);
    if (result.success) {
      logInfo(`[Mirror] Side flip executed: ${result.orderId}`);
    } else {
      logError(`[Mirror] Side flip entry failed: ${result.error}`);
    }
  }

  private async handleLeverageChange(signal: TradeSignal, delta: PositionDelta): Promise<void> {
    logInfo(`[Mirror] Leverage change detected for ${signal.symbol}: ${signal.leverage}x ${signal.marginType}`);
    try {
      await this.binance.setLeverage(signal.symbol, signal.leverage);
      await this.binance.setMarginType(signal.symbol, signal.marginType);
      logInfo(`[Mirror] Updated ${signal.symbol} to ${signal.leverage}x ${signal.marginType}`);
    } catch (error: any) {
      logWarn(`[Mirror] Failed to update leverage/margin: ${error.message}`);
    }
  }

  private mergeOptions(options?: FollowOptions): Required<FollowOptions> {
    return {
      totalMargin: options?.totalMargin ?? this.config.trading.totalMarginUsdt,
      marginType: options?.marginType ?? this.config.trading.marginType,
      priceTolerance: options?.priceTolerance ?? this.config.trading.priceTolerancePercent,
      maxPositionSize: options?.maxPositionSize ?? this.config.trading.maxPositionSizeUsdt,
      dryRun: options?.dryRun ?? false,
    };
  }
}