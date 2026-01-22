const logger = require('../logger');

const logFormData = (req, res, next) => {
  if (req.method === 'POST' && req.headers['content-type']?.includes('multipart/form-data')) {
    logger.info('FormData request received', {
      path: req.path,
      headers: req.headers,
      contentLength: req.headers['content-length'],
    });
    next();
  } else {
    next();
  }
};

module.exports = logFormData;