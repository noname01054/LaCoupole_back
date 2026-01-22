// db.js
const mysql = require('mysql2/promise');
require('dotenv').config();
const logger = require('../logger');

let pool;

/**
 * This file supports:
 * 1) Direct connection to VPS MySQL (less safe): host=82.112.253.250, port=3306
 * 2) SSH tunnel (recommended): host=127.0.0.1, port=3307
 *
 * If you set env vars in .env, they override defaults.
 */

// Defaults for your VPS external database
const DEFAULT_DB_HOST = '82.112.253.250';
const DEFAULT_DB_PORT = 3306;
const DEFAULT_DB_USER = 'user2';
const DEFAULT_DB_PASSWORD = 'Jmal1234567@';
const DEFAULT_DB_NAME = 'backup_db';

// If you use an SSH tunnel like:
//   ssh -L 3307:127.0.0.1:3306 root@82.112.253.250
// then set DB_HOST=127.0.0.1 and DB_PORT=3307 in your local .env
const dbHost = process.env.DB_HOST || process.env.MYSQLHOST || DEFAULT_DB_HOST;

const dbPort = (() => {
  const raw = process.env.DB_PORT || process.env.MYSQLPORT;
  if (raw !== undefined && raw !== '') {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_DB_PORT;
})();

const dbUser = process.env.DB_USER || process.env.MYSQLUSER || DEFAULT_DB_USER;

const dbPassword =
  process.env.DB_PASSWORD !== undefined
    ? process.env.DB_PASSWORD
    : process.env.MYSQLPASSWORD !== undefined
      ? process.env.MYSQLPASSWORD
      : DEFAULT_DB_PASSWORD;

const dbName =
  process.env.DB_NAME || process.env.MYSQLDATABASE || DEFAULT_DB_NAME;

try {
  pool = mysql.createPool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,

    // Safe settings
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 20000,
    timezone: '+00:00',
    charset: 'utf8mb4',

    // If you later enable MySQL SSL, you can turn this on.
    // ssl: { rejectUnauthorized: true },
  });

  // Test connection on startup
  (async () => {
    try {
      const connection = await pool.getConnection();
      logger.info('✅ Database connected successfully', {
        host: dbHost,
        port: dbPort,
        database: dbName,
        user: dbUser,
      });
      connection.release();
    } catch (err) {
      logger.error('❌ Database connection failed', {
        error: err.message,
        host: dbHost,
        port: dbPort,
        user: dbUser,
        database: dbName,
      });
    }
  })();
} catch (err) {
  logger.error('Error initializing database pool', { error: err.message });
  throw err;
}

module.exports = pool;
