const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken');
const logger = require('../logger');
const themeValidate = require('../middleware/themeValidate');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Configure Cloudinary storage for multer
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'Uploads/Theme',
    allowed_formats: ['jpg', 'jpeg', 'png'],
    public_id: (req, file) => `${Date.now()}-${file.originalname}`,
  },
});

const upload = require('multer')({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Image must be JPEG or PNG'), false);
    }
  },
}).fields([{ name: 'logo', maxCount: 1 }, { name: 'favicon', maxCount: 1 }]);

// Middleware to verify admin role
const validateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('No token provided for theme operation', { headers: req.headers });
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key');
    if (decoded.role !== 'admin') {
      logger.warn('Non-admin attempt to access theme operation', { user: decoded });
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Invalid token for theme operation', { error: error.message });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Middleware to log raw FormData
const logFormData = (req, res, next) => {
  if (req.headers['content-type']?.includes('multipart/form-data')) {
    logger.info('Raw FormData request for theme branding', {
      headers: req.headers,
      method: req.method,
      url: req.url,
    });
  }
  next();
};

// Get current theme
router.get('/theme', async (req, res) => {
  try {
    const [theme] = await db.query('SELECT * FROM themes ORDER BY updated_at DESC LIMIT 1');
    if (!theme.length) {
      // Insert default theme if none exists
      const defaultTheme = {
        primary_color: '#ff6b35',
        secondary_color: '#ff8c42',
        background_color: '#faf8f5',
        text_color: '#1f2937',
        site_title: 'Café Local',
        currency: '$',
        logo_url: null,
        favicon_url: null,
      };
      await db.query(
        'INSERT INTO themes (primary_color, secondary_color, background_color, text_color, site_title, currency, logo_url, favicon_url, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        [
          defaultTheme.primary_color,
          defaultTheme.secondary_color,
          defaultTheme.background_color,
          defaultTheme.text_color,
          defaultTheme.site_title,
          defaultTheme.currency,
          defaultTheme.logo_url,
          defaultTheme.favicon_url,
        ]
      );
      logger.info('Default theme created', { defaultTheme });
      return res.json(defaultTheme);
    }
    logger.info('Theme fetched', { themeId: theme[0].id });
    res.json(theme[0]);
  } catch (error) {
    logger.error('Error fetching theme', { error: error.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// Update theme colors (admin only)
router.put('/theme', validateAdmin, themeValidate, async (req, res) => {
  const { primary_color, secondary_color, background_color, text_color, site_title, currency } = req.body;
  try {
    const [existingTheme] = await db.query('SELECT id FROM themes ORDER BY updated_at DESC LIMIT 1');
    if (!existingTheme.length) {
      // Insert new theme if none exists
      await db.query(
        'INSERT INTO themes (primary_color, secondary_color, background_color, text_color, site_title, currency, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          primary_color || '#ff6b35',
          secondary_color || '#ff8c42',
          background_color || '#faf8f5',
          text_color || '#1f2937',
          site_title || 'Café Local',
          currency || '$',
          req.user.id,
        ]
      );
      logger.info('New theme created', { primary_color, secondary_color, site_title, currency });
    } else {
      // Update existing theme
      const [result] = await db.query(
        'UPDATE themes SET primary_color = ?, secondary_color = ?, background_color = ?, text_color = ?, site_title = ?, currency = ?, admin_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [
          primary_color || '#ff6b35',
          secondary_color || '#ff8c42',
          background_color || '#faf8f5',
          text_color || '#1f2937',
          site_title || 'Café Local',
          currency || '$',
          req.user.id,
          existingTheme[0].id,
        ]
      );
      if (result.affectedRows === 0) {
        logger.warn('No theme found for update', { id: existingTheme[0].id });
        return res.status(404).json({ error: 'No theme found' });
      }
      logger.info('Theme updated', { id: existingTheme[0].id, primary_color, secondary_color, site_title, currency });
    }
    res.json({ message: 'Theme updated successfully' });
  } catch (error) {
    logger.error('Error updating theme', { error: error.message, body: req.body });
    res.status(500).json({ error: 'Server error' });
  }
});

// Update theme branding (logo, favicon, site title) - admin only
router.put('/theme/branding', validateAdmin, themeValidate, logFormData, upload, async (req, res) => {
  try {
    const { site_title } = req.body;
    const files = req.files || {};
    const [existingTheme] = await db.query('SELECT id, logo_url, favicon_url FROM themes ORDER BY updated_at DESC LIMIT 1');
    let logo_url = existingTheme.length ? existingTheme[0].logo_url : null;
    let favicon_url = existingTheme.length ? existingTheme[0].favicon_url : null;

    // Handle logo upload
    if (files.logo && files.logo[0]) {
      if (existingTheme.length && existingTheme[0].logo_url) {
        const oldPublicId = existingTheme[0].logo_url.split('/').pop().split('.')[0];
        try {
          await cloudinary.uploader.destroy(`Uploads/Theme/${oldPublicId}`);
          logger.info('Old logo image deleted from Cloudinary', { public_id: oldPublicId });
        } catch (err) {
          logger.error('Error deleting old logo image from Cloudinary', { error: err.message, public_id: oldPublicId });
        }
      }
      logo_url = files.logo[0].path; // Cloudinary URL
      logger.info('Logo uploaded to Cloudinary', { url: logo_url });
    }

    // Handle favicon upload
    if (files.favicon && files.favicon[0]) {
      if (existingTheme.length && existingTheme[0].favicon_url) {
        const oldPublicId = existingTheme[0].favicon_url.split('/').pop().split('.')[0];
        try {
          await cloudinary.uploader.destroy(`Uploads/Theme/${oldPublicId}`);
          logger.info('Old favicon image deleted from Cloudinary', { public_id: oldPublicId });
        } catch (err) {
          logger.error('Error deleting old favicon image from Cloudinary', { error: err.message, public_id: oldPublicId });
        }
      }
      favicon_url = files.favicon[0].path; // Cloudinary URL
      logger.info('Favicon uploaded to Cloudinary', { url: favicon_url });
    }

    if (!existingTheme.length) {
      // Insert new theme if none exists
      await db.query(
        'INSERT INTO themes (logo_url, favicon_url, site_title, primary_color, secondary_color, background_color, text_color, currency, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          logo_url,
          favicon_url,
          site_title || 'Café Local',
          '#ff6b35',
          '#ff8c42',
          '#faf8f5',
          '#1f2937',
          '$',
          req.user.id,
        ]
      );
      logger.info('New theme created with branding', { logo_url, favicon_url, site_title });
    } else {
      // Update existing theme
      const [result] = await db.query(
        'UPDATE themes SET logo_url = ?, favicon_url = ?, site_title = ?, admin_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [
          logo_url,
          favicon_url,
          site_title || existingTheme[0].site_title || 'Café Local',
          req.user.id,
          existingTheme[0].id,
        ]
      );
      if (result.affectedRows === 0) {
        logger.warn('No theme found for branding update', { id: existingTheme[0].id });
        return res.status(404).json({ error: 'No theme found' });
      }
      logger.info('Theme branding updated', { id: existingTheme[0].id, logo_url, favicon_url, site_title });
    }
    res.json({ message: 'Branding updated successfully', logo_url, favicon_url, site_title: site_title || existingTheme[0].site_title || 'Café Local' });
  } catch (error) {
    logger.error('Error updating theme branding', { error: error.message, body: req.body });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;