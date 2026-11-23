import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/capture/redact.ts";

// All secrets below are fabricated for testing; none is a live credential.

test("redacts an AWS access key id and reports it", () => {
  const r = redact("key is AKIAABCDEFGHIJKLMNOP here");
  assert.equal(r.text, "key is [REDACTED:aws-access-key] here");
  assert.deepEqual(r.counts, { "aws-access-key": 1 });
});

test("redacts a private key block across lines", () => {
  const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
  const r = redact(`before\n${block}\nafter`);
  assert.equal(r.text, "before\n[REDACTED:private-key]\nafter");
  assert.equal(r.counts["private-key"], 1);
});

test("redacts an assigned secret but keeps the key name", () => {
  const r = redact('{"api_key": "abcd1234efgh5678"}');
  assert.equal(r.text, '{"api_key": "[REDACTED:assigned-secret]"}');
  assert.equal(r.counts["assigned-secret"], 1);
});

test("redacts a bearer token and a GitHub token", () => {
  const r = redact(
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  );
  assert.equal(r.counts["bearer-token"], 1);
  assert.equal(r.counts["github-token"], 1);
  assert.ok(!r.text.includes("abcdefghijklmnopqrstuvwxyz0123"));
});

test("redacts an Anthropic-style key before the generic sk- rule can see it", () => {
  const r = redact("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  assert.equal(r.text, "[REDACTED:anthropic-key]");
  assert.equal(r.counts["anthropic-key"], 1);
  assert.equal(r.counts["openai-key"], undefined);
});

test("leaves ordinary text untouched", () => {
  const text = "Refactor the token bucket limiter; tests pass. Password policy is in docs.";
  const r = redact(text);
  assert.equal(r.text, text);
  assert.deepEqual(r.counts, {});
});

test("never returns the secret value in counts or text", () => {
  const secret = "AKIAABCDEFGHIJKLMNOP";
  const r = redact(`x ${secret} y`);
  assert.ok(!r.text.includes(secret));
  assert.ok(!JSON.stringify(r.counts).includes(secret));
});
