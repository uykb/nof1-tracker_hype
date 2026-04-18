import { EventEmitter } from 'events';
import { HyperliquidClient } from './hyperliquid-client';
import { HyperliquidWs } from './hyperliquid-ws';
import { PositionTracker } from './position-tracker';
import { BinanceService } from './binance-service';
import { TradeExecutor } from './trade-executor';
import { RiskManager } from './risk-manager';
import { OrderHistoryManager } from './order-history';
import { NotificationManager, createNotifiersFromEnv, NotificationMessage } from './notifier';
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
  private notifier: NotificationManager;
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;
  private consecutiveEmptyPolls = 0;
  private static readonly MIN_POLL_INTERVAL = 3000;
  private static readonly MAX_POLL_INTERVAL = 30000;
  private static readonly IDLE_THRESHOLD = 3;

  constructor(private config: AppConfig) {
    super();
    this.hlClient = new HyperliquidClient(config.hyperliquid.apiUrl);
    this.hlWs = new HyperliquidWs(config.hyperliquid.wsUrl, config.hyperliquid.targetAddress);
    this.tracker = new PositionTracker(this.hlClient);
    this.binance = new BinanceService(config.binance.apiKey, config.binance.apiSecret, config.binance.testnet);
    this.executor = new TradeExecutor(this.binance);
    this.riskManager = new RiskManager(config.trading.priceTolerancePercent);
    this.orderHistory = new OrderHistoryManager();
    this.notifier = new NotificationManager();
    for (const n of createNotifiersFromEnv()) {
      this.notifier.addNotifier(n);
    }
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

    try {
      logInfo('[Mirror] Step 1/6: Syncing Binance server time...');
      await this.binance.syncServerTime();
      logInfo('[Mirror] Step 1/6: Binance server time synced OK');
    } catch (error: any) {
      logError(`[Mirror] Step 1/5 FAILED: Binance server time sync error: ${error.message}`);
      throw error;
    }

    try {
      logInfo('[Mirror] Step 2/6: Verifying Binance account...');
      const account = await this.binance.getAccountInfo();
      logInfo(`[Mirror] Step 2/6: Binance account OK, available balance: ${account.availableBalance} USDT`);
    } catch (error: any) {
      logError(`[Mirror] Step 2/6 FAILED: Binance account verification error: ${error.message}`);
      throw error;
    }

    try {
      logInfo('[Mirror] Step 3/6: Prefetching Binance exchange info...');
      await this.binance.prefetchExchangeInfo();
      logInfo('[Mirror] Step 3/6: Exchange info prefetched OK');
    } catch (error: any) {
      logWarn(`[Mirror] Step 3/6 WARNING: Prefetch exchange info failed: ${error.message}. Will fetch per-symbol on demand.`);
    }

    try {
      logInfo('[Mirror] Step 4/6: Loading order history...');
      await this.orderHistory.load();
      logInfo('[Mirror] Step 4/6: Order history loaded OK');
    } catch (error: any) {
      logError(`[Mirror] Step 4/6 FAILED: Order history load error: ${error.message}`);
      throw error;
    }

    try {
      logInfo('[Mirror] Step 5/6: Initializing position tracker...');
      await this.tracker.initialize(this.config.hyperliquid.targetAddress);
      logInfo('[Mirror] Step 5/6: Position tracker initialized OK');
    } catch (error: any) {
      logError(`[Mirror] Step 5/6 FAILED: Position tracker init error: ${error.message}`);
      throw error;
    }

    this.setupWsListeners();
    try {
      logInfo('[Mirror] Step 6/6: Connecting WebSocket...');
      await this.hlWs.connect();
      this.hlWs.subscribeToFills();
      logInfo('[Mirror] Step 6/6: WebSocket connected and subscribed OK');
    } catch (error: any) {
      logWarn(`[Mirror] Step 6/6 WARNING: WebSocket connection failed, falling back to polling only: ${error.message}`);
    }

    this.startPolling();
    logInfo('[Mirror] All steps completed. Polling started.');
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
      this.resetPollInterval();
      this.pollAndProcess().catch((err) => {
        logError(`[Mirror] WS-triggered poll error: ${(err as Error).message}`);
      });
    });

    this.hlWs.on('connected', () => {
      logInfo('[Mirror] WebSocket reconnected');
    });

    this.hlWs.on('disconnected', (reason: string) => {
      logWarn(`[Mirror] WebSocket disconnected: ${reason}`);
      this.notifier.notify('WARNING', 'WebSocket Disconnected', `HL WebSocket disconnected: ${reason}`);
    });

    this.hlWs.on('error', (error: Error) => {
      logError(`[Mirror] WebSocket error: ${error.message}`);
      this.notifier.notify('ERROR', 'WebSocket Error', error.message);
    });
  }

  private startPolling(): void {
    this.stopPolling();
    this.consecutiveEmptyPolls = 0;
    this.scheduleNextPoll(MirrorEngine.MIN_POLL_INTERVAL);
  }

  private scheduleNextPoll(delay: number): void {
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAndProcess();
      } catch (error) {
        logError(`[Mirror] Poll error: ${(error as Error).message}`);
      }
      if (this.isRunning) {
        const nextDelay = this.getNextPollDelay();
        this.scheduleNextPoll(nextDelay);
      }
    }, delay);
  }

  private getNextPollDelay(): number {
    if (this.consecutiveEmptyPolls >= MirrorEngine.IDLE_THRESHOLD) {
      return MirrorEngine.MAX_POLL_INTERVAL;
    }
    return MirrorEngine.MIN_POLL_INTERVAL;
  }

  private resetPollInterval(): void {
    this.consecutiveEmptyPolls = 0;
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollAndProcess(): Promise<void> {
    if (!this.tracker.isReady()) return;
    if (this.isProcessing) {
      logDebug('[Mirror] pollAndProcess skipped: already processing');
      return;
    }
    this.isProcessing = true;
    try {
      let deltas: PositionDelta[];
      try {
        deltas = await this.tracker.detectChanges(this.config.hyperliquid.targetAddress);
      } catch (error: any) {
        logError(`[Mirror] detectChanges FAILED: ${error.message}`);
        return;
      }

      if (deltas.length === 0) {
        this.consecutiveEmptyPolls++;
        logDebug('[Mirror] No position changes detected');
        return;
      }

      this.resetPollInterval();

      try {
        const count = await this.executor.cleanOrphanedOrders();
        if (count > 0) logInfo(`[Mirror] Cleaned ${count} orphaned order(s)`);
      } catch (error: any) {
        logWarn(`[Mirror] cleanOrphanedOrders FAILED (non-fatal): ${error.message}`);
      }

      for (const delta of deltas) {
        try {
          await this.processDelta(delta);
        } catch (error: any) {
          logError(`[Mirror] processDelta FAILED for ${delta.type} ${delta.symbol}: ${error.message}`);
        }
      }

      try {
        await this.orderHistory.save();
      } catch (error: any) {
        logError(`[Mirror] orderHistory.save FAILED: ${error.message}`);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processDelta(delta: PositionDelta): Promise<void> {
    const opts = this.mergeOptions();
    const signal = this.riskManager.buildSignalFromDelta(delta, opts.ratio);
    if (!signal) {
      logDebug(`[Mirror] No signal for delta type ${delta.type} on ${delta.symbol}`);
      return;
    }

    const dedupKey = `${delta.symbol}:${signal.side}:${delta.timestamp}`;
    if (this.orderHistory.isOrderProcessed(delta.symbol, signal.side, delta.timestamp)) {
      logInfo(`[Mirror] SKIP duplicate: ${delta.type} ${delta.symbol} (already processed, key=${dedupKey})`);
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
      } else {
        logWarn(`[Mirror] Unknown MODIFY subtype: ${delta.type} for ${delta.symbol}`);
      }
    }
  }

  private async handleEnter(signal: TradeSignal, delta: PositionDelta, dryRun: boolean): Promise<void> {
    if (!delta.current) return;

    logInfo(`[Mirror] handleEnter START: ${signal.symbol} ${signal.side} qty=${signal.quantity.toFixed(4)}`);

    // Step 1: Get mark price for tolerance check
    let currentPrice: string;
    try {
      logDebug(`[Mirror]   Step 1: getMarkPrice(${signal.symbol})...`);
      currentPrice = await this.binance.getMarkPrice(signal.symbol);
      logDebug(`[Mirror]   Step 1: getMarkPrice OK, price=${currentPrice}`);
    } catch (error: any) {
      logError(`[Mirror]   Step 1 FAILED: getMarkPrice(${signal.symbol}) error: ${error.message}`);
      return;
    }

    // Step 2: Price tolerance check
    const priceCheck = this.riskManager.checkPriceTolerance(
      delta.current.entryPrice,
      parseFloat(currentPrice),
      signal.symbol,
    );
    signal.priceTolerance = priceCheck;
    logDebug(`[Mirror]   Step 2: price tolerance check: diff=${priceCheck.priceDifference.toFixed(2)}%, tol=${priceCheck.tolerance}%, pass=${priceCheck.shouldExecute}`);

    if (!priceCheck.shouldExecute) {
      logWarn(`[Mirror]   Step 2 SKIP: price tolerance exceeded for ${signal.symbol}: ${priceCheck.priceDifference.toFixed(2)}% > ${priceCheck.tolerance}%`);
      return;
    }

    if (signal.quantity <= 0) {
      logWarn(`[Mirror]   SKIP: quantity too small after ratio: ${signal.quantity}`);
      return;
    }

    // Step 3: Execute trade
    logInfo(`[Mirror]   Step 3: executeSignal(${signal.symbol} ${signal.side} ${signal.quantity.toFixed(4)} @ market ${signal.leverage}x ${signal.marginType})...`);
    const result = await this.executor.executeSignal(signal, dryRun);
    logInfo(`[Mirror]   Step 3: executeSignal result: success=${result.success}, orderId=${result.orderId ?? 'N/A'}, error=${result.error ?? 'none'}`);

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
      logInfo(`[Mirror] Enter OK: orderId=${result.orderId ?? 'N/A'} qty=${signal.quantity.toFixed(4)} ${signal.symbol} price=${result.price ?? 'market'}`);
      this.notifier.notify('TRADE', `Enter ${signal.side} ${signal.symbol}`, `qty=${signal.quantity.toFixed(4)} @ ${result.price ?? 'market'} orderId=${result.orderId ?? 'N/A'}`);
    } else {
      logError(`[Mirror] Enter FAILED: ${result.error}`);
      this.notifier.notify('ERROR', `Enter FAILED ${signal.symbol}`, result.error ?? 'unknown error');
    }
  }

  private async handleExit(signal: TradeSignal, delta: PositionDelta, dryRun: boolean): Promise<void> {
    logInfo(`[Mirror] handleExit START: ${signal.symbol}`);

    logDebug(`[Mirror]   Step 1: closePosition(${signal.symbol})...`);
    const result = await this.executor.closePosition(signal.symbol, dryRun);
    logInfo(`[Mirror]   Step 1: closePosition result: success=${result.success}, orderId=${result.orderId ?? 'N/A'}, error=${result.error ?? 'none'}`);

    if (result.success) {
      this.orderHistory.addProcessedOrder({
        id: result.orderId ?? `hl-exit-${delta.timestamp}`,
        symbol: signal.symbol,
        side: signal.side,
        quantity: result.quantity,
        timestamp: Date.now(),
        hlFillTime: delta.timestamp,
      });
      logInfo(`[Mirror] Exit OK: orderId=${result.orderId ?? 'N/A'}`);
    } else {
      logError(`[Mirror] Exit FAILED: ${result.error}`);
      this.notifier.notify('ERROR', `Exit FAILED ${signal.symbol}`, result.error ?? 'unknown error');
    }
  }

  private async handleSideFlip(signal: TradeSignal, delta: PositionDelta, dryRun: boolean): Promise<void> {
    logInfo(`[Mirror] handleSideFlip START: ${signal.symbol} closing then reopening`);

    // Step 1: Close old position
    logDebug(`[Mirror]   Step 1: closePosition(${signal.symbol}) for flip...`);
    const closeResult = await this.executor.closePosition(signal.symbol, dryRun);
    logInfo(`[Mirror]   Step 1: close result: success=${closeResult.success}, error=${closeResult.error ?? 'none'}`);
    if (!closeResult.success && closeResult.error !== 'no_position') {
      logError(`[Mirror]   Step 1 FAILED: cannot close for flip: ${closeResult.error}`);
      return;
    }

    if (!delta.current) return;

    // Step 2: Get mark price for tolerance check
    let currentPrice: string;
    try {
      logDebug(`[Mirror]   Step 2: getMarkPrice(${signal.symbol}) for flip...`);
      currentPrice = await this.binance.getMarkPrice(signal.symbol);
      logDebug(`[Mirror]   Step 2: getMarkPrice OK, price=${currentPrice}`);
    } catch (error: any) {
      logError(`[Mirror]   Step 2 FAILED: getMarkPrice(${signal.symbol}) for flip: ${error.message}`);
      return;
    }

    const priceCheck = this.riskManager.checkPriceTolerance(
      delta.current.entryPrice,
      parseFloat(currentPrice),
      signal.symbol,
    );
    if (!priceCheck.shouldExecute) {
      logWarn(`[Mirror]   Step 2 SKIP: price tolerance exceeded for side flip on ${signal.symbol}`);
      return;
    }
    signal.priceTolerance = priceCheck;

    if (signal.quantity <= 0) {
      logWarn(`[Mirror]   SKIP: quantity too small for side flip: ${signal.quantity}`);
      return;
    }

    // Step 3: Open new position
    logInfo(`[Mirror]   Step 3: executeSignal for side flip (${signal.symbol} ${signal.side} ${signal.quantity.toFixed(4)})...`);
    const result = await this.executor.executeSignal(signal, dryRun);
    if (result.success) {
      logInfo(`[Mirror] Side flip OK: orderId=${result.orderId ?? 'N/A'}`);
    } else {
      logError(`[Mirror] Side flip entry FAILED: ${result.error}`);
    }
  }

  private async handleLeverageChange(signal: TradeSignal): Promise<void> {
    logInfo(`[Mirror] handleLeverageChange START: ${signal.symbol} → ${signal.leverage}x ${signal.marginType}`);

    try {
      logDebug(`[Mirror]   Step 1: setLeverage(${signal.symbol}, ${signal.leverage})...`);
      await this.binance.setLeverage(signal.symbol, signal.leverage);
      logInfo(`[Mirror]   Step 1: setLeverage OK`);
    } catch (error: any) {
      logWarn(`[Mirror]   Step 1 FAILED: setLeverage: ${error.message}`);
    }

    try {
      logDebug(`[Mirror]   Step 2: setMarginType(${signal.symbol}, ${signal.marginType})...`);
      await this.binance.setMarginType(signal.symbol, signal.marginType);
      logInfo(`[Mirror]   Step 2: setMarginType OK`);
    } catch (error: any) {
      logWarn(`[Mirror]   Step 2 FAILED: setMarginType: ${error.message}`);
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

  getTracker(): PositionTracker {
    return this.tracker;
  }

  getBinance(): BinanceService {
    return this.binance;
  }

  getOrderHistory(): OrderHistoryManager {
    return this.orderHistory;
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }
}