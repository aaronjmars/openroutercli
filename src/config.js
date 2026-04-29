import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const XDG = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
export const CONFIG_DIR = join(XDG, 'openrouter');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_AUTH_URL = 'https://openrouter.ai/auth';

export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveConfig(cfg) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = CONFIG_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.rename(tmp, CONFIG_FILE);
}

export async function clearConfig() {
  try {
    await fs.unlink(CONFIG_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function resolveAuth(opts = {}) {
  const cfg = await loadConfig();
  const userKey =
    process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || cfg.apiKey;
  const mgmtKey = process.env.OPENROUTER_MANAGEMENT_KEY || cfg.managementKey;

  // If the caller explicitly passed --key, that always wins.
  // Otherwise: management commands prefer the management key (falling back to
  // the regular key); inference commands prefer the regular key (falling back
  // to the management key).
  let apiKey;
  let usedManagementSlot = false;
  if (opts.key) {
    apiKey = opts.key;
  } else if (opts.requiresManagement) {
    apiKey = mgmtKey || userKey;
    usedManagementSlot = !!mgmtKey;
  } else {
    apiKey = userKey || mgmtKey;
  }

  const baseUrl =
    opts.baseUrl ||
    process.env.OPENROUTER_BASE_URL ||
    cfg.baseUrl ||
    DEFAULT_BASE_URL;
  const referer =
    opts.referer ||
    process.env.OPENROUTER_REFERER ||
    cfg.referer ||
    'https://github.com/openrouter-cli';
  const title =
    opts.title || process.env.OPENROUTER_TITLE || cfg.title || 'openrouter-cli';
  return {
    apiKey,
    baseUrl,
    referer,
    title,
    config: cfg,
    usedManagementSlot,
    hasManagementKey: !!mgmtKey,
    hasUserKey: !!userKey
  };
}
