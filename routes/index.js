const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises; // Use promises for async
const glob = require('glob').promises;
const ajv = require('../config/ajv');
const logger = require('../config/logger');
const errorHandler = require('../middleware/errorHandler');
const { executeJSONFlow } = require('../jsonflow-executor');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const cache = require('memory-cache');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const router = express.Router();

// Controllers
const ExchangeController = require('../controllers/exchangeController');
const ChainAdapter = require('../adapters/chainAdapter');
const agentController = require('../controllers/agentController');
const apiController = require('../controllers/apiController');
const casinoController = require('../controllers/casinoController');
const ritualController = require('../controllers/ritualController');
const governanceController = require('../controllers/governanceController');
const FeedController = require('../controllers/feedController');
const MarketController = require('../controllers/marketController');

// Instantiate controllers
const exchangeController = new ExchangeController();
const chainAdapter = new ChainAdapter();
const feedController = new FeedController(exchangeController, chainAdapter);
const marketController = new MarketController(exchangeController, chainAdapter);

// Security middleware
router.use(helmet());
router.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 })); // 100 requests per 15min

// JWT Authentication with refresh check
const authenticateJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return next(Object.assign(new Error('Missing JWT token'), { status: 401 }));
  }
  try {
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET missing');
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.exp < Date.now() / 1000) {
      return next(Object.assign(new Error('Token expired'), { status: 401 }));
    }
    req.user = decoded;
    next();
  } catch (error) {
    next(Object.assign(error, { status: 403 }));
  }
};

// Async schema loading
const schemas = {};
const criticalSchemas = ['sovereign-api', 'agent', 'ritual', 'governance', 'oracle', 'casino', 'market', 'feed'];
const loadSchemas = async () => {
  const schemaDir = path.join(__dirname, '../schema');
  const files = await glob(`${schemaDir}/**/*.schema.json`);
  for (const file of files) {
    try {
      const schema = JSON.parse(await fs.readFile(file, 'utf-8'));
      const schemaName = path.basename(file, '.schema.json');
      schemas[schemaName] = schema;
      if (criticalSchemas.includes(schemaName)) {
        logger.info(`Loaded critical schema: ${schemaName}`);
        ajv.addSchema(schema, schema.$id || schemaName);
      }
    } catch (error) {
      const schemaName = path.basename(file, '.schema.json');
      if (criticalSchemas.includes(schemaName)) {
        logger.error(`Critical schema load error: ${file}`, { error: error.message });
        process.exit(1);
      } else {
        logger.warn(`Schema load error: ${file}`, { error: error.message });
      }
    }
  }
};

// Initialize schemas
loadSchemas().catch(err => {
  logger.error('Schema initialization failed', { error: err.message });
  process.exit(1);
});

// Schema validator
const getSchemaValidator = (schemaName, module, action) => {
  if (!schemas[schemaName]) {
    logger.warn(`Schema ${schemaName} not found`);
    return () => true;
  }
  const schema = module && action
    ? schemas[schemaName].properties?.[module]?.properties?.[action] || schemas[schemaName]
    : schemas[schemaName];
  return schema ? ajv.compile(schema) : () => true;
};

const validateWith = (schemaName, module, action) => {
  const validate = getSchemaValidator(schemaName, module, action);
  return (req, res, next) => {
    if (!validate(req.body)) {
      logger.warn(`Schema validation failed for ${schemaName}.${module}.${action}`, { errors: validate.errors });
      return res.status(400).json({ success: false, errors: validate.errors });
    }
    next();
  };
};

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn(`Request validation failed`, { errors: errors.array() });
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

// Cache middleware for GET requests
const cacheMiddleware = (duration) => (req, res, next) => {
  const key = `__express__${req.originalUrl}`;
  const cached = cache.get(key);
  if (cached) {
    return res.json(cached);
  }
  res.sendResponse = res.json;
  res.json = (body) => {
    cache.put(key, body, duration * 1000);
    res.sendResponse(body);
  };
  next();
};

// Identity Routes
router.post(
  '/identity/register',
  [
    body('username').isString().notEmpty().trim().escape(),
    body('publicKey').isString().notEmpty().matches(/^(0x)?[0-9a-fA-F]{40}$/),
    validateRequest,
    validateWith('agent', 'identity', 'register')
  ],
  async (req, res, next) => {
    try {
      const result = await agentController.register(req.body);
      res.status(201).json({ success: true, message: 'User registered', data: result });
    } catch (e) {
      next(e);
    }
  }
);

// Oracle Routes (example, others follow similar pattern)
router.get(
  '/oracle/consensus',
  authenticateJWT,
  cacheMiddleware(60), // Cache for 60 seconds
  async (req, res, next) => {
    try {
      const result = await executeJSONFlow({ workflow: 'oracle-consensus', params: req.query });
      res.status(200).json({ success: true, message: 'Consensus retrieved', data: result });
    } catch (e) {
      next(e);
    }
  }
);

// Error middleware (standardized response)
router.use((err, req, res, next) => {
  logger.error('Request error', { error: err.message, stack: err.stack, path: req.path });
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal Server Error',
    code: err.status || 500
  });
});

// Modular route imports (example)
const identityRoutes = require('./routes/identity');
const oracleRoutes = require('./routes/oracle');
router.use('/identity', identityRoutes);
router.use('/oracle', oracleRoutes);
// Add other modules similarly

module.exports = router;