const express = require('express');
const router = express.Router();
const db = require('../config/db');
const logger = require('../logger');

const checkAdminOrServer = async (userId) => {
  if (!userId) return false;
  const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
  return rows.length > 0 && ['admin', 'server'].includes(rows[0].role);
};

router.get('/notifications', async (req, res) => {
  const { is_read } = req.query;
  const userId = req.user?.id; // Changed from req.session.user to req.user
  const timestamp = new Date().toISOString();

  try {
    if (!req.user || !(await checkAdminOrServer(userId))) {
      logger.warn('Unauthorized access attempt to notifications', { userId, timestamp });
      return res.status(403).json({ error: 'Unauthorized' });
    }

    let query = 'SELECT * FROM notifications WHERE type = ?';
    const queryParams = ['order'];

    if (is_read !== undefined && ['0', '1'].includes(is_read)) {
      query += ' AND is_read = ?';
      queryParams.push(parseInt(is_read));
    }

    query += ' ORDER BY created_at DESC';

    const [rows] = await db.query(query, queryParams);
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching notifications', {
      error: error.message,
      stack: error.stack,
      userId,
      timestamp,
    });
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.put('/notifications/:id/read', async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id; // Changed from req.session.user to req.user
  const timestamp = new Date().toISOString();

  try {
    if (!req.user || !(await checkAdminOrServer(userId))) {
      logger.warn('Unauthorized attempt to mark notification as read', { userId, notificationId: id, timestamp });
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const [notificationRows] = await db.query('SELECT * FROM notifications WHERE id = ?', [id]);
    if (notificationRows.length === 0) {
      logger.warn('Notification not found', { notificationId: id, userId, timestamp });
      return res.status(404).json({ error: 'Notification not found' });
    }

    await db.query('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);
    logger.info('Notification marked as read', { notificationId: id, userId, timestamp });
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    logger.error('Error marking notification as read', {
      error: error.message,
      stack: error.stack,
      notificationId: id,
      userId,
      timestamp,
    });
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

router.put('/notifications/clear', async (req, res) => {
  const userId = req.user?.id; // Changed from req.session.user to req.user
  const timestamp = new Date().toISOString();

  try {
    if (!req.user || !(await checkAdminOrServer(userId))) {
      logger.warn('Unauthorized attempt to clear notifications', { userId, timestamp });
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await db.query('UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND type = ?', ['order']);
    logger.info('Notifications cleared', { userId, timestamp });
    res.json({ message: 'Notifications cleared' });
  } catch (error) {
    logger.error('Error clearing notifications', {
      error: error.message,
      stack: error.stack,
      userId,
      timestamp,
    });
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

module.exports = router;