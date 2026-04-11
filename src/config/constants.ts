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
  return {
    hyperliquid: {
      apiUrl: hlTestnet ? HYPERLIQUID_CONFIG.TESTNET_API_URL : HYPERLIQUID_CONFIG.MAINNET_API_URL,
      wsUrl: hlTestnet ? HYPERLIQUID_CONFIG.TESTNET_WS_URL : HYPERLIQUID_CONFIG.MAINNET_WS_URL,
      targetAddress: process.env.HYPERLIQUID_TARGET_ADDRESS || '',
      pollIntervalMs: parseInt(process.env.HYPERLIQUID_POLL_INTERVAL_MS || '3000', 10),
    },
    binance: {
      apiKey: process.env.BINANCE_API_KEY || '',
      apiSecret: process.env.BINANCE_API_SECRET || '',
      baseUrl: binanceTestnet ? BINANCE_CONFIG.TESTNET_BASE_URL : BINANCE_CONFIG.MAINNET_BASE_URL,
      testnet: binanceTestnet,
    },
    trading: {
      fixedRatio: parseFloat(process.env.FIXED_RATIO || '1.0'),
      priceTolerancePercent: parseFloat(process.env.PRICE_TOLERANCE_PERCENT || '1.0'),
      marginType: (process.env.MARGIN_TYPE as 'ISOLATED' | 'CROSSED') || TRADING_CONFIG.DEFAULT_MARGIN_TYPE,
    },
    logging: {
      level: process.env.LOG_LEVEL || 'INFO',
    },
  };
}