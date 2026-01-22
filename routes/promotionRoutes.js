const express = require('express');
const router = express.Router();
const db = require('../config/db');
const logger = require('../logger');

const checkAdmin = async (userId) => {
  if (!userId) return false;
  const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
  return rows.length > 0 && rows[0].role === 'admin';
};

// Create promotion
router.post('/promotions', async (req, res) => {
  const { user_id, name, description, discount_percentage, start_date, end_date, active, item_id } = req.body;
  try {
    if (!req.session.user || req.session.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to create promotion', { user_id, sessionUser: req.session.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!name || !discount_percentage || !start_date || !end_date) {
      logger.warn('Missing required fields', { fields: { name, discount_percentage, start_date, end_date } });
      return res.status(400).json({ error: 'Name, discount percentage, start date, and end date are required' });
    }
    const parsedDiscount = parseFloat(discount_percentage);
    if (isNaN(parsedDiscount) || parsedDiscount <= 0 || parsedDiscount > 100) {
      logger.warn('Invalid discount percentage', { discount_percentage });
      return res.status(400).json({ error: 'Discount percentage must be between 0 and 100' });
    }
    const startDate = new Date(start_date);
    const endDate = new Date(end_date);
    if (startDate >= endDate) {
      logger.warn('Invalid date range', { start_date, end_date });
      return res.status(400).json({ error: 'End date must be after start date' });
    }
    if (item_id) {
      const [item] = await db.query('SELECT id FROM menu_items WHERE id = ?', [item_id]);
      if (item.length === 0) {
        logger.warn('Menu item not found', { item_id });
        return res.status(404).json({ error: 'Menu item not found' });
      }
    }
    const [result] = await db.query(
      'INSERT INTO promotions (name, description, discount_percentage, start_date, end_date, active, item_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, description || null, parsedDiscount, startDate, endDate, active || false, item_id || null]
    );
    logger.info('Promotion created', { id: result.insertId, name });
    res.status(201).json({ message: 'Promotion created', id: result.insertId });
  } catch (error) {
    logger.error('Error creating promotion', { error: error.message, name });
    res.status(500).json({ error: 'Failed to create promotion' });
  }
});

// Update promotion
router.put('/promotions/:id', async (req, res) => {
  const { user_id, name, description, discount_percentage, start_date, end_date, active, item_id } = req.body;
  const { id } = req.params;
  try {
    if (!req.session.user || req.session.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to update promotion', { user_id, sessionUser: req.session.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const promotionId = parseInt(id);
    if (isNaN(promotionId) || promotionId <= 0) {
      logger.warn('Invalid promotion ID', { id });
      return res.status(400).json({ error: 'Valid promotion ID is required' });
    }
    const updates = [];
    const values = [];
    if (name) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description || null);
    }
    if (discount_percentage) {
      const parsedDiscount = parseFloat(discount_percentage);
      if (isNaN(parsedDiscount) || parsedDiscount <= 0 || parsedDiscount > 100) {
        logger.warn('Invalid discount percentage', { discount_percentage });
        return res.status(400).json({ error: 'Discount percentage must be between 0 and 100' });
      }
      updates.push('discount_percentage = ?');
      values.push(parsedDiscount);
    }
    if (start_date) {
      updates.push('start_date = ?');
      values.push(new Date(start_date));
    }
    if (end_date) {
      updates.push('end_date = ?');
      values.push(new Date(end_date));
    }
    if (active !== undefined) {
      updates.push('active = ?');
      values.push(active);
    }
    if (item_id !== undefined) {
      if (item_id) {
        const [item] = await db.query('SELECT id FROM menu_items WHERE id = ?', [item_id]);
        if (item.length === 0) {
          logger.warn('Menu item not found', { item_id });
          return res.status(404).json({ error: 'Menu item not found' });
        }
      }
      updates.push('item_id = ?');
      values.push(item_id || null);
    }
    if (updates.length === 0) {
      logger.warn('No fields to update', { id: promotionId });
      return res.status(400).json({ error: 'No fields to update' });
    }
    values.push(promotionId);
    const [result] = await db.query(`UPDATE promotions SET ${updates.join(', ')} WHERE id = ?`, values);
    if (result.affectedRows === 0) {
      logger.warn('Promotion not found', { id: promotionId });
      return res.status(404).json({ error: 'Promotion not found' });
    }
    logger.info('Promotion updated', { id: promotionId });
    res.json({ message: 'Promotion updated' });
  } catch (error) {
    logger.error('Error updating promotion', { error: error.message, id });
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

// Delete promotion
router.delete('/promotions/:id', async (req, res) => {
  const { user_id } = req.body;
  const { id } = req.params;
  try {
    if (!req.session.user || req.session.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to delete promotion', { user_id, sessionUser: req.session.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const promotionId = parseInt(id);
    if (isNaN(promotionId) || promotionId <= 0) {
      logger.warn('Invalid promotion ID', { id });
      return res.status(400).json({ error: 'Valid promotion ID is required' });
    }
    const [result] = await db.query('DELETE FROM promotions WHERE id = ?', [promotionId]);
    if (result.affectedRows === 0) {
      logger.warn('Promotion not found', { id: promotionId });
      return res.status(404).json({ error: 'Promotion not found' });
    }
    logger.info('Promotion deleted', { id: promotionId });
    res.json({ message: 'Promotion deleted' });
  } catch (error) {
    logger.error('Error deleting promotion', { error: error.message, id });
    res.status(500).json({ error: 'Failed to delete promotion' });
  }
});

// Fetch all promotions
router.get('/promotions', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.*, mi.name AS item_name
      FROM promotions p
      LEFT JOIN menu_items mi ON p.item_id = mi.id
      WHERE p.active = TRUE AND NOW() BETWEEN p.start_date AND p.end_date
    `);
    logger.info('Promotions fetched', { count: rows.length });
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching promotions', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch promotions' });
  }
});

// Fetch single promotion
router.get('/promotions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (!req.session.user || !await checkAdmin(req.session.user.id)) {
      logger.warn('Unauthorized attempt to fetch promotion', { sessionUser: req.session.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const promotionId = parseInt(id);
    if (isNaN(promotionId) || promotionId <= 0) {
      logger.warn('Invalid promotion ID', { id });
      return res.status(400).json({ error: 'Valid promotion ID is required' });
    }
    const [rows] = await db.query(`
      SELECT p.*, mi.name AS item_name
      FROM promotions p
      LEFT JOIN menu_items mi ON p.item_id = mi.id
      WHERE p.id = ?
    `, [promotionId]);
    if (rows.length === 0) {
      logger.warn('Promotion not found', { id: promotionId });
      return res.status(404).json({ error: 'Promotion not found' });
    }
    logger.info('Promotion fetched', { id: promotionId });
    res.json(rows[0]);
  } catch (error) {
    logger.error('Error fetching promotion', { error: error.message, id });
    res.status(500).json({ error: 'Failed to fetch promotion' });
  }
});

module.exports = router;