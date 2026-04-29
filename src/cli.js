import { setJsonMode, setQuiet, c, outln } from './output.js';
import { loginCommand, logoutCommand } from './commands/login.js';
import { whoamiCommand, creditsCommand, activityCommand } from './commands/account.js';
import { modelsCommand, providersCommand } from './commands/models.js';
import { chatCommand, completeCommand } from './commands/chat.js';
import { embedCommand } from './commands/embed.js';
import { rerankCommand } from './commands/rerank.js';
import { speechCommand } from './commands/speech.js';
import { videoCommand } from './commands/video.js';
import { messagesCommand, responsesCommand } from './commands/messages.js';
import { generationCommand } from './commands/generation.js';
import { keysCommand } from './commands/keys.js';
import { requestCommand } from './commands/request.js';
import { guardrailsCommand } from './commands/guardrails.js';
import { workspacesCommand } from './commands/workspaces.js';
import { orgCommand, zdrCommand, authCodeCommand } from './commands/misc.js';

const VERSION = '0.1.0';

const COMMANDS = {
  login: loginCommand,
  logout: logoutCommand,
  whoami: whoamiCommand,
  credits: creditsCommand,
  activity: activityCommand,
  models: modelsCommand,
  providers: providersCommand,
  chat: chatCommand,
  complete: completeCommand,
  embed: embedCommand,
  rerank: rerankCommand,
  speech: speechCommand,
  tts: speechCommand,
  video: videoCommand,
  messages: messagesCommand,
  responses: responsesCommand,
  generation: generationCommand,
  keys: keysCommand,
  guardrails: guardrailsCommand,
  workspaces: workspacesCommand,
  org: orgCommand,
  zdr: zdrCommand,
  'auth-code': authCodeCommand,
  request: requestCommand
};

const HELP = `openrouter — CLI for the OpenRouter API

Usage:
  openrouter <command> [options]

Auth:
  login                  OAuth PKCE login (or pass --key sk-or-... to save manually)
  login --management     Save a management/provisioning key (dashboard-only;
                         required for \`keys\` and \`activity\`)
  logout [--management]  Remove the stored user key, management key, or both (--all)
  whoami [--management]  Show the active key(s) (label, limits, usage, type)

Inference:
  chat [prompt...]       Chat completion (interactive REPL when run with no args in a TTY)
  complete [prompt...]   Alias for chat
  messages [prompt...]   Anthropic-compatible /messages endpoint
  responses [prompt...]  OpenAI-compatible /responses endpoint
  embed [text...]        Embeddings
  rerank --query --doc   Reranking
  speech [text...]       Text to speech (audio out)
  video <sub>            Video generation jobs (create / get / wait / download / models)

Discovery:
  models [list|show|endpoints|count|user]  List models, full model detail,
                                           provider variants, count, or your
                                           workspace-filtered set
  embed models                             List embedding models
  video models                             List video generation models
  providers                                List providers (with HQ + datacenters)
  generation <id> [--content]              Generation metadata or content
  credits                                  Remaining credits
  activity                                 Usage activity (management key)
  zdr                                      Preview Zero-Data-Retention impact

Management (require a management key):
  keys <sub>             list / get / create / update / delete
  guardrails <sub>       list / get / create / update / delete / assignments
  workspaces <sub>       list / get / create / update / delete / add-members / remove-members
  org members            List organization members
  auth-code              Mint a PKCE authorization code so a user can claim a key
  request <METHOD> <path>  Raw authenticated request to any endpoint

Global options (work with all commands):
  -k, --key <key>        Use this API key instead of the stored one
      --base-url <url>   Override API base URL (default: https://openrouter.ai/api/v1)
      --referer <url>    HTTP-Referer header (set as your app's URL)
      --title <name>     X-Title header (your app name; appears on openrouter.ai)
      --json             Output JSON (also disables streaming, color, and prompts)
  -q, --quiet            Suppress informational stderr messages
  -h, --help             Show help (use \`openrouter <command> --help\` for command-specific help)

Environment:
  OPENROUTER_API_KEY         Default user key
  OPENROUTER_MANAGEMENT_KEY  Default management/provisioning key
  OPENROUTER_BASE_URL        Default base URL
  OPENROUTER_REFERER         Default HTTP-Referer
  OPENROUTER_TITLE           Default X-Title
  NO_COLOR                   Disable ANSI colors
  OPENROUTER_DEBUG=1         Print stack traces on error

Examples:
  openrouter login
  openrouter chat "Hello, world" -m anthropic/claude-3.5-sonnet
  echo "summarize this" | openrouter chat -m openai/gpt-4o-mini --no-stream
  openrouter models --filter claude --json
  openrouter embed -m openai/text-embedding-3-small "hello" "world"
  openrouter request GET /credits

Version: ${VERSION}
`;

function preParseGlobals(argv) {
  // Pull global flags out of any position so they work before or after the subcommand.
  const out = [];
  let json = false;
  let quiet = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '-q' || a === '--quiet') quiet = true;
    else if (a === '-V' || a === '--version') version = true;
    else if (a === '-h' || a === '--help') {
      help = true;
      out.push(a); // forward so subcommand help can also pick it up
    } else out.push(a);
  }
  return { argv: out, json, quiet, help, version };
}

export async function run(argv) {
  const pre = preParseGlobals(argv);
  setJsonMode(pre.json);
  setQuiet(pre.quiet);

  if (pre.version) {
    outln(VERSION);
    return 0;
  }

  if (!pre.argv.length || (pre.help && !pre.argv[0]?.match(/^[a-z]/))) {
    process.stdout.write(HELP);
    return 0;
  }

  const cmd = pre.argv[0];
  const rest = pre.argv.slice(1);
  const handler = COMMANDS[cmd];
  if (!handler) {
    process.stderr.write(`Unknown command: ${cmd}\n\n`);
    process.stdout.write(HELP);
    process.exit(1);
  }
  const code = await handler(rest);
  if (typeof code === 'number') await safeExit(code);
}

function safeExit(code) {
  // Make sure stdout/stderr are flushed before exiting (otherwise large
  // responses piped to jq/etc. get truncated).
  return new Promise((resolve) => {
    let pending = 0;
    const done = () => {
      if (--pending <= 0) {
        process.exit(code);
        resolve();
      }
    };
    for (const stream of [process.stdout, process.stderr]) {
      if (stream && stream.writableLength > 0) {
        pending++;
        stream.write('', done);
      }
    }
    if (pending === 0) {
      process.exit(code);
      resolve();
    }
  });
}
