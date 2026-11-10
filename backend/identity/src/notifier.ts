import { Injectable, Logger } from '@nestjs/common';

export abstract class Notifier {
  abstract send(to: { email?: string | null; phone?: string | null }, template: 'password-reset', data: Record<string, string>): Promise<void>;
}

/** Development notifier. Replace with the Notifications microservice (email, SMS) when it exists. */
@Injectable()
export class ConsoleNotifier extends Notifier {
  private readonly log = new Logger('Notifier');
  async send(to: { email?: string | null; phone?: string | null }, template: string, data: Record<string, string>) {
    if (process.env.NODE_ENV === 'production') {
      this.log.warn(`No delivery channel configured for template "${template}".`);
      return;
    }
    this.log.log(`[dev] ${template} -> ${to.email ?? to.phone ?? 'no contact'} ${JSON.stringify(data)}`);
  }
}
