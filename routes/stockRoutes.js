const express = require('express');
const router = express.Router();
const db = require('../config/db');
const logger = require('../logger');
const stockValidation = require('../middleware/stockValidation');

// Check admin access
const checkAdmin = async (userId) => {
  if (!userId) return false;
  const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
  return rows.length > 0 && rows[0].role === 'admin';
};

// Add a new ingredient
router.post('/stock/ingredients', async (req, res) => {
  const { name, unit, quantity_in_stock, low_stock_threshold, user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to add ingredient', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.query('SELECT id FROM ingredients WHERE name = ?', [name.trim()]);
      if (existing.length > 0) {
        await connection.rollback();
        logger.warn('Ingredient already exists', { name });
        return res.status(400).json({ error: 'Ingredient name already exists' });
      }
      const [result] = await connection.query(
        'INSERT INTO ingredients (name, unit, quantity_in_stock, low_stock_threshold) VALUES (?, ?, ?, ?)',
        [name.trim(), unit.trim(), parseFloat(quantity_in_stock) || 0, parseFloat(low_stock_threshold) || 0]
      );
      await connection.query(
        'INSERT INTO stock_transactions (ingredient_id, quantity, transaction_type, reason) VALUES (?, ?, ?, ?)',
        [result.insertId, parseFloat(quantity_in_stock) || 0, 'addition', 'Initial stock addition']
      );
      await connection.commit();
      logger.info('Ingredient created', { id: result.insertId, name, quantity_in_stock });
      res.status(201).json({ message: 'Ingredient created', id: result.insertId });
    } catch (error) {
      await connection.rollback();
      logger.error('Error creating ingredient', { error: error.message, body: req.body });
      res.status(500).json({ error: 'Failed to create ingredient', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in add ingredient route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update ingredient stock
router.put('/stock/ingredients/:id', stockValidation.updateIngredient, async (req, res) => {
  const { id } = req.params;
  const { name, unit, quantity_in_stock, low_stock_threshold, user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to update ingredient', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const ingredientId = parseInt(id);
      const [existing] = await connection.query('SELECT id, quantity_in_stock FROM ingredients WHERE id = ?', [ingredientId]);
      if (existing.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: ingredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }
      const [duplicate] = await connection.query('SELECT id FROM ingredients WHERE name = ? AND id != ?', [name.trim(), ingredientId]);
      if (duplicate.length > 0) {
        await connection.rollback();
        logger.warn('Ingredient name already exists', { name, id: ingredientId });
        return res.status(400).json({ error: 'Ingredient name already exists' });
      }
      const quantityChange = parseFloat(quantity_in_stock) - existing[0].quantity_in_stock;
      if (quantityChange !== 0) {
        await connection.query(
          'INSERT INTO stock_transactions (ingredient_id, quantity, transaction_type, reason) VALUES (?, ?, ?, ?)',
          [ingredientId, quantityChange, quantityChange > 0 ? 'addition' : 'deduction', 'Stock adjustment']
        );
      }
      await connection.query(
        'UPDATE ingredients SET name = ?, unit = ?, quantity_in_stock = ?, low_stock_threshold = ? WHERE id = ?',
        [name.trim(), unit.trim(), parseFloat(quantity_in_stock), parseFloat(low_stock_threshold) || 0, ingredientId]
      );
      await connection.commit();
      logger.info('Ingredient updated', { id: ingredientId, name, quantity_in_stock });
      res.json({ message: 'Ingredient updated' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error updating ingredient', { error: error.message, id, body: req.body });
      res.status(500).json({ error: 'Failed to update ingredient', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in update ingredient route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete ingredient
router.delete('/stock/ingredients/:id', async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to delete ingredient', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const ingredientId = parseInt(id);
      const [existing] = await connection.query('SELECT id FROM ingredients WHERE id = ?', [ingredientId]);
      if (existing.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: ingredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }
      await connection.query('DELETE FROM ingredients WHERE id = ?', [ingredientId]);
      await connection.commit();
      logger.info('Ingredient deleted', { id: ingredientId });
      res.json({ message: 'Ingredient deleted' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error deleting ingredient', { error: error.message, id });
      res.status(500).json({ error: 'Failed to delete ingredient', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in delete ingredient route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign ingredient to menu item
router.post('/stock/menu-items/:id/ingredients', stockValidation.assignIngredient, async (req, res) => {
  const { ingredient_id, quantity, user_id } = req.body;
  const { id } = req.params;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to assign ingredient to menu item', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const menuItemId = parseInt(id);
      const ingredientId = parseInt(ingredient_id);
      const parsedQuantity = parseFloat(quantity);

      // Validate input
      if (isNaN(menuItemId) || menuItemId <= 0) {
        await connection.rollback();
        logger.warn('Invalid menu item ID', { id: menuItemId });
        return res.status(400).json({ error: 'Valid menu item ID is required' });
      }
      if (isNaN(ingredientId) || ingredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: ingredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        await connection.rollback();
        logger.warn('Invalid quantity', { quantity });
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }

      // Check if menu item exists
      const [menuItem] = await connection.query('SELECT id FROM menu_items WHERE id = ?', [menuItemId]);
      if (menuItem.length === 0) {
        await connection.rollback();
        logger.warn('Menu item not found', { id: menuItemId });
        return res.status(404).json({ error: 'Menu item not found' });
      }

      // Check if ingredient exists
      const [ingredient] = await connection.query('SELECT id, quantity_in_stock FROM ingredients WHERE id = ?', [ingredientId]);
      if (ingredient.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: ingredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }

      // Check if the association already exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM menu_item_ingredients WHERE menu_item_id = ? AND ingredient_id = ?',
        [menuItemId, ingredientId]
      );
      if (existingAssignment.length > 0) {
        await connection.rollback();
        logger.warn('Ingredient already assigned to menu item', { menu_item_id: menuItemId, ingredient_id: ingredientId });
        return res.status(400).json({ error: 'Ingredient already assigned to this menu item' });
      }

      // Insert the new association
      const [result] = await connection.query(
        'INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, quantity) VALUES (?, ?, ?)',
        [menuItemId, ingredientId, parsedQuantity]
      );

      await connection.commit();
      logger.info('Ingredient assigned to menu item', { menu_item_id: menuItemId, ingredient_id: ingredientId, quantity: parsedQuantity });
      res.status(201).json({ message: 'Ingredient assigned', id: result.insertId });
    } catch (error) {
      await connection.rollback();
      logger.error('Error assigning ingredient to menu item', { error: error.message, menu_item_id: id, ingredient_id, quantity });
      res.status(500).json({ error: 'Failed to assign ingredient', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in assign ingredient to menu item route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update ingredient association for menu item
router.put('/stock/menu-items/:id/ingredients/:ingredientId', stockValidation.assignIngredient, async (req, res) => {
  const { id, ingredientId } = req.params;
  const { quantity, user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to update ingredient association', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const menuItemId = parseInt(id);
      const parsedIngredientId = parseInt(ingredientId);
      const parsedQuantity = parseFloat(quantity);

      // Validate input
      if (isNaN(menuItemId) || menuItemId <= 0) {
        await connection.rollback();
        logger.warn('Invalid menu item ID', { id: menuItemId });
        return res.status(400).json({ error: 'Valid menu item ID is required' });
      }
      if (isNaN(parsedIngredientId) || parsedIngredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: parsedIngredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        await connection.rollback();
        logger.warn('Invalid quantity', { quantity });
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }

      // Check if menu item exists
      const [menuItem] = await connection.query('SELECT id FROM menu_items WHERE id = ?', [menuItemId]);
      if (menuItem.length === 0) {
        await connection.rollback();
        logger.warn('Menu item not found', { id: menuItemId });
        return res.status(404).json({ error: 'Menu item not found' });
      }

      // Check if ingredient exists
      const [ingredient] = await connection.query('SELECT id FROM ingredients WHERE id = ?', [parsedIngredientId]);
      if (ingredient.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }

      // Check if the association exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM menu_item_ingredients WHERE menu_item_id = ? AND ingredient_id = ?',
        [menuItemId, parsedIngredientId]
      );
      if (existingAssignment.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient association not found', { menu_item_id: menuItemId, ingredient_id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient association not found' });
      }

      // Update the association
      await connection.query(
        'UPDATE menu_item_ingredients SET quantity = ? WHERE menu_item_id = ? AND ingredient_id = ?',
        [parsedQuantity, menuItemId, parsedIngredientId]
      );

      await connection.commit();
      logger.info('Ingredient association updated', { menu_item_id: menuItemId, ingredient_id: parsedIngredientId, quantity: parsedQuantity });
      res.json({ message: 'Ingredient association updated' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error updating ingredient association', { error: error.message, menu_item_id: id, ingredient_id: ingredientId, quantity });
      res.status(500).json({ error: 'Failed to update ingredient association', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in update ingredient association route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete ingredient association from menu item
router.delete('/stock/menu-items/:id/ingredients/:ingredientId', async (req, res) => {
  const { id, ingredientId } = req.params;
  const { user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to delete ingredient association', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const menuItemId = parseInt(id);
      const parsedIngredientId = parseInt(ingredientId);

      // Validate input
      if (isNaN(menuItemId) || menuItemId <= 0) {
        await connection.rollback();
        logger.warn('Invalid menu item ID', { id: menuItemId });
        return res.status(400).json({ error: 'Valid menu item ID is required' });
      }
      if (isNaN(parsedIngredientId) || parsedIngredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: parsedIngredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }

      // Check if the association exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM menu_item_ingredients WHERE menu_item_id = ? AND ingredient_id = ?',
        [menuItemId, parsedIngredientId]
      );
      if (existingAssignment.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient association not found', { menu_item_id: menuItemId, ingredient_id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient association not found' });
      }

      // Delete the association
      await connection.query(
        'DELETE FROM menu_item_ingredients WHERE menu_item_id = ? AND ingredient_id = ?',
        [menuItemId, parsedIngredientId]
      );

      await connection.commit();
      logger.info('Ingredient association deleted', { menu_item_id: menuItemId, ingredient_id: parsedIngredientId });
      res.json({ message: 'Ingredient association deleted' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error deleting ingredient association', { error: error.message, menu_item_id: id, ingredient_id: ingredientId });
      res.status(500).json({ error: 'Failed to delete ingredient association', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in delete ingredient association route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign ingredient to breakfast
router.post('/stock/breakfasts/:id/ingredients', stockValidation.assignIngredient, async (req, res) => {
  const { ingredient_id, quantity, user_id } = req.body;
  const { id } = req.params;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to assign ingredient to breakfast', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const breakfastId = parseInt(id);
      const ingredientId = parseInt(ingredient_id);
      const parsedQuantity = parseFloat(quantity);

      // Validate input
      if (isNaN(breakfastId) || breakfastId <= 0) {
        await connection.rollback();
        logger.warn('Invalid breakfast ID', { id: breakfastId });
        return res.status(400).json({ error: 'Valid breakfast ID is required' });
      }
      if (isNaN(ingredientId) || ingredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: ingredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        await connection.rollback();
        logger.warn('Invalid quantity', { quantity });
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }

      // Check if breakfast exists
      const [breakfast] = await connection.query('SELECT id FROM breakfasts WHERE id = ?', [breakfastId]);
      if (breakfast.length === 0) {
        await connection.rollback();
        logger.warn('Breakfast not found', { id: breakfastId });
        return res.status(404).json({ error: 'Breakfast not found' });
      }

      // Check if ingredient exists
      const [ingredient] = await connection.query('SELECT id FROM ingredients WHERE id = ?', [ingredientId]);
      if (ingredient.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: ingredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }

      // Check if the association already exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM breakfast_ingredients WHERE breakfast_id = ? AND ingredient_id = ?',
        [breakfastId, ingredientId]
      );
      if (existingAssignment.length > 0) {
        await connection.rollback();
        logger.warn('Ingredient already assigned to breakfast', { breakfast_id: breakfastId, ingredient_id: ingredientId });
        return res.status(400).json({ error: 'Ingredient already assigned to this breakfast' });
      }

      // Insert the new association
      const [result] = await connection.query(
        'INSERT INTO breakfast_ingredients (breakfast_id, ingredient_id, quantity) VALUES (?, ?, ?)',
        [breakfastId, ingredientId, parsedQuantity]
      );
      await connection.commit();
      logger.info('Ingredient assigned to breakfast', { breakfast_id: breakfastId, ingredient_id: ingredientId, quantity: parsedQuantity });
      res.status(201).json({ message: 'Ingredient assigned', id: result.insertId });
    } catch (error) {
      await connection.rollback();
      logger.error('Error assigning ingredient to breakfast', { error: error.message, breakfast_id: id, ingredient_id, quantity });
      res.status(500).json({ error: 'Failed to assign ingredient', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in assign ingredient to breakfast route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update ingredient association for breakfast
router.put('/stock/breakfasts/:id/ingredients/:ingredientId', stockValidation.assignIngredient, async (req, res) => {
  const { id, ingredientId } = req.params;
  const { quantity, user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to update breakfast ingredient association', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const breakfastId = parseInt(id);
      const parsedIngredientId = parseInt(ingredientId);
      const parsedQuantity = parseFloat(quantity);

      // Validate input
      if (isNaN(breakfastId) || breakfastId <= 0) {
        await connection.rollback();
        logger.warn('Invalid breakfast ID', { id: breakfastId });
        return res.status(400).json({ error: 'Valid breakfast ID is required' });
      }
      if (isNaN(parsedIngredientId) || parsedIngredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: parsedIngredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        await connection.rollback();
        logger.warn('Invalid quantity', { quantity });
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }

      // Check if breakfast exists
      const [breakfast] = await connection.query('SELECT id FROM breakfasts WHERE id = ?', [breakfastId]);
      if (breakfast.length === 0) {
        await connection.rollback();
        logger.warn('Breakfast not found', { id: breakfastId });
        return res.status(404).json({ error: 'Breakfast not found' });
      }

      // Check if ingredient exists
      const [ingredient] = await connection.query('SELECT id FROM ingredients WHERE id = ?', [parsedIngredientId]);
      if (ingredient.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }

      // Check if the association exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM breakfast_ingredients WHERE breakfast_id = ? AND ingredient_id = ?',
        [breakfastId, parsedIngredientId]
      );
      if (existingAssignment.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient association not found', { breakfast_id: breakfastId, ingredient_id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient association not found' });
      }

      // Update the association
      await connection.query(
        'UPDATE breakfast_ingredients SET quantity = ? WHERE breakfast_id = ? AND ingredient_id = ?',
        [parsedQuantity, breakfastId, parsedIngredientId]
      );

      await connection.commit();
      logger.info('Ingredient association updated', { breakfast_id: breakfastId, ingredient_id: parsedIngredientId, quantity: parsedQuantity });
      res.json({ message: 'Ingredient association updated' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error updating ingredient association', { error: error.message, breakfast_id: id, ingredient_id: ingredientId, quantity });
      res.status(500).json({ error: 'Failed to update ingredient association', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in update breakfast ingredient association route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete ingredient association from breakfast
router.delete('/stock/breakfasts/:id/ingredients/:ingredientId', async (req, res) => {
  const { id, ingredientId } = req.params;
  const { user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to delete breakfast ingredient association', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const breakfastId = parseInt(id);
      const parsedIngredientId = parseInt(ingredientId);

      // Validate input
      if (isNaN(breakfastId) || breakfastId <= 0) {
        await connection.rollback();
        logger.warn('Invalid breakfast ID', { id: breakfastId });
        return res.status(400).json({ error: 'Valid breakfast ID is required' });
      }
      if (isNaN(parsedIngredientId) || parsedIngredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: parsedIngredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }

      // Check if the association exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM breakfast_ingredients WHERE breakfast_id = ? AND ingredient_id = ?',
        [breakfastId, parsedIngredientId]
      );
      if (existingAssignment.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient association not found', { breakfast_id: breakfastId, ingredient_id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient association not found' });
      }

      // Delete the association
      await connection.query(
        'DELETE FROM breakfast_ingredients WHERE breakfast_id = ? AND ingredient_id = ?',
        [breakfastId, parsedIngredientId]
      );

      await connection.commit();
      logger.info('Ingredient association deleted', { breakfast_id: breakfastId, ingredient_id: parsedIngredientId });
      res.json({ message: 'Ingredient association deleted' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error deleting ingredient association', { error: error.message, breakfast_id: id, ingredient_id: ingredientId });
      res.status(500).json({ error: 'Failed to delete ingredient association', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in delete breakfast ingredient association route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign ingredient to supplement
router.post('/stock/supplements/:id/ingredients', stockValidation.assignIngredient, async (req, res) => {
  const { ingredient_id, quantity, user_id } = req.body;
  const { id } = req.params;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to assign ingredient to supplement', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const supplementId = parseInt(id);
      const ingredientId = parseInt(ingredient_id);
      const parsedQuantity = parseFloat(quantity);

      // Validate input
      if (isNaN(supplementId) || supplementId <= 0) {
        await connection.rollback();
        logger.warn('Invalid supplement ID', { id: supplementId });
        return res.status(400).json({ error: 'Valid supplement ID is required' });
      }
      if (isNaN(ingredientId) || ingredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: ingredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        await connection.rollback();
        logger.warn('Invalid quantity', { quantity });
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }

      // Check if supplement exists
      const [supplement] = await connection.query('SELECT id FROM supplements WHERE id = ?', [supplementId]);
      if (supplement.length === 0) {
        await connection.rollback();
        logger.warn('Supplement not found', { id: supplementId });
        return res.status(404).json({ error: 'Supplement not found' });
      }

      // Check if ingredient exists
      const [ingredient] = await connection.query('SELECT id FROM ingredients WHERE id = ?', [ingredientId]);
      if (ingredient.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: ingredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }

      // Check if the association already exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM supplement_ingredients WHERE supplement_id = ? AND ingredient_id = ?',
        [supplementId, ingredientId]
      );
      if (existingAssignment.length > 0) {
        await connection.rollback();
        logger.warn('Ingredient already assigned to supplement', { supplement_id: supplementId, ingredient_id: ingredientId });
        return res.status(400).json({ error: 'Ingredient already assigned to this supplement' });
      }

      // Insert the new association
      const [result] = await connection.query(
        'INSERT INTO supplement_ingredients (supplement_id, ingredient_id, quantity) VALUES (?, ?, ?)',
        [supplementId, ingredientId, parsedQuantity]
      );
      await connection.commit();
      logger.info('Ingredient assigned to supplement', { supplement_id: supplementId, ingredient_id: ingredientId, quantity: parsedQuantity });
      res.status(201).json({ message: 'Ingredient assigned', id: result.insertId });
    } catch (error) {
      await connection.rollback();
      logger.error('Error assigning ingredient to supplement', { error: error.message, supplement_id: id, ingredient_id, quantity });
      res.status(500).json({ error: 'Failed to assign ingredient', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in assign ingredient to supplement route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update ingredient association for supplement
router.put('/stock/supplements/:id/ingredients/:ingredientId', stockValidation.assignIngredient, async (req, res) => {
  const { id, ingredientId } = req.params;
  const { quantity, user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to update supplement ingredient association', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const supplementId = parseInt(id);
      const parsedIngredientId = parseInt(ingredientId);
      const parsedQuantity = parseFloat(quantity);

      // Validate input
      if (isNaN(supplementId) || supplementId <= 0) {
        await connection.rollback();
        logger.warn('Invalid supplement ID', { id: supplementId });
        return res.status(400).json({ error: 'Valid supplement ID is required' });
      }
      if (isNaN(parsedIngredientId) || parsedIngredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: parsedIngredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        await connection.rollback();
        logger.warn('Invalid quantity', { quantity });
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }

      // Check if supplement exists
      const [supplement] = await connection.query('SELECT id FROM supplements WHERE id = ?', [supplementId]);
      if (supplement.length === 0) {
        await connection.rollback();
        logger.warn('Supplement not found', { id: supplementId });
        return res.status(404).json({ error: 'Supplement not found' });
      }

      // Check if ingredient exists
      const [ingredient] = await connection.query('SELECT id FROM ingredients WHERE id = ?', [parsedIngredientId]);
      if (ingredient.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }

      // Check if the association exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM supplement_ingredients WHERE supplement_id = ? AND ingredient_id = ?',
        [supplementId, parsedIngredientId]
      );
      if (existingAssignment.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient association not found', { supplement_id: supplementId, ingredient_id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient association not found' });
      }

      // Update the association
      await connection.query(
        'UPDATE supplement_ingredients SET quantity = ? WHERE supplement_id = ? AND ingredient_id = ?',
        [parsedQuantity, supplementId, parsedIngredientId]
      );

      await connection.commit();
      logger.info('Ingredient association updated', { supplement_id: supplementId, ingredient_id: parsedIngredientId, quantity: parsedQuantity });
      res.json({ message: 'Ingredient association updated' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error updating ingredient association', { error: error.message, supplement_id: id, ingredient_id: ingredientId, quantity });
      res.status(500).json({ error: 'Failed to update ingredient association', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in update supplement ingredient association route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete ingredient association from supplement
router.delete('/stock/supplements/:id/ingredients/:ingredientId', async (req, res) => {
  const { id, ingredientId } = req.params;
  const { user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to delete supplement ingredient association', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const supplementId = parseInt(id);
      const parsedIngredientId = parseInt(ingredientId);

      // Validate input
      if (isNaN(supplementId) || supplementId <= 0) {
        await connection.rollback();
        logger.warn('Invalid supplement ID', { id: supplementId });
        return res.status(400).json({ error: 'Valid supplement ID is required' });
      }
      if (isNaN(parsedIngredientId) || parsedIngredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: parsedIngredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }

      // Check if the association exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM supplement_ingredients WHERE supplement_id = ? AND ingredient_id = ?',
        [supplementId, parsedIngredientId]
      );
      if (existingAssignment.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient association not found', { supplement_id: supplementId, ingredient_id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient association not found' });
      }

      // Delete the association
      await connection.query(
        'DELETE FROM supplement_ingredients WHERE supplement_id = ? AND ingredient_id = ?',
        [supplementId, parsedIngredientId]
      );

      await connection.commit();
      logger.info('Ingredient association deleted', { supplement_id: supplementId, ingredient_id: parsedIngredientId });
      res.json({ message: 'Ingredient association deleted' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error deleting ingredient association', { error: error.message, supplement_id: id, ingredient_id: ingredientId });
      res.status(500).json({ error: 'Failed to delete ingredient association', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in delete supplement ingredient association route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign ingredient to breakfast option
router.post('/stock/breakfast-options/:id/ingredients', stockValidation.assignIngredient, async (req, res) => {
  const { ingredient_id, quantity, user_id } = req.body;
  const { id } = req.params;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to assign ingredient to breakfast option', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const optionId = parseInt(id);
      const ingredientId = parseInt(ingredient_id);
      const parsedQuantity = parseFloat(quantity);

      // Validate input
      if (isNaN(optionId) || optionId <= 0) {
        await connection.rollback();
        logger.warn('Invalid breakfast option ID', { id: optionId });
        return res.status(400).json({ error: 'Valid breakfast option ID is required' });
      }
      if (isNaN(ingredientId) || ingredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: ingredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        await connection.rollback();
        logger.warn('Invalid quantity', { quantity });
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }

      // Check if breakfast option exists
      const [option] = await connection.query('SELECT id FROM breakfast_options WHERE id = ?', [optionId]);
      if (option.length === 0) {
        await connection.rollback();
        logger.warn('Breakfast option not found', { id: optionId });
        return res.status(404).json({ error: 'Breakfast option not found' });
      }

      // Check if ingredient exists
      const [ingredient] = await connection.query('SELECT id FROM ingredients WHERE id = ?', [ingredientId]);
      if (ingredient.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: ingredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }

      // Check if the association already exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM breakfast_option_ingredients WHERE breakfast_option_id = ? AND ingredient_id = ?',
        [optionId, ingredientId]
      );
      if (existingAssignment.length > 0) {
        await connection.rollback();
        logger.warn('Ingredient already assigned to breakfast option', { option_id: optionId, ingredient_id: ingredientId });
        return res.status(400).json({ error: 'Ingredient already assigned to this breakfast option' });
      }

      // Insert the new association
      const [result] = await connection.query(
        'INSERT INTO breakfast_option_ingredients (breakfast_option_id, ingredient_id, quantity) VALUES (?, ?, ?)',
        [optionId, ingredientId, parsedQuantity]
      );
      await connection.commit();
      logger.info('Ingredient assigned to breakfast option', { option_id: optionId, ingredient_id: ingredientId, quantity: parsedQuantity });
      res.status(201).json({ message: 'Ingredient assigned', id: result.insertId });
    } catch (error) {
      await connection.rollback();
      logger.error('Error assigning ingredient to breakfast option', { error: error.message, option_id: id, ingredient_id, quantity });
      res.status(500).json({ error: 'Failed to assign ingredient', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in assign ingredient to breakfast option route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update ingredient association for breakfast option
router.put('/stock/breakfast-options/:id/ingredients/:ingredientId', stockValidation.assignIngredient, async (req, res) => {
  const { id, ingredientId } = req.params;
  const { quantity, user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to update breakfast option ingredient association', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const optionId = parseInt(id);
      const parsedIngredientId = parseInt(ingredientId);
      const parsedQuantity = parseFloat(quantity);

      // Validate input
      if (isNaN(optionId) || optionId <= 0) {
        await connection.rollback();
        logger.warn('Invalid breakfast option ID', { id: optionId });
        return res.status(400).json({ error: 'Valid breakfast option ID is required' });
      }
      if (isNaN(parsedIngredientId) || parsedIngredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: parsedIngredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        await connection.rollback();
        logger.warn('Invalid quantity', { quantity });
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }

      // Check if breakfast option exists
      const [option] = await connection.query('SELECT id FROM breakfast_options WHERE id = ?', [optionId]);
      if (option.length === 0) {
        await connection.rollback();
        logger.warn('Breakfast option not found', { id: optionId });
        return res.status(404).json({ error: 'Breakfast option not found' });
      }

      // Check if ingredient exists
      const [ingredient] = await connection.query('SELECT id FROM ingredients WHERE id = ?', [parsedIngredientId]);
      if (ingredient.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient not found', { id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient not found' });
      }

      // Check if the association exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM breakfast_option_ingredients WHERE breakfast_option_id = ? AND ingredient_id = ?',
        [optionId, parsedIngredientId]
      );
      if (existingAssignment.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient association not found', { option_id: optionId, ingredient_id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient association not found' });
      }

      // Update the association
      await connection.query(
        'UPDATE breakfast_option_ingredients SET quantity = ? WHERE breakfast_option_id = ? AND ingredient_id = ?',
        [parsedQuantity, optionId, parsedIngredientId]
      );

      await connection.commit();
      logger.info('Ingredient association updated', { option_id: optionId, ingredient_id: parsedIngredientId, quantity: parsedQuantity });
      res.json({ message: 'Ingredient association updated' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error updating ingredient association', { error: error.message, option_id: id, ingredient_id: ingredientId, quantity });
      res.status(500).json({ error: 'Failed to update ingredient association', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in update breakfast option ingredient association route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete ingredient association from breakfast option
router.delete('/stock/breakfast-options/:id/ingredients/:ingredientId', async (req, res) => {
  const { id, ingredientId } = req.params;
  const { user_id } = req.body;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to delete breakfast option ingredient association', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const optionId = parseInt(id);
      const parsedIngredientId = parseInt(ingredientId);

      // Validate input
      if (isNaN(optionId) || optionId <= 0) {
        await connection.rollback();
        logger.warn('Invalid breakfast option ID', { id: optionId });
        return res.status(400).json({ error: 'Valid breakfast option ID is required' });
      }
      if (isNaN(parsedIngredientId) || parsedIngredientId <= 0) {
        await connection.rollback();
        logger.warn('Invalid ingredient ID', { id: parsedIngredientId });
        return res.status(400).json({ error: 'Valid ingredient ID is required' });
      }

      // Check if the association exists
      const [existingAssignment] = await connection.query(
        'SELECT id FROM breakfast_option_ingredients WHERE breakfast_option_id = ? AND ingredient_id = ?',
        [optionId, parsedIngredientId]
      );
      if (existingAssignment.length === 0) {
        await connection.rollback();
        logger.warn('Ingredient association not found', { option_id: optionId, ingredient_id: parsedIngredientId });
        return res.status(404).json({ error: 'Ingredient association not found' });
      }

      // Delete the association
      await connection.query(
        'DELETE FROM breakfast_option_ingredients WHERE breakfast_option_id = ? AND ingredient_id = ?',
        [optionId, parsedIngredientId]
      );

      await connection.commit();
      logger.info('Ingredient association deleted', { option_id: optionId, ingredient_id: parsedIngredientId });
      res.json({ message: 'Ingredient association deleted' });
    } catch (error) {
      await connection.rollback();
      logger.error('Error deleting ingredient association', { error: error.message, option_id: id, ingredient_id: ingredientId });
      res.status(500).json({ error: 'Failed to delete ingredient association', details: error.message });
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Error in delete breakfast option ingredient association route', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fetch all ingredients
router.get('/stock/ingredients', async (req, res) => {
  const { user_id } = req.query;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to fetch ingredients', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const [rows] = await db.query('SELECT id, name, unit, quantity_in_stock, low_stock_threshold FROM ingredients');
    logger.info('Ingredients fetched', { count: rows.length });
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching ingredients', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch ingredients', details: error.message });
  }
});

// Fetch stock dashboard data
router.get('/stock/stock-dashboard', async (req, res) => {
  const { user_id } = req.query;
  try {
    if (!req.user || req.user.id !== parseInt(user_id) || !await checkAdmin(user_id)) {
      logger.warn('Unauthorized attempt to fetch stock dashboard', { user_id, authenticatedUser: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }
    const [ingredients] = await db.query(
      'SELECT id, name, unit, quantity_in_stock, low_stock_threshold FROM ingredients'
    );
    const [lowStock] = await db.query(
      'SELECT id, name, unit, quantity_in_stock, low_stock_threshold FROM ingredients WHERE quantity_in_stock <= low_stock_threshold * 2.2'
    );
    const [transactions] = await db.query(
      'SELECT st.id, st.ingredient_id, i.name, st.quantity, st.transaction_type, st.reason, st.created_at FROM stock_transactions st JOIN ingredients i ON st.ingredient_id = i.id ORDER BY st.created_at DESC LIMIT 50'
    );
    const [itemIngredients] = await db.query(
      'SELECT mi.id, mi.name, mii.ingredient_id, i.name AS ingredient_name, mii.quantity, i.unit FROM menu_item_ingredients mii JOIN menu_items mi ON mii.menu_item_id = mi.id JOIN ingredients i ON mii.ingredient_id = i.id'
    );
    const [breakfastIngredients] = await db.query(
      'SELECT b.id, b.name, bi.ingredient_id, i.name AS ingredient_name, bi.quantity, i.unit FROM breakfast_ingredients bi JOIN breakfasts b ON bi.breakfast_id = b.id JOIN ingredients i ON bi.ingredient_id = i.id'
    );
    const [supplementIngredients] = await db.query(
      'SELECT s.id, s.name, si.ingredient_id, i.name AS ingredient_name, si.quantity, i.unit FROM supplement_ingredients si JOIN supplements s ON si.supplement_id = s.id JOIN ingredients i ON si.ingredient_id = i.id'
    );
    const [optionIngredients] = await db.query(
      'SELECT bo.id, bo.option_name, boi.ingredient_id, i.name AS ingredient_name, boi.quantity, i.unit FROM breakfast_option_ingredients boi JOIN breakfast_options bo ON boi.breakfast_option_id = bo.id JOIN ingredients i ON boi.ingredient_id = i.id'
    );
    res.json({
      ingredients,
      lowStock,
      transactions,
      associations: {
        menuItems: itemIngredients,
        breakfasts: breakfastIngredients,
        supplements: supplementIngredients,
        breakfastOptions: optionIngredients,
      },
    });
  } catch (error) {
    logger.error('Error fetching stock dashboard', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch stock dashboard', details: error.message });
  }
});

// Export the router
module.exports = router;