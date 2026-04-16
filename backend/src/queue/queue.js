const { Queue } = require('bullmq');
const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const pipelineQueue = new Queue('seo-pipeline', { connection });

module.exports = pipelineQueue;
