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
      const color = message.type === 'ERROR' ? 0xff0000
        : message.type === 'TRADE' ? 0x00ff00
        : message.type === 'WARNING' ? 0xffaa00
        : 0x00aaff;
      const payload = {
        embeds: [{
          title: message.title,
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

  addNotifier(notifier: Notifier): void {
    this.notifiers.push(notifier);
    logInfo(`[Notify] Added ${notifier.constructor.name}`);
  }

  async notify(type: NotificationMessage['type'], title: string, body: string): Promise<void> {
    const message: NotificationMessage = {
      type,
      title,
      body,
      timestamp: Date.now(),
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