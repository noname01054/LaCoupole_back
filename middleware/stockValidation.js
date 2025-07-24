const { body, param } = require('express-validator');

const addIngredient = [
  body('name').trim().notEmpty().withMessage('Ingredient name is required'),
  body('unit').trim().notEmpty().withMessage('Unit is required'),
  body('quantity_in_stock')
    .isFloat({ min: 0 }).withMessage('Quantity in stock must be a non-negative number'),
  body('low_stock_threshold')
    .isFloat({ min: 0 }).withMessage('Low stock threshold must be a non-negative number'),
];

const updateIngredient = [
  param('id').isInt({ min: 1 }).withMessage('Valid ingredient ID is required'),
  body('name').trim().notEmpty().withMessage('Ingredient name is required'),
  body('unit').trim().notEmpty().withMessage('Unit is required'),
  body('quantity_in_stock')
    .isFloat({ min: 0 }).withMessage('Quantity in stock must be a non-negative number'),
  body('low_stock_threshold')
    .isFloat({ min: 0 }).withMessage('Low stock threshold must be a non-negative number'),
];

const deleteIngredient = [
  param('id').isInt({ min: 1 }).withMessage('Valid ingredient ID is required'),
];

const assignIngredient = [
  body('ingredient_id').isInt({ min: 1 }).withMessage('Valid ingredient ID is required'),
  body('quantity').isFloat({ min: 0 }).withMessage('Quantity must be a non-negative number'),
];

module.exports = {
  addIngredient,
  updateIngredient,
  deleteIngredient,
  assignIngredient,
};
