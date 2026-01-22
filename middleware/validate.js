const { body, validationResult, param, query } = require('express-validator');
const logger = require('../logger');
const db = require('../config/db');
const { v4: uuidv4, validate: isUuid } = require('uuid');

const validate = (req, res, next) => {
  const validations = [];

  logger.debug('Validation middleware called', {
    method: req.method,
    path: req.path,
    params: req.params,
    body: req.body,
    headers: { 'x-session-id': req.headers['x-session-id'] },
  });

  // Skip validation for stock/ingredient assignment endpoints to avoid false positives
  if (req.path.startsWith('/stock')) {
    return next();
  }

  // Bypass GET validations entirely to avoid blocking reads for guests/public
  if (req.method === 'GET') {
    return next();
  }

  // Menu item validations
  if (req.method === 'POST' || req.method === 'PUT') {
    if (req.path.includes('/menu-items') && !req.path.includes('/availability') && !req.path.includes('/supplements')) {
      validations.push(
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required'),
        body('name')
          .isString()
          .notEmpty()
          .trim()
          .withMessage('Name is required'),
        body('regular_price')
          .isString()
          .trim()
          .customSanitizer(value => value ? parseFloat(value) : undefined)
          .isFloat({ min: 0.01 })
          .withMessage('Regular price must be a positive number'),
        body('sale_price')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseFloat(value) : undefined)
          .isFloat({ min: 0 })
          .withMessage('Sale price must be a non-negative number'),
        body('category_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .withMessage('Invalid category ID'),
        body('availability')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value === 'true' || value === true)
          .isBoolean()
          .withMessage('Availability must be a boolean'),
        body('dietary_tags')
          .optional()
          .customSanitizer(value => {
            if (!value) return [];
            try {
              const parsed = Array.isArray(value) ? value : JSON.parse(value);
              return Array.isArray(parsed) ? parsed : value.split(',').map(tag => tag.trim()).filter(tag => tag);
            } catch {
              return value.split(',').map(tag => tag.trim()).filter(tag => tag);
            }
          }),
        body('description')
          .optional()
          .isString()
          .trim()
          .withMessage('Description must be a string')
      );
      if (req.method === 'PUT' && req.path.match(/^\/menu-items\/\d+$/)) {
        validations.push(
          param('id')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid item ID is required')
        );
      }
    } else if (req.path.match(/^\/orders\/\d+\/approve$/) && req.method === 'POST') {
      // Keep approval lenient; main route will validate/parse the ID
    } else if (req.path.match(/^\/orders\/\d+\/cancel$/) && req.method === 'POST') {
      // Keep cancel lenient; route handles ID and optional restoreStock
    } else if (req.path.includes('/orders') && req.method === 'POST') {
      validations.push(
        body('items').optional().isArray().withMessage('Items must be an array'),
        body('items.*.item_id')
          .optional()
          .isInt({ min: 1 })
          .withMessage('Valid item ID is required'),
        body('items.*.quantity')
          .optional()
          .isInt({ min: 1 })
          .withMessage('Quantity must be at least 1'),
        body('items.*.unit_price')
          .optional()
          .isFloat({ min: 0.01 })
          .withMessage('Unit price must be a positive number'),
        body('items.*.supplement_id')
          .optional({ nullable: true })
          .customSanitizer(value => value === null || value === '' ? null : value)
          .isInt({ min: 1 })
          .withMessage('Valid supplement ID is required'),
        body('items.*.supplement_ids')
          .optional()
          .customSanitizer(value => {
            if (!value) return [];
            if (Array.isArray(value)) return value.map(v => parseInt(v, 10)).filter(v => !Number.isNaN(v));
            try {
              const parsed = JSON.parse(value);
              if (Array.isArray(parsed)) return parsed.map(v => parseInt(v, 10)).filter(v => !Number.isNaN(v));
            } catch {
              /* ignore parse failure and fall through */
            }
            return [parseInt(value, 10)].filter(v => !Number.isNaN(v));
          })
          .custom(value => Array.isArray(value) && value.every(v => Number.isInteger(v) && v > 0))
          .withMessage('Supplement IDs must be an array of positive integers'),
        body('items.*.supplement_price')
          .optional()
          .isFloat({ min: 0 })
          .withMessage('Supplement price must be a non-negative number'),
        body('items.*.supplement_name')
          .optional({ nullable: true })
          .customSanitizer(value => (value === null || value === undefined) ? '' : String(value))
          .isString()
          .withMessage('Supplement name must be a string'),
        body('total_price')
          .isFloat({ min: 0.01 })
          .withMessage('Total price must be a positive number'),
        body('order_type')
          .isIn(['delivery', 'local', 'takeaway', 'imported'])
          .withMessage('Order type must be delivery, local, takeaway, or imported'),
        body('delivery_address')
          .if(body('order_type').equals('delivery'))
          .notEmpty()
          .isString()
          .trim()
          .withMessage('Delivery address is required for delivery orders'),
        body('promotion_id')
          .optional()
          .isInt({ min: 1 })
          .withMessage('Valid promotion ID is required'),
        body('table_id')
          .if(body('order_type').equals('local'))
          .notEmpty()
          .isInt({ min: 1 })
          .withMessage('Table ID is required for local orders'),
        body('session_id')
          .notEmpty()
          .isString()
          .trim()
          .custom((value, { req }) => {
            const headerSessionId = req.headers['x-session-id'];
            const isStaffConsole = req.body?.source === 'staff-console';
            const isGuestSession = typeof value === 'string' && value.startsWith('guest-');
            if (headerSessionId && value !== headerSessionId && !isStaffConsole) {
              throw new Error('Session ID in body does not match X-Session-Id header');
            }
            if (!isStaffConsole && !isGuestSession && !isUuid(value)) {
              throw new Error('Session ID must be a valid UUID v4');
            }
            return true;
          })
          .withMessage('Valid session ID is required'),
        body('request_id')
          .optional()
          .isString()
          .trim()
          .custom(value => !value || isUuid(value))
          .withMessage('Request ID must be a valid UUID v4 if provided')
      );
    } else if (req.path.includes('/categories') && !req.path.includes('/supplements')) {
      validations.push(
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required'),
        body('name')
          .isString()
          .notEmpty()
          .trim()
          .withMessage('Name is required'),
        body('description')
          .optional()
          .isString()
          .trim()
          .withMessage('Description must be a string')
      );
      if (req.method === 'PUT') {
        validations.push(
          param('id')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid category ID is required')
        );
      }
    } else if (req.path.includes('/promotions')) {
      validations.push(
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required'),
        body('name')
          .isString()
          .notEmpty()
          .trim()
          .withMessage('Name is required'),
        body('description')
          .optional()
          .isString()
          .trim()
          .withMessage('Description must be a string'),
        body('discount_percentage')
          .isFloat({ min: 0, max: 100 })
          .withMessage('Discount percentage must be between 0 and 100'),
        body('item_id')
          .optional()
          .isInt({ min: 1 })
          .withMessage('Valid item ID is required'),
        body('start_date').isISO8601().withMessage('Valid start date is required'),
        body('end_date').isISO8601().withMessage('Valid end date is required'),
        body('active').isBoolean().withMessage('Active must be a boolean')
      );
      if (req.method === 'PUT') {
        validations.push(
          param('id')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid promotion ID is required')
        );
      }
    } else if (req.path.includes('/staff') || req.path.match(/^\/users(\/\d+)?$/)) {
      validations.push(
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required'),
        body('email').isEmail().withMessage('Valid email is required'),
        body('role')
          .isIn(['server', 'admin'])
          .withMessage('Role must be server or admin')
      );
      if (req.path.includes('/staff')) {
        validations.push(
          body('password')
            .isString()
            .notEmpty()
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters')
        );
      }
      if (req.method === 'PUT') {
        validations.push(
          param('id')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid user ID is required')
        );
      }
    } else if (req.path.includes('/tables')) {
      if (req.path.includes('/tables/bulk')) {
        validations.push(
          body('user_id')
            .optional()
            .customSanitizer((value, { req }) => {
              // default to authenticated user for bulk tables
              if (value === 0) return 0;
              if (!value && req.user?.id) return req.user.id;
              return value;
            })
            .toInt()
            .isInt({ min: 1 })
            .custom((value, { req }) => {
              if (!req.user) return true; // will be handled by route auth
              if (value && Number(req.user.id) !== Number(value)) {
                throw new Error('User ID does not match authenticated user');
              }
              return true;
            })
            .withMessage('Valid user ID matching authenticated user is required'),
          body('start_number')
            .isInt({ min: 1 })
            .withMessage('Start table number must be a positive number'),
          body('end_number')
            .isInt({ min: 1 })
            .withMessage('End table number must be a positive number'),
          body('capacity')
            .isInt({ min: 1 })
            .withMessage('Capacity must be a positive integer')
        );
      } else {
        validations.push(
          body('user_id')
            .optional()
            .isString()
            .trim()
            .customSanitizer(value => value ? parseInt(value) : undefined)
            .isInt({ min: 1 })
            .custom((value, { req }) => {
              if (value && (!req.user || req.user.id !== value)) {
                throw new Error('User ID does not match authenticated user');
              }
              return true;
            })
            .withMessage('Valid user ID matching authenticated user is required'),
          body('table_number')
            .isString()
            .notEmpty()
            .trim()
            .withMessage('Table number is required'),
          body('capacity')
            .isString()
            .trim()
            .customSanitizer(value => value ? parseInt(value) : undefined)
            .isInt({ min: 1 })
            .withMessage('Capacity must be a positive integer'),
          body('status')
            .optional()
            .isIn(['available', 'occupied'])
            .withMessage('Status must be available or occupied')
        );
        if (req.method === 'PUT') {
          validations.push(
            param('id')
              .isString()
              .trim()
              .customSanitizer(value => parseInt(value))
              .isInt({ min: 1 })
              .withMessage('Valid table ID is required')
          );
        }
      }
    } else if (req.path.includes('/reservations')) {
      validations.push(
        body('table_id')
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .withMessage('Valid table ID is required'),
        body('reservation_time').isISO8601().withMessage('Valid reservation time is required'),
        body('phone_number')
          .matches(/^\+\d{10,15}$/)
          .withMessage('Phone number must be in international format (e.g., +1234567890)')
      );
      if (req.method === 'PUT') {
        validations.push(
          param('id')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid reservation ID is required'),
          body('status')
            .isIn(['pending', 'confirmed', 'cancelled'])
            .withMessage('Valid status is required')
        );
      }
    } else if (req.path.includes('/supplements') && !req.path.includes('/menu-items')) {
      validations.push(
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required'),
        body('name')
          .isString()
          .notEmpty()
          .trim()
          .withMessage('Name is required'),
        body('price')
          .isString()
          .trim()
          .customSanitizer(value => value ? parseFloat(value) : undefined)
          .isFloat({ min: 0.01 })
          .withMessage('Price must be a positive number')
      );
      if (req.method === 'PUT') {
        validations.push(
          param('id')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid supplement ID is required')
        );
      }
    } else if (req.path.includes('/menu-items') && req.path.includes('/supplements')) {
      validations.push(
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required'),
        body('supplement_id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid supplement ID is required'),
        body('name')
          .isString()
          .notEmpty()
          .trim()
          .withMessage('Name is required'),
        body('additional_price')
          .isString()
          .trim()
          .customSanitizer(value => value ? parseFloat(value) : undefined)
          .isFloat({ min: 0 })
          .withMessage('Additional price must be a non-negative number'),
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid menu item ID is required')
      );
      if (req.method === 'PUT' && req.path.match(/^\/menu-items\/\d+\/supplements\/\d+$/)) {
        validations.push(
          param('menuItemId')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid menu item ID is required'),
          param('supplementId')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid supplement ID is required'),
          body('user_id')
            .optional()
            .isString()
            .trim()
            .customSanitizer(value => value ? parseInt(value) : undefined)
            .isInt({ min: 1 })
            .custom((value, { req }) => {
              if (value && (!req.user || req.user.id !== value)) {
                throw new Error('User ID does not match authenticated user');
              }
              return true;
            })
            .withMessage('Valid user ID matching authenticated user is required'),
          body('name')
            .isString()
            .notEmpty()
            .trim()
            .withMessage('Name is required'),
          body('additional_price')
            .isString()
            .trim()
            .customSanitizer(value => value ? parseFloat(value) : undefined)
            .isFloat({ min: 0 })
            .withMessage('Additional price must be a non-negative number')
        );
      }
      if (req.method === 'DELETE') {
        validations.push(
          param('menuItemId')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid menu item ID is required'),
          param('supplementId')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid supplement ID is required')
        );
      }
    } else if (req.path.includes('/notifications')) {
      // Skip validation for mark-read and clear endpoints
      if (req.method === 'PUT' && req.path.match(/^\/notifications\/\d+\/read$/)) {
        // no body required
      } else if (req.method === 'PUT' && req.path === '/notifications/clear') {
        // no body required
      } else {
      validations.push(
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required'),
        body('type')
          .isIn(['order', 'reservation'])
          .withMessage('Type must be order or reservation'),
        body('message')
          .isString()
          .notEmpty()
          .trim()
          .withMessage('Message is required'),
        body('ref_id')
          .isInt({ min: 1 })
          .withMessage('Valid reference ID is required')
      );
      }
    } else if (req.path.includes('/banners')) {
      validations.push(
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required'),
        body('title')
          .isString()
          .notEmpty()
          .trim()
          .withMessage('Title is required'),
        body('description')
          .optional()
          .isString()
          .trim()
          .withMessage('Description must be a string'),
        body('active')
          .isBoolean()
          .withMessage('Active must be a boolean')
      );
      if (req.method === 'PUT') {
        validations.push(
          param('id')
            .isString()
            .trim()
            .customSanitizer(value => parseInt(value))
            .isInt({ min: 1 })
            .withMessage('Valid banner ID is required')
        );
      }
    }
  }

  // GET and DELETE validations
  if (req.method === 'GET') {
    if (req.path.match(/^\/orders(?!.*(approve|session))/)) {
      validations.push(
        query('time_range')
          .optional()
          .isIn(['hour', 'day', 'yesterday', 'week', 'month'])
          .withMessage('Invalid time range'),
        query('approved')
          .optional()
          .isIn(['0', '1'])
          .withMessage('Approved must be 0 or 1')
      );
    }
    if (req.path.match(/^\/orders\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid order ID is required')
      );
    }
    if (req.path.match(/^\/menu-items\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid item ID is required')
      );
    }
    if (req.path.match(/^\/categories\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid category ID is required')
      );
    }
  }

  if (req.method === 'DELETE') {
    if (req.path.match(/^\/menu-items\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid item ID is required'),
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required')
      );
    } else if (req.path.match(/^\/categories\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid category ID is required'),
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('Invalid user ID');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required')
      );
    } else if (req.path.match(/^\/promotions\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Invalid promotion ID'),
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('Invalid user ID');
            }
            return true;
          })
          .withMessage('Valid user ID')
      );
    } else if (req.path.match(/^\/staff\/\d+$/) || req.path.match(/^\/users\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Invalid user ID'),
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('Invalid user ID');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user')
      );
    } else if (req.path.match(/^\/tables\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid table ID is required'),
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required')
      );
    } else if (req.path.match(/^\/supplements\/\d+$/)) {
      validations.push(
        param('id')
          .isString()
          .trim()
          .customSanitizer(value => parseInt(value))
          .isInt({ min: 1 })
          .withMessage('Valid supplement ID is required'),
        body('user_id')
          .optional()
          .isString()
          .trim()
          .customSanitizer(value => value ? parseInt(value) : undefined)
          .isInt({ min: 1 })
          .custom((value, { req }) => {
            if (value && (!req.user || req.user.id !== value)) {
              throw new Error('User ID does not match authenticated user');
            }
            return true;
          })
          .withMessage('Valid user ID matching authenticated user is required')
      );
    }
  }

  Promise.all(validations.map(validation => validation.run(req))).then(() => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Validation errors', {
        errors: errors.array(),
        method: req.method,
        path: req.path,
        body: req.body,
        params: req.params,
        query: req.query,
        headers: { 'x-session-id': req.headers['x-session-id'] },
      });
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  }).catch(err => {
    logger.error('Validation middleware error', {
      error: err.message,
      method: req.method,
      path: req.path,
    });
    res.status(500).json({ error: 'Internal validation error' });
  });
};

module.exports = validate;
