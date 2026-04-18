import { logInfo, logDebug, logWarn } from '../utils/logger';

export interface NotificationMessage {
  type: 'TRADE' | 'ERROR' | 'STATUS' | 'WARNING';
  title: string;
  body: string;
  timestamp: number;
}

export interface Notifier {
  send(message: NotificationMessage): Promise<void>;
}

export class DiscordNotifier implements Notifier {
  constructor(private webhookUrl: string) {}

  async send(message: NotificationMessage): Promise<void> {
    try {
      const emoji = message.type === 'TRADE' ? '🟢'
        : message.type === 'ERROR' ? '🔴'
        : message.type === 'WARNING' ? '🟡'
        : '🔵';
      const color = message.type === 'ERROR' ? 0xff0000
        : message.type === 'TRADE' ? 0x00ff00
        : message.type === 'WARNING' ? 0xffaa00
        : 0x00aaff;
      const payload = {
        embeds: [{
          title: `${emoji} ${message.title}`,
          description: message.body,
          color,
          timestamp: new Date(message.timestamp).toISOString(),
        }],
      };
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logWarn(`[Discord] Webhook failed: ${response.status} ${response.statusText}`);
      } else {
        logDebug(`[Discord] Notification sent: ${message.title}`);
      }
    } catch (error: any) {
      logWarn(`[Discord] Send failed: ${error.message}`);
    }
  }
}

export class NotificationManager {
  private notifiers: Notifier[] = [];
  private lastNotified: Map<string, number> = new Map();
  private throttleMs: number;

  constructor(throttleMs: number = 60000) {
    this.throttleMs = throttleMs;
  }

  addNotifier(notifier: Notifier): void {
    this.notifiers.push(notifier);
    logInfo(`[Notify] Added ${notifier.constructor.name}`);
  }

  async notify(type: NotificationMessage['type'], title: string, body: string): Promise<void> {
    const key = `${type}:${title}`;
    const now = Date.now();
    const lastTime = this.lastNotified.get(key);
    if (lastTime && now - lastTime < this.throttleMs) {
      logDebug(`[Notify] Throttled: ${title} (last sent ${Math.round((now - lastTime) / 1000)}s ago)`);
      return;
    }
    this.lastNotified.set(key, now);

    const message: NotificationMessage = {
      type,
      title,
      body,
      timestamp: now,
    };
    for (const notifier of this.notifiers) {
      await notifier.send(message).catch((err) => {
        logWarn(`[Notify] ${notifier.constructor.name} failed: ${(err as Error).message}`);
      });
    }
  }
}

export function createNotifiersFromEnv(): Notifier[] {
  const notifiers: Notifier[] = [];
  const webhookUrl = process.env.WEBHOOK_URL;
  if (webhookUrl) {
    notifiers.push(new DiscordNotifier(webhookUrl));
  }
  return notifiers;
}