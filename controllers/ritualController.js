const { v4: uuid } = require('uuid');
const ethers = require('ethers');
const logger = require('../config/logger'); // Aligned with your middleware logger
const db = require('../config/db');
const chainAdapter = require('../adapters/chainAdapter');
const Ajv = require('ajv');
const jsonflowExecutor = require('../config/jsonflow-executor');
const ritualSchema = require('../schema/rituals/ad-revenue-ritual.schema.json');

// Initialize AJV (reusing your middleware's configuration)
const ajv = new Ajv({
  strict: false, // Allow non-standard keywords (metadata, nlp, steps)
  allErrors: true, // Report all validation errors
  verbose: true // Include schema and data in errors
});

// Compile schema
let validate;
try {
  validate = ajv.compile(ritualSchema);
  logger.info('Ad revenue ritual schema compiled successfully');
} catch (err) {
  logger.error('Schema compilation failed:', err.message);
  throw new Error('Schema compilation failed');
}

// Middleware from your input
const validateRitual = async (req, res, next) => {
  try {
    const valid = validate(req.body);
    if (!valid) {
      const error = new Error('Validation failed');
      error.status = 400;
      error.details = validate.errors.map(err => ({
        path: err.instancePath,
        message: err.message,
        params: err.params
      }));
      logger.warn('Validation failed:', error.details);
      return next(error);
    }

    const { metadata, nlp, steps } = req.body;
    req.app.locals.ritualMetadata = metadata || {};
    logger.info('Ritual metadata:', {
      schema_version: metadata?.schema_version,
      function: metadata?.function,
      tags: metadata?.tags
    });

    if (nlp && nlp.mapIntent) {
      req.app.locals.nlpConfig = {
        intentMap: nlp.mapIntent,
        model: nlp.model || 'grok_3',
        language: nlp.language || 'en'
      };
      logger.debug('NLP config initialized:', req.app.locals.nlpConfig);
    }

    req.app.locals.ritualSteps = steps || [];
    logger.debug(`Loaded ${steps?.length || 0} ritual steps`);

    if (!Array.isArray(req.body.rituals)) {
      const error = new Error('Rituals must be an array');
      error.status = 400;
      return next(error);
    }

    if (req.body.nlp?.mapIntent) {
      req.app.locals.actions = Object.keys(nlp.mapIntent).map(intent => ({
        intent,
        action: nlp.mapIntent[intent],
        nl_phrase: steps?.find(step => step.function === nlp.mapIntent[intent])?.nl_phrase
      }));
    }

    logger.info('Ritual validation successful');
    next();
  } catch (err) {
    logger.error('Unexpected error in validateRitual:', err.message);
    const error = new Error('Internal server error');
    error.status = 500;
    next(error);
  }
};

const executeRitualStep = async (req, res, next) => {
  try {
    const { ritualSteps } = req.app.locals;
    if (!ritualSteps.length) {
      logger.warn('No ritual steps to execute');
      return res.status(400).json({ error: 'No steps provided' });
    }

    const step = ritualSteps[0]; // Simplified: execute first step
    logger.info('Executing step:', { id: step.id, type: step.type, nl_phrase: step.nl_phrase });

    if (step.type === 'blockchain_operation') {
      logger.info(`Executing blockchain operation: ${step.nl_phrase}`, step.params);
      req.app.locals.stepResult = { status: 'success', operation: step.id };
    } else if (step.type === 'call' && req.app.locals.nlpConfig) {
      logger.info(`Executing NLP call: ${step.nl_phrase}`, step.args);
      req.app.locals.stepResult = { status: 'success', call: step.function };
    }

    next();
  } catch (err) {
    logger.error('Error executing ritual step:', err.message);
    const error = new Error('Step execution failed');
    error.status = 500;
    next(error);
  }
};

class RitualController {
  static async executeWorkflow(req, res) {
    try {
      // Use middleware for validation and step setup
      await validateRitual(req, res, async () => {
        await executeRitualStep(req, res, async () => {
          const { sid, adId, pulseScore } = req.body.schema.inputs;
          const workflowId = uuid();
          logger.info('Starting ad revenue ritual workflow', { workflowId, sid });

          // Execute JSONFlow steps
          const result = await jsonflowExecutor.run(ritualSchema, req.body, {
            context: { db, chainAdapter, logger },
          });

          // Step 1: Validate SID (handled by middleware)
          // Step 2: Record Ritual
          const ritualId = result.outputs.ritualId;
          await db.rituals.insert({
            ritualId,
            sid,
            adId,
            timestamp: new Date(),
          });

          // Step 3: Distribute Revenue via Voucher
          const voucherId = result.outputs.voucherId;
          const reward = (pulseScore / 1000).toFixed(18); // Reward based on Pulse Score
          await chainAdapter.executeContract({
            chain: 'ethereum',
            method: 'createVoucher',
            params: [sid, { amount: reward, assetType: 'ETH', contractAddress: '0x0' }, ethers.utils.sha256('ritual')],
          });

          await db.vouchers.insert({
            voucherId,
            creatorSID: sid,
            value: { amount: reward, assetType: 'ETH', contractAddress: '0x0' },
            status: 'created',
            transferHistory: [],
            createdAt: new Date(),
          });

          // Log NLP and metadata from middleware
          if (req.app.locals.nlpConfig) {
            logger.info('NLP processed', { config: req.app.locals.nlpConfig });
          }
          logger.info('Ritual metadata recorded', { metadata: req.app.locals.ritualMetadata });

          logger.info('Ad revenue ritual completed', { ritualId, voucherId, sid });
          res.status(200).json({ ritualId, voucherId, status: 'success' });
        });
      });
    } catch (error) {
      logger.error('Ad revenue ritual failed', { error: error.message, stack: error.stack });
      res.status(error.status || 500).json({ error: error.message, details: error.details });
    }
  }

  static async getRitualStatus({ ritualId }) {
    try {
      const ritual = await db.rituals.findOne({ ritualId });
      if (!ritual) throw new Error('Ritual not found');
      logger.info('Ritual status retrieved', { ritualId });
      return { ritualId, status: ritual.status, adId: ritual.adId, sid: ritual.sid };
    } catch (error) {
      logger.error('Ritual status retrieval failed', { error: error.message });
      throw error;
    }
  }
}

module.exports = RitualController;