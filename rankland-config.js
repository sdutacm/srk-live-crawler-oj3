const RANKLAND_PRODUCTION_API_BASE = 'https://rl.algoux.cn/api/v2';

function resolveRanklandConfig(isDevelopment, config) {
  return {
    ...config,
    apiBase: isDevelopment ? config.apiBase : RANKLAND_PRODUCTION_API_BASE,
  };
}

function loadRanklandConfig(isDevelopment, configLoader = require) {
  const configPath = isDevelopment ? './configs/rl-v2.dev' : './configs/rl-v2.prod';
  try {
    return resolveRanklandConfig(isDevelopment, configLoader(configPath));
  } catch (error) {
    error.message = `Failed to load Rankland config ${configPath}: ${error.message}`;
    throw error;
  }
}

module.exports = {
  RANKLAND_PRODUCTION_API_BASE,
  loadRanklandConfig,
};
