// db.js
const mysql = require('mysql2/promise');
require('dotenv').config();
const logger = require('../logger');

let pool;

try {
  pool = mysql.createPool({
    // === Use Railway's PUBLIC credentials for apps running OUTSIDE Railway ===
    // If your app is deployed ON Railway, you can keep the internal ones as fallback
    host: process.env.MYSQLHOST || 'metro.proxy.rlwy.net',
    port: parseInt(process.env.MYSQLPORT) || 53599,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'PxeHSosrMqjpqbzpQHGBLAQtLNWwrWnp',
    database: process.env.MYSQLDATABASE || 'railway',

    // Optional: extra safe settings
    waitForConnections: true,
    connectionLimit: 10,        // good default for most apps
    queueLimit: 0,
    connectTimeout: 20000,      // increased timeout (Railway public can be slower)
    timezone: '+00:00',         // recommended for consistency
    charset: 'utf8mb4',
  });

  // Test the connection on startup
  (async () => {
    try {
      const connection = await pool.getConnection();
      logger.info('✅ Database connected successfully', {
        host: process.env.MYSQLHOST || 'metro.proxy.rlwy.net',
        port: process.env.MYSQLPORT || 53599,
        database: process.env.MYSQLDATABASE || 'railway',
      });
      connection.release();
    } catch (err) {
      logger.error('❌ Database connection failed', {
        error: err.message,
        host: process.env.MYSQLHOST || 'metro.proxy.rlwy.net',
        port: process.env.MYSQLPORT || 53599,
        user: process.env.MYSQLUSER || 'root',
        database: process.env.MYSQLDATABASE || 'railway',
      });
    }
  })();
} catch (err) {
  logger.error('Error initializing database pool', { error: err.message });
  throw err;
}

module.exports = pool;
