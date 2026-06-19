'use strict';

const { Pool } = require('pg');

// Берём конфиг из DATABASE_URL (приоритет) или из отдельных переменных
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
        min: parseInt(process.env.DB_POOL_MIN) || 2,
        max: parseInt(process.env.DB_POOL_MAX) || 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME     || 'seogenius_db',
        user:     process.env.DB_USER     || 'seogenius',
        password: process.env.DB_PASSWORD,
        min:      parseInt(process.env.DB_POOL_MIN) || 2,
        max:      parseInt(process.env.DB_POOL_MAX) || 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
);

// Логируем ошибки пула — не даём упасть всему процессу
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Выполнить SQL-запрос.
 * @param {string} text   — SQL с плейсхолдерами $1, $2, ...
 * @param {Array}  params — массив параметров
 * @returns {Promise<import('pg').QueryResult>}
 */
const query = (text, params) => pool.query(text, params);

/**
 * Получить клиента из пула для транзакций.
 * Не забывайте вызывать client.release() в finally-блоке.
 * @returns {Promise<import('pg').PoolClient>}
 */
const getClient = () => pool.connect();

/**
 * Проверить подключение к БД (используется при старте сервера).
 * Повторяет попытки с экспоненциальной задержкой, если БД ещё не готова.
 * @param {object}  [opts]
 * @param {number}  [opts.maxRetries=10]      — макс. число попыток
 * @param {number}  [opts.baseDelayMs=2000]   — начальная задержка (мс)
 * @param {number}  [opts.maxDelayMs=15000]   — потолок задержки (мс)
 * @returns {Promise<void>}
 */
const testConnection = async (opts = {}) => {
  const maxRetries  = opts.maxRetries  ?? 10;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const maxDelayMs  = opts.maxDelayMs  ?? 15000;

  for (let attempt = 1; ; attempt++) {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query('SELECT NOW() AS now');
        console.log(`[DB] Connected. Server time: ${result.rows[0].now}`);
      } finally {
        client.release();
      }
      return; // success
    } catch (err) {
      if (attempt >= maxRetries) {
        console.error(`[DB] Failed to connect after ${maxRetries} attempts: ${err.message}`);
        throw err;
      }
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      console.warn(`[DB] Connection attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
};

module.exports = { query, getClient, testConnection, pool };
