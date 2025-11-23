import pino from 'pino';

/**
 * Pino config object for Fastify.
 */
export const loggerConfig = {
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label: string) {
      return { level: label };
    }
  },
  messageKey: 'message',
  base: {
    service: 'order-exec-engine'
  }
};

/**
 * Standalone pino logger instance for non-Fastify logs
 */
export const logger = pino(loggerConfig);

/**
 * Child logger
 */
export const loggerWith = (bindings: Record<string, any>) =>
  logger.child(bindings);
