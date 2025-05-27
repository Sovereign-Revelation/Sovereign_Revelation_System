const { v4: uuid } = require('uuid');
const logger = require('../config/logger');
const db = require('../config/db');
const ajv = require('../config/ajv');
const jsonflowExecutor = require('../config/jsonflow-executor');
const oracleSchema = require('../schema/oracle/oracle-portal.schema.json');

const validateSchema = ajv.compile(oracleSchema);

class OraclePortalController {
  static async executeWorkflow(input) {
    try {
      // Validate input against schema
      if (!validateSchema(input)) {
        logger.error('Invalid oracle input', { errors: validateSchema.errors });
        throw new Error('Invalid input: ' + JSON.stringify(validateSchema.errors));
      }

      const { sid, nodeData } = input.schema.inputs;
      const workflowId = uuid();
      logger.info('Starting oracle node workflow', { workflowId, sid });

      // Execute JSONFlow steps
      const result = await jsonflowExecutor.run(oracleSchema, input, {
        context: { db, logger },
      });

      // Step 1: Validate SID (executed by jsonflowExecutor)
      // Step 2: Register Node
      const nodeId = result.outputs.nodeId;
      await db.nodes.insert({
        nodeId,
        sid,
        data: nodeData,
        status: 'active',
        createdAt: new Date(),
      });

      // Step 3: Reward Pulse
      const pulseReward = 50; // Example reward
      await db.pulse.update(
        { sid },
        { $inc: { pulseScore: pulseReward }, $set: { lastUpdated: new Date() } },
        { upsert: true }
      );

      logger.info('Oracle node registered', { nodeId, sid, pulseReward });
      return { nodeId, pulseReward };
    } catch (error) {
      logger.error('Oracle node workflow failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  static async provideData({ nodeId, data }) {
    try {
      const node = await db.nodes.findOne({ nodeId });
      if (!node) throw new Error('Node not found');
      await db.nodes.update({ nodeId }, {
        $push: { dataSubmissions: { data, timestamp: new Date() } },
      });
      logger.info('Oracle data provided', { nodeId });
      return { nodeId, status: 'data-submitted' };
    } catch (error) {
      logger.error('Oracle data submission failed', { error: error.message });
      throw error;
    }
  }
}

module.exports = OraclePortalController;