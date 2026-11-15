import assert from "node:assert/strict";
import { stdin } from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalKey = process.env.OPENROUTER_API_KEY;
const originalFetch = globalThis.fetch;
const originalIterator = stdin[Symbol.asyncIterator];
process.env.XDG_CONFIG_HOME = join(tmpdir(), `openroutercli-test-${process.pid}`);
process.env.OPENROUTER_API_KEY = "fake-test-key";

const { APIError } = await import("../src/api.js");
const { readStdinText } = await import("../src/args.js");
const { chatCommand } = await import("../src/commands/chat.js");
const { messagesCommand, responsesCommand } = await import("../src/commands/messages.js");
const { requestCommand } = await import("../src/commands/request.js");
const { rerankCommand } = await import("../src/commands/rerank.js");
const { batchesCommand } = await import("../src/commands/batches.js");

after(() => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
  stdin[Symbol.asyncIterator] = originalIterator;
});

function setStdinChunks(chunks) {
  stdin[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) yield chunk;
  };
}

function splitAccent(before, after) {
  return [
    Buffer.concat([Buffer.from(before), Buffer.from([0xc3])]),
    Buffer.concat([Buffer.from([0xa9]), Buffer.from(after)]),
  ];
}

function mockResponse(body, contentType = "application/json") {
  globalThis.fetch = async () =>
    new Response(body, { status: 200, headers: { "Content-Type": contentType } });
}

function isApiError(error) {
  return error instanceof APIError && error.exitCode === 2;
}

test("split UTF-8 bytes survive every piped text request path", async () => {
  setStdinChunks(splitAccent("h", "!"));
  assert.equal(await readStdinText(), "hé!");

  let sent;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(
      '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"results":[]}',
      { status: 200 },
    );
  };

  setStdinChunks(splitAccent("h", "!"));
  assert.equal(await chatCommand(["--model", "test/model", "--no-stream"]), 0);
  assert.equal(sent.messages[0].content, "hé!");

  setStdinChunks(splitAccent("h", "!"));
  assert.equal(await messagesCommand(["--model", "test/model", "--no-stream"]), 0);
  assert.equal(sent.messages[0].content, "hé!");

  setStdinChunks(splitAccent('{"text":"h', '!"}'));
  assert.equal(await requestCommand(["POST", "/test", "--body", "-"]), 0);
  assert.equal(sent.text, "hé!");

  setStdinChunks(splitAccent("h", "!\n"));
  assert.equal(
    await rerankCommand(["--model", "test/model", "--query", "q", "--docs-file", "-"]),
    0,
  );
  assert.deepEqual(sent.documents, ["hé!"]);
});

test("generation commands reject HTTP 200 error bodies", async () => {
  setStdinChunks([]);
  mockResponse('{"error":{"code":402,"message":"Insufficient credits"}}');
  await assert.rejects(chatCommand(["hi", "--model", "test/model", "--no-stream"]), isApiError);

  mockResponse('{"type":"error","error":{"message":"Insufficient credits"}}');
  await assert.rejects(
    messagesCommand(["--body", '{"model":"test/model","messages":[]}', "--no-stream"]),
    isApiError,
  );

  mockResponse('{"status":"failed","error":{"message":"Provider disconnected"}}');
  await assert.rejects(
    responsesCommand(["--body", '{"model":"test/model","input":"hi"}', "--no-stream"]),
    isApiError,
  );
});

test("response.failed streams fail and completed streams succeed", async () => {
  const args = ["--body", '{"model":"test/model","input":"hi"}', "--stream"];
  mockResponse(
    'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"Provider disconnected"}}}\n\n',
    "text/event-stream",
  );
  await assert.rejects(responsesCommand(args), isApiError);

  mockResponse(
    'data: {"type":"response.completed","response":{"status":"completed","error":null}}\n\n',
    "text/event-stream",
  );
  assert.equal(await responsesCommand(args), 0);
});

test("batch wait stops at its deadline before another poll", async () => {
  let polls = 0;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "batch-test",
        status: ++polls === 1 ? "in_progress" : "completed",
        request_counts: { completed: 0, failed: 0, total: 1 },
      }),
      { status: 200 },
    );
  await assert.rejects(
    batchesCommand(["wait", "batch-test", "--timeout", "0.02", "--interval", "0.05"]),
    /timeout waiting for batch/,
  );
  assert.equal(polls, 1);
});
