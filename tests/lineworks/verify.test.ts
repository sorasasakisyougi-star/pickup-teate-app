import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { verifySignature, sha256Hex } from '../../lib/lineworks/verify';

test('verifySignature accepts matching HMAC-SHA256 base64', () => {
  const body = '{"type":"message","content":{"text":"hi"}}';
  const secret = 'test-secret-123';
  const sig = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  assert.equal(verifySignature(body, sig, secret), true);
});

test('verifySignature rejects wrong signature', () => {
  assert.equal(verifySignature('body', 'aW52YWxpZA==', 'secret'), false);
});

test('verifySignature rejects empty signature', () => {
  assert.equal(verifySignature('body', '', 'secret'), false);
});

test('verifySignature rejects empty secret', () => {
  assert.equal(verifySignature('body', 'anything', ''), false);
});

test('verifySignature rejects tampered body', () => {
  const secret = 'k';
  const sig = crypto.createHmac('sha256', secret).update('a').digest('base64');
  assert.equal(verifySignature('b', sig, secret), false);
});

test('sha256Hex returns 64-char hex', () => {
  const h = sha256Hex('hello');
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('sha256Hex deterministic', () => {
  assert.equal(sha256Hex('x'), sha256Hex('x'));
  assert.notEqual(sha256Hex('x'), sha256Hex('y'));
});
