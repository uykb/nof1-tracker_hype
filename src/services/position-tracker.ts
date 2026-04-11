import { EventEmitter } from 'events';
import { HyperliquidClient } from './hyperliquid-client';
import {
  MirrorPosition,
  PositionDelta,
  HlClearinghouseState,
  parseHlPosition,
} from '../types';
import { logInfo, logDebug, logWarn } from '../utils/logger';

export class PositionTracker extends EventEmitter {
  private lastPositions: Map<string, MirrorPosition> = new Map();
  private lastRawState: HlClearinghouseState | null = null;
  private isInitialized = false;

  constructor(private hlClient: HyperliquidClient) {
    super();
  }

  async initialize(address: string): Promise<void> {
    logInfo('[Tracker] Initializing position tracking...');
    const state = await this.hlClient.getClearinghouseState(address);
    this.lastRawState = state;
    this.lastPositions = this.parseState(state);
    this.isInitialized = true;
    logInfo(`[Tracker] Initialized with ${this.lastPositions.size} active position(s)`);
    for (const [symbol, pos] of this.lastPositions) {
      logInfo(`[Tracker]   ${pos.side} ${pos.size} ${symbol} @ ${pos.entryPrice} (${pos.leverage}x ${pos.marginType})`);
    }
  }

  async detectChanges(address: string): Promise<PositionDelta[]> {
    const currentState = await this.hlClient.getClearinghouseState(address);
    const currentPositions = this.parseState(currentState);
    const deltas = this.computeDeltas(this.lastPositions, currentPositions);
    this.lastRawState = currentState;
    this.lastPositions = currentPositions;
    return deltas;
  }

  notifyFill(fill: { coin: string; side: string; sz: string }): void {
    logInfo(`[Tracker] Real-time fill detected: ${fill.side} ${fill.sz} ${fill.coin}`);
  }

  private parseState(state: HlClearinghouseState): Map<string, MirrorPosition> {
    const positions = new Map<string, MirrorPosition>();
    for (const ap of state.assetPositions) {
      const pos = parseHlPosition(ap);
      if (pos) {
        positions.set(pos.symbol, pos);
      }
    }
    return positions;
  }

  private computeDeltas(
    prevMap: Map<string, MirrorPosition>,
    currMap: Map<string, MirrorPosition>,
  ): PositionDelta[] {
    const deltas: PositionDelta[] = [];
    const now = Date.now();
    const allSymbols = new Set([...prevMap.keys(), ...currMap.keys()]);

    for (const symbol of allSymbols) {
      const prev = prevMap.get(symbol) ?? null;
      const curr = currMap.get(symbol) ?? null;

      if (!prev && curr) {
        deltas.push({ type: 'NEW', symbol, previous: null, current: curr, timestamp: now });
      } else if (prev && !curr) {
        deltas.push({ type: 'CLOSED', symbol, previous: prev, current: null, timestamp: now });
      } else if (prev && curr) {
        if (prev.side !== curr.side) {
          deltas.push({ type: 'SIDE_FLIPPED', symbol, previous: prev, current: curr, timestamp: now });
        } else if (Math.abs(curr.size - prev.size) > 1e-8) {
          deltas.push({
            type: curr.size > prev.size ? 'INCREASED' : 'DECREASED',
            symbol, previous: prev, current: curr, timestamp: now,
          });
        } else if (prev.leverage !== curr.leverage || prev.marginType !== curr.marginType) {
          deltas.push({ type: 'LEVERAGE_CHANGED', symbol, previous: prev, current: curr, timestamp: now });
        }
      }
    }
    return deltas;
  }

  getLastPositions(): Map<string, MirrorPosition> {
    return new Map(this.lastPositions);
  }

  getLastRawState(): HlClearinghouseState | null {
    return this.lastRawState;
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  reset(): void {
    this.lastPositions.clear();
    this.lastRawState = null;
    this.isInitialized = false;
  }
}