const express = require('express');
const router = express.Router();
const db = require('../config/db');
const logger = require('../logger');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const breakfastValidation = require('../middleware/breakfastValidation');

// Configure Cloudinary storage for multer
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'Uploads/Breakfast',
    allowed_formats: ['jpg', 'jpeg', 'png'],
    public_id: (req, file) => `${Date.now()}-${file.originalname}`,
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Image must be JPEG or PNG'), false);
    }
  },
}).single('image');

// Middleware to check admin role
const checkAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    logger.warn('No token provided for admin check');
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [decoded.id]);
    if (rows.length === 0 || rows[0].role !== 'admin') {
      logger.warn('Unauthorized attempt', { user_id: decoded.id });
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Invalid token', { error: error.message });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Middleware to log raw FormData and JSON
const logFormData = (req, res, next) => {
  if (req.headers['content-type']?.includes('multipart/form-data')) {
    const formData = {};
    for (const [key, value] of Object.entries(req.body)) {
      formData[key] = value;
    }
    logger.info('Raw FormData request', {
      headers: req.headers,
      method: req.method,
      url: req.url,
      formData,
      file: req.file ? { public_id: req.file.public_id, url: req.file.path } : null,
    });
  } else if (req.headers['content-type']?.includes('application/json')) {
    logger.info('Raw JSON request', {
      headers: req.headers,
      method: req.method,
      url: req.url,
      body: req.body,
    });
  }
  next();
};

// Fetch all breakfast options
router.get('/breakfast-options', checkAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT bo.id, bo.breakfast_id, b.name AS breakfast_name, bo.group_id, bog.title AS group_title, 
              bo.option_type, bo.option_name, bo.additional_price
       FROM breakfast_options bo
       JOIN breakfasts b ON bo.breakfast_id = b.id
       JOIN breakfast_option_groups bog ON bo.group_id = bog.id
       WHERE bo.breakfast_id IS NOT NULL
       UNION
       SELECT bo.id, NULL AS breakfast_id, NULL AS breakfast_name, bo.group_id, bog.title AS group_title, 
              bo.option_type, bo.option_name, bo.additional_price
       FROM breakfast_options bo
       JOIN breakfast_option_groups bog ON bo.group_id = bog.id
       WHERE bo.breakfast_id IS NULL`
    );
    logger.info('Breakfast options fetched', { count: rows.length });
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching breakfast options', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch breakfast options', details: error.message });
  }
});

// Create breakfast
router.post('/breakfasts', checkAdmin, breakfastValidation, upload, logFormData, async (req, res) => {
  const { name, description, price, availability, category_id, option_groups, reusable_option_groups } = req.body;
  const image = req.file;
  logger.info('Parsed breakfast creation request', {
    body: { name, description, price, availability, category_id, option_groups, reusable_option_groups },
    file: image ? { public_id: image.public_id, url: image.path } : null,
  });
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const finalName = name && name.trim() ? name.trim() : 'Unnamed Breakfast';
    const finalPrice = price && !isNaN(parseFloat(price)) && parseFloat(price) >= 0.01 ? parseFloat(price) : 0.01;
    const parsedAvailability = availability === 'true' || availability === true;
    const parsedCategoryId = category_id ? parseInt(category_id) : null;
    const image_url = image ? image.path : null; // Cloudinary URL

    const [result] = await connection.query(
      'INSERT INTO breakfasts (name, description, price, image_url, availability, category_id) VALUES (?, ?, ?, ?, ?, ?)',
      [finalName, description || null, finalPrice, image_url, parsedAvailability, parsedCategoryId]
    );
    const breakfastId = result.insertId;

    if (option_groups) {
      const parsedGroups = typeof option_groups === 'string' ? JSON.parse(option_groups) : option_groups;
      for (const group of parsedGroups) {
        const parsedMaxSelections = parseInt(group.max_selections) || 1;
        const [groupResult] = await connection.query(
          'INSERT INTO breakfast_option_groups (breakfast_id, title, is_required, max_selections) VALUES (?, ?, ?, ?)',
          [breakfastId, group.title.trim(), group.is_required, parsedMaxSelections]
        );
        const groupId = groupResult.insertId;
        if (group.options && Array.isArray(group.options)) {
          for (const option of group.options) {
            const parsedPrice = parseFloat(option.additional_price) || 0;
            await connection.query(
              'INSERT INTO breakfast_options (breakfast_id, group_id, option_type, option_name, additional_price) VALUES (?, ?, ?, ?, ?)',
              [breakfastId, groupId, option.option_type || '', option.option_name.trim(), parsedPrice]
            );
          }
        }
      }
    }

    if (reusable_option_groups) {
      let parsedReusableGroups = Array.isArray(reusable_option_groups) ? reusable_option_groups : JSON.parse(reusable_option_groups);
      for (const groupId of parsedReusableGroups) {
        const [group] = await connection.query('SELECT id FROM breakfast_option_groups WHERE id = ? AND breakfast_id IS NULL', [groupId]);
        if (group.length === 0) {
          logger.warn('Reusable option group not found, skipping', { groupId, breakfastId });
          continue;
        }
        await connection.query(
          'INSERT INTO breakfast_option_group_mappings (breakfast_id, option_group_id) VALUES (?, ?)',
          [breakfastId, groupId]
        );
      }
    }

    await connection.commit();
    logger.info('Breakfast created', { id: breakfastId, name: finalName, image_url, category_id: parsedCategoryId });
    res.status(201).json({ message: 'Breakfast created', id: result.insertId });
  } catch (error) {
    await connection.rollback();
    logger.error('Error creating breakfast', { error: error.message, body: req.body });
    res.status(500).json({ error: 'Failed to create breakfast', details: error.message });
  } finally {
    connection.release();
  }
});

// Update breakfast
router.put('/breakfasts/:id', checkAdmin, breakfastValidation, upload, logFormData, async (req, res) => {
  const { name, description, price, availability, category_id, option_groups, reusable_option_groups } = req.body;
  const image = req.file;
  const { id } = req.params;
  logger.info('Parsed breakfast update request', {
    params: { id },
    body: { name, description, price, availability, category_id, option_groups, reusable_option_groups },
    file: image ? { public_id: image.public_id, url: image.path } : null,
  });
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const breakfastId = parseInt(id);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      await connection.rollback();
      logger.warn('Invalid breakfast ID', { id });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    const [existing] = await connection.query('SELECT image_url FROM breakfasts WHERE id = ?', [breakfastId]);
    if (existing.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    const finalName = name && name.trim() ? name.trim() : 'Unnamed Breakfast';
    const finalPrice = price && !isNaN(parseFloat(price)) && parseFloat(price) >= 0.01 ? parseFloat(price) : 0.01;
    const parsedAvailability = availability === 'true' || availability === true;
    const parsedCategoryId = category_id ? parseInt(category_id) : null;
    const image_url = image ? image.path : existing[0].image_url; // Cloudinary URL
    if (image && existing[0].image_url) {
      const oldPublicId = existing[0].image_url.split('/').pop().split('.')[0];
      try {
        await cloudinary.uploader.destroy(`Uploads/Breakfast/${oldPublicId}`);
        logger.info('Old breakfast image deleted from Cloudinary', { public_id: oldPublicId });
      } catch (err) {
        logger.error('Error deleting old breakfast image from Cloudinary', { error: err.message, public_id: oldPublicId });
      }
    }
    const updateFields = [finalName, description || null, finalPrice, parsedAvailability, parsedCategoryId];
    let query = 'UPDATE breakfasts SET name = ?, description = ?, price = ?, availability = ?, category_id = ?';
    if (image_url) {
      query += ', image_url = ?';
      updateFields.push(image_url);
    }
    updateFields.push(breakfastId);
    await connection.query(query + ' WHERE id = ?', updateFields);
    await connection.query('DELETE FROM breakfast_option_groups WHERE breakfast_id = ?', [breakfastId]);
    await connection.query('DELETE FROM breakfast_options WHERE breakfast_id = ?', [breakfastId]);
    await connection.query('DELETE FROM breakfast_option_group_mappings WHERE breakfast_id = ?', [breakfastId]);
    if (option_groups) {
      const parsedGroups = typeof option_groups === 'string' ? JSON.parse(option_groups) : option_groups;
      for (const group of parsedGroups) {
        const parsedMaxSelections = parseInt(group.max_selections) || 1;
        const [groupResult] = await connection.query(
          'INSERT INTO breakfast_option_groups (breakfast_id, title, is_required, max_selections) VALUES (?, ?, ?, ?)',
          [breakfastId, group.title.trim(), group.is_required, parsedMaxSelections]
        );
        const groupId = groupResult.insertId;
        if (group.options && Array.isArray(group.options)) {
          for (const option of group.options) {
            const parsedPrice = parseFloat(option.additional_price) || 0;
            await connection.query(
              'INSERT INTO breakfast_options (breakfast_id, group_id, option_type, option_name, additional_price) VALUES (?, ?, ?, ?, ?)',
              [breakfastId, groupId, option.option_type || '', option.option_name.trim(), parsedPrice]
            );
          }
        }
      }
    }
    if (reusable_option_groups) {
      let parsedReusableGroups = Array.isArray(reusable_option_groups) ? reusable_option_groups : JSON.parse(reusable_option_groups);
      for (const groupId of parsedReusableGroups) {
        const [group] = await connection.query('SELECT id FROM breakfast_option_groups WHERE id = ? AND breakfast_id IS NULL', [groupId]);
        if (group.length === 0) {
          logger.warn('Reusable option group not found, skipping', { groupId, breakfastId });
          continue;
        }
        await connection.query(
          'INSERT INTO breakfast_option_group_mappings (breakfast_id, option_group_id) VALUES (?, ?)',
          [breakfastId, groupId]
        );
      }
    }
    await connection.commit();
    logger.info('Breakfast updated', { id: breakfastId, name: finalName, image_url, category_id: parsedCategoryId });
    res.json({ message: 'Breakfast updated' });
  } catch (error) {
    await connection.rollback();
    logger.error('Error updating breakfast', { error: error.message, body: req.body });
    res.status(500).json({ error: 'Failed to update breakfast', details: error.message });
  } finally {
    connection.release();
  }
});

// Delete breakfast
router.delete('/breakfasts/:id', checkAdmin, breakfastValidation, async (req, res) => {
  const { id } = req.params;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const breakfastId = parseInt(id);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      await connection.rollback();
      logger.warn('Invalid breakfast ID', { id });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    const [existing] = await connection.query('SELECT image_url FROM breakfasts WHERE id = ?', [breakfastId]);
    if (existing.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    if (existing[0].image_url) {
      const publicId = existing[0].image_url.split('/').pop().split('.')[0];
      try {
        await cloudinary.uploader.destroy(`Uploads/Breakfast/${publicId}`);
        logger.info('Breakfast image deleted from Cloudinary', { public_id: publicId });
      } catch (err) {
        logger.error('Error deleting breakfast image from Cloudinary', { error: err.message, public_id: publicId });
      }
    }
    await connection.query('DELETE FROM breakfast_options WHERE breakfast_id = ?', [breakfastId]);
    await connection.query('DELETE FROM breakfast_option_groups WHERE breakfast_id = ?', [breakfastId]);
    await connection.query('DELETE FROM breakfast_option_group_mappings WHERE breakfast_id = ?', [breakfastId]);
    await connection.query('DELETE FROM breakfasts WHERE id = ?', [breakfastId]);
    await connection.commit();
    logger.info('Breakfast deleted', { id: breakfastId });
    res.json({ message: 'Breakfast deleted' });
  } catch (error) {
    await connection.rollback();
    logger.error('Error deleting breakfast', { error: error.message, id });
    res.status(500).json({ error: 'Failed to delete breakfast', details: error.message });
  } finally {
    connection.release();
  }
});

// Fetch all breakfasts
router.get('/breakfasts', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, c.name AS category_name,
              COALESCE(AVG(r.rating), 0) AS average_rating,
              COUNT(r.id) AS review_count
       FROM breakfasts b
       LEFT JOIN categories c ON b.category_id = c.id
       LEFT JOIN breakfast_ratings r ON b.id = r.breakfast_id
       GROUP BY b.id`
    );
    const sanitizedRows = rows.map(item => ({
      ...item,
      average_rating: parseFloat(item.average_rating).toFixed(1),
      review_count: parseInt(item.review_count),
    }));
    res.json(sanitizedRows);
  } catch (error) {
    logger.error('Error fetching breakfasts', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch breakfasts', details: error.message });
  }
});

