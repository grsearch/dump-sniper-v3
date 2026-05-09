'use strict';

const axios = require('axios');
const { config } = require('../config');

/**
 * 用 Helius getPriorityFeeEstimate 获取动态 priority fee。
 * 返回 microLamports per CU。带上限保护。
 */
async function getPriorityFee(accountKeys = [], level = 'High') {
  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getPriorityFeeEstimate',
      params: [
        {
          accountKeys: accountKeys.length ? accountKeys : undefined,
          options: { priorityLevel: level },
        },
      ],
    };
    const { data } = await axios.post(config.helius.rpcUrl, body, { timeout: 3000 });
    if (data.error) throw new Error(JSON.stringify(data.error));
    const microLamports = Math.floor(data.result?.priorityFeeEstimate || 0);
    // 上限保护：假设 CU limit = 200_000，则 fee 上限对应的 microLamports/CU 限值
    const cuLimit = 200_000;
    const maxMicroPerCu = Math.floor((config.maxPriorityFeeLamports * 1_000_000) / cuLimit);
    const capped = Math.min(microLamports, maxMicroPerCu);
    return { microLamports: capped, raw: microLamports };
  } catch (err) {
    console.warn(`[priorityFee] estimate failed, fallback to default: ${err.message}`);
    return { microLamports: 200_000, raw: 0 }; // fallback ~0.00004 SOL @ 200k CU
  }
}

module.exports = { getPriorityFee };
