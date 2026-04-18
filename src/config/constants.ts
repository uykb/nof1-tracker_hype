import { AppConfig } from '../types';

export const HYPERLIQUID_CONFIG = {
  MAINNET_API_URL: 'https://api.hyperliquid.xyz',
  TESTNET_API_URL: 'https://api.hyperliquid-testnet.xyz',
  MAINNET_WS_URL: 'wss://api.hyperliquid.xyz/ws',
  TESTNET_WS_URL: 'wss://api.hyperliquid-testnet.xyz/ws',
  DEFAULT_POLL_INTERVAL_MS: 3000,
  WS_RECONNECT_BASE_DELAY_MS: 1000,
  WS_RECONNECT_MAX_DELAY_MS: 30000,
  WS_PING_INTERVAL_MS: 50000,
};

export const BINANCE_CONFIG = {
  MAINNET_BASE_URL: 'https://fapi.binance.com',
  TESTNET_BASE_URL: 'https://testnet.binancefuture.com',
};

export const TRADING_CONFIG = {
  DEFAULT_FIXED_RATIO: 1.0,
  DEFAULT_PRICE_TOLERANCE_PERCENT: 1.0,
  DEFAULT_MARGIN_TYPE: 'CROSSED' as const,
  VERIFICATION_DELAY_MS: 2000,
  BETWEEN_OPERATIONS_DELAY_MS: 1000,
};

export const DATA_CONFIG = {
  ORDER_HISTORY_FILE: 'order-history.json',
  DATA_DIR: 'data',
};

export function buildConfigFromEnv(): AppConfig {
  const hlTestnet = process.env.HYPERLIQUID_TESTNET === 'true';
  const binanceTestnet = process.env.BINANCE_TESTNET === 'true';

  const targetAddress = process.env.HYPERLIQUID_TARGET_ADDRESS || '';
  const apiKey = process.env.BINANCE_API_KEY || '';
  const apiSecret = process.env.BINANCE_API_SECRET || '';
  const fixedRatio = parseFloat(process.env.FIXED_RATIO || '1.0');
  const priceTolerancePercent = parseFloat(process.env.PRICE_TOLERANCE_PERCENT || '1.0');
  const pollIntervalMs = parseInt(process.env.HYPERLIQUID_POLL_INTERVAL_MS || '3000', 10);

  if (!targetAddress) {
    throw new Error('HYPERLIQUID_TARGET_ADDRESS is required');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(targetAddress)) {
    throw new Error(`HYPERLIQUID_TARGET_ADDRESS invalid format: "${targetAddress}". Must be 0x-prefixed 40-char hex.`);
  }
  if (!apiKey) {
    throw new Error('BINANCE_API_KEY is required');
  }
  if (!apiSecret) {
    throw new Error('BINANCE_API_SECRET is required');
  }
  if (isNaN(fixedRatio) || fixedRatio <= 0 || fixedRatio > 1) {
    throw new Error(`FIXED_RATIO must be > 0 and <= 1, got: "${process.env.FIXED_RATIO}"`);
  }
  if (isNaN(priceTolerancePercent) || priceTolerancePercent <= 0) {
    throw new Error(`PRICE_TOLERANCE_PERCENT must be > 0, got: "${process.env.PRICE_TOLERANCE_PERCENT}"`);
  }
  if (isNaN(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error(`HYPERLIQUID_POLL_INTERVAL_MS must be >= 1000, got: "${process.env.HYPERLIQUID_POLL_INTERVAL_MS}"`);
  }

  const marginTypeRaw = process.env.MARGIN_TYPE || TRADING_CONFIG.DEFAULT_MARGIN_TYPE;
  if (marginTypeRaw !== 'ISOLATED' && marginTypeRaw !== 'CROSSED') {
    throw new Error(`MARGIN_TYPE must be ISOLATED or CROSSED, got: "${marginTypeRaw}"`);
  }

  return {
    hyperliquid: {
      apiUrl: hlTestnet ? HYPERLIQUID_CONFIG.TESTNET_API_URL : HYPERLIQUID_CONFIG.MAINNET_API_URL,
      wsUrl: hlTestnet ? HYPERLIQUID_CONFIG.TESTNET_WS_URL : HYPERLIQUID_CONFIG.MAINNET_WS_URL,
      targetAddress,
      pollIntervalMs,
    },
    binance: {
      apiKey,
      apiSecret,
      baseUrl: binanceTestnet ? BINANCE_CONFIG.TESTNET_BASE_URL : BINANCE_CONFIG.MAINNET_BASE_URL,
      testnet: binanceTestnet,
    },
    trading: {
      fixedRatio,
      priceTolerancePercent,
      marginType: marginTypeRaw as 'ISOLATED' | 'CROSSED',
    },
    logging: {
      level: process.env.LOG_LEVEL || 'INFO',
    },
  };
}