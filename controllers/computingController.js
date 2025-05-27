const { v4: uuid } = require('uuid');
const logger = require('../config/logger');
const db = require('../config/db');
const ajv = require('../config/ajv');
const jsonflowExecutor = require('../config/jsonflow-executor');
const computingSchema = require('../schema/computing/computing-donation.schema.json');

const validateSchema = ajv.compile(computingSchema);

class ComputingController {
  static async executeWorkflow(input) {
    try {
      // Validate input against schema
      if (!validateSchema(input)) {
        logger.error('Invalid computing input', { errors: validateSchema.errors });
        throw new Error('Invalid input: ' + JSON.stringify(validateSchema.errors));
      }

      const { sid, resource } = input.schema.inputs;
      const workflowId = uuid();
      logger.info('Starting computing donation workflow', { workflowId, sid });

      // Execute JSONFlow steps
      const result = await jsonflowExecutor.run(computingSchema, input, {
        context: { db, logger },
      });

      // Step 1: Validate SID (executed by jsonflowExecutor)
      // Step 2: Record Donation
      const donationId = result.outputs.donationId;
      await db.donations.insert({
        donationId,
        sid,
        resource,
        timestamp: new Date(),
      });

      // Step 3: Reward Pulse
      const pulseReward = Math.floor(resource.amount * 10); // Example reward calculation
      await db.pulse.update(
        { sid },
        { $inc: { pulseScore: pulseReward }, $set: { lastUpdated: new Date() } },
        { upsert: true }
      );

      logger.info('Computing donation processed', { donationId, sid, pulseReward });
      return { donationId, pulseReward };
    } catch (error) {
      logger.error('Computing donation failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }
}

module.exports = ComputingController;