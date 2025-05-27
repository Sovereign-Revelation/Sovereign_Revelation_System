const { v4: uuid } = require('uuid');
const logger = require('../config/logger');
const db = require('../config/db');
const ajv = require('../config/ajv');
const jsonflowExecutor = require('../config/jsonflow-executor');
const pulseSchema = require('../schema/pulse/pulse.schema.json');

const validateSchema = ajv.compile(pulseSchema);

class PulseController {
  static async executeWorkflow(input) {
    try {
      // Validate input against schema
      if (!validateSchema(input)) {
        logger.error('Invalid pulse input', { errors: validateSchema.errors });
        throw new Error('Invalid input: ' + JSON.stringify(validateSchema.errors));
      }

      const { sid, quest } = input.schema.inputs;
      const workflowId = uuid();
      logger.info('Starting pulse workflow', { workflowId, sid });

      // Execute JSONFlow steps
      const result = await jsonflowExecutor.run(pulseSchema, input, {
        context: { db, logger },
      });

      // Step 1: Validate SID (executed by jsonflowExecutor)
      // Step 2: Record Quest
      const questId = result.outputs.questId;
      await db.quests.insert({
        questId,
        sid,
        type: quest.type,
        reward: quest.reward,
        timestamp: new Date(),
      });

      // Step 3: Update Pulse Score
      const pulse = await db.pulse.findOneAndUpdate(
        { sid },
        { $inc: { pulseScore: quest.reward }, $set: { lastUpdated: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );

      logger.info('Pulse updated successfully', { sid, questId, pulseScore: pulse.pulseScore });
      return { questId, pulseScore: pulse.pulseScore };
    } catch (error) {
      logger.error('Pulse workflow failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  static async getPulseScore({ sid }) {
    try {
      const pulse = await db.pulse.findOne({ sid });
      if (!pulse) throw new Error('Pulse score not found');
      logger.info('Pulse score retrieved', { sid, pulseScore: pulse.pulseScore });
      return { sid, pulseScore: pulse.pulseScore };
    } catch (error) {
      logger.error('Pulse score retrieval failed', { error: error.message });
      throw error;
    }
  }
}

module.exports = PulseController;