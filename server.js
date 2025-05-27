// server.js
// Load environment variables with fallback
const dotenv = require('dotenv');
const dotenvResult = dotenv.config();
if (dotenvResult.error && process.env.NODE_ENV !== 'production') {
  console.warn('No .env file found, relying on system environment variables');
}

// Core dependencies
const http = require('http');
const https = require('https');
const fs = require('fs');
const app = require('./app');
const logger = require('./config/logger');
const chainAdapter = require('./adapters/chainAdapter'); // For cross-chain cleanup
const sovereignEntropyNodeController = require('./controllers/sovereignEntropyNodeController'); // For node cleanup

// Validate essential environment variables
const requiredEnv = [
  'PORT',
  'NODE_ENV',
  'CHAIN_PROVIDER', // For cross-chain (e.g., Ethereum, Polkadot)
  'ORACLE_KEY', // For AI oracle nodes
  'VOUCHER_CONTRACT_ADDRESS', // For Sovereign Vouchers
];
const missingEnv = requiredEnv.filter(env => !process.env[env]);

if (missingEnv.length) {
  logger.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// Normalize and set port
const port = normalizePort(process.env.PORT || '3000');
app.set('port', port);

// Create server (HTTP or HTTPS based on env)
let server;
if (process.env.USE_HTTPS === 'true' && process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
  try {
    const options = {
      key: fs.readFileSync(process.env.SSL_KEY_PATH),
      cert: fs.readFileSync(process.env.SSL_CERT_PATH),
    };
    server = https.createServer(options, app);
    logger.info('HTTPS server initialized');
  } catch (err) {
    logger.error(`Failed to initialize HTTPS: ${err.message}`);
    process.exit(1);
  }
} else {
  server = http.createServer(app);
  logger.info('HTTP server initialized (HTTPS disabled)');
}

// Start server
server.listen(port);
server.on('error', onError);
server.on('listening', onListening);

// Graceful shutdown
const shutdown = async () => {
  logger.info('SIGTERM received. Initiating graceful shutdown...');
  
  // Cleanup SRP-specific resources
  try {
    await chainAdapter.disconnect(); // Disconnect from chains (e.g., Ethereum, Polkadot)
    logger.info('Disconnected from blockchain networks');
    await sovereignEntropyNodeController.shutdown(); // Stop entropy nodes
    logger.info('Entropy nodes shut down');
  } catch (err) {
    logger.error(`Shutdown error: ${err.message}`);
  }

  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown); // Handle Ctrl+C

// ------------------
// Helper Functions
// ------------------

function normalizePort(val) {
  const port = parseInt(val, 10);
  if (isNaN(port)) {
    logger.warn(`Invalid port value: ${val}, falling back to 3000`);
    return 3000;
  }
  if (port >= 0) return port;
  logger.error('Port must be a positive number');
  return false;
}

function onError(error) {
  if (error.syscall !== 'listen') {
    logger.error(`Server error: ${error.message}`, { stack: error.stack });
    throw error;
  }

  const bind = typeof port === 'string' ? `Pipe ${port}` : `Port ${port}`;

  switch (error.code) {
    case 'EACCES':
      logger.error(`${bind} requires elevated privileges`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      logger.error(`${bind} is already in use`);
      process.exit(1);
      break;
    case 'ENOTFOUND':
      logger.error(`Network error: ${bind} not found`);
      process.exit(1);
      break;
    default:
      logger.error(`Unexpected error: ${error.message}`, { stack: error.stack });
      throw error;
  }
}

function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string' ? `pipe ${addr}` : `port ${addr.port}`;
  
  // Initialize SRP-specific components
  try {
    chainAdapter.initialize(); // Connect to chains
    logger.info('Connected to blockchain networks');
    sovereignEntropyNodeController.start(); // Start entropy nodes
    logger.info('Entropy nodes initialized');
  } catch (err) {
    logger.error(`Initialization error: ${err.message}`);
    process.exit(1);
  }

  logger.info(`Server running on ${bind} in ${process.env.NODE_ENV} mode`);
}