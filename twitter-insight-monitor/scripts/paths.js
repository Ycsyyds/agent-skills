const os = require('node:os');
const path = require('node:path');

function resolve(opts = {}) {
  const home = opts.home || os.homedir();
  const xdgConfig = opts.xdgConfig || process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const configDir = path.join(xdgConfig, 'twitter-insight');
  return {
    home,
    configDir,
    configFile: path.join(configDir, 'config.json'),
    stateFile: path.join(configDir, 'state.json'),
    defaultDataHome: path.join(home, '.twitter-insight'),
  };
}

function dataPaths(dataHome) {
  return {
    dataHome,
    dataDir: path.join(dataHome, 'data'),
    dailyDir: path.join(dataHome, 'reports', 'daily'),
    weeklyDir: path.join(dataHome, 'reports', 'weekly'),
    longTermDir: path.join(dataHome, 'memory', 'long-term'),
    coreInsights: path.join(dataHome, 'memory', 'long-term', 'core-insights.md'),
    archiveDir: path.join(dataHome, 'memory', 'archive'),
  };
}

module.exports = { resolve, dataPaths };
