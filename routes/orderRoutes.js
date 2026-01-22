const express = require('express');
const router = express.Router();
const db = require('../config/db');
const logger = require('../logger');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');

const recentRequests = new Map();

const checkAdminOrServer = async (userId) => {
  if (!userId) return false;
  const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
  return rows.length > 0 && ['admin', 'server'].includes(rows[0].role);
};

module.exports = (io) => {
  router.post('/orders', async (req, res) => {
    const { items, breakfastItems, total_price, order_type, delivery_address, promotion_id, table_id, request_id, notes, session_id, source } = req.body;
    const isStaffRequest = req.user && ['admin', 'server'].includes(req.user.role) && source === 'staff-console';
    const autoApprove = isStaffRequest;
    const sessionId = session_id || req.headers['x-session-id'] || req.sessionID || (isStaffRequest ? `staff-${req.user.id}-${uuidv4()}` : null);
    const deviceId = req.headers['x-device-id'] || (isStaffRequest ? `staff-device-${req.user.id}` : 'unknown');
    const userAgent = req.headers['user-agent'] || 'unknown';
    const ipAddress = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const timestamp = new Date().toISOString();

    // Validate deviceId
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!isStaffRequest && (!deviceId || deviceId === 'unknown' || !uuidRegex.test(deviceId))) {
      logger.warn('Invalid or missing deviceId', { deviceId, sessionId, timestamp });
      return res.status(400).json({ error: 'Valid device ID is required' });
    }

    // Log fingerprint inputs for debugging
    logger.debug('Device fingerprint inputs', { ipAddress, userAgent, deviceId, sessionId, timestamp, isStaffRequest });

    // Generate device fingerprint using deviceId and a secondary IP+UA fingerprint to avoid easy rotation
    const deviceFingerprint = crypto
      .createHash('sha256')
      .update(deviceId)
      .digest('hex');
    const ipFingerprint = crypto
      .createHash('sha256')
      .update(`${ipAddress}|${userAgent}`)
      .digest('hex');

    logger.info('Received order request', {
      items: items?.length || 0,
      breakfastItems: breakfastItems?.length || 0,
      request_id: null,
      table_id,
      supplements: items?.map(i => ({ item_id: i.item_id, supplement_id: i.supplement_id, supplement_ids: i.supplement_ids })) || [],
      sessionId,
      deviceId,
      deviceFingerprint,
      ipFingerprint,
      timestamp,
      notes,
    });

    try {
      if (!isStaffRequest) {
        // Clean up old entries from device_order_limits (older than 1 hour)
        await db.query(
          'DELETE FROM device_order_limits WHERE order_timestamp < NOW() - INTERVAL 1 HOUR'
        );

        // Rate limiting: Check orders in the last hour for this device
        const fingerprintsToCheck = Array.from(new Set([deviceFingerprint, ipFingerprint]));
        const fingerprintPlaceholders = fingerprintsToCheck.map(() => '?').join(', ');
        const [orderCountRows] = await db.query(
          `SELECT COUNT(*) as order_count FROM device_order_limits WHERE device_fingerprint IN (${fingerprintPlaceholders}) AND order_timestamp >= NOW() - INTERVAL 1 HOUR`,
          fingerprintsToCheck
        );
        const orderCount = parseInt(orderCountRows[0].order_count, 10);

        logger.info('Rate limit check', {
          deviceId,
          deviceFingerprint,
          ipFingerprint,
          orderCount,
          sessionId,
          timestamp
        });

        if (orderCount >= 3) {
          logger.warn('Rate limit exceeded for device', { deviceId, deviceFingerprint, ipFingerprint, orderCount, sessionId, timestamp });
          return res.status(429).json({ error: 'Order limit exceeded. Only 3 orders per hour are allowed per device/user agent combination.' });
        }
      }

      if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
        logger.warn('Invalid or missing sessionId', { sessionId, timestamp });
        return res.status(400).json({ error: 'Valid session ID is required' });
      }

      const orderHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ items, breakfastItems, table_id, order_type, total_price, sessionId, notes }))
        .digest('hex');
      if (recentRequests.has(orderHash)) {
        logger.warn('Duplicate order submission detected', { sessionId, orderHash, timestamp });
        return res.status(429).json({ error: 'Duplicate order detected. Please wait a moment.' });
      }
      recentRequests.set(orderHash, timestamp);
      setTimeout(() => recentRequests.delete(orderHash), 15000);

      if (!items?.length && !breakfastItems?.length) {
        logger.warn('Invalid or empty items', { sessionId, timestamp });
        return res.status(400).json({ error: 'Items or breakfast items array is required and non-empty' });
      }
      if (!order_type || !['local', 'delivery', 'takeaway', 'imported'].includes(order_type)) {
        logger.warn('Invalid order_type', { order_type, sessionId, timestamp });
        return res.status(400).json({ error: 'Invalid order type' });
      }
      if (order_type === 'local' && (!table_id || isNaN(parseInt(table_id)))) {
        logger.warn('Invalid table_id', { table_id, sessionId, timestamp });
        return res.status(400).json({ error: 'Table ID required for local orders' });
      }
      if (order_type === 'delivery' && (!delivery_address || !delivery_address.trim())) {
        logger.warn('Missing delivery address', { sessionId, timestamp });
        return res.status(400).json({ error: 'Delivery address required' });
      }

      let calculatedTotal = 0;

      if (items && Array.isArray(items)) {
        for (const item of items) {
          const { item_id, quantity, unit_price } = item;
          const supplementIds = Array.isArray(item.supplement_ids)
            ? item.supplement_ids.map(id => parseInt(id, 10)).filter(id => !Number.isNaN(id))
            : [];
          if (item.supplement_id && !supplementIds.includes(item.supplement_id)) {
            supplementIds.push(parseInt(item.supplement_id, 10));
          }
          if (!item_id || isNaN(item_id) || item_id <= 0) {
            logger.warn('Invalid item_id', { item_id, sessionId, timestamp });
            return res.status(400).json({ error: `Invalid item_id: ${item_id}` });
          }
          if (!quantity || isNaN(quantity) || quantity <= 0) {
            logger.warn('Invalid quantity', { item_id, quantity, sessionId, timestamp });
            return res.status(400).json({ error: `Invalid quantity for item ${item_id}` });
          }
          if (!unit_price || isNaN(parseFloat(unit_price)) || parseFloat(unit_price) <= 0) {
            logger.warn('Invalid unit_price', { item_id, unit_price, sessionId, timestamp });
            return res.status(400).json({ error: `Invalid unit_price for item ${item_id}` });
          }

          const [menuItem] = await db.query('SELECT availability, regular_price, sale_price FROM menu_items WHERE id = ?', [item_id]);
          if (menuItem.length === 0 || !menuItem[0].availability) {
            logger.warn('Item unavailable', { item_id, sessionId, timestamp });
            return res.status(400).json({ error: `Item ${item_id} is unavailable` });
          }
          let expectedPrice = menuItem[0].sale_price !== null ? parseFloat(menuItem[0].sale_price) : parseFloat(menuItem[0].regular_price);
          let itemTotal = expectedPrice;

          if (supplementIds.length > 0) {
            const [supplements] = await db.query(
              `SELECT supplement_id, additional_price FROM menu_item_supplements WHERE menu_item_id = ? AND supplement_id IN (?)`,
              [item_id, supplementIds]
            );
            if (supplements.length !== supplementIds.length) {
              const foundIds = supplements.map(s => s.supplement_id);
              logger.warn('Invalid supplements', { item_id, supplementIds, foundIds, sessionId, timestamp });
              return res.status(400).json({ error: `Invalid supplement IDs for item ${item_id}. Provided: [${supplementIds.join(', ')}], Found: [${foundIds.join(', ')}]` });
            }
            const supplementPrice = supplements.reduce((sum, supp) => sum + parseFloat(supp.additional_price || 0), 0);
            itemTotal += supplementPrice;
          }

          if (Math.abs(parseFloat(unit_price) - itemTotal) > 0.01) {
            logger.warn('Price mismatch', { item_id, provided: unit_price, expected: itemTotal, sessionId, timestamp, supplementIds });
            return res.status(400).json({ error: `Invalid unit_price for item ${item_id}. Expected ${itemTotal}, got ${unit_price}` });
          }
          calculatedTotal += itemTotal * quantity;
        }
      }

      const breakfastMap = new Map();
      if (breakfastItems && Array.isArray(breakfastItems)) {
        for (const item of breakfastItems) {
          const { breakfast_id, quantity, unit_price, option_ids } = item;
          if (!breakfast_id || isNaN(breakfast_id) || breakfast_id <= 0) {
            logger.warn('Invalid breakfast_id', { breakfast_id, sessionId, timestamp });
            return res.status(400).json({ error: `Invalid breakfast_id: ${breakfast_id}` });
          }
          if (!quantity || isNaN(quantity) || quantity <= 0) {
            logger.warn('Invalid quantity', { breakfast_id, quantity, sessionId, timestamp });
            return res.status(400).json({ error: `Invalid quantity for breakfast ${breakfast_id}` });
          }
          if (!unit_price || isNaN(parseFloat(unit_price)) || parseFloat(unit_price) <= 0) {
            logger.warn('Invalid unit_price', { breakfast_id, unit_price, sessionId, timestamp });
            return res.status(400).json({ error: `Invalid unit_price for breakfast ${breakfast_id}` });
          }

          const [breakfast] = await db.query('SELECT availability, price FROM breakfasts WHERE id = ?', [breakfast_id]);
          if (breakfast.length === 0 || !breakfast[0].availability) {
            logger.warn('Breakfast unavailable', { breakfast_id, sessionId, timestamp });
            return res.status(400).json({ error: `Breakfast ${breakfast_id} is unavailable` });
          }
          let expectedPrice = parseFloat(breakfast[0].price);

          const [groups] = await db.query(
            `SELECT DISTINCT bog.id, bog.is_required, bog.title
             FROM breakfast_option_groups bog
             LEFT JOIN breakfast_options bo ON bo.group_id = bog.id
             WHERE bog.breakfast_id = ? AND bo.id IS NOT NULL
             UNION
             SELECT DISTINCT bog.id, bog.is_required, bog.title
             FROM breakfast_option_groups bog
             INNER JOIN breakfast_option_group_mappings bogm ON bog.id = bogm.option_group_id
             LEFT JOIN breakfast_options bo ON bo.group_id = bog.id
             WHERE bogm.breakfast_id = ? AND bog.breakfast_id IS NULL AND bo.id IS NOT NULL`,
            [breakfast_id, breakfast_id]
          );

          logger.info('Fetched option groups for breakfast', {
            breakfast_id,
            groupCount: groups.length,
            requiredGroups: groups.filter(g => g.is_required).map(g => ({ id: g.id, title: g.title })),
            sessionId,
            timestamp
          });

          if (option_ids && Array.isArray(option_ids) && option_ids.length > 0) {
            const [options] = await db.query(
              `SELECT bo.id, bo.group_id, bo.additional_price
               FROM breakfast_options bo
               JOIN breakfast_option_groups bog ON bo.group_id = bog.id
               WHERE (bo.breakfast_id = ? OR bo.breakfast_id IS NULL)
               AND bo.id IN (?)`,
              [breakfast_id, option_ids]
            );
            if (options.length !== option_ids.length) {
              logger.warn('Invalid breakfast options', {
                breakfast_id,
                provided_option_ids: option_ids,
                found_options: options.map(o => o.id),
                sessionId,
                timestamp
              });
              return res.status(400).json({
                error: `Invalid option IDs for breakfast ${breakfast_id}. Provided: [${option_ids.join(', ')}], Found: [${options.map(o => o.id).join(', ')}]`
              });
            }
            const selectedGroups = new Set(options.map(opt => opt.group_id));
            const requiredGroups = groups.filter(g => g.is_required).map(g => g.id);
            const missingRequiredGroups = requiredGroups.filter(g => !selectedGroups.has(g));
            if (missingRequiredGroups.length > 0) {
              const missingGroupTitles = groups
                .filter(g => missingRequiredGroups.includes(g.id))
                .map(g => g.title || `Group ${g.id}`)
                .join(', ');
              logger.warn('Missing required options', {
                breakfast_id,
                missingGroups: missingRequiredGroups,
                missingGroupTitles,
                sessionId,
                timestamp
              });
              return res.status(400).json({
                error: `Must select one option from each required option group for breakfast ${breakfast_id}. Missing groups: [${missingGroupTitles}]`
              });
            }
            const optionPrice = options.reduce((sum, opt) => sum + parseFloat(opt.additional_price || 0), 0);
            expectedPrice += optionPrice;
          } else if (groups.length > 0) {
            const requiredGroups = groups.filter(g => g.is_required);
            if (requiredGroups.length > 0) {
              const requiredGroupTitles = requiredGroups.map(g => g.title || `Group ${g.id}`).join(', ');
              logger.warn('No options provided but required groups exist', {
                breakfast_id,
                requiredGroupCount: requiredGroups.length,
                requiredGroupTitles,
                sessionId,
                timestamp
              });
              return res.status(400).json({
                error: `Must select one option from each of the ${requiredGroups.length} required option groups for breakfast ${breakfast_id}. Required groups: [${requiredGroupTitles}]`
              });
            }
          }

          const providedPrice = parseFloat(unit_price);
          if (isNaN(providedPrice) || providedPrice <= 0) {
            logger.warn('Invalid unit_price', { breakfast_id, unit_price, sessionId, timestamp });
            return res.status(400).json({ error: `Invalid unit_price for breakfast ${breakfast_id}` });
          }
          if (providedPrice + 0.01 < expectedPrice) {
            logger.warn('Price below expected', { breakfast_id, provided: unit_price, expected: expectedPrice, sessionId, timestamp });
            return res.status(400).json({ error: `Invalid unit_price for breakfast ${breakfast_id}. Expected at least ${expectedPrice}, got ${unit_price}` });
          }
          // Allow minor overage (treat provided price if higher than calculated to support future surcharges)
          if (providedPrice > expectedPrice) {
            expectedPrice = providedPrice;
          }

          if (!breakfastMap.has(breakfast_id)) {
            breakfastMap.set(breakfast_id, { breakfast_id, quantity: 0, unit_price: expectedPrice, option_ids: [] });
          }
          const breakfastEntry = breakfastMap.get(breakfast_id);
          breakfastEntry.quantity += quantity;
          if (option_ids && Array.isArray(option_ids)) {
            breakfastEntry.option_ids.push(...option_ids.filter(id => !breakfastEntry.option_ids.includes(id)));
          }
          calculatedTotal += expectedPrice * quantity;
        }
      }

      let tableRecord = null;
      let effectiveTableId = table_id;
      if (order_type === 'local' && table_id) {
        const [tableRows] = await db.query('SELECT id, status FROM tables WHERE id = ? OR table_number = ?', [table_id, table_id]);
        if (tableRows.length === 0) {
          logger.warn('Invalid table', { table_id, sessionId, timestamp });
          return res.status(400).json({ error: 'Table does not exist' });
        }
        tableRecord = tableRows[0];
        effectiveTableId = tableRecord.id;
        if (tableRecord.status === 'reserved') {
          logger.warn('Table reserved', { table_id, sessionId, timestamp });
          return res.status(400).json({ error: 'Table is reserved' });
        }
        if (tableRecord.status !== 'occupied') {
          await db.query('UPDATE tables SET status = ? WHERE id = ?', ['occupied', tableRecord.id]);
        }
      }

      let discount = 0;
      if (promotion_id) {
        const [promo] = await db.query(
          'SELECT discount_percentage, item_id FROM promotions WHERE id = ? AND active = TRUE AND NOW() BETWEEN start_date AND end_date',
          [promotion_id]
        );
        if (promo.length > 0) {
          discount = promo[0].discount_percentage / 100;
          let promoCalculatedPrice = 0;

          if (items && Array.isArray(items)) {
            for (const item of items) {
              const [menuItem] = await db.query('SELECT regular_price, sale_price FROM menu_items WHERE id = ?', [item.item_id]);
              let itemPrice = (menuItem[0].sale_price !== null ? parseFloat(menuItem[0].sale_price) : parseFloat(menuItem[0].regular_price)) * item.quantity;

              const promoSupplementIds = Array.isArray(item.supplement_ids)
                ? item.supplement_ids.map(id => parseInt(id, 10)).filter(id => !Number.isNaN(id))
                : [];
              if (item.supplement_id && !promoSupplementIds.includes(item.supplement_id)) {
                promoSupplementIds.push(parseInt(item.supplement_id, 10));
              }

              if (promoSupplementIds.length > 0) {
                const [supplements] = await db.query(
                  'SELECT additional_price FROM menu_item_supplements WHERE menu_item_id = ? AND supplement_id IN (?)',
                  [item.item_id, promoSupplementIds]
                );
                const suppPrice = supplements.reduce((sum, supp) => sum + parseFloat(supp.additional_price || 0), 0) * item.quantity;
                itemPrice += suppPrice;
              }

              promoCalculatedPrice += (!promo[0].item_id || item.item_id === promo[0].item_id) ? itemPrice * (1 - discount) : itemPrice;
            }
          }

          if (breakfastItems && Array.isArray(breakfastItems)) {
            for (const item of breakfastItems) {
              const [breakfast] = await db.query('SELECT price FROM breakfasts WHERE id = ?', [item.breakfast_id]);
              let itemPrice = parseFloat(breakfast[0].price) * item.quantity;
              if (item.option_ids && Array.isArray(item.option_ids)) {
                const [options] = await db.query(
                  'SELECT additional_price FROM breakfast_options WHERE breakfast_id = ? AND id IN (?)',
                  [item.breakfast_id, item.option_ids]
                );
                const optionPrice = options.reduce((sum, opt) => sum + parseFloat(opt.additional_price || 0), 0) * item.quantity;
                itemPrice += optionPrice;
              }
              promoCalculatedPrice += itemPrice;
            }
          }

          calculatedTotal = promoCalculatedPrice;
        }
      }

      const providedPrice = parseFloat(total_price) || 0;
      if (Math.abs(providedPrice - calculatedTotal) > 0.01) {
        logger.warn('Total price mismatch', { providedPrice, calculatedPrice: calculatedTotal, sessionId, timestamp });
        return res.status(400).json({ error: `Total price mismatch. Expected ${calculatedTotal.toFixed(2)}, got ${providedPrice.toFixed(2)}` });
      }

      const connection = await db.getConnection();
      await connection.beginTransaction();

      try {
        const [orderResult] = await connection.query(
          'INSERT INTO orders (total_price, order_type, delivery_address, promotion_id, table_id, session_id, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [calculatedTotal, order_type, delivery_address || null, promotion_id || null, order_type === 'local' ? effectiveTableId : null, sessionId, notes || null, autoApprove ? 'preparing' : 'pending']
        );
        const orderId = orderResult.insertId;

        // Record the order attempt in device_order_limits (only for public/client orders)
        if (!isStaffRequest) {
          const limitFingerprints = Array.from(new Set([deviceFingerprint, ipFingerprint]));
          for (const fp of limitFingerprints) {
            await connection.query(
              'INSERT INTO device_order_limits (device_fingerprint, order_timestamp, device_id) VALUES (?, ?, ?)',
              [fp, new Date(), deviceId]
            );
          }
        }

        if (items && Array.isArray(items)) {
          for (const item of items) {
            const supplementIds = Array.isArray(item.supplement_ids)
              ? item.supplement_ids.map(id => parseInt(id, 10)).filter(id => !Number.isNaN(id))
              : [];
            if (item.supplement_id && !supplementIds.includes(item.supplement_id)) {
              supplementIds.push(parseInt(item.supplement_id, 10));
            }
            const primarySupplementId = supplementIds.length > 0 ? supplementIds[0] : null;
            await connection.query(
              'INSERT INTO order_items (order_id, item_id, quantity, unit_price, supplement_id) VALUES (?, ?, ?, ?, ?)',
              [orderId, item.item_id, item.quantity, item.unit_price, primarySupplementId]
            );
          }
        }

        if (breakfastItems && Array.isArray(breakfastItems)) {
          for (const [breakfast_id, { quantity, unit_price, option_ids }] of breakfastMap) {
            const [orderItemResult] = await connection.query(
              'INSERT INTO order_items (order_id, breakfast_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
              [orderId, breakfast_id, quantity, unit_price]
            );
            const orderItemId = orderItemResult.insertId;
            if (option_ids && Array.isArray(option_ids) && option_ids.length > 0) {
              for (const optionId of option_ids) {
                await connection.query(
                  'INSERT INTO breakfast_order_options (order_item_id, breakfast_option_id) VALUES (?, ?)',
                  [orderItemId, optionId]
                );
              }
            }
          }
        }

        // Auto-approve staff-created orders with immediate stock deduction
        if (autoApprove) {
          const ingredientUsage = new Map();

          const [orderItems] = await connection.query(
            'SELECT item_id, breakfast_id, quantity, supplement_id FROM order_items WHERE order_id = ?',
            [orderId]
          );
          const [breakfastOptions] = await connection.query(
            'SELECT boo.breakfast_option_id FROM breakfast_order_options boo JOIN order_items oi ON boo.order_item_id = oi.id WHERE oi.order_id = ?',
            [orderId]
          );

          for (const item of orderItems) {
            const { item_id, breakfast_id, quantity, supplement_id } = item;

            if (item_id) {
              const [menuItemIngredients] = await connection.query(
                'SELECT ingredient_id, quantity AS ingredient_quantity FROM menu_item_ingredients WHERE menu_item_id = ?',
                [item_id]
              );
              for (const ing of menuItemIngredients) {
                const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
                ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
              }
            }

            if (supplement_id) {
              const [supplementIngredients] = await connection.query(
                'SELECT ingredient_id, quantity AS ingredient_quantity FROM supplement_ingredients WHERE supplement_id = ?',
                [supplement_id]
              );
              for (const ing of supplementIngredients) {
                const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
                ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
              }
            }

            if (breakfast_id) {
              const [breakfastIngredients] = await connection.query(
                'SELECT ingredient_id, quantity AS ingredient_quantity FROM breakfast_ingredients WHERE breakfast_id = ?',
                [breakfast_id]
              );
              for (const ing of breakfastIngredients) {
                const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
                ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
              }
            }
          }

          for (const option of breakfastOptions) {
            const [optionIngredients] = await connection.query(
              'SELECT ingredient_id, quantity AS ingredient_quantity FROM breakfast_option_ingredients WHERE breakfast_option_id = ?',
              [option.breakfast_option_id]
            );
            for (const ing of optionIngredients) {
              const totalQuantity = parseFloat(ing.ingredient_quantity);
              ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
            }
          }

          for (const [ingredientId, requiredQuantity] of ingredientUsage) {
            const [stock] = await connection.query(
              'SELECT name, quantity_in_stock FROM ingredients WHERE id = ? FOR UPDATE',
              [ingredientId]
            );

            if (stock.length === 0) {
              await connection.rollback();
              logger.warn('Ingredient not found during auto-approval', { ingredientId, orderId, sessionId, timestamp });
              return res.status(400).json({ error: `Ingredient ID ${ingredientId} not found` });
            }

            const availableStock = parseFloat(stock[0].quantity_in_stock);
            if (availableStock < requiredQuantity) {
              await connection.rollback();
              logger.warn('Insufficient stock during auto-approval', {
                ingredientId,
                ingredientName: stock[0].name,
                required: requiredQuantity,
                available: availableStock,
                orderId,
                sessionId,
                timestamp
              });
              return res.status(400).json({
                error: `Insufficient stock for ${stock[0].name}. Required: ${requiredQuantity}, Available: ${availableStock}`
              });
            }

            const newQuantity = availableStock - requiredQuantity;
            await connection.query(
              'UPDATE ingredients SET quantity_in_stock = ?, updated_at = NOW() WHERE id = ?',
              [newQuantity, ingredientId]
            );
            await connection.query(
              'INSERT INTO stock_transactions (ingredient_id, quantity, transaction_type, order_id, reason) VALUES (?, ?, ?, ?, ?)',
              [ingredientId, -requiredQuantity, 'deduction', orderId, 'Order approval']
            );
          }

          await connection.query(
            'UPDATE orders SET approved = 1, status = ? WHERE id = ?',
            ['preparing', orderId]
          );
        }

        const [orderDetails] = await connection.query(`
          SELECT o.*, t.table_number,
                 GROUP_CONCAT(oi.item_id) AS item_ids,
                 GROUP_CONCAT(CASE WHEN oi.item_id IS NOT NULL THEN oi.quantity END) AS menu_quantities,
                 GROUP_CONCAT(mi.name) AS item_names, GROUP_CONCAT(mi.image_url) AS image_urls,
                 GROUP_CONCAT(oi.unit_price) AS unit_prices, GROUP_CONCAT(oi.supplement_id) AS supplement_ids,
                 GROUP_CONCAT(mis.name) AS supplement_names, GROUP_CONCAT(mis.additional_price) AS supplement_prices,
                 GROUP_CONCAT(DISTINCT oi.breakfast_id) AS breakfast_ids,
                 GROUP_CONCAT(CASE WHEN oi.breakfast_id IS NOT NULL THEN oi.quantity END) AS breakfast_quantities,
                 GROUP_CONCAT(DISTINCT b.name) AS breakfast_names,
                 GROUP_CONCAT(DISTINCT b.image_url) AS breakfast_images,
                 GROUP_CONCAT(boo.breakfast_option_id) AS breakfast_option_ids,
                 GROUP_CONCAT(bo.option_name) AS breakfast_option_names,
                 GROUP_CONCAT(bo.additional_price) AS breakfast_option_prices
          FROM orders o
          LEFT JOIN order_items oi ON o.id = oi.order_id
          LEFT JOIN menu_items mi ON oi.item_id = mi.id
          LEFT JOIN menu_item_supplements mis ON oi.supplement_id = mis.supplement_id AND oi.item_id = mis.menu_item_id
          LEFT JOIN breakfasts b ON oi.breakfast_id = b.id
          LEFT JOIN breakfast_order_options boo ON oi.id = boo.order_item_id
          LEFT JOIN breakfast_options bo ON boo.breakfast_option_id = bo.id
          LEFT JOIN tables t ON o.table_id = t.id
          WHERE o.id = ?
          GROUP BY o.id
        `, [orderId]);

        orderDetails[0].approved = Number(orderDetails[0].approved);

        let notification = null;
        if (!isStaffRequest) {
          let notificationMessage;
          if (order_type === 'local') {
            notificationMessage = `New order #${orderId} for Table ${orderDetails[0].table_number || effectiveTableId || 'N/A'}`;
          } else if (order_type === 'delivery') {
            notificationMessage = `New delivery order #${orderId} for ${delivery_address}`;
          } else {
            notificationMessage = `New imported order #${orderId}`;
          }

          const [notificationResult] = await connection.query(
            'INSERT INTO notifications (type, reference_id, message) VALUES (?, ?, ?)',
            ['order', orderId, notificationMessage]
          );
          const notificationId = notificationResult.insertId;

          const [rows] = await connection.query('SELECT * FROM notifications WHERE id = ?', [notificationId]);
          notification = rows[0];
        }

        await connection.commit();

        if (!isStaffRequest) {
          io.to('staff-notifications').emit('newOrder', orderDetails[0]);
          io.to(`guest-${sessionId}`).emit('newOrder', orderDetails[0]);

          if (notification) {
            io.to('staff-notifications').emit('newNotification', {
              id: notification.id,
              type: notification.type,
              reference_id: notification.reference_id,
              message: notification.message,
              is_read: Number(notification.is_read),
              created_at: notification.created_at.toISOString(),
            });
          }
        }

        if (order_type === 'local' && effectiveTableId) {
          io.to('staff-notifications').emit('tableStatusUpdate', { id: effectiveTableId, status: 'occupied' });
        }

        logger.info('Order created successfully', {
          orderId,
          items: items?.length || 0,
          breakfastItems: breakfastItems?.length || 0,
          supplements: items?.map(i => ({ item_id: i.item_id, supplement_id: i.supplement_id })) || [],
          table_id,
          total_price: calculatedTotal,
          notificationId: notification?.id || null,
          sessionId,
          deviceId,
          deviceFingerprint,
          timestamp,
          notes,
        });
        res.status(201).json({ message: 'Order created', orderId });
      } catch (err) {
        await connection.rollback();
        logger.error('Error creating order in transaction', { error: err.message, table_id, sessionId, deviceId, deviceFingerprint, timestamp });
        res.status(500).json({ error: 'Failed to create order' });
      } finally {
        connection.release();
      }
    } catch (err) {
      logger.error('Error creating order', { error: err.message, table_id, sessionId, deviceId, deviceFingerprint, timestamp });
      res.status(500).json({ error: 'Failed to create order' });
    }
  });

  router.get('/orders', async (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.sessionID;
    const timestamp = new Date().toISOString();
    const { time_range, approved } = req.query;

    try {
      if (!req.user || !await checkAdminOrServer(req.user.id)) {
        logger.warn('Unauthorized attempt to fetch orders', { authenticatedUser: req.user, sessionId, timestamp });
        return res.status(403).json({ error: 'Admin or server access required' });
      }

      let query = `
        SELECT o.*, t.table_number,
               GROUP_CONCAT(oi.item_id) AS item_ids,
               GROUP_CONCAT(CASE WHEN oi.item_id IS NOT NULL THEN oi.quantity END) AS menu_quantities,
               GROUP_CONCAT(mi.name) AS item_names, GROUP_CONCAT(mi.image_url) AS image_urls,
               GROUP_CONCAT(oi.unit_price) AS unit_prices, GROUP_CONCAT(oi.supplement_id) AS supplement_ids,
               GROUP_CONCAT(mis.name) AS supplement_names, GROUP_CONCAT(mis.additional_price) AS supplement_prices,
               GROUP_CONCAT(DISTINCT oi.breakfast_id) AS breakfast_ids,
               GROUP_CONCAT(CASE WHEN oi.breakfast_id IS NOT NULL THEN oi.quantity END) AS breakfast_quantities,
               GROUP_CONCAT(DISTINCT b.name) AS breakfast_names,
               GROUP_CONCAT(DISTINCT b.image_url) AS breakfast_images,
               GROUP_CONCAT(boo.breakfast_option_id) AS breakfast_option_ids,
               GROUP_CONCAT(bo.option_name) AS breakfast_option_names,
               GROUP_CONCAT(bo.additional_price) AS breakfast_option_prices
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN menu_items mi ON oi.item_id = mi.id
        LEFT JOIN menu_item_supplements mis ON oi.supplement_id = mis.supplement_id AND oi.item_id = mi.id
        LEFT JOIN breakfasts b ON oi.breakfast_id = b.id
        LEFT JOIN breakfast_order_options boo ON oi.id = boo.order_item_id
        LEFT JOIN breakfast_options bo ON boo.breakfast_option_id = bo.id
        LEFT JOIN tables t ON o.table_id = t.id
      `;
      let queryParams = [];
      let whereClauses = [];

      if (time_range === 'hour') {
        whereClauses.push('o.created_at >= NOW() - INTERVAL 1 HOUR');
      } else if (time_range === 'day') {
        whereClauses.push('o.created_at >= CURDATE()');
      } else if (time_range === 'yesterday') {
        whereClauses.push('o.created_at >= CURDATE() - INTERVAL 1 DAY AND o.created_at < CURDATE()');
      } else if (time_range === 'week') {
        whereClauses.push('o.created_at >= CURDATE() - INTERVAL 7 DAY');
      } else if (time_range === 'month') {
        whereClauses.push('o.created_at >= CURDATE() - INTERVAL 30 DAY');
      }

      if (approved === '1') {
        whereClauses.push('o.approved = 1');
      } else if (approved === '0') {
        whereClauses.push('o.approved = 0');
      }

      if (req.user && req.user.role === 'server') {
        whereClauses.push("o.session_id NOT LIKE 'staff-%'");
      }

      if (whereClauses.length > 0) {
        query += ' WHERE ' + whereClauses.join(' AND ');
      }

      query += ' GROUP BY o.id ORDER BY o.created_at DESC';

      const [rows] = await db.query(query, queryParams);

      const formattedRows = rows.map(row => ({
        ...row,
        approved: Number(row.approved),
        status: row.status || 'pending',
      }));

      logger.info('Orders fetched successfully', { count: rows.length, time_range, approved, sessionId, timestamp });
      res.json({ data: formattedRows });
    } catch (err) {
      logger.error('Error fetching orders', { error: err.message, time_range, approved, sessionId, timestamp });
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  router.get('/orders/:id', async (req, res) => {
    const { id } = req.params;
    const sessionId = req.headers['x-session-id'] || req.sessionID;
    const timestamp = new Date().toISOString();

    try {
      const orderId = parseInt(id);
      if (isNaN(orderId) || orderId <= 0) {
        logger.warn('Invalid order ID', { orderId: id, sessionId, timestamp });
        return res.status(400).json({ error: 'Valid order ID required' });
      }

      const [rows] = await db.query(`
        SELECT o.*, t.table_number,
               GROUP_CONCAT(oi.item_id) AS item_ids,
               GROUP_CONCAT(CASE WHEN oi.item_id IS NOT NULL THEN oi.quantity END) AS menu_quantities,
               GROUP_CONCAT(mi.name) AS item_names, GROUP_CONCAT(mi.image_url) AS image_urls,
               GROUP_CONCAT(oi.unit_price) AS unit_prices, GROUP_CONCAT(oi.supplement_id) AS supplement_ids,
               GROUP_CONCAT(mis.name) AS supplement_names, GROUP_CONCAT(mis.additional_price) AS supplement_prices,
               GROUP_CONCAT(DISTINCT oi.breakfast_id) AS breakfast_ids,
               GROUP_CONCAT(CASE WHEN oi.breakfast_id IS NOT NULL THEN oi.quantity END) AS breakfast_quantities,
               GROUP_CONCAT(DISTINCT b.name) AS breakfast_names,
               GROUP_CONCAT(DISTINCT b.image_url) AS breakfast_images,
               GROUP_CONCAT(boo.breakfast_option_id) AS breakfast_option_ids,
               GROUP_CONCAT(bo.option_name) AS breakfast_option_names,
               GROUP_CONCAT(bo.additional_price) AS breakfast_option_prices
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN menu_items mi ON oi.item_id = mi.id
        LEFT JOIN menu_item_supplements mis ON oi.supplement_id = mis.supplement_id AND oi.item_id = mi.id
        LEFT JOIN breakfasts b ON oi.breakfast_id = b.id
        LEFT JOIN breakfast_order_options boo ON oi.id = boo.order_item_id
        LEFT JOIN breakfast_options bo ON boo.breakfast_option_id = bo.id
        LEFT JOIN tables t ON o.table_id = t.id
        WHERE o.id = ?
        GROUP BY o.id
      `, [orderId]);

      if (rows.length === 0) {
        logger.warn('Order not found', { orderId, sessionId, timestamp });
        return res.status(404).json({ error: 'Order not found' });
      }

      rows[0].approved = Number(rows[0].approved);
      rows[0].status = rows[0].status || 'pending';

      logger.info('Order fetched successfully', { orderId, sessionId, timestamp });
      res.json(rows[0]);
    } catch (err) {
      logger.error('Error fetching order', { error: err.message, orderId: id, sessionId, timestamp });
      res.status(500).json({ error: 'Failed to fetch order' });
    }
  });

  router.put('/orders/:id', async (req, res) => {
    const { id } = req.params;
    const { approved } = req.body;
    const sessionId = req.headers['x-session-id'] || req.sessionID;
    const timestamp = new Date().toISOString();

    try {
      if (!req.user || !await checkAdminOrServer(req.user.id)) {
        logger.warn('Unauthorized attempt to update order', { authenticatedUser: req.user, sessionId, timestamp });
        return res.status(403).json({ error: 'Admin or server access required' });
      }

      const orderId = parseInt(id);
      if (isNaN(orderId) || orderId <= 0) {
        logger.warn('Invalid order ID', { id, sessionId, timestamp });
        return res.status(400).json({ error: 'Valid order ID required' });
      }

      if (approved !== 1 && approved !== 0) {
        logger.warn('Invalid approved value', { orderId, approved, sessionId, timestamp });
        return res.status(400).json({ error: 'Invalid approved value' });
      }

      const [orderRows] = await db.query('SELECT session_id, approved, status FROM orders WHERE id = ?', [orderId]);
      if (orderRows.length === 0) {
        logger.warn('Order not found', { orderId, sessionId, timestamp });
        return res.status(404).json({ error: 'Order not found' });
      }

      await db.query('UPDATE orders SET approved = ?, status = ? WHERE id = ?', [approved, approved ? 'preparing' : orderRows[0].status, orderId]);

      const [orderDetails] = await db.query(`
        SELECT o.*, t.table_number,
               GROUP_CONCAT(oi.item_id) AS item_ids,
               GROUP_CONCAT(CASE WHEN oi.item_id IS NOT NULL THEN oi.quantity END) AS menu_quantities,
               GROUP_CONCAT(mi.name) AS item_names, GROUP_CONCAT(mi.image_url) AS image_urls,
               GROUP_CONCAT(oi.unit_price) AS unit_prices, GROUP_CONCAT(oi.supplement_id) AS supplement_ids,
               GROUP_CONCAT(mis.name) AS supplement_names, GROUP_CONCAT(mis.additional_price) AS supplement_prices,
               GROUP_CONCAT(DISTINCT oi.breakfast_id) AS breakfast_ids,
               GROUP_CONCAT(CASE WHEN oi.breakfast_id IS NOT NULL THEN oi.quantity END) AS breakfast_quantities,
               GROUP_CONCAT(DISTINCT b.name) AS breakfast_names,
               GROUP_CONCAT(DISTINCT b.image_url) AS breakfast_images,
               GROUP_CONCAT(boo.breakfast_option_id) AS breakfast_option_ids,
               GROUP_CONCAT(bo.option_name) AS breakfast_option_names,
               GROUP_CONCAT(bo.additional_price) AS breakfast_option_prices
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN menu_items mi ON oi.item_id = mi.id
        LEFT JOIN menu_item_supplements mis ON oi.supplement_id = mis.supplement_id AND oi.item_id = mi.id
        LEFT JOIN breakfasts b ON oi.breakfast_id = b.id
        LEFT JOIN breakfast_order_options boo ON oi.id = boo.order_item_id
        LEFT JOIN breakfast_options bo ON boo.breakfast_option_id = bo.id
        LEFT JOIN tables t ON o.table_id = t.id
        WHERE o.id = ?
        GROUP BY o.id
      `, [orderId]);

      orderDetails[0].approved = Number(orderDetails[0].approved);
      const derivedStatus = orderDetails[0].status || (orderDetails[0].approved ? 'preparing' : 'pending');

      const guestSessionId = orderRows[0].session_id;
      io.to(`guest-${guestSessionId}`).emit('orderApproved', { orderId: orderId.toString(), status: derivedStatus, orderDetails: orderDetails[0] });
      io.to('staff-notifications').emit('orderApproved', { orderId: orderId.toString(), status: derivedStatus, orderDetails: orderDetails[0] });

      logger.info('Order status updated successfully', { orderId, approved, status: derivedStatus, sessionId, timestamp });
      res.status(200).json({ message: 'Order status updated' });
    } catch (err) {
      logger.error('Error processing order update', { error: err.message, orderId: id, sessionId, timestamp });
      res.status(500).json({ error: 'Failed to process order update' });
    }
  });

  // FIXED: Order approval endpoint with idempotency and single stock deduction
  router.post('/orders/:id/approve', async (req, res) => {
    const { id } = req.params;
    const timestamp = new Date().toISOString();
    const sessionId = req.headers['x-session-id'] || req.sessionID;

    try {
      if (!req.user || !await checkAdminOrServer(req.user.id)) {
        logger.warn('Unauthorized attempt to approve order', { authenticatedUser: req.user, sessionId, timestamp });
        return res.status(403).json({ error: 'Admin or server access required' });
      }

      const orderId = parseInt(id);
      if (isNaN(orderId) || orderId <= 0) {
        logger.warn('Invalid order ID for approval', { id, sessionId, timestamp });
        return res.status(400).json({ error: 'Valid order ID required' });
      }

      const connection = await db.getConnection();
      await connection.beginTransaction();

      try {
        // CRITICAL FIX: Lock the order row and check status in a single atomic operation
        const [orderRows] = await connection.query(
          'SELECT id, session_id, approved, status FROM orders WHERE id = ? FOR UPDATE',
          [orderId]
        );

        if (orderRows.length === 0) {
          await connection.rollback();
          logger.warn('Order not found for approval', { orderId, sessionId, timestamp });
          return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderRows[0];

        // CRITICAL FIX: Check if already approved (idempotency check)
        if (order.approved && order.status !== 'cancelled') {
          await connection.rollback();
          logger.warn('Order already approved - preventing duplicate stock deduction', { 
            orderId, 
            currentStatus: order.status, 
            sessionId, 
            timestamp 
          });
          return res.status(400).json({ error: 'Order already approved' });
        }

        // CRITICAL FIX: Check if stock deduction already occurred for this order
        const [existingDeductions] = await connection.query(
          'SELECT id FROM stock_transactions WHERE order_id = ? AND transaction_type = ? LIMIT 1',
          [orderId, 'deduction']
        );

        if (existingDeductions.length > 0) {
          await connection.rollback();
          logger.warn('Stock already deducted for this order - preventing duplicate deduction', { 
            orderId, 
            sessionId, 
            timestamp 
          });
          return res.status(400).json({ error: 'Stock already deducted for this order' });
        }

        // Fetch order items and breakfast options
        const [orderItems] = await connection.query(
          'SELECT item_id, breakfast_id, quantity, supplement_id FROM order_items WHERE order_id = ?',
          [orderId]
        );

        const [breakfastOptions] = await connection.query(
          'SELECT boo.breakfast_option_id FROM breakfast_order_options boo JOIN order_items oi ON boo.order_item_id = oi.id WHERE oi.order_id = ?',
          [orderId]
        );

        // Calculate required ingredients
        const ingredientUsage = new Map();

        for (const item of orderItems) {
          const { item_id, breakfast_id, quantity, supplement_id } = item;

          // Process menu items
          if (item_id) {
            const [menuItemIngredients] = await connection.query(
              'SELECT ingredient_id, quantity AS ingredient_quantity FROM menu_item_ingredients WHERE menu_item_id = ?',
              [item_id]
            );
            for (const ing of menuItemIngredients) {
              const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
              ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
            }
          }

          // Process supplements
          if (supplement_id) {
            const [supplementIngredients] = await connection.query(
              'SELECT ingredient_id, quantity AS ingredient_quantity FROM supplement_ingredients WHERE supplement_id = ?',
              [supplement_id]
            );
            for (const ing of supplementIngredients) {
              const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
              ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
            }
          }

          // Process breakfasts
          if (breakfast_id) {
            const [breakfastIngredients] = await connection.query(
              'SELECT ingredient_id, quantity AS ingredient_quantity FROM breakfast_ingredients WHERE breakfast_id = ?',
              [breakfast_id]
            );
            for (const ing of breakfastIngredients) {
              const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
              ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
            }
          }
        }

        // Process breakfast options
        for (const option of breakfastOptions) {
          const [optionIngredients] = await connection.query(
            'SELECT ingredient_id, quantity AS ingredient_quantity FROM breakfast_option_ingredients WHERE breakfast_option_id = ?',
            [option.breakfast_option_id]
          );
          for (const ing of optionIngredients) {
            const totalQuantity = parseFloat(ing.ingredient_quantity);
            ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
          }
        }

        // Check stock availability and update (SINGLE ATOMIC OPERATION PER INGREDIENT)
        for (const [ingredientId, requiredQuantity] of ingredientUsage) {
          const [stock] = await connection.query(
            'SELECT name, quantity_in_stock FROM ingredients WHERE id = ? FOR UPDATE',
            [ingredientId]
          );

          if (stock.length === 0) {
            await connection.rollback();
            logger.warn('Ingredient not found', { ingredientId, orderId, sessionId, timestamp });
            return res.status(400).json({ error: `Ingredient ID ${ingredientId} not found` });
          }

          const availableStock = parseFloat(stock[0].quantity_in_stock);
          if (availableStock < requiredQuantity) {
            await connection.rollback();
            logger.warn('Insufficient stock', {
              ingredientId,
              ingredientName: stock[0].name,
              required: requiredQuantity,
              available: availableStock,
              orderId,
              sessionId,
              timestamp
            });
            return res.status(400).json({
              error: `Insufficient stock for ${stock[0].name}. Required: ${requiredQuantity}, Available: ${availableStock}`
            });
          }

          // SINGLE UPDATE: Deduct stock in one operation
          const newQuantity = availableStock - requiredQuantity;
          await connection.query(
            'UPDATE ingredients SET quantity_in_stock = ?, updated_at = NOW() WHERE id = ?',
            [newQuantity, ingredientId]
          );

          // SINGLE INSERT: Record transaction for audit trail
          await connection.query(
            'INSERT INTO stock_transactions (ingredient_id, quantity, transaction_type, order_id, reason) VALUES (?, ?, ?, ?, ?)',
            [ingredientId, -requiredQuantity, 'deduction', orderId, 'Order approval']
          );

          logger.debug('Stock deducted for ingredient', {
            ingredientId,
            ingredientName: stock[0].name,
            deducted: requiredQuantity,
            previousStock: availableStock,
            newStock: newQuantity,
            orderId,
            timestamp
          });
        }

        // Update order status (SINGLE UPDATE)
        await connection.query(
          'UPDATE orders SET approved = 1, status = ? WHERE id = ?',
          ['preparing', orderId]
        );

        // Fetch updated order details
        const [orderDetails] = await connection.query(`
          SELECT o.*, t.table_number,
                 GROUP_CONCAT(oi.item_id) AS item_ids,
                 GROUP_CONCAT(CASE WHEN oi.item_id IS NOT NULL THEN oi.quantity END) AS menu_quantities,
                 GROUP_CONCAT(mi.name) AS item_names, GROUP_CONCAT(mi.image_url) AS image_urls,
                 GROUP_CONCAT(oi.unit_price) AS unit_prices, GROUP_CONCAT(oi.supplement_id) AS supplement_ids,
                 GROUP_CONCAT(mis.name) AS supplement_names, GROUP_CONCAT(mis.additional_price) AS supplement_prices,
                 GROUP_CONCAT(DISTINCT oi.breakfast_id) AS breakfast_ids,
                 GROUP_CONCAT(CASE WHEN oi.breakfast_id IS NOT NULL THEN oi.quantity END) AS breakfast_quantities,
                 GROUP_CONCAT(DISTINCT b.name) AS breakfast_names,
                 GROUP_CONCAT(DISTINCT b.image_url) AS breakfast_images,
                 GROUP_CONCAT(boo.breakfast_option_id) AS breakfast_option_ids,
                 GROUP_CONCAT(bo.option_name) AS breakfast_option_names,
                 GROUP_CONCAT(bo.additional_price) AS breakfast_option_prices
          FROM orders o
          LEFT JOIN order_items oi ON o.id = oi.order_id
          LEFT JOIN menu_items mi ON oi.item_id = mi.id
          LEFT JOIN menu_item_supplements mis ON oi.supplement_id = mis.supplement_id AND oi.item_id = mis.menu_item_id
          LEFT JOIN breakfasts b ON oi.breakfast_id = b.id
          LEFT JOIN breakfast_order_options boo ON oi.id = boo.order_item_id
          LEFT JOIN breakfast_options bo ON boo.breakfast_option_id = bo.id
          LEFT JOIN tables t ON o.table_id = t.id
          WHERE o.id = ?
          GROUP BY o.id
        `, [orderId]);

        orderDetails[0].approved = Number(orderDetails[0].approved);
        const derivedStatus = orderDetails[0].status || 'preparing';

        await connection.commit();

        const guestSessionId = order.session_id;
        io.to(`guest-${guestSessionId}`).emit('orderApproved', {
          orderId: orderId.toString(),
          status: derivedStatus,
          orderDetails: orderDetails[0]
        });
        io.to('staff-notifications').emit('orderApproved', {
          orderId: orderId.toString(),
          status: derivedStatus,
          orderDetails: orderDetails[0]
        });

        logger.info('Order approved successfully with single stock deduction', {
          orderId,
          ingredientUsage: Object.fromEntries(ingredientUsage),
          guestSessionId,
          sessionId,
          timestamp
        });

        res.status(200).json({ message: 'Order approved' });
      } catch (err) {
        await connection.rollback();
        logger.error('Error approving order with stock deduction', {
          error: err.message,
          stack: err.stack,
          orderId,
          sessionId,
          timestamp
        });
        res.status(500).json({ error: 'Failed to approve order' });
      } finally {
        connection.release();
      }
    } catch (err) {
      logger.error('Error approving order', { error: err.message, orderId: id, sessionId, timestamp });
      res.status(500).json({ error: 'Failed to approve order' });
    }
  });

  router.post('/orders/:id/cancel', async (req, res) => {
    const { id } = req.params;
    const { restoreStock = false } = req.body;
    const timestamp = new Date().toISOString();
    const sessionId = req.headers['x-session-id'] || req.sessionID;

    try {
      if (!req.user || !await checkAdminOrServer(req.user.id)) {
        logger.warn('Unauthorized attempt to cancel order', { authenticatedUser: req.user, sessionId, timestamp });
        return res.status(403).json({ error: 'Admin or server access required' });
      }
      const orderId = parseInt(id);
      if (isNaN(orderId) || orderId <= 0) {
        logger.warn('Invalid order ID for cancellation', { id, sessionId, timestamp });
        return res.status(400).json({ error: 'Valid order ID required' });
      }

      const connection = await db.getConnection();
      await connection.beginTransaction();

      try {
        // CRITICAL FIX: Lock order row to prevent race conditions
        const [orderRows] = await connection.query(
          'SELECT id, session_id, status, approved FROM orders WHERE id = ? FOR UPDATE',
          [orderId]
        );

        if (orderRows.length === 0) {
          await connection.rollback();
          logger.warn('Order not found for cancellation', { orderId, sessionId, timestamp });
          return res.status(404).json({ error: 'Order not found' });
        }

        if (orderRows[0].status === 'cancelled') {
          await connection.rollback();
          logger.warn('Order already cancelled', { orderId, sessionId, timestamp });
          return res.status(400).json({ error: 'Order already cancelled' });
        }

        let ingredientUsage = null;

        // Only attempt restoration if requested and order was previously approved
        if (restoreStock === true && orderRows[0].approved) {
          // CRITICAL FIX: Prevent double restoration
          const [existingRestorations] = await connection.query(
            'SELECT id FROM stock_transactions WHERE order_id = ? AND reason = ? LIMIT 1',
            [orderId, 'Order cancellation stock restoration']
          );
          if (existingRestorations.length > 0) {
            await connection.rollback();
            logger.warn('Stock already restored for order', { orderId, sessionId, timestamp });
            return res.status(400).json({ error: 'Stock already restored for this order' });
          }

          // Verify a deduction actually occurred
          const [deductionsExist] = await connection.query(
            'SELECT id FROM stock_transactions WHERE order_id = ? AND transaction_type = ? LIMIT 1',
            [orderId, 'deduction']
          );

          if (deductionsExist.length === 0) {
            logger.warn('No prior deduction found for order; skipping stock restoration', { orderId, sessionId, timestamp });
          } else {
            // Recompute ingredient usage
            ingredientUsage = new Map();
            const [orderItems] = await connection.query(
              'SELECT item_id, breakfast_id, quantity, supplement_id FROM order_items WHERE order_id = ?',
              [orderId]
            );
            const [breakfastOptions] = await connection.query(
              'SELECT boo.breakfast_option_id FROM breakfast_order_options boo JOIN order_items oi ON boo.order_item_id = oi.id WHERE oi.order_id = ?',
              [orderId]
            );

            for (const item of orderItems) {
              const { item_id, breakfast_id, quantity, supplement_id } = item;

              if (item_id) {
                const [menuItemIngredients] = await connection.query(
                  'SELECT ingredient_id, quantity AS ingredient_quantity FROM menu_item_ingredients WHERE menu_item_id = ?',
                  [item_id]
                );
                for (const ing of menuItemIngredients) {
                  const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
                  ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
                }
              }

              if (supplement_id) {
                const [supplementIngredients] = await connection.query(
                  'SELECT ingredient_id, quantity AS ingredient_quantity FROM supplement_ingredients WHERE supplement_id = ?',
                  [supplement_id]
                );
                for (const ing of supplementIngredients) {
                  const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
                  ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
                }
              }

              if (breakfast_id) {
                const [breakfastIngredients] = await connection.query(
                  'SELECT ingredient_id, quantity AS ingredient_quantity FROM breakfast_ingredients WHERE breakfast_id = ?',
                  [breakfast_id]
                );
                for (const ing of breakfastIngredients) {
                  const totalQuantity = parseFloat(ing.ingredient_quantity) * quantity;
                  ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
                }
              }
            }

            for (const option of breakfastOptions) {
              const [optionIngredients] = await connection.query(
                'SELECT ingredient_id, quantity AS ingredient_quantity FROM breakfast_option_ingredients WHERE breakfast_option_id = ?',
                [option.breakfast_option_id]
              );
              for (const ing of optionIngredients) {
                const totalQuantity = parseFloat(ing.ingredient_quantity);
                ingredientUsage.set(ing.ingredient_id, (ingredientUsage.get(ing.ingredient_id) || 0) + totalQuantity);
              }
            }

            // Perform restoration
            for (const [ingredientId, qtyToRestore] of ingredientUsage) {
              const [stockRows] = await connection.query(
                'SELECT id, name, quantity_in_stock FROM ingredients WHERE id = ? FOR UPDATE',
                [ingredientId]
              );
              if (stockRows.length === 0) {
                await connection.rollback();
                logger.warn('Ingredient not found during restoration', { ingredientId, orderId, sessionId, timestamp });
                return res.status(400).json({ error: `Ingredient ID ${ingredientId} not found during restoration` });
              }
              const currentQty = parseFloat(stockRows[0].quantity_in_stock);
              const newQty = currentQty + parseFloat(qtyToRestore);
              await connection.query(
                'UPDATE ingredients SET quantity_in_stock = ?, updated_at = NOW() WHERE id = ?',
                [newQty, ingredientId]
              );

              await connection.query(
                'INSERT INTO stock_transactions (ingredient_id, quantity, transaction_type, order_id, reason) VALUES (?, ?, ?, ?, ?)',
                [ingredientId, qtyToRestore, 'addition', orderId, 'Order cancellation stock restoration']
              );

              logger.debug('Stock restored for ingredient', {
                ingredientId,
                ingredientName: stockRows[0].name,
                restored: qtyToRestore,
                previousStock: currentQty,
                newStock: newQty,
                orderId,
                timestamp
              });
            }
          }
        }

        // Update order status
        await connection.query('UPDATE orders SET status = ?, approved = 0 WHERE id = ?', ['cancelled', orderId]);

        const [orderDetails] = await connection.query(`
          SELECT o.*, t.table_number,
                 GROUP_CONCAT(oi.item_id) AS item_ids,
                 GROUP_CONCAT(CASE WHEN oi.item_id IS NOT NULL THEN oi.quantity END) AS menu_quantities,
                 GROUP_CONCAT(mi.name) AS item_names, GROUP_CONCAT(mi.image_url) AS image_urls,
                 GROUP_CONCAT(oi.unit_price) AS unit_prices, GROUP_CONCAT(oi.supplement_id) AS supplement_ids,
                 GROUP_CONCAT(mis.name) AS supplement_names, GROUP_CONCAT(mis.additional_price) AS supplement_prices,
                 GROUP_CONCAT(DISTINCT oi.breakfast_id) AS breakfast_ids,
                 GROUP_CONCAT(CASE WHEN oi.breakfast_id IS NOT NULL THEN oi.quantity END) AS breakfast_quantities,
                 GROUP_CONCAT(DISTINCT b.name) AS breakfast_names,
                 GROUP_CONCAT(DISTINCT b.image_url) AS breakfast_images,
                 GROUP_CONCAT(boo.breakfast_option_id) AS breakfast_option_ids,
                 GROUP_CONCAT(bo.option_name) AS breakfast_option_names,
                 GROUP_CONCAT(bo.additional_price) AS breakfast_option_prices
          FROM orders o
          LEFT JOIN order_items oi ON o.id = oi.order_id
          LEFT JOIN menu_items mi ON oi.item_id = mi.id
          LEFT JOIN menu_item_supplements mis ON oi.supplement_id = mis.supplement_id AND oi.item_id = mi.id
          LEFT JOIN breakfasts b ON oi.breakfast_id = b.id
          LEFT JOIN breakfast_order_options boo ON oi.id = boo.order_item_id
          LEFT JOIN breakfast_options bo ON boo.breakfast_option_id = bo.id
          LEFT JOIN tables t ON o.table_id = t.id
          WHERE o.id = ?
          GROUP BY o.id
        `, [orderId]);

        orderDetails[0].approved = Number(orderDetails[0].approved);
        const derivedStatus = orderDetails[0].status || 'cancelled';

        await connection.commit();

        const guestSessionId = orderRows[0].session_id;
        io.to(`guest-${guestSessionId}`).emit('orderCancelled', { orderId: orderId.toString(), status: derivedStatus, orderDetails: orderDetails[0] });
        io.to('staff-notifications').emit('orderCancelled', { orderId: orderId.toString(), status: derivedStatus, orderDetails: orderDetails[0] });

        logger.info('Order cancelled successfully', {
          orderId,
          restoreStock,
          ingredientUsage: ingredientUsage ? Object.fromEntries(ingredientUsage) : null,
          guestSessionId,
          sessionId,
          timestamp
        });
        res.status(200).json({ message: 'Order cancelled' });
      } catch (err) {
        await connection.rollback();
        logger.error('Error cancelling order with stock restoration', { error: err.message, orderId, restoreStock, sessionId, timestamp });
        res.status(500).json({ error: 'Failed to cancel order' });
      } finally {
        connection.release();
      }
    } catch (err) {
      logger.error('Error cancelling order', { error: err.message, orderId: id, sessionId, timestamp });
      res.status(500).json({ error: 'Failed to cancel order' });
    }
  });

  router.get('/session', (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.sessionID;
    const deviceId = req.headers['x-device-id'] || uuidv4();
    res.json({ sessionId, deviceId });
  });

  return router;
};
