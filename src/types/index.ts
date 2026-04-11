export interface HlPosition {
  coin: string;
  entryPx: string | null;
  leverage: HlLeverage;
  liquidationPx: string | null;
  marginUsed: string;
  positionValue: string;
  returnOnEquity: string;
  szi: string;
  unrealizedPnl: string;
}

export interface HlLeverage {
  type: 'cross' | 'isolated';
  value: number;
  rawUsd?: string;
}

export interface HlAssetPosition {
  position: HlPosition;
  type: 'oneWay';
}

export interface HlMarginSummary {
  accountValue: string;
  totalMarginUsed: string;
  totalNtlPos: string;
  totalRawUsd: string;
}

export interface HlClearinghouseState {
  assetPositions: HlAssetPosition[];
  crossMarginSummary: HlMarginSummary;
  marginSummary: HlMarginSummary;
  withdrawable: string;
}

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'S';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken: string;
}

export interface HlUserFillsMessage {
  channel: 'userFills';
  data: {
    user: string;
    isSnapshot: boolean;
    fills: HlFill[];
  };
}

export interface MirrorPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  leverage: number;
  marginType: 'ISOLATED' | 'CROSSED';
  marginUsed: number;
  unrealizedPnl: number;
  liquidationPrice: number | null;
}

export interface PositionDelta {
  type: 'NEW' | 'CLOSED' | 'INCREASED' | 'DECREASED' | 'SIDE_FLIPPED' | 'LEVERAGE_CHANGED';
  symbol: string;
  previous: MirrorPosition | null;
  current: MirrorPosition | null;
  timestamp: number;
}

export interface TradeSignal {
  action: 'ENTER' | 'EXIT' | 'MODIFY';
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  leverage: number;
  marginType: 'ISOLATED' | 'CROSSED';
  reason: string;
  sourceDelta: PositionDelta;
  priceTolerance?: PriceToleranceCheck;
  capitalAllocation?: CapitalAllocation;
}

export interface PriceToleranceCheck {
  entryPrice: number;
  currentPrice: number;
  priceDifference: number;
  tolerance: number;
  shouldExecute: boolean;
}

export interface CapitalAllocation {
  totalMargin: number;
  allocatedMargin: number;
  allocationRatio: number;
  notionalValue: number;
  adjustedQuantity: number;
  leverage: number;
}

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;
  error?: string;
  reason?: string;
}

export interface StopOrderResult {
  takeProfitOrderId?: string;
  stopLossOrderId?: string;
  errors: string[];
}

export interface ProcessedOrder {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price?: number;
  hlOid?: number;
  hlFillTime?: number;
  timestamp: number;
}

export interface MirroredTradeRecord {
  hlFill: HlFill;
  binanceOrderId?: string;
  binanceSide?: 'BUY' | 'SELL';
  binanceQuantity?: number;
  binancePrice?: number;
  status: 'PENDING' | 'EXECUTED' | 'FAILED' | 'SKIPPED';
  reason?: string;
  timestamp: number;
}

export interface AppConfig {
  hyperliquid: {
    apiUrl: string;
    wsUrl: string;
    targetAddress: string;
    pollIntervalMs: number;
  };
  binance: {
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
    testnet: boolean;
  };
  trading: {
    maxPositionSizeUsdt: number;
    defaultLeverage: number;
    riskPercentage: number;
    priceTolerancePercent: number;
    totalMarginUsdt: number;
    marginType: 'ISOLATED' | 'CROSSED';
  };
  logging: {
    level: string;
  };
}

export interface FollowOptions {
  totalMargin?: number;
  marginType?: 'ISOLATED' | 'CROSSED';
  priceTolerance?: number;
  maxPositionSize?: number;
  dryRun?: boolean;
}

export const SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  BNB: 'BNBUSDT',
  XRP: 'XRPUSDT',
  DOGE: 'DOGEUSDT',
  ADA: 'ADAUSDT',
  AVAX: 'AVAXUSDT',
  DOT: 'DOTUSDT',
  LINK: 'LINKUSDT',
  MATIC: 'MATICUSDT',
  UNI: 'UNIUSDT',
  ATOM: 'ATOMUSDT',
  LTC: 'LTCUSDT',
  NEAR: 'NEARUSDT',
  APT: 'APTUSDT',
  ARB: 'ARBUSDT',
  OP: 'OPUSDT',
  FIL: 'FILUSDT',
  SUI: 'SUIUSDT',
  SEI: 'SEIUSDT',
  TIA: 'TIAUSDT',
  WIF: 'WIFUSDT',
  PEPE: '1000PEPEUSDT',
  FTM: 'FTMUSDT',
  MKR: 'MKRUSDT',
  AAVE: 'AAVEUSDT',
  CRV: 'CRVUSDT',
  SUSHI: 'SUSHIUSDT',
  COMP: 'COMPUSDT',
  SNX: 'SNXUSDT',
  YFI: 'YFIUSDT',
  ENA: 'ENAUSDT',
  EIGEN: 'EIGENUSDT',
  TRUMP: 'TRUMPUSDT',
};

export function hlCoinToBinanceSymbol(coin: string): string {
  return SYMBOL_MAP[coin] ?? `${coin}USDT`;
}

export function binanceSymbolToHlCoin(symbol: string): string {
  for (const [coin, sym] of Object.entries(SYMBOL_MAP)) {
    if (sym === symbol) return coin;
  }
  return symbol.replace('USDT', '').replace('1000', '');
}

export function parseHlPosition(assetPos: HlAssetPosition): MirrorPosition | null {
  const pos = assetPos.position;
  const size = parseFloat(pos.szi);
  if (size === 0 || pos.entryPx === null) return null;
  return {
    symbol: hlCoinToBinanceSymbol(pos.coin),
    side: size > 0 ? 'LONG' : 'SHORT',
    size: Math.abs(size),
    entryPrice: parseFloat(pos.entryPx),
    leverage: pos.leverage.value,
    marginType: pos.leverage.type === 'isolated' ? 'ISOLATED' : 'CROSSED',
    marginUsed: parseFloat(pos.marginUsed),
    unrealizedPnl: parseFloat(pos.unrealizedPnl),
    liquidationPrice: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
  };
}