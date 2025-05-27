const { v4: uuid } = require('uuid');
const ethers = require('ethers');
const logger = require('../config/logger');
const db = require('../config/db');
const crypto = require('../config/crypto');
const chainAdapter = require('../adapters/chainAdapter');
const ajv = require('../config/ajv');
const jsonflowExecutor = require('../config/jsonflow-executor');
const voucherSchema = require('../schema/voucher/voucher.schema.json');

const validateSchema = ajv.compile(voucherSchema);

class VoucherController {
  static async executeWorkflow(input) {
    try {
      // Validate input against schema
      if (!validateSchema(input)) {
        logger.error('Invalid voucher input', { errors: validateSchema.errors });
        throw new Error('Invalid input: ' + JSON.stringify(validateSchema.errors));
      }

      const { creatorSID, value, password } = input.schema.inputs;
      const workflowId = uuid();
      logger.info('Starting voucher workflow', { workflowId, creatorSID });

      // Execute JSONFlow steps
      const result = await jsonflowExecutor.run(voucherSchema, input, {
        context: {
          db,
          chainAdapter,
          crypto,
          logger,
        },
      });

      // Step 1: Validate SID (executed by jsonflowExecutor)
      // Step 2: Create Voucher on-chain
      const voucherId = result.outputs.voucherId;
      const passwordHash = ethers.utils.sha256(ethers.utils.toUtf8Bytes(password));
      await chainAdapter.executeContract({
        chain: value.assetType === 'ETH' ? 'ethereum' : 'polkadot',
        method: 'createVoucher',
        params: [creatorSID, value, passwordHash],
      });

      // Step 3: Store voucher metadata
      await db.vouchers.insert({
        voucherId,
        creatorSID,
        value,
        status: 'created',
        transferHistory: [],
        createdAt: new Date(),
      });

      logger.info('Voucher created successfully', { voucherId, creatorSID });
      return { voucherId, status: 'created' };
    } catch (error) {
      logger.error('Voucher workflow failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  static async transferVoucher({ voucherId, fromSID, toSID, password }) {
    try {
      const voucher = await db.vouchers.findOne({ voucherId });
      if (!voucher) throw new Error('Voucher not found');
      if (voucher.status !== 'created') throw new Error('Voucher not transferable');

      const passwordHash = ethers.utils.sha256(ethers.utils.toUtf8Bytes(password));
      await chainAdapter.executeContract({
        chain: voucher.value.assetType === 'ETH' ? 'ethereum' : 'polkadot',
        method: 'transferVoucher',
        params: [voucherId, fromSID, toSID, passwordHash],
      });

      await db.vouchers.update({ voucherId }, {
        $set: { status: 'transferred' },
        $push: { transferHistory: { fromSID, toSID, timestamp: new Date() } },
      });

      logger.info('Voucher transferred', { voucherId, fromSID, toSID });
      return { voucherId, status: 'transferred' };
    } catch (error) {
      logger.error('Voucher transfer failed', { error: error.message });
      throw error;
    }
  }

  static async redeemVoucher({ voucherId, redeemerSID, password }) {
    try {
      const voucher = await db.vouchers.findOne({ voucherId });
      if (!voucher) throw new Error('Voucher not found');
      if (voucher.status === 'redeemed') throw new Error('Voucher already redeemed');

      const passwordHash = ethers.utils.sha256(ethers.utils.toUtf8Bytes(password));
      await chainAdapter.executeContract({
        chain: voucher.value.assetType === 'ETH' ? 'ethereum' : 'polkadot',
        method: 'redeemVoucher',
        params: [voucherId, redeemerSID, passwordHash],
      });

      await db.vouchers.update({ voucherId }, {
        $set: { status: 'redeemed' },
      });

      logger.info('Voucher redeemed', { voucherId, redeemerSID });
      return { voucherId, status: 'redeemed' };
    } catch (error) {
      logger.error('Voucher redemption failed', { error: error.message });
      throw error;
    }
  }
}

module.exports = VoucherController;