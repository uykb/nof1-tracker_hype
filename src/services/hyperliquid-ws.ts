import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { HlFill, HlUserFillsMessage } from '../types';
import { HYPERLIQUID_CONFIG } from '../config/constants';
import { ConnectionError } from '../utils/errors';
import { logInfo, logDebug, logWarn, logError, logVerbose } from '../utils/logger';

export interface HlWsEvents {
  fill: (fill: HlFill) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
}

export class HyperliquidWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 100;
  private pingInterval: NodeJS.Timer | null = null;
  private isShuttingDown = false;
  private subscriptions: Array<{ method: string; subscription: Record<string, unknown> }> = [];

  constructor(
    private wsUrl: string = HYPERLIQUID_CONFIG.MAINNET_WS_URL,
    private targetAddress: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      logInfo(`[HL-WS] Connecting to ${this.wsUrl}`);
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        logInfo('[HL-WS] Connected');
        this.reconnectAttempts = 0;
        this.startPingInterval();
        this.resubscribeAll();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

this.ws.on('close', (code: number, reason: Buffer) => {
      const msg = reason.toString() || `Connection closed (code: ${code})`;
      if (code === 1000 || msg.toLowerCase().includes('expired')) {
        logInfo(`[HL-WS] Closed normally: ${msg}`);
      } else {
        logWarn(`[HL-WS] ${msg}`);
      }
      this.emit('disconnected', msg);
        this.stopPingInterval();
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error: Error) => {
        const msg = error.message.toLowerCase();
        if (msg.includes('502') || msg.includes('503') || msg.includes('bad gateway') || msg.includes('unexpected server response')) {
          logWarn(`[HL-WS] Transient error: ${error.message}`);
        } else {
          logError(`[HL-WS] Error: ${error.message}`);
        }
        this.emit('error', error);
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(new ConnectionError(`WebSocket connection failed: ${error.message}`, error));
        }
      });
    });
  }

  disconnect(): void {
    this.isShuttingDown = true;
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logInfo('[HL-WS] Disconnected');
  }

  subscribeToFills(): void {
    const sub = {
      method: 'subscribe',
      subscription: { type: 'userFills', user: this.targetAddress },
    };
    this.subscriptions.push(sub);
    this.send(sub);
    logInfo(`[HL-WS] Subscribed to fills for ${this.targetAddress}`);
  }

  unsubscribeFromFills(): void {
    const unsub = {
      method: 'unsubscribe',
      subscription: { type: 'userFills', user: this.targetAddress },
    };
    this.send(unsub);
    this.subscriptions = this.subscriptions.filter(
      (s) => !(s.subscription.type === 'userFills' && s.subscription.user === this.targetAddress),
    );
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      if (msg.channel === 'userFills') {
        const data = (msg as HlUserFillsMessage).data;
        if (data && data.fills) {
          for (const fill of data.fills) {
            if (!data.isSnapshot) {
              logVerbose(`[HL-WS] Fill: ${fill.coin} ${fill.side} ${fill.sz} @ ${fill.px}`);
              this.emit('fill', fill);
            }
          }
        }
      } else if (msg.channel === 'pong' || msg.method === 'ping') {
        logDebug('[HL-WS] Pong received');
      } else if (msg.channel === 'subscriptionResponse') {
        logDebug(`[HL-WS] Subscription response: ${JSON.stringify(msg.data)}`);
      }
    } catch (error) {
      logWarn(`[HL-WS] Failed to parse message: ${raw.substring(0, 100)}`);
    }
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      this.send({ method: 'ping' });
    }, HYPERLIQUID_CONFIG.WS_PING_INTERVAL_MS) as unknown as NodeJS.Timer;
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval as unknown as number);
      this.pingInterval = null;
    }
  }

  private resubscribeAll(): void {
    for (const sub of this.subscriptions) {
      this.send(sub);
    }
    logDebug(`[HL-WS] Resubscribed ${this.subscriptions.length} channels`);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logError(`[HL-WS] Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }

    const delay = Math.min(
      HYPERLIQUID_CONFIG.WS_RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      HYPERLIQUID_CONFIG.WS_RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts++;

    logInfo(`[HL-WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        logWarn(`[HL-WS] Reconnect failed (will retry): ${(error as Error).message}`);
      }
    }, delay);
  }
}

