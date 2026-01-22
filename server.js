const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const logger = require('./logger');
const db = require('./config/db');
const validate = require('./middleware/validate');
const themeValidate = require('./middleware/themeValidate');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Initialize express app first
const app = express();
const server = http.createServer(app);

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dbvbbtekw',
  api_key: process.env.CLOUDINARY_API_KEY || '156121837471457',
  api_secret: process.env.CLOUDINARY_API_SECRET || '_SDgvc8l9rl5lS7rf8KXazaYwr0',
});

// Configure multer with Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'Uploads',
    allowed_formats: ['jpg', 'jpeg', 'png', 'ico'],
    public_id: (req, file) => `${Date.now()}-${file.originalname}`,
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|ico/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only .jpg, .jpeg, .png, and .ico files are allowed'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

app.set('upload', upload);

// Validate critical environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
if (!process.env.JWT_SECRET) {
  logger.warn('JWT_SECRET not set, using default value');
}
const CLIENT_URL = process.env.CLIENT_URL || 'https://la-coupole.vercel.app';
if (!process.env.CLIENT_URL) {
  logger.warn('CLIENT_URL not set, defaulting to production frontend URL');
}

// Configure allowed origins for CORS
const allowedOrigins = [
  CLIENT_URL.replace(/\/$/, ''), // Remove trailing slash
  ...(process.env.NODE_ENV === 'development' ? [
    'http://localhost:5173',
    'http://192.168.1.6:5173',
    'http://192.168.1.8:5173',
    'http://192.168.111.1:5173',
    /^http:\/\/192\.168\.1\.\d{1,3}:5173$/
  ] : []),
];

