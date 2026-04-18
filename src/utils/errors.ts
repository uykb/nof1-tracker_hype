export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class TradingError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'TradingError';
  }
}

export class ConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export function isTransientError(error: unknown): boolean {
  if (error instanceof ApiError) {
    const status = error.statusCode;
    if (!status) return false;
    if (status === 429) return true;
    if (status >= 500) return true;
    return false;
  }
  if (error instanceof TradingError) {
    if (error.code === '-1021') return true;
    return false;
  }
  if (error instanceof ConnectionError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('socket hang up')) return true;
    if (msg.includes('rate limit') || msg.includes('too many requests')) return true;
    return false;
  }
  return false;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  retryOnlyTransient: boolean = true,
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (retryOnlyTransient && !isTransientError(error)) {
        throw lastError;
      }
      if (i < maxRetries) {
        const delay = baseDelay * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}