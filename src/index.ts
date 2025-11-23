import Fastify from 'fastify';
import createOrdersRoutes from './api/orders';
import { logger, loggerConfig } from './lib/logger';

const server = Fastify({
  logger: loggerConfig,   // Pass CONFIG, not instance
});

server.register(createOrdersRoutes, { prefix: '/api' });

const start = async () => {
  try {
    await server.listen({ port: 3000, host: '0.0.0.0' });
    server.log.info('Server listening on port 3000'); // use Fastify logger
  } catch (err) {
    logger.error(err); // standalone logger for fatal startup errors
    process.exit(1);
  }
};

start();
