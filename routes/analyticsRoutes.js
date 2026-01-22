const express = require('express');
const router = express.Router();
const db = require('../config/db');
const logger = require('../logger');
const { query, validationResult } = require('express-validator');

const checkAdmin = async (userId) => {
  if (!userId) return false;
  const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
  return rows.length > 0 && rows[0].role === 'admin';
};

// Validation middleware for query parameters
const validateQueryParams = [
  query('start_date').optional().isISO8601().withMessage('start_date must be a valid ISO8601 date'),
  query('end_date').optional().isISO8601().withMessage('end_date must be a valid ISO8601 date'),
  query('category_id').optional().isInt({ min: 1 }).withMessage('category_id must be a positive integer'),
  query('order_type').optional().isIn(['local', 'delivery']).withMessage('order_type must be "local" or "delivery"'),
  query('start_hour').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('start_hour must be in HH:mm format'),
  query('end_hour').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('end_hour must be in HH:mm format'),
];

// Helper function to build dynamic WHERE clauses for time and hour filtering
const buildTimeFilter = (startDate, endDate, startHour, endHour, tableAlias) => {
  const conditions = [];
  const params = [];

  const startDateStr = startDate ? String(startDate) : null;
  const endDateStr = endDate ? String(endDate) : null;

  if (startDateStr && startDateStr !== 'undefined') {
    try {
      const start = new Date(startDateStr);
      if (isNaN(start.getTime())) throw new Error('Invalid start date');
      const startFormatted = startDateStr.includes('T') || startDateStr.includes(' ')
        ? start.toISOString()
        : `${startDateStr}T00:00:00.000Z`;
      conditions.push(`${tableAlias}.created_at >= ?`);
      params.push(startFormatted);
    } catch (err) {
      logger.error('Invalid start date format', { startDate: startDateStr, error: err.message });
      throw new Error('Invalid start date format');
    }
  }

  if (endDateStr && endDateStr !== 'undefined') {
    try {
      const end = new Date(endDateStr);
      if (isNaN(end.getTime())) throw new Error('Invalid end date');
      const endFormatted = endDateStr.includes('T') || endDateStr.includes(' ')
        ? end.toISOString()
        : `${endDateStr}T23:59:59.999Z`;
      conditions.push(`${tableAlias}.created_at <= ?`);
      params.push(endFormatted);
    } catch (err) {
      logger.error('Invalid end date format', { endDate: endDateStr, error: err.message });
      throw new Error('Invalid end date format');
    }
  }

  if (startHour && startHour !== 'undefined') {
    try {
      conditions.push(`HOUR(${tableAlias}.created_at) >= ?`);
      params.push(parseInt(startHour.split(':')[0]));
    } catch (err) {
      logger.error('Invalid start hour format', { startHour, error: err.message });
      throw new Error('Invalid start hour format');
    }
  }

  if (endHour && endHour !== 'undefined') {
    try {
      conditions.push(`HOUR(${tableAlias}.created_at) <= ?`);
      params.push(parseInt(endHour.split(':')[0]));
    } catch (err) {
      logger.error('Invalid end hour format', { endHour, error: err.message });
      throw new Error('Invalid end hour format');
    }
  }

  return { conditions, params };
};

