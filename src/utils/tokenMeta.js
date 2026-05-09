'use strict';

const axios = require('axios');
const { config } = require('../config');

/**
 * 通过 Helius DAS API 获取代币基本信息（symbol, decimals, name）。
 */
async function fetchTokenAssetFromHelius(mint) {
  const url = config.helius.rpcUrl;
  const body = {
    jsonrpc: '2.0',
    id: 'getAsset',
    method: 'getAsset',
    params: { id: mint },
  };
  const { data } = await axios.post(url, body, { timeout: 8000 });
  if (data.error) throw new Error(`Helius getAsset error: ${JSON.stringify(data.error)}`);
  const asset = data.result;
  if (!asset) throw new Error('Helius returned empty asset');
  const meta = asset.content?.metadata || {};
  const tokenInfo = asset.token_info || {};
  return {
    mint,
    symbol: meta.symbol || tokenInfo.symbol || 'UNKNOWN',
    name: meta.name || 'Unknown',
    decimals: tokenInfo.decimals ?? 6,
    supply: tokenInfo.supply ?? null,
  };
}

/**
 * 通过 Birdeye 获取 FDV 和流动性等市场数据。
 */
async function fetchTokenMarketFromBirdeye(mint) {
  const url = `${config.birdeye.baseUrl}/defi/token_overview`;
  const headers = {
    'X-API-KEY': config.birdeye.apiKey,
    'x-chain': 'solana',
    accept: 'application/json',
  };
  const { data } = await axios.get(url, {
    headers,
    params: { address: mint },
    timeout: 8000,
  });
  if (!data?.success) throw new Error(`Birdeye token_overview failed: ${JSON.stringify(data)}`);
  const d = data.data || {};
  return {
    fdv: d.fdv ?? null,
    marketCap: d.mc ?? null,
    liquidity: d.liquidity ?? null,
    price: d.price ?? null,
    priceChange24h: d.priceChange24hPercent ?? null,
    volume24h: d.v24hUSD ?? null,
  };
}

/**
 * 综合调用：返回完整代币信息。Birdeye 失败时不阻塞，返回部分信息。
 */
async function fetchTokenFullInfo(mint) {
  const asset = await fetchTokenAssetFromHelius(mint);
  let market = {};
  try {
    market = await fetchTokenMarketFromBirdeye(mint);
  } catch (err) {
    console.warn(`[tokenMeta] Birdeye fetch failed for ${mint}: ${err.message}`);
  }
  return { ...asset, ...market, fetchedAt: Date.now() };
}

module.exports = {
  fetchTokenAssetFromHelius,
  fetchTokenMarketFromBirdeye,
  fetchTokenFullInfo,
};
