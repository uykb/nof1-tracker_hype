export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  VERBOSE = 4,
}

const LOG_LEVEL_ORDER: Record<string, LogLevel> = {
  ERROR: LogLevel.ERROR,
  WARN: LogLevel.WARN,
  INFO: LogLevel.INFO,
  DEBUG: LogLevel.DEBUG,
  VERBOSE: LogLevel.VERBOSE,
};

let currentLevel: LogLevel = LogLevel.INFO;

export function setLogLevel(level: string): void {
  currentLevel = LOG_LEVEL_ORDER[level.toUpperCase()] ?? LogLevel.INFO;
}

export function log(level: LogLevel, message: string): void {
  if (level > currentLevel) return;
  const timestamp = new Date().toISOString();
  const levelName = LogLevel[level] || 'UNKNOWN';
  const prefix = `[${timestamp}] [${levelName}]`;
  if (level <= LogLevel.WARN) {
    console.error(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export function logError(message: string): void {
  log(LogLevel.ERROR, message);
}

export function logWarn(message: string): void {
  log(LogLevel.WARN, message);
}

export function logInfo(message: string): void {
  log(LogLevel.INFO, message);
}

export function logDebug(message: string): void {
  log(LogLevel.DEBUG, message);
}

export function logVerbose(message: string): void {
  log(LogLevel.VERBOSE, message);
}