// Fetch single breakfast
router.get('/breakfasts/:id', breakfastValidation, async (req, res) => {
  try {
    const breakfastId = parseInt(req.params.id);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      logger.warn('Invalid breakfast ID', { id: req.params.id });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    const [rows] = await db.query(
      `SELECT b.*, c.name AS category_name,
              COALESCE(AVG(r.rating), 0) AS average_rating,
              COUNT(r.id) AS review_count
       FROM breakfasts b
       LEFT JOIN categories c ON b.category_id = c.id
       LEFT JOIN breakfast_ratings r ON b.id = r.breakfast_id
       WHERE b.id = ?
       GROUP BY b.id`,
      [breakfastId]
    );
    if (rows.length === 0) {
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    const breakfast = rows[0];
    breakfast.average_rating = parseFloat(breakfast.average_rating).toFixed(1);
    breakfast.review_count = parseInt(breakfast.review_count);
    res.json(breakfast);
  } catch (error) {
    logger.error('Error fetching breakfast', { error: error.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch breakfast', details: error.message });
  }
});

// Fetch related breakfasts and menu items
router.get('/breakfasts/:id/related', async (req, res) => {
  try {
    const breakfastId = parseInt(req.params.id);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      logger.warn('Invalid breakfast ID', { id: req.params.id });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    const [breakfast] = await db.query(
      'SELECT category_id FROM breakfasts WHERE id = ?',
      [breakfastId]
    );
    if (!breakfast.length) {
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    const [breakfastRows] = await db.query(
      `SELECT b.*, c.name AS category_name,
              COALESCE(AVG(r.rating), 0) AS average_rating,
              COUNT(r.id) AS review_count
       FROM breakfasts b
       LEFT JOIN categories c ON b.category_id = c.id
       LEFT JOIN breakfast_ratings r ON b.id = r.breakfast_id
       WHERE b.category_id = ? AND b.id != ?
       GROUP BY b.id
       LIMIT 2`,
      [breakfast[0].category_id, breakfastId]
    );
    const [menuItemRows] = await db.query(
      `SELECT mi.*, c.name AS category_name,
              COALESCE(AVG(r.rating), 0) AS average_rating,
              COUNT(r.id) AS review_count
       FROM menu_items mi
       LEFT JOIN categories c ON mi.category_id = c.id
       LEFT JOIN ratings r ON mi.id = r.item_id
       WHERE mi.category_id = ?
       GROUP BY mi.id
       LIMIT 2`,
      [breakfast[0].category_id]
    );
    const sanitizedBreakfasts = breakfastRows.map(item => ({
      ...item,
      type: 'breakfast',
      average_rating: parseFloat(item.average_rating).toFixed(1),
      review_count: parseInt(item.review_count),
    }));
    const sanitizedMenuItems = menuItemRows.map(item => ({
      ...item,
      type: 'menuItem',
      dietary_tags: item.dietary_tags && typeof item.dietary_tags === 'string' && item.dietary_tags.match(/^\[.*\]$/)
        ? item.dietary_tags
        : '[]',
      average_rating: parseFloat(item.average_rating).toFixed(1),
      review_count: parseInt(item.review_count),
    }));
    const combinedItems = [...sanitizedBreakfasts, ...sanitizedMenuItems].slice(0, 4);
    res.json(combinedItems);
  } catch (error) {
    logger.error('Error fetching related products', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch related products', details: error.message });
  }
});

// Create option group
router.post('/breakfasts/:id/option-groups', checkAdmin, breakfastValidation, async (req, res) => {
  const { title, is_required, max_selections } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const breakfastId = parseInt(req.params.id);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      await connection.rollback();
      logger.warn('Invalid breakfast ID', { id: req.params.id });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    if (!title || !title.trim()) {
      await connection.rollback();
      logger.warn('Missing title');
      return res.status(400).json({ error: 'Title is required' });
    }
    const parsedIsRequired = is_required === 'true' || is_required === true;
    const parsedMaxSelections = parseInt(max_selections) || 1;
    const [breakfast] = await connection.query('SELECT id FROM breakfasts WHERE id = ?', [breakfastId]);
    if (breakfast.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    const [existingGroup] = await connection.query('SELECT id FROM breakfast_option_groups WHERE breakfast_id = ? AND title = ?', [breakfastId, title.trim()]);
    if (existingGroup.length > 0) {
      await connection.rollback();
      logger.warn('Duplicate option group title', { title, breakfast_id: breakfastId });
      return res.status(400).json({ error: 'Option group title already exists for this breakfast' });
    }
    const [result] = await connection.query(
      'INSERT INTO breakfast_option_groups (breakfast_id, title, is_required, max_selections) VALUES (?, ?, ?, ?)',
      [breakfastId, title.trim(), parsedIsRequired, parsedMaxSelections]
    );
    await connection.commit();
    logger.info('Option group created', { id: result.insertId, breakfast_id: breakfastId, title, is_required: parsedIsRequired, max_selections: parsedMaxSelections });
    res.status(201).json({ message: 'Option group created', id: result.insertId });
  } catch (error) {
    await connection.rollback();
    logger.error('Error creating option group', { error: error.message, breakfast_id: req.params.id });
    res.status(500).json({ error: 'Failed to create option group', details: error.message });
  } finally {
    connection.release();
  }
});

// Update option group
router.put('/breakfasts/:breakfastId/option-groups/:groupId', checkAdmin, breakfastValidation, async (req, res) => {
  const { title, is_required, max_selections } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const breakfastId = parseInt(req.params.breakfastId);
    const groupId = parseInt(req.params.groupId);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      await connection.rollback();
      logger.warn('Invalid breakfast ID', { id: req.params.breakfastId });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    if (isNaN(groupId) || groupId <= 0) {
      await connection.rollback();
      logger.warn('Invalid group ID', { id: req.params.groupId });
      return res.status(400).json({ error: 'Valid group ID is required' });
    }
    if (!title || !title.trim()) {
      await connection.rollback();
      logger.warn('Missing title');
      return res.status(400).json({ error: 'Title is required' });
    }
    const parsedIsRequired = is_required === 'true' || is_required === true;
    const parsedMaxSelections = parseInt(max_selections) || 1;
    const [breakfast] = await connection.query('SELECT id FROM breakfasts WHERE id = ?', [breakfastId]);
    if (breakfast.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    const [group] = await connection.query('SELECT id FROM breakfast_option_groups WHERE id = ? AND breakfast_id = ?', [groupId, breakfastId]);
    if (group.length === 0) {
      await connection.rollback();
      logger.warn('Option group not found', { id: groupId, breakfast_id: breakfastId });
      return res.status(404).json({ error: 'Option group not found' });
    }
    const [existingGroup] = await connection.query('SELECT id FROM breakfast_option_groups WHERE breakfast_id = ? AND title = ? AND id != ?', [breakfastId, title.trim(), groupId]);
    if (existingGroup.length > 0) {
      await connection.rollback();
      logger.warn('Duplicate option group title', { title, breakfast_id: breakfastId });
      return res.status(400).json({ error: 'Option group title already exists for this breakfast' });
    }
    await connection.query(
      'UPDATE breakfast_option_groups SET title = ?, is_required = ?, max_selections = ? WHERE id = ?',
      [title.trim(), parsedIsRequired, parsedMaxSelections, groupId]
    );
    await connection.commit();
    logger.info('Option group updated', { id: groupId, breakfast_id: breakfastId, title, is_required: parsedIsRequired, max_selections: parsedMaxSelections });
    res.json({ message: 'Option group updated' });
  } catch (error) {
    await connection.rollback();
    logger.error('Error updating option group', { error: error.message, breakfast_id: req.params.breakfastId, group_id: req.params.groupId });
    res.status(500).json({ error: 'Failed to update option group', details: error.message });
  } finally {
    connection.release();
  }
});

// Delete option group
router.delete('/breakfasts/:breakfastId/option-groups/:groupId', checkAdmin, breakfastValidation, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const breakfastId = parseInt(req.params.breakfastId);
    const groupId = parseInt(req.params.groupId);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      await connection.rollback();
      logger.warn('Invalid breakfast ID', { id: req.params.breakfastId });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    if (isNaN(groupId) || groupId <= 0) {
      await connection.rollback();
      logger.warn('Invalid group ID', { id: req.params.groupId });
      return res.status(400).json({ error: 'Valid group ID is required' });
    }
    const [breakfast] = await connection.query('SELECT id FROM breakfasts WHERE id = ?', [breakfastId]);
    if (breakfast.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    const [directGroup] = await connection.query('SELECT id FROM breakfast_option_groups WHERE id = ? AND breakfast_id = ?', [groupId, breakfastId]);
    if (directGroup.length > 0) {
      await connection.query('DELETE FROM breakfast_options WHERE group_id = ?', [groupId]);
      await connection.query('DELETE FROM breakfast_option_groups WHERE id = ? AND breakfast_id = ?', [groupId, breakfastId]);
    } else {
      const [mapping] = await connection.query(
        'SELECT id FROM breakfast_option_group_mappings WHERE breakfast_id = ? AND option_group_id = ?',
        [breakfastId, groupId]
      );
      if (mapping.length === 0) {
        await connection.rollback();
        logger.warn('Option group not found', { id: groupId, breakfast_id: breakfastId });
        return res.status(404).json({ error: 'Option group not found' });
      }
      await connection.query(
        'DELETE FROM breakfast_option_group_mappings WHERE breakfast_id = ? AND option_group_id = ?',
        [breakfastId, groupId]
      );
    }
    await connection.commit();
    logger.info('Option group deleted', { id: groupId, breakfast_id: breakfastId });
    res.json({ message: 'Option group deleted' });
  } catch (error) {
    await connection.rollback();
    logger.error('Error deleting option group', { error: error.message, breakfast_id: req.params.breakfastId, group_id: req.params.groupId });
    res.status(500).json({ error: 'Failed to delete option group', details: error.message });
  } finally {
    connection.release();
  }
});

// Fetch option groups
router.get('/breakfasts/:id/option-groups', breakfastValidation, async (req, res) => {
  try {
    const breakfastId = parseInt(req.params.id);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      logger.warn('Invalid breakfast ID', { id: req.params.id });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    const [specificGroups] = await db.query(
        'SELECT id, title, is_required, max_selections FROM breakfast_option_groups WHERE breakfast_id = ?',
        [breakfastId]
    );
    const [reusableGroups] = await db.query(
        `SELECT bog.id, bog.title, bog.is_required, bog.max_selections
         FROM breakfast_option_groups bog
         INNER JOIN breakfast_option_group_mappings bogm ON bog.id = bogm.option_group_id
         WHERE bogm.breakfast_id = ? AND bog.breakfast_id IS NULL`,
        [breakfastId]
    );
    const allGroups = [...specificGroups, ...reusableGroups];
    res.json(allGroups);
  } catch (error) {
    logger.error('Error fetching option groups', { error: error.message, breakfast_id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch option groups', details: error.message });
  }
});

// Create reusable option group
router.post('/option-groups/reusable', checkAdmin, breakfastValidation, upload, logFormData, async (req, res) => {
  const { title, is_required, max_selections, options } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const parsedIsRequired = is_required === 'true' || is_required === true;
    const parsedMaxSelections = parseInt(max_selections) || 1;
    const parsedOptions = options ? (typeof options === 'string' ? JSON.parse(options) : options) : [];
    if (!title || typeof title !== 'string' || !title.trim()) {
      await connection.rollback();
      logger.warn('Invalid title provided', { title });
      return res.status(400).json({ error: 'Title is required and must be a non-empty string' });
    }
    const [existingGroup] = await connection.query(
      'SELECT id FROM breakfast_option_groups WHERE breakfast_id IS NULL AND title = ?',
      [title.trim()]
    );
    if (existingGroup.length > 0) {
      await connection.rollback();
      logger.warn('Duplicate reusable option group title', { title });
      return res.status(400).json({ error: 'Reusable option group title already exists' });
    }
    const [result] = await connection.query(
      'INSERT INTO breakfast_option_groups (breakfast_id, title, is_required, max_selections) VALUES (NULL, ?, ?, ?)',
      [title.trim(), parsedIsRequired, parsedMaxSelections]
    );
    const groupId = result.insertId;
    logger.debug('Created group with ID', { groupId });
    if (parsedOptions.length > 0) {
      for (const option of parsedOptions) {
        if (!option.option_type?.trim() || !option.option_name?.trim()) {
          await connection.rollback();
          logger.warn('Invalid option provided', { option });
          return res.status(400).json({ error: 'Each option must have a non-empty option_type and option_name' });
        }
        const parsedPrice = parseFloat(option.additional_price) || 0;
        const query = 'INSERT INTO breakfast_options (breakfast_id, group_id, option_type, option_name, additional_price, created_at, updated_at) VALUES (NULL, ?, ?, ?, ?, NOW(), NOW())';
        const params = [groupId, option.option_type.trim(), option.option_name.trim(), parsedPrice];
        logger.debug('Executing option insert', { query, params });
        await connection.query(query, params);
      }
    }
    await connection.commit();
    logger.info('Reusable option group created', { id: groupId, title, is_required: parsedIsRequired, max_selections: parsedMaxSelections, options: parsedOptions });
    res.status(201).json({ message: 'Reusable option group created', id: groupId });
  } catch (error) {
    await connection.rollback();
    logger.error('Error creating reusable option group', { error: error.message, body: req.body });
    res.status(400).json({ error: 'Failed to create reusable option group', details: error.message });
  } finally {
    connection.release();
  }
});

// Update reusable option group
router.put('/option-groups/reusable/:id', checkAdmin, breakfastValidation, upload, logFormData, async (req, res) => {
  const { title, is_required, max_selections, options } = req.body;
  const { id } = req.params;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const groupId = parseInt(id);
    if (isNaN(groupId) || groupId <= 0) {
      await connection.rollback();
      logger.warn('Invalid group ID', { id });
      return res.status(400).json({ error: 'Valid group ID is required' });
    }
    const parsedIsRequired = is_required === 'true' || is_required === true;
    const parsedMaxSelections = parseInt(max_selections) || 1;
    const parsedOptions = options ? (typeof options === 'string' ? JSON.parse(options) : options) : [];
    const [group] = await connection.query('SELECT id FROM breakfast_option_groups WHERE id = ? AND breakfast_id IS NULL', [groupId]);
    if (group.length === 0) {
      await connection.rollback();
      logger.warn('Reusable option group not found', { id: groupId });
      return res.status(404).json({ error: 'Reusable option group not found' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      await connection.rollback();
      logger.warn('Invalid title provided', { title });
      return res.status(400).json({ error: 'Title is required and must be a non-empty string' });
    }
    const [existingGroup] = await connection.query(
      'SELECT id FROM breakfast_option_groups WHERE breakfast_id IS NULL AND title = ? AND id != ?',
      [title.trim(), groupId]
    );
    if (existingGroup.length > 0) {
      await connection.rollback();
      logger.warn('Duplicate reusable option group title', { title, id: groupId });
      return res.status(400).json({ error: 'Reusable option group title already exists' });
    }
    await connection.query(
      'UPDATE breakfast_option_groups SET title = ?, is_required = ?, max_selections = ?, updated_at = NOW() WHERE id = ?',
      [title.trim(), parsedIsRequired, parsedMaxSelections, groupId]
    );
    await connection.query('DELETE FROM breakfast_options WHERE group_id = ?', [groupId]);
    if (parsedOptions.length > 0) {
      for (const option of parsedOptions) {
        if (!option.option_type?.trim() || !option.option_name?.trim()) {
          await connection.rollback();
          logger.warn('Invalid option provided', { option });
          return res.status(400).json({ error: 'Each option must have a non-empty option_type and option_name' });
        }
        const parsedPrice = parseFloat(option.additional_price) || 0;
        const query = 'INSERT INTO breakfast_options (breakfast_id, group_id, option_type, option_name, additional_price, created_at, updated_at) VALUES (NULL, ?, ?, ?, ?, NOW(), NOW())';
        const params = [groupId, option.option_type.trim(), option.option_name.trim(), parsedPrice];
        logger.debug('Executing option insert', { query, params });
        await connection.query(query, params);
      }
    }
    await connection.commit();
    logger.info('Reusable option group updated', { id: groupId, title, is_required: parsedIsRequired, max_selections: parsedMaxSelections, options: parsedOptions });
    res.json({ message: 'Reusable option group updated' });
  } catch (error) {
    await connection.rollback();
    logger.error('Error updating reusable option group', { error: error.message, id, body: req.body });
    res.status(400).json({ error: 'Failed to update reusable option group', details: error.message });
  } finally {
    connection.release();
  }
});

// Delete reusable option group
router.delete('/option-groups/reusable/:id', checkAdmin, breakfastValidation, async (req, res) => {
  const { id } = req.params;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const groupId = parseInt(id);
    if (isNaN(groupId) || groupId <= 0) {
      await connection.rollback();
      logger.warn('Invalid group ID', { id });
      return res.status(400).json({ error: 'Valid group ID is required' });
    }
    const [group] = await connection.query('SELECT id FROM breakfast_option_groups WHERE id = ? AND breakfast_id IS NULL', [groupId]);
    if (group.length === 0) {
      await connection.rollback();
      logger.warn('Reusable option group not found', { id: groupId });
      return res.status(404).json({ error: 'Reusable option group not found' });
    }
    await connection.query('DELETE FROM breakfast_options WHERE group_id = ?', [groupId]);
    await connection.query('DELETE FROM breakfast_option_group_mappings WHERE option_group_id = ?', [groupId]);
    await connection.query('DELETE FROM breakfast_option_groups WHERE id = ?', [groupId]);
    await connection.commit();
    logger.info('Reusable option group deleted', { id: groupId });
    res.json({ message: 'Reusable option group deleted' });
  } catch (error) {
    await connection.rollback();
    logger.error('Error deleting reusable option group', { error: error.message, id });
    res.status(500).json({ error: 'Failed to delete reusable option group', details: error.message });
  } finally {
    connection.release();
  }
});

// Fetch reusable option groups
router.get('/option-groups/reusable', breakfastValidation, async (req, res) => {
  try {
    const [groups] = await db.query(
      'SELECT id, title, is_required, max_selections, created_at, updated_at FROM breakfast_option_groups WHERE breakfast_id IS NULL'
    );
    const groupIds = groups.map(group => group.id);
    const [options] = groupIds.length
      ? await db.query('SELECT id, group_id, option_type, option_name, additional_price FROM breakfast_options WHERE group_id IN (?)', [groupIds])
      : [[], []];
    const result = groups.map(group => ({
      ...group,
      options: options.filter(option => option.group_id === group.id).map(opt => ({
        id: opt.id,
        option_type: opt.option_type,
        option_name: opt.option_name,
        additional_price: parseFloat(opt.additional_price)
      }))
    }));
    res.json(result);
  } catch (error) {
    logger.error('Error fetching reusable option groups', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch reusable option groups', details: error.message });
  }
});

// Fetch single reusable option group
router.get('/option-groups/reusable/:id', breakfastValidation, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    if (isNaN(groupId) || groupId <= 0) {
      logger.warn('Invalid group ID', { id: req.params.id });
      return res.status(400).json({ error: 'Valid group ID is required' });
    }
    const [groups] = await db.query(
      'SELECT id, title, is_required, max_selections, created_at, updated_at FROM breakfast_option_groups WHERE id = ? AND breakfast_id IS NULL',
      [groupId]
    );
    if (groups.length === 0) {
      logger.warn('Reusable option group not found', { id: groupId });
      return res.status(404).json({ error: 'Reusable option group not found' });
    }
    const [options] = await db.query(
      'SELECT id, group_id, option_type, option_name, additional_price FROM breakfast_options WHERE group_id = ?',
      [groupId]
    );
    const result = {
      ...groups[0],
      options: options.map(opt => ({
        id: opt.id,
        option_type: opt.option_type,
        option_name: opt.option_name,
        additional_price: parseFloat(opt.additional_price)
      }))
    };
    res.json(result);
  } catch (error) {
    logger.error('Error fetching reusable option group', { error: error.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch reusable option group', details: error.message });
  }
});

// Create breakfast option
router.post('/breakfasts/:id/options', checkAdmin, breakfastValidation, async (req, res) => {
  const { group_id, option_type, option_name, additional_price } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const breakfastId = parseInt(req.params.id);
    const parsedGroupId = parseInt(group_id);
    const parsedAdditionalPrice = parseFloat(additional_price) || 0;
    if (isNaN(breakfastId) || breakfastId <= 0) {
      await connection.rollback();
      logger.warn('Invalid breakfast ID', { id: req.params.id });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    if (isNaN(parsedGroupId) || parsedGroupId <= 0) {
      await connection.rollback();
      logger.warn('Invalid group ID', { group_id });
      return res.status(400).json({ error: 'Valid group ID is required' });
    }
    if (!option_type || !option_name) {
      await connection.rollback();
      logger.warn('Missing required fields', { fields: { option_type, option_name } });
      return res.status(400).json({ error: 'Option type and name are required' });
    }
    if (isNaN(parsedAdditionalPrice) || parsedAdditionalPrice < 0) {
      await connection.rollback();
      logger.warn('Invalid additional price', { additional_price });
      return res.status(400).json({ error: 'Additional price must be a non-negative number' });
    }
    const [breakfast] = await connection.query('SELECT id FROM breakfasts WHERE id = ?', [breakfastId]);
    if (breakfast.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    const [group] = await connection.query('SELECT id FROM breakfast_option_groups WHERE id = ? AND breakfast_id = ?', [parsedGroupId, breakfastId]);
    if (group.length === 0) {
      await connection.rollback();
      logger.warn('Option group not found', { id: parsedGroupId, breakfast_id: breakfastId });
      return res.status(404).json({ error: 'Option group not found' });
    }
    const [result] = await connection.query(
      'INSERT INTO breakfast_options (breakfast_id, group_id, option_type, option_name, additional_price) VALUES (?, ?, ?, ?, ?)',
      [breakfastId, parsedGroupId, option_type.trim(), option_name.trim(), parsedAdditionalPrice]
    );
    await connection.commit();
    logger.info('Breakfast option created', { id: result.insertId, breakfast_id: breakfastId, group_id: parsedGroupId });
    res.status(201).json({ message: 'Breakfast option created', id: result.insertId });
  } catch (error) {
    await connection.rollback();
    logger.error('Error creating breakfast option', { error: error.message, breakfast_id: req.params.id });
    res.status(500).json({ error: 'Failed to create breakfast option', details: error.message });
  } finally {
    connection.release();
  }
});

// Update breakfast option
router.put('/breakfasts/:breakfastId/options/:optionId', checkAdmin, breakfastValidation, async (req, res) => {
  const { group_id, option_type, option_name, additional_price } = req.body;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const breakfastId = parseInt(req.params.breakfastId);
    const optionId = parseInt(req.params.optionId);
    const parsedGroupId = parseInt(group_id);
    const parsedAdditionalPrice = parseFloat(additional_price) || 0;
    if (isNaN(breakfastId) || breakfastId <= 0) {
      await connection.rollback();
      logger.warn('Invalid breakfast ID', { id: req.params.breakfastId });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    if (isNaN(optionId) || optionId <= 0) {
      await connection.rollback();
      logger.warn('Invalid option ID', { id: req.params.optionId });
      return res.status(400).json({ error: 'Valid option ID is required' });
    }
    if (isNaN(parsedGroupId) || parsedGroupId <= 0) {
      await connection.rollback();
      logger.warn('Invalid group ID', { group_id });
      return res.status(400).json({ error: 'Valid group ID is required' });
    }
    if (!option_type || !option_name) {
      await connection.rollback();
      logger.warn('Missing required fields', { fields: { option_type, option_name } });
      return res.status(400).json({ error: 'Option type and name are required' });
    }
    if (isNaN(parsedAdditionalPrice) || parsedAdditionalPrice < 0) {
      await connection.rollback();
      logger.warn('Invalid additional price', { additional_price });
      return res.status(400).json({ error: 'Additional price must be a non-negative number' });
    }
    const [breakfast] = await connection.query('SELECT id FROM breakfasts WHERE id = ?', [breakfastId]);
    if (breakfast.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast not found', { id: breakfastId });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    const [group] = await connection.query('SELECT id FROM breakfast_option_groups WHERE id = ? AND breakfast_id = ?', [parsedGroupId, breakfastId]);
    if (group.length === 0) {
      await connection.rollback();
      logger.warn('Option group not found', { id: parsedGroupId, breakfast_id: breakfastId });
      return res.status(404).json({ error: 'Option group not found' });
    }
    const [option] = await connection.query('SELECT id FROM breakfast_options WHERE id = ? AND breakfast_id = ?', [optionId, breakfastId]);
    if (option.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast option not found', { id: optionId, breakfast_id: breakfastId });
      return res.status(404).json({ error: 'Breakfast option not found' });
    }
    await connection.query(
      'UPDATE breakfast_options SET group_id = ?, option_type = ?, option_name = ?, additional_price = ? WHERE id = ?',
      [parsedGroupId, option_type.trim(), option_name.trim(), parsedAdditionalPrice, optionId]
    );
    await connection.commit();
    logger.info('Breakfast option updated', { id: optionId, breakfast_id: breakfastId, group_id: parsedGroupId });
    res.json({ message: 'Breakfast option updated' });
  } catch (error) {
    await connection.rollback();
    logger.error('Error updating breakfast option', { error: error.message, breakfast_id: req.params.breakfastId, option_id: req.params.optionId });
    res.status(500).json({ error: 'Failed to update breakfast option', details: error.message });
  } finally {
    connection.release();
  }
});

// Delete breakfast option
router.delete('/breakfasts/:breakfastId/options/:optionId', checkAdmin, breakfastValidation, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const breakfastId = parseInt(req.params.breakfastId);
    const optionId = parseInt(req.params.optionId);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      await connection.rollback();
      logger.warn('Invalid breakfast ID', { id: req.params.breakfastId });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    if (isNaN(optionId) || optionId <= 0) {
      await connection.rollback();
      logger.warn('Invalid option ID', { id: req.params.optionId });
      return res.status(400).json({ error: 'Valid option ID is required' });
    }
    const [result] = await connection.query(
      'DELETE FROM breakfast_options WHERE id = ? AND breakfast_id = ?',
      [optionId, breakfastId]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      logger.warn('Breakfast option not found', { id: optionId, breakfast_id: breakfastId });
      return res.status(404).json({ error: 'Breakfast option not found' });
    }
    await connection.commit();
    logger.info('Breakfast option deleted', { id: optionId, breakfast_id: breakfastId });
    res.json({ message: 'Breakfast option deleted' });
  } catch (error) {
    await connection.rollback();
    logger.error('Error deleting breakfast option', { error: error.message, breakfast_id: req.params.breakfastId, option_id: req.params.optionId });
    res.status(500).json({ error: 'Failed to delete breakfast option', details: error.message });
  } finally {
    connection.release();
  }
});

// Fetch breakfast options
router.get('/breakfasts/:id/options', breakfastValidation, async (req, res) => {
  try {
    const breakfastId = parseInt(req.params.id);
    if (isNaN(breakfastId) || breakfastId <= 0) {
      logger.warn('Invalid breakfast ID', { id: req.params.id });
      return res.status(400).json({ error: 'Valid breakfast ID is required' });
    }
    const [rows] = await db.query(
      `SELECT bo.id, bo.group_id, bo.option_type, bo.option_name, bo.additional_price, bog.title as group_title, bog.is_required, bog.max_selections
       FROM breakfast_options bo
       JOIN breakfast_option_groups bog ON bo.group_id = bog.id
       WHERE bo.breakfast_id = ? OR (bog.breakfast_id IS NULL AND bog.id IN (
         SELECT option_group_id FROM breakfast_option_group_mappings WHERE breakfast_id = ?
       ))`,
      [breakfastId, breakfastId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching breakfast options', { error: error.message, breakfast_id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch breakfast options', details: error.message });
  }
});

// Submit breakfast rating
router.post('/breakfast-ratings', [
  require('express-validator').body('breakfast_id').isInt({ min: 1 }).withMessage('Valid breakfast ID is required'),
  require('express-validator').body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
], async (req, res) => {
  const errors = require('express-validator').validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation errors for breakfast rating', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array() });
  }
  const { breakfast_id, rating } = req.body;
  const sessionId = req.sessionID || null;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [breakfast] = await connection.query('SELECT id FROM breakfasts WHERE id = ?', [breakfast_id]);
    if (breakfast.length === 0) {
      await connection.rollback();
      logger.warn('Breakfast not found for rating', { breakfast_id });
      return res.status(404).json({ error: 'Breakfast not found' });
    }
    if (sessionId) {
      const [existingRating] = await connection.query(
        'SELECT id FROM breakfast_ratings WHERE breakfast_id = ? AND session_id = ?',
        [breakfast_id, sessionId]
      );
      if (existingRating.length > 0) {
        await connection.rollback();
        logger.warn('Rating already exists for this breakfast in session', { breakfast_id, sessionId });
        return res.status(400).json({ error: 'You have already rated this breakfast' });
      }
    }
    const [result] = await connection.query(
      'INSERT INTO breakfast_ratings (breakfast_id, rating, session_id, created_at) VALUES (?, ?, ?, NOW())',
      [breakfast_id, rating, sessionId]
    );
    await connection.query(
      `UPDATE breakfasts
       SET average_rating = (SELECT AVG(rating) FROM breakfast_ratings WHERE breakfast_id = ?),
           review_count = (SELECT COUNT(*) FROM breakfast_ratings WHERE breakfast_id = ?)
       WHERE id = ?`,
      [breakfast_id, breakfast_id, breakfast_id]
    );
    await connection.commit();
    logger.info('Breakfast rating submitted', { id: result.insertId, breakfast_id, rating, sessionId });
    res.status(201).json({ message: 'Breakfast rating submitted', id: result.insertId });
  } catch (error) {
    await connection.rollback();
    logger.error('Error submitting breakfast rating', { error: error.message, breakfast_id, rating, sessionId });
    res.status(500).json({ error: 'Failed to submit breakfast rating', details: error.message });
  } finally {
    connection.release();
  }
});

// Fetch ratings by breakfast
router.get('/breakfast-ratings', [
  require('express-validator').query('breakfast_id').isInt({ min: 1 }).withMessage('Valid breakfast ID is required'),
], async (req, res) => {
  const errors = require('express-validator').validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation errors for fetching breakfast ratings', { errors: errors.array() });
    return res.status(400).json({ errors: errors.array() });
  }
  const { breakfast_id } = req.query;
  const sessionId = req.sessionID || null;
  try {
    const query = sessionId
      ? 'SELECT id, breakfast_id, rating, created_at FROM breakfast_ratings WHERE breakfast_id = ? AND session_id = ?'
      : 'SELECT id, breakfast_id, rating, created_at FROM breakfast_ratings WHERE breakfast_id = ? AND session_id IS NULL';
    const params = sessionId ? [breakfast_id, sessionId] : [breakfast_id];
    const [rows] = await db.query(query, params);
    logger.info('Breakfast ratings fetched successfully', { breakfast_id, sessionId, count: rows.length });
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching breakfast ratings', { error: error.message, breakfast_id, sessionId });
    res.status(500).json({ error: 'Failed to fetch breakfast ratings', details: error.message });
  }
});

module.exports = router;