// Fetch enhanced analytics overview
router.get('/analytics-overview', validateQueryParams, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation errors for analytics overview', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array() });
  }

  const { start_date, end_date, category_id, order_type, start_hour, end_hour } = req.query;

  try {
    if (!req.user) {
      logger.warn('No authenticated user for analytics', { query: req.query });
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!await checkAdmin(req.user.id)) {
      logger.warn('Unauthorized attempt to fetch analytics', { user: req.user });
      return res.status(403).json({ error: 'Admin access required' });
    }

    logger.debug('Fetching analytics with query:', { query: req.query });

    // Build time filter for orders
    const orderTimeFilter = buildTimeFilter(start_date, end_date, start_hour, end_hour, 'o');
    let orderWhereClause = orderTimeFilter.conditions.length > 0 ? `WHERE ${orderTimeFilter.conditions.join(' AND ')}` : '';
    let orderParams = [...orderTimeFilter.params];

    // Additional filters for orders
    const orderConditions = [];
    if (order_type) {
      orderConditions.push('o.order_type = ?');
      orderParams.push(order_type);
    }
    if (orderConditions.length > 0) {
      orderWhereClause = orderWhereClause ? `${orderWhereClause} AND ${orderConditions.join(' AND ')}` : `WHERE ${orderConditions.join(' AND ')}`;
    }

    // Build time filter for previous period (for percentage change)
    let previousStartDate, previousEndDate;
    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error('Invalid date range for previous period calculation');
      }
      const diff = end.getTime() - start.getTime();
      previousEndDate = new Date(start.getTime() - 1000);
      previousStartDate = new Date(previousEndDate.getTime() - diff);
    }
    const prevOrderTimeFilter = buildTimeFilter(previousStartDate, previousEndDate, start_hour, end_hour, 'o');
    let prevOrderWhereClause = prevOrderTimeFilter.conditions.length > 0 ? `WHERE ${prevOrderTimeFilter.conditions.join(' AND ')}` : '';
    let prevOrderParams = [...prevOrderTimeFilter.params];
    if (order_type) {
      prevOrderWhereClause = prevOrderWhereClause ? `${prevOrderWhereClause} AND o.order_type = ?` : `WHERE o.order_type = ?`;
      prevOrderParams.push(order_type);
    }

    // Total Orders
    logger.debug('Querying total orders:', { query: `SELECT COUNT(*) as count FROM orders o ${orderWhereClause}`, params: orderParams });
    const [totalOrders] = await db.query(`SELECT COUNT(*) as count FROM orders o ${orderWhereClause}`, orderParams);
    logger.debug('Querying previous total orders:', { query: `SELECT COUNT(*) as count FROM orders o ${prevOrderWhereClause}`, params: prevOrderParams });
    const [prevTotalOrders] = await db.query(`SELECT COUNT(*) as count FROM orders o ${prevOrderWhereClause}`, prevOrderParams);
    const totalOrdersCount = totalOrders[0].count;
    const prevTotalOrdersCount = prevTotalOrders[0].count;
    const totalOrdersChange = prevTotalOrdersCount > 0
      ? ((totalOrdersCount - prevTotalOrdersCount) / prevTotalOrdersCount * 100).toFixed(2)
      : null;

    // Total Revenue (only for approved orders)
    let revenueWhereClause = orderWhereClause ? `${orderWhereClause} AND o.approved = 1` : `WHERE o.approved = 1`;
    let revenueParams = [...orderParams];
    let prevRevenueWhereClause = prevOrderWhereClause ? `${prevOrderWhereClause} AND o.approved = 1` : `WHERE o.approved = 1`;
    let prevRevenueParams = [...prevOrderParams];
    logger.debug('Querying total revenue:', { query: `SELECT SUM(total_price) as revenue FROM orders o ${revenueWhereClause}`, params: revenueParams });
    const [totalRevenue] = await db.query(`SELECT SUM(total_price) as revenue FROM orders o ${revenueWhereClause}`, revenueParams);
    logger.debug('Querying previous total revenue:', { query: `SELECT SUM(total_price) as revenue FROM orders o ${prevRevenueWhereClause}`, params: prevRevenueParams });
    const [prevTotalRevenue] = await db.query(`SELECT SUM(total_price) as revenue FROM orders o ${prevRevenueWhereClause}`, prevRevenueParams);
    const revenue = parseFloat(totalRevenue[0].revenue || 0).toFixed(2);
    const prevRevenue = parseFloat(prevTotalRevenue[0].revenue || 0).toFixed(2);
    const revenueChange = prevRevenue > 0
      ? ((revenue - prevRevenue) / prevRevenue * 100).toFixed(2)
      : null;

    // Order Type Breakdown
    logger.debug('Querying order type breakdown:', { query: `SELECT o.order_type, COUNT(*) as count FROM orders o ${orderWhereClause} GROUP BY o.order_type`, params: orderParams });
    const [orderTypeBreakdown] = await db.query(
      `SELECT o.order_type, COUNT(*) as count FROM orders o ${orderWhereClause} GROUP BY o.order_type`,
      orderParams
    );

    // Top Selling Items (include revenue)
    let topItemsWhereClause = orderTimeFilter.conditions.length > 0 ? `WHERE ${orderTimeFilter.conditions.join(' AND ')}` : '';
    let topItemsParams = [...orderTimeFilter.params];
    if (category_id) {
      topItemsWhereClause = topItemsWhereClause ? `${topItemsWhereClause} AND mi.category_id = ?` : `WHERE mi.category_id = ?`;
      topItemsParams.push(category_id);
    }
    logger.debug('Querying top selling items:', { query: `SELECT mi.id, mi.name, SUM(oi.quantity) as total_quantity, SUM(oi.quantity * oi.unit_price) as total_revenue FROM order_items oi JOIN menu_items mi ON oi.item_id = mi.id JOIN orders o ON oi.order_id = o.id ${topItemsWhereClause} GROUP BY oi.item_id ORDER BY total_quantity DESC LIMIT 5`, params: topItemsParams });
    const [topSellingItems] = await db.query(
      `SELECT mi.id, mi.name, SUM(oi.quantity) as total_quantity, SUM(oi.quantity * oi.unit_price) as total_revenue
       FROM order_items oi
       JOIN menu_items mi ON oi.item_id = mi.id
       JOIN orders o ON oi.order_id = o.id
       ${topItemsWhereClause}
       GROUP BY oi.item_id
       ORDER BY total_quantity DESC
       LIMIT 5`,
      topItemsParams
    );
    const sanitizedTopSellingItems = topSellingItems.map(item => ({
      ...item,
      total_revenue: parseFloat(item.total_revenue || 0).toFixed(2),
    }));

    // Sales Trend Over Time (daily if < 1 month, monthly otherwise)
    let groupByClause = 'DATE(o.created_at)';
    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);
      const diffDays = (end - start) / (1000 * 60 * 60 * 24);
      if (diffDays > 30) {
        groupByClause = 'DATE_FORMAT(o.created_at, "%Y-%m")';
      }
    }
    logger.debug('Querying sales trend:', { query: `SELECT ${groupByClause} as time_period, SUM(o.total_price) as total_revenue, COUNT(*) as total_orders FROM orders o ${orderWhereClause} GROUP BY ${groupByClause} ORDER BY time_period ASC`, params: orderParams });
    const [salesTrend] = await db.query(
      `SELECT ${groupByClause} as time_period, SUM(o.total_price) as total_revenue, COUNT(*) as total_orders
       FROM orders o
       ${orderWhereClause}
       GROUP BY ${groupByClause}
       ORDER BY time_period ASC`,
      orderParams
    );
    const sanitizedSalesTrend = salesTrend.map(item => ({
      ...item,
      total_revenue: parseFloat(item.total_revenue || 0).toFixed(2),
    }));

    // Table Reservation Status
    const reservationTimeFilter = buildTimeFilter(start_date, end_date, start_hour, end_hour, 'r');
    let reservationWhereClause = reservationTimeFilter.conditions.length > 0 ? `WHERE ${reservationTimeFilter.conditions.join(' AND ')}` : '';
    let reservationParams = [...reservationTimeFilter.params];
    logger.debug('Querying reservations:', { query: `SELECT r.id, r.table_id, t.table_number, r.reservation_time, r.phone_number, r.status FROM reservations r JOIN tables t ON r.table_id = t.id ${reservationWhereClause} ORDER BY r.reservation_time DESC LIMIT 10`, params: reservationParams });
    const [reservations] = await db.query(
      `SELECT r.id, r.table_id, t.table_number, r.reservation_time, r.phone_number, r.status
       FROM reservations r
       JOIN tables t ON r.table_id = t.id
       ${reservationWhereClause}
       ORDER BY r.reservation_time DESC
       LIMIT 10`,
      reservationParams
    );
    logger.debug('Querying reservation status counts:', { query: `SELECT r.status, COUNT(*) as count FROM reservations r ${reservationWhereClause} GROUP BY r.status`, params: reservationParams });
    const [reservationStatusCounts] = await db.query(
      `SELECT r.status, COUNT(*) as count
       FROM reservations r
       ${reservationWhereClause}
       GROUP BY r.status`,
      reservationParams
    );

    // Average Rating per Item
    let ratingsWhereClause = '';
    let ratingsParams = [];
    if (category_id) {
      ratingsWhereClause = `WHERE mi.category_id = ?`;
      ratingsParams.push(category_id);
    }
    logger.debug('Querying average ratings:', { query: `SELECT mi.id, mi.name, AVG(r.rating) as average_rating, COUNT(r.id) as review_count FROM menu_items mi LEFT JOIN ratings r ON mi.id = r.item_id ${ratingsWhereClause} GROUP BY mi.id HAVING review_count > 0 ORDER BY average_rating DESC LIMIT 5`, params: ratingsParams });
    const [averageRatings] = await db.query(
      `SELECT mi.id, mi.name, AVG(r.rating) as average_rating, COUNT(r.id) as review_count
       FROM menu_items mi
       LEFT JOIN ratings r ON mi.id = r.item_id
       ${ratingsWhereClause}
       GROUP BY mi.id
       HAVING review_count > 0
       ORDER BY average_rating DESC
       LIMIT 5`,
      ratingsParams
    );
    const sanitizedAverageRatings = averageRatings.map(item => ({
      ...item,
      average_rating: parseFloat(item.average_rating || 0).toFixed(1),
      review_count: parseInt(item.review_count || 0),
    }));

    // Category Sales Distribution
    let categorySalesWhereClause = orderTimeFilter.conditions.length > 0 ? `WHERE ${orderTimeFilter.conditions.join(' AND ')}` : '';
    let categorySalesParams = [...orderTimeFilter.params];
    if (category_id) {
      categorySalesWhereClause = categorySalesWhereClause ? `${categorySalesWhereClause} AND mi.category_id = ?` : `WHERE mi.category_id = ?`;
      categorySalesParams.push(category_id);
    }
    logger.debug('Querying category sales:', { query: `SELECT c.id, c.name, SUM(oi.quantity * oi.unit_price) as total_revenue FROM order_items oi JOIN menu_items mi ON oi.item_id = mi.id JOIN categories c ON mi.category_id = c.id JOIN orders o ON oi.order_id = o.id ${categorySalesWhereClause} GROUP BY c.id ORDER BY total_revenue DESC`, params: categorySalesParams });
    const [categorySales] = await db.query(
      `SELECT c.id, c.name, SUM(oi.quantity * oi.unit_price) as total_revenue
       FROM order_items oi
       JOIN menu_items mi ON oi.item_id = mi.id
       JOIN categories c ON mi.category_id = c.id
       JOIN orders o ON oi.order_id = o.id
       ${categorySalesWhereClause}
       GROUP BY c.id
       ORDER BY total_revenue DESC`,
      categorySalesParams
    );
    const sanitizedCategorySales = categorySales.map(item => ({
      ...item,
      total_revenue: parseFloat(item.total_revenue || 0).toFixed(2),
    }));

    // Recent Orders
    logger.debug('Querying recent orders:', { query: `SELECT o.id, o.total_price, o.order_type, o.approved, o.created_at, t.table_number FROM orders o LEFT JOIN tables t ON o.table_id = t.id ${orderWhereClause} ORDER BY o.created_at DESC LIMIT 5`, params: orderParams });
    const [recentOrders] = await db.query(
      `SELECT o.id, o.total_price, o.order_type, o.approved, o.created_at, t.table_number
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       ${orderWhereClause}
       ORDER BY o.created_at DESC
       LIMIT 5`,
      orderParams
    );
    const sanitizedRecentOrders = recentOrders.map(order => ({
      ...order,
      total_price: parseFloat(order.total_price || 0).toFixed(2),
    }));

    // Promotion Impact
    let promotionWhereClause = orderWhereClause ? `${orderWhereClause} AND o.promotion_id IS NOT NULL` : `WHERE o.promotion_id IS NOT NULL`;
    let promotionParams = [...orderParams];
    logger.debug('Querying promotion impact:', { query: `SELECT p.id, p.name, COUNT(o.id) as order_count, SUM(p.discount_percentage * o.total_price / 100) as total_discount FROM orders o JOIN promotions p ON o.promotion_id = p.id ${promotionWhereClause} GROUP BY p.id ORDER BY order_count DESC`, params: promotionParams });
    const [promotionImpact] = await db.query(
      `SELECT p.id, p.name, COUNT(o.id) as order_count, SUM(p.discount_percentage * o.total_price / 100) as total_discount
       FROM orders o
       JOIN promotions p ON o.promotion_id = p.id
       ${promotionWhereClause}
       GROUP BY p.id
       ORDER BY order_count DESC`,
      promotionParams
    );
    const sanitizedPromotionImpact = promotionImpact.map(item => ({
      ...item,
      total_discount: parseFloat(item.total_discount || 0).toFixed(2),
    }));

    const analytics = {
      totalOrders: {
        count: totalOrdersCount,
        change: totalOrdersChange ? parseFloat(totalOrdersChange) : null,
      },
      totalRevenue: {
        revenue,
        change: revenueChange ? parseFloat(revenueChange) : null,
      },
      orderTypeBreakdown,
      topSellingItems: sanitizedTopSellingItems,
      salesTrend: sanitizedSalesTrend,
      reservationStatus: {
        reservations,
        statusCounts: reservationStatusCounts,
      },
      averageRatings: sanitizedAverageRatings,
      categorySales: sanitizedCategorySales,
      recentOrders: sanitizedRecentOrders,
      promotionImpact: sanitizedPromotionImpact,
    };

    logger.info('Analytics fetched successfully', { filters: req.query });
    res.json(analytics);
  } catch (error) {
    logger.error('Error fetching analytics', { error: error.stack, filters: req.query });
    res.status(500).json({ error: 'Failed to fetch analytics', details: error.message });
  }
});

module.exports = router;