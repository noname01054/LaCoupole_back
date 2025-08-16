const mysql = require('mysql2/promise');
require('dotenv').config();
const logger = require('../logger');

let pool;

try {
  pool = mysql.createPool({
    host: process.env.MYSQLHOST || 'switchback.proxy.rlwy.net',
    port: parseInt(process.env.MYSQLPORT) || 42497,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'QEdkfOjWSNSYsdwKCInwsMUhvRYgfjVo',
    database: process.env.MYSQLDATABASE || 'railway',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000,
  });

  pool.getConnection()
    .then((conn) => {
      logger.info('Database connected successfully', {
        host: process.env.MYSQLHOST,
        port: process.env.MYSQLPORT,
        database: process.env.MYSQLDATABASE,
      });
      conn.release();
    })
    .catch((err) => {
      logger.error('Database connection failed', {
        error: err.message,
        host: process.env.MYSQLHOST,
        port: process.env.MYSQLPORT,
        user: process.env.MYSQLUSER,
        database: process.env.MYSQLDATABASE,
      });
      throw err;
    });
} catch (err) {
  logger.error('Error initializing database pool', {
    error: err.message,
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT,
    user: process.env.MYSQLUSER,
    database: process.env.MYSQLDATABASE,
  });
  throw err;
}

module.exports = pool;
