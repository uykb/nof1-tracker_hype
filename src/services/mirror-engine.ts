import { EventEmitter } from 'events';
import { HyperliquidClient } from './hyperliquid-client';
import { HyperliquidWs } from './hyperliquid-ws';
import { PositionTracker } from './position-tracker';
import { BinanceService } from './binance-service';
import { TradeExecutor } from './trade-executor';
import { RiskManager } from './risk-manager';
import { OrderHistoryManager } from './order-history';
import { AppConfig, FollowOptions, HlFill, PositionDelta, TradeSignal } from '../types';
import { logInfo, logDebug, logWarn, logError } from '../utils/logger';

export class MirrorEngine extends EventEmitter {
  private hlClient: HyperliquidClient;
  private hlWs: HyperliquidWs;
  private tracker: PositionTracker;
  private binance: BinanceService;
  private executor: TradeExecutor;
  private riskManager: RiskManager;
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
    this.riskManager = new RiskManager(config.trading.priceTolerancePercent);
    this.orderHistory = new OrderHistoryManager();
  }

  async start(options?: FollowOptions): Promise<void> {
    if (this.isRunning) {
      logWarn('[Mirror] Already running');
      return;
    }

    const ratio = options?.ratio ?? this.config.trading.fixedRatio;
    const marginType = options?.marginType ?? this.config.trading.marginType;
    const dryRun = options?.dryRun ?? false;

    logInfo('[Mirror] Starting Hyperliquid → Binance mirror engine');
    logInfo(`[Mirror] Target: ${this.config.hyperliquid.targetAddress}`);
    logInfo(`[Mirror] Binance: ${this.config.binance.testnet ? 'TESTNET' : 'MAINNET'}`);
    logInfo(`[Mirror] Ratio: ${ratio}, Margin type: ${marginType}, Dry run: ${dryRun}`);

    if (options?.priceTolerance !== undefined) {
      this.riskManager.setPriceTolerance(options.priceTolerance);
    }

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

    this.startPolling();
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

  private startPolling(): void {
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
    const opts = this.mergeOptions();
    const signal = this.riskManager.buildSignalFromDelta(delta, opts.ratio);
    if (!signal) {
      logDebug(`[Mirror] No signal for delta type ${delta.type} on ${delta.symbol}`);
      return;
    }

    logInfo(`[Mirror] Delta: ${delta.type} ${delta.symbol} → Signal: ${signal.action} ${signal.side} qty=${signal.quantity.toFixed(4)} (${signal.leverage}x ${signal.marginType})`);

    if (signal.action === 'EXIT') {
      await this.handleExit(signal, delta, opts.dryRun);
    } else if (signal.action === 'ENTER') {
      await this.handleEnter(signal, delta, opts.dryRun);
    } else if (signal.action === 'MODIFY') {
      if (delta.type === 'SIDE_FLIPPED') {
        await this.handleSideFlip(signal, delta, opts.dryRun);
      } else if (delta.type === 'LEVERAGE_CHANGED') {
        await this.handleLeverageChange(signal);
      }
    }
  }

  private async handleEnter(signal: TradeSignal, delta: PositionDelta, dryRun: boolean): Promise<void> {
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

    if (signal.quantity <= 0) {
      logWarn(`[Mirror] Quantity too small after ratio: ${signal.quantity}`);
      return;
    }

    const result = await this.executor.executeSignal(signal, dryRun);

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
      logInfo(`[Mirror] Entry executed: ${result.orderId ?? 'ok'} qty=${signal.quantity.toFixed(4)} ${signal.symbol}`);

      if (delta.current.liquidationPrice && !dryRun) {
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

  private async handleExit(signal: TradeSignal, delta: PositionDelta, dryRun: boolean): Promise<void> {
    const result = await this.executor.closePosition(signal.symbol, dryRun);

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

  private async handleSideFlip(signal: TradeSignal, delta: PositionDelta, dryRun: boolean): Promise<void> {
    logInfo(`[Mirror] Handling side flip: closing then reopening ${signal.symbol}`);

    const closeResult = await this.executor.closePosition(signal.symbol, dryRun);
    if (!closeResult.success && closeResult.error !== 'no_position') {
      logError(`[Mirror] Failed to close position for flip: ${closeResult.error}`);
      return;
    }

    if (!delta.current) return;

    const currentPrice = await this.binance.getMarkPrice(signal.symbol);
    const priceCheck = this.riskManager.checkPriceTolerance(
      delta.current.entryPrice,
      parseFloat(currentPrice),
      signal.symbol,
    );
    if (!priceCheck.shouldExecute) {
      logWarn(`[Mirror] Price tolerance exceeded for side flip on ${signal.symbol}`);
      return;
    }
    signal.priceTolerance = priceCheck;

    if (signal.quantity <= 0) {
      logWarn(`[Mirror] Quantity too small for side flip: ${signal.quantity}`);
      return;
    }

    const result = await this.executor.executeSignal(signal, dryRun);
    if (result.success) {
      logInfo(`[Mirror] Side flip executed: ${result.orderId ?? 'ok'}`);
    } else {
      logError(`[Mirror] Side flip entry failed: ${result.error}`);
    }
  }

  private async handleLeverageChange(signal: TradeSignal): Promise<void> {
    logInfo(`[Mirror] Leverage change: ${signal.symbol} → ${signal.leverage}x ${signal.marginType}`);
    try {
      await this.binance.setLeverage(signal.symbol, signal.leverage);
      await this.binance.setMarginType(signal.symbol, signal.marginType);
      logInfo(`[Mirror] Updated ${signal.symbol} to ${signal.leverage}x ${signal.marginType}`);
    } catch (error: any) {
      logWarn(`[Mirror] Failed to update leverage/margin: ${error.message}`);
    }
  }

  private mergeOptions(): Required<FollowOptions> {
    return {
      ratio: this.config.trading.fixedRatio,
      marginType: this.config.trading.marginType,
      priceTolerance: this.config.trading.priceTolerancePercent,
      dryRun: false,
    };
  }
}