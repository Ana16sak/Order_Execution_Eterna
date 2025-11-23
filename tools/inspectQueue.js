// tools/inspectQueue.js
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
const queueName = process.env.ORDER_QUEUE || 'order-queue';

(async () => {
  const connection = new IORedis(redisUrl);
  const q = new Queue(queueName, { connection });

  const jobs = await q.getJobs(['waiting','active','completed','failed','delayed'], 0, 50);
  console.log('Found jobs:', jobs.length);
  for (const j of jobs) {
    console.log('---');
    console.log('id:', j.id);
    console.log('state:', j.opts?.state || 'unknown');
    console.log('data:', JSON.stringify(j.data, null, 2));
    console.log('timestamp:', j.timestamp);
  }

  await q.close();
  connection.disconnect();
})();
