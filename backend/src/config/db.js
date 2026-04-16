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
        database: process.env.DB_NAME     || 'seo_genius',
        user:     process.env.DB_USER     || 'seo_user',
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
 * @returns {Promise<void>}
 */
const testConnection = async () => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW() AS now');
    console.log(`[DB] Connected. Server time: ${result.rows[0].now}`);
  } finally {
    client.release();
  }
};

module.exports = { query, getClient, testConnection, pool };
