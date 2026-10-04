import { config } from '../shared/config';
import { logger } from '../shared/logger';
import type { Email } from './templates';

// In development we just log the email. In production this would open an SMTP
// connection to config.smtpUrl; the interface stays the same either way.
export async function sendEmail(to: string, email: Email): Promise<void> {
  if (config.env === 'production' && config.smtpUrl) {
    // Intentionally left as a seam: wire nodemailer here when SMTP is set up.
    logger.info('smtp send', { to, subject: email.subject });
    return;
  }
  logger.debug('email (dev)', { to, from: config.mailFrom, subject: email.subject });
}
