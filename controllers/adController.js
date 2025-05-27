const { v4: uuid } = require('uuid');
const ethers = require('ethers');
const logger = require('../config/logger');
const db = require('../config/db');
const chainAdapter = require('../adapters/chainAdapter');
const ajv = require('../config/ajv');
const jsonflowExecutor = require('../config/jsonflow-executor');
const adSchema = require('../schema/advertising/advertising.schema.json');

const validateSchema = ajv.compile(adSchema);

class AdController {
  static async executeWorkflow(input) {
    try {
      // Validate input against schema
      if (!validateSchema(input)) {
        logger.error('Invalid ad input', { errors: validateSchema.errors });
        throw new Error('Invalid input: ' + JSON.stringify(validateSchema.errors));
      }

      const { creatorSID, adContent, revenuePool } = input.schema.inputs;
      const workflowId = uuid();
      logger.info('Starting ad workflow', { workflowId, creatorSID });

      // Execute JSONFlow steps
      const result = await jsonflowExecutor.run(adSchema, input, {
        context: { db, chainAdapter, logger },
      });

      // Step 1: Validate Ad (executed by jsonflowExecutor)
      // Step 2: Store Ad
      const adId = result.outputs.adId;
      await db.ads.insert({
        adId,
        creatorSID,
        content: adContent,
        status: 'active',
        createdAt: new Date(),
      });

      // Step 3: Distribute Revenue
      const distribution = await chainAdapter.executeContract({
        chain: revenuePool.assetType === 'ETH' ? 'ethereum' : 'polkadot',
        method: 'distributeRevenue',
        params: [revenuePool, input.optInUsers],
      });

      await db.ads.update({ adId }, {
        $set: { distribution: distribution.map(d => ({ sid: d.sid, amount: d.amount })) },
      });

      logger.info('Ad created and revenue distributed', { adId, creatorSID });
      return { adId, distribution };
    } catch (error) {
      logger.error('Ad workflow failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  static async optInAd({ sid, adId }) {
    try {
      const ad = await db.ads.findOne({ adId });
      if (!ad) throw new Error('Ad not found');
      await db.ads.update({ adId }, {
        $push: { optInUsers: { sid, pulseScore: (await db.pulse.findOne({ sid }))?.pulseScore || 0, timestamp: new Date() } },
      });
      logger.info('User opted into ad', { sid, adId });
      return { adId, status: 'opted-in' };
    } catch (error) {
      logger.error('Ad opt-in failed', { error: error.message });
      throw error;
    }
  }
}

module.exports = AdController;