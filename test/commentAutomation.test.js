import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  fillTemplate,
  parseCommentChange,
  ruleMatchesComment,
} from '../src/services/instagramAutomationService.js';
import { isValidMetaSignature } from '../src/routes/webhooks.js';

const baseRule = {
  enabled: true,
  mediaScope: 'all',
  mediaIds: [],
  triggerType: 'keywords',
  keywords: ['link', 'price'],
};

test('keyword rules match whole words case-insensitively', () => {
  assert.equal(ruleMatchesComment(baseRule, { mediaId: '1', text: 'Send me the LINK please' }), true);
  assert.equal(ruleMatchesComment(baseRule, { mediaId: '1', text: 'price?' }), true);
  assert.equal(ruleMatchesComment(baseRule, { mediaId: '1', text: 'linked in bio' }), false);
  assert.equal(ruleMatchesComment(baseRule, { mediaId: '1', text: 'nice video' }), false);
});

test('rules respect media scope, trigger type and enabled flag', () => {
  const specific = { ...baseRule, mediaScope: 'specific', mediaIds: ['42'] };
  assert.equal(ruleMatchesComment(specific, { mediaId: '42', text: 'link' }), true);
  assert.equal(ruleMatchesComment(specific, { mediaId: '7', text: 'link' }), false);
  assert.equal(ruleMatchesComment({ ...baseRule, triggerType: 'any' }, { mediaId: '1', text: 'wow' }), true);
  assert.equal(ruleMatchesComment({ ...baseRule, enabled: false }, { mediaId: '1', text: 'link' }), false);
});

test('templates fill the commenter username', () => {
  assert.equal(fillTemplate('Thanks {{username}}! Check your DMs', { username: 'sam' }), 'Thanks @sam! Check your DMs');
  assert.equal(fillTemplate('{{ USERNAME }} sent', { username: '' }), 'sent');
});

test('parses Instagram comment webhook changes', () => {
  const comment = parseCommentChange('178', {
    field: 'comments',
    value: { id: 'c1', text: 'link', from: { id: 'u1', username: 'sam' }, media: { id: 'm1' } },
  });
  assert.deepEqual(comment, {
    entryId: '178', commentId: 'c1', parentId: '', mediaId: 'm1', text: 'link', fromId: 'u1', fromUsername: 'sam',
  });
  assert.equal(parseCommentChange('178', { field: 'mentions', value: { id: 'x' } }), null);
});

test('verifies Meta webhook signatures against the raw body', () => {
  const body = Buffer.from('{"object":"instagram"}');
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
  assert.equal(isValidMetaSignature(body, signature, ['other', 'secret']), true);
  assert.equal(isValidMetaSignature(body, signature, ['other']), false);
  assert.equal(isValidMetaSignature(body, 'sha256=abcd', ['secret']), false);
  assert.equal(isValidMetaSignature(body, undefined, ['secret']), false);
});
