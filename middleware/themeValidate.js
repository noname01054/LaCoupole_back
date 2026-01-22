const { body, validationResult } = require('express-validator');
const logger = require('../logger');

const themeValidate = (req, res, next) => {
  const validations = [];

  if (req.method === 'PUT' && req.path.includes('/theme')) {
    validations.push(
      body('primary_color')
        .optional()
        .isString()
        .trim()
        .matches(/^#[0-9A-Fa-f]{6}$/)
        .withMessage('Primary color must be a valid hex color code (e.g., #ff6b35)'),
      body('secondary_color')
        .optional()
        .isString()
        .trim()
        .matches(/^#[0-9A-Fa-f]{6}$/)
        .withMessage('Secondary color must be a valid hex color code (e.g., #ff8c42)'),
      body('background_color')
        .optional()
        .isString()
        .trim()
        .matches(/^#[0-9A-Fa-f]{6}$/)
        .withMessage('Background color must be a valid hex color code (e.g., #faf8f5)'),
      body('text_color')
        .optional()
        .isString()
        .trim()
        .matches(/^#[0-9A-Fa-f]{6}$/)
        .withMessage('Text color must be a valid hex color code (e.g., #1f2937)'),
      body('site_title')
        .optional()
        .isString()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Site title must be a string with a maximum length of 100 characters')
    );
  }

  Promise.all(validations.map(validation => validation.run(req))).then(() => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Theme validation errors', {
        errors: errors.array(),
        method: req.method,
        path: req.path,
        body: req.body,
      });
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  }).catch(err => {
    logger.error('Theme validation middleware error', {
      error: err.message,
      method: req.method,
      path: req.path,
    });
    res.status(500).json({ error: 'Internal validation error' });
  });
};

module.exports = themeValidate;