const corsOptions = {
  origin: (origin, callback) => {
    const normalizedOrigin = origin ? origin.replace(/\/$/, '') : origin;
    logger.debug('CORS check', { origin: normalizedOrigin, allowedOrigins });
    if (!normalizedOrigin || allowedOrigins.some(allowed => 
      typeof allowed === 'string' ? allowed === normalizedOrigin : allowed.test(normalizedOrigin)
    )) {
      logger.debug('CORS allowed', { origin: normalizedOrigin });
      callback(null, true);
    } else {
      logger.warn('CORS blocked', { origin: normalizedOrigin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id', 'X-Device-Id'],
  credentials: true,
};

app.use(cors(corsOptions));

// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const normalizedOrigin = origin ? origin.replace(/\/$/, '') : origin;
      logger.debug('Socket.IO CORS check', { origin: normalizedOrigin, allowedOrigins });
      if (!normalizedOrigin || allowedOrigins.some(allowed => 
        typeof allowed === 'string' ? allowed === normalizedOrigin : allowed.test(normalizedOrigin)
      )) {
        logger.debug('Socket.IO CORS allowed', { origin: normalizedOrigin });
        callback(null, true);
      } else {
        logger.warn('Socket.IO CORS blocked', { origin: normalizedOrigin });
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id', 'X-Device-Id'],
    credentials: true,
  },
  path: '/socket.io/',
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve Cloudinary images
app.get('/Uploads/:publicId', async (req, res) => {
  try {
    const { publicId } = req.params;
    const imageUrl = cloudinary.url(`Uploads/${publicId}`, {
      secure: true,
    });
    res.redirect(imageUrl);
  } catch (error) {
    logger.error('Error redirecting to Cloudinary image', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch image' });
  }
});

// JWT Middleware
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (!token || token === 'null' || token === 'undefined' || !token.trim()) {
      logger.debug('Empty or invalid token received', { token: token || 'none', url: req.url });
      return next();
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      logger.debug('JWT verified', { userId: decoded.id, email: decoded.email, url: req.url });
    } catch (error) {
      logger.warn('Invalid JWT', { error: error.message, token: token.substring(0, 10) + '...', url: req.url });
    }
  }
  logger.info('Incoming request', {
    method: req.method,
    url: req.url,
    user: req.user ? req.user.id : 'anonymous',
    origin: req.headers.origin,
  });
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', environment: process.env.NODE_ENV || 'production' });
});

// Apply validations middleware before routes
app.use('/api', (req, res, next) => {
  if (
    req.method === 'POST' ||
    req.method === 'PUT' ||
    req.method === 'DELETE' ||
    (req.method === 'GET' && (
      req.path.includes('/menu-items') ||
      req.path.includes('/categories') ||
      req.path.includes('/ratings') ||
      req.path.includes('/tables') ||
      req.path.includes('/notifications') ||
      req.path.includes('/banners') ||
      req.path.includes('/breakfasts') ||
      req.path.includes('/ingredients') ||
      req.path.includes('/stock-dashboard')
    ))
  ) {
    if (req.path.includes('/menu-items') || 
        req.path.includes('/categories') || 
        req.path.includes('/banners') || 
        req.path.includes('/breakfasts') ||
        req.path.includes('/ingredients')) {
      if (req.headers['content-type']?.includes('multipart/form-data')) {
        return next();
      }
    }
    return validate(req, res, next);
  } else if (req.path.includes('/theme')) {
    return themeValidate(req, res, next);
  }
  next();
});

// Routes
const authRoutes = require('./routes/authRoutes');
const menuRoutes = require('./routes/menuRoutes');
const orderRoutes = require('./routes/orderRoutes')(io);
const reservationRoutes = require('./routes/reservationRoutes')(io);
const promotionRoutes = require('./routes/promotionRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const breakfastRoutes = require('./routes/breakfastRoutes');
const themeRoutes = require('./routes/themeRoutes');
const stockRoutes = require('./routes/stockRoutes');

app.use('/api', authRoutes);
app.use('/api', menuRoutes);
app.use('/api', orderRoutes);
app.use('/api', reservationRoutes);
app.use('/api', promotionRoutes);
app.use('/api', analyticsRoutes);
app.use('/api', notificationRoutes);
app.use('/api', bannerRoutes);
app.use('/api', breakfastRoutes);
app.use('/api', themeRoutes);
app.use('/api', stockRoutes);

// Debug route to list all Cloudinary uploads
app.get('/api/debug/uploads', async (req, res) => {
  try {
    const result = await cloudinary.api.resources({
      resource_type: 'image',
      prefix: 'Uploads',
      max_results: 100,
    });
    const files = result.resources.map(resource => ({
      public_id: resource.public_id,
      url: resource.secure_url,
    }));
    logger.info('Listing Cloudinary uploads', { count: files.length });
    res.json({ files });
  } catch (error) {
    logger.error('Error listing Cloudinary uploads', { error: error.message });
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

function logRoutes() {
  app._router?.stack?.forEach((layer) => {
    if (layer.route) {
      logger.info('Registered route', {
        method: layer.route.stack[0].method.toUpperCase(),
        path: layer.route.path,
      });
    } else if (layer.name === 'router' && layer.handle.stack) {
      const prefix = layer.regexp.source
        .replace(/\\\//g, '/')
        .replace(/^\/\^/, '')
        .replace(/\/\?\(\?=\/\|\$\)/, '');
      layer.handle.stack.forEach((handler) => {
        if (handler.route) {
          logger.info('Registered route', {
            method: handler.route.stack[0].method.toUpperCase(),
            path: prefix + handler.route.path,
          });
        }
      });
    }
  });
}

logRoutes();

// Error handling middleware
app.use((err, req, res, next) => {
  if (err.code === 'ECONNABORTED') {
    logger.error('Request aborted', {
      method: req.method,
      url: req.url,
      user: req.user ? req.user.id : 'anonymous',
      origin: req.headers.origin,
    });
    return res.status(408).json({ error: 'Request timeout' });
  }
  if (err.message === 'Not allowed by CORS') {
    logger.error('CORS error', { method: req.method, url: req.url, origin: req.headers.origin });
    return res.status(403).json({ error: 'CORS policy violation' });
  }
  logger.error('Server error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url,
    user: req.user ? req.user.id : 'anonymous',
    origin: req.headers.origin,
  });
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  logger.warn('Route not found', {
    method: req.method,
    url: req.url,
    user: req.user ? req.user.id : 'anonymous',
    origin: req.headers.origin,
  });
  res.status(404).json({ error: 'Not found' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info('New socket connection', { id: socket.id });

  socket.on('join-session', async (data) => {
    const { token, sessionId } = data;
    if (!token && !sessionId) {
      logger.warn('No token or sessionId provided for socket session', { socketId: socket.id });
      socket.emit('auth-error', { message: 'No token or session ID provided' });
      return;
    }
    if (token) {
      if (typeof token !== 'string' || !token.trim()) {
        logger.warn('Invalid token provided for socket session', { socketId: socket.id });
        socket.emit('auth-error', { message: 'Invalid or empty token' });
        return;
      }
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [decoded.id]);
        if (rows.length > 0 && ['admin', 'server'].includes(rows[0].role)) {
          socket.join('staff-notifications');
          logger.info('Socket joined staff-notifications room', { socketId: socket.id, userId: decoded.id, role: rows[0].role });
        } else {
          logger.warn('Unauthorized socket join attempt', { socketId: socket.id, userId: decoded.id });
          socket.emit('auth-error', { message: 'Unauthorized access' });
        }
      } catch (error) {
        logger.warn('Invalid JWT for socket session', { error: error.message, socketId: socket.id });
        socket.emit('auth-error', { message: 'Invalid or expired token' });
      }
    } else if (sessionId && typeof sessionId === 'string' && sessionId.trim()) {
      socket.join(`guest-${sessionId}`);
      logger.info('Guest socket joined', { socketId: socket.id, sessionId });
    } else {
      logger.warn('Invalid sessionId for socket session', { socketId: socket.id });
      socket.emit('auth-error', { message: 'Invalid session ID' });
    }
  });

  socket.on('disconnect', () => {
    logger.info('Socket disconnected', { socketId: socket.id });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', async () => {
  try {
    await db.getConnection();
    logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'production'} environment`);
  } catch (error) {
    logger.error('Failed to connect to database', { error: error.message });
    process.exit(1);
  }
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason: reason.message || reason, promise });
});
