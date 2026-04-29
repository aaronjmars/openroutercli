import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from '../args.js';
import { loadConfig, saveConfig, DEFAULT_AUTH_URL, DEFAULT_BASE_URL } from '../config.js';
import { api } from '../api.js';
import { c, info, isJsonMode, outln, printJSON } from '../output.js';

const HELP = `Usage: openrouter login [options]

Authenticate with OpenRouter and store an API key locally.

Two key types are supported:
  - User key (default):       used for inference (chat, embeddings, etc.).
                              Created by OAuth or pasted.
  - Management key:           used for account-wide operations (\`keys\`
                              subcommands, \`activity\`). Must be created in
                              the OpenRouter dashboard at
                              https://openrouter.ai/settings/provisioning-keys
                              — they cannot be obtained via OAuth.

You can store one of each. The CLI picks the right one automatically per
command. Both can also be supplied via env vars (see below).

Options:
  -k, --key <key>      Save an existing API key (sk-or-...). Skips OAuth.
      --management     Save the key into the management slot (instead of
                       the user-key slot). Implies manual entry — pass with
                       --key, --stdin, or via the interactive prompt.
      --no-browser     Don't auto-open the browser; just print the auth URL.
      --port <port>    Local port for the OAuth callback (default: random).
      --base-url <url> Override API base URL (default: ${DEFAULT_BASE_URL}).
      --auth-url <url> Override auth URL (default: ${DEFAULT_AUTH_URL}).
      --stdin          Read the key from stdin instead of prompting.
  -h, --help           Show this help.

Environment:
  OPENROUTER_API_KEY         User key
  OPENROUTER_MANAGEMENT_KEY  Management key
`;

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function readFromStdin() {
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.trim();
}

async function promptKey() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('Paste your OpenRouter API key (sk-or-...): ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function saveKey(apiKey, extra = {}) {
  const cfg = await loadConfig();
  cfg.apiKey = apiKey;
  Object.assign(cfg, extra);
  await saveConfig(cfg);
  return cfg;
}

async function saveManagementKey(apiKey, extra = {}) {
  const cfg = await loadConfig();
  cfg.managementKey = apiKey;
  Object.assign(cfg, extra);
  await saveConfig(cfg);
  return cfg;
}

async function promptManagementKey() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(
      'Paste your OpenRouter management key (sk-or-v1-...). Create one at\n  https://openrouter.ai/settings/provisioning-keys\n› '
    );
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function pkceFlow({ port, openInBrowser, authUrl, baseUrl }) {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest()
  );

  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost`);
      if (u.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      const html = (title, body) =>
        `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
        `<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:6rem auto;padding:0 1rem;color:#222}h1{font-weight:600}` +
        `code{background:#f4f4f5;padding:.1rem .35rem;border-radius:.25rem}</style></head><body>${body}</body></html>`;
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(
          html('Login failed', `<h1>Login failed</h1><p>${error}</p>`)
        );
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(
          html('Missing code', '<h1>Missing code</h1>')
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        html(
          'OpenRouter CLI: signed in',
          '<h1>You are signed in.</h1><p>You can close this tab and return to the terminal.</p>'
        )
      );
      setTimeout(() => server.close(), 100);
      resolve(code);
    });
    server.on('error', reject);
    server.listen(port || 0, '127.0.0.1', () => {
      const actualPort = server.address().port;
      const callback = `http://localhost:${actualPort}/callback`;
      const params = new URLSearchParams({
        callback_url: callback,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      });
      const url = `${authUrl}?${params.toString()}`;
      info(`Listening on ${callback}`);
      if (openInBrowser) {
        info('Opening browser...');
        openBrowser(url);
      }
      outln(c.bold('Open this URL to sign in:'));
      outln('  ' + c.cyan(url));
      outln('');
      info('Waiting for callback (press Ctrl+C to cancel)...');
    });
  });

  const code = await codePromise;
  info('Exchanging authorization code for API key...');
  const data = await api('POST', '/auth/keys', {
    requireAuth: false,
    auth: { baseUrl },
    body: {
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256'
    }
  });
  return data;
}

export async function loginCommand(argv) {
  const { values } = parseArgs(argv, {
    'no-browser': { type: 'boolean' },
    port: { type: 'string' },
    'auth-url': { type: 'string' },
    stdin: { type: 'boolean' },
    management: { type: 'boolean' }
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const baseUrl = values['base-url'] || DEFAULT_BASE_URL;
  const authUrl = values['auth-url'] || DEFAULT_AUTH_URL;

  // Management-key path: never OAuth — always paste/stdin/--key.
  if (values.management) {
    let key = values.key;
    if (!key && values.stdin) key = await readFromStdin();
    if (!key) key = await promptManagementKey();
    if (!key || !key.startsWith('sk-or-')) {
      throw new Error('Expected management key starting with "sk-or-".');
    }
    await saveManagementKey(key, {
      baseUrl: values['base-url'] || undefined
    });
    if (isJsonMode()) printJSON({ saved: true, slot: 'management' });
    else info(`Saved management key (${key.slice(0, 12)}...).`);
    return 0;
  }

  // Manual user-key path
  if (values.key || values.stdin) {
    const key = values.key || (await readFromStdin());
    if (!key || !key.startsWith('sk-or-')) {
      throw new Error('Expected API key starting with "sk-or-".');
    }
    await saveKey(key, {
      baseUrl: values['base-url'] || undefined
    });
    info(`Saved API key (${key.slice(0, 12)}...).`);
    if (isJsonMode()) printJSON({ saved: true, slot: 'user' });
    return 0;
  }

  // Interactive: try OAuth, but offer paste fallback if user prefers
  const port = values.port ? Number(values.port) : 0;
  let result;
  try {
    result = await pkceFlow({
      port,
      openInBrowser: !values['no-browser'],
      authUrl,
      baseUrl
    });
  } catch (err) {
    if (process.env.OPENROUTER_DEBUG) info(String(err.stack || err));
    info('OAuth flow failed; falling back to manual key entry.');
    const key = await promptKey();
    if (!key) throw new Error('No API key provided.');
    await saveKey(key);
    if (isJsonMode()) printJSON({ saved: true, mode: 'manual' });
    else info('Saved API key.');
    return 0;
  }

  await saveKey(result.key, {
    userId: result.user_id,
    baseUrl: values['base-url'] || undefined
  });
  if (isJsonMode()) {
    printJSON({ saved: true, user_id: result.user_id });
  } else {
    outln(c.green('Signed in.') + ' ' + c.dim(`user_id=${result.user_id}`));
  }
  return 0;
}

export async function logoutCommand(argv) {
  const { values } = parseArgs(argv, {
    management: { type: 'boolean' },
    all: { type: 'boolean' }
  });
  if (values.help) {
    process.stdout.write(
      'Usage: openrouter logout [--management|--all]\n\n' +
        'Remove the locally stored API key. By default removes the user key.\n' +
        '  --management  Remove the management key only\n' +
        '  --all         Remove both\n'
    );
    return 0;
  }
  const cfg = await loadConfig();
  let removed = [];
  if (values.all || !values.management) {
    if (cfg.apiKey) {
      delete cfg.apiKey;
      delete cfg.userId;
      removed.push('user');
    }
  }
  if (values.all || values.management) {
    if (cfg.managementKey) {
      delete cfg.managementKey;
      removed.push('management');
    }
  }
  if (!removed.length) {
    info('No matching key was stored.');
    return 0;
  }
  await saveConfig(cfg);
  if (isJsonMode()) printJSON({ logged_out: removed });
  else info(`Logged out (${removed.join(', ')}).`);
  return 0;
}
