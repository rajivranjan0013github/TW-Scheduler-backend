import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { fillTemplate, ruleMatchesComment } from '../src/services/commentAutomationService.js';
import { parseCommentChange } from '../src/services/socialProviders/instagram.js';
import * as facebook from '../src/services/socialProviders/facebook.js';
import { isGraphObjectId } from '../src/services/socialProviders/index.js';
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

test('rules only fire on comments posted after they were turned on', () => {
  const rule = { ...baseRule, createdAt: new Date('2026-10-01T10:00:00Z'), enabledAt: new Date('2026-10-20T10:00:00Z') };
  assert.equal(ruleMatchesComment(rule, { mediaId: '1', text: 'link', commentedAt: new Date('2026-10-20T10:05:00Z') }), true);
  assert.equal(ruleMatchesComment(rule, { mediaId: '1', text: 'link', commentedAt: new Date('2026-10-20T09:55:00Z') }), false);
  assert.equal(ruleMatchesComment(rule, { mediaId: '1', text: 'link', commentedAt: new Date('2026-10-05T10:00:00Z') }), false);
  // Rules saved before enabledAt existed fall back to their creation time
  const legacy = { ...baseRule, createdAt: new Date('2026-10-01T10:00:00Z') };
  assert.equal(ruleMatchesComment(legacy, { mediaId: '1', text: 'link', commentedAt: new Date('2026-09-30T10:00:00Z') }), false);
  assert.equal(ruleMatchesComment(legacy, { mediaId: '1', text: 'link', commentedAt: new Date('2026-10-02T10:00:00Z') }), true);
});

test('turning a rule on records when it became active', async () => {
  const { default: AutomationRule } = await import('../src/models/AutomationRule.js');
  const setEnabledAt = AutomationRule.schema.s.hooks._pres.get('save').find((hook) => hook.fn.name === 'setEnabledAt').fn;
  const rule = new AutomationRule({ userId: '507f1f77bcf86cd799439011', socialAccountId: '507f1f77bcf86cd799439012', name: 'Test' });
  const before = Date.now();
  setEnabledAt.call(rule);
  assert.ok(rule.enabledAt.getTime() >= before);

  // Re-enabling after a pause moves the start forward; edits that keep it off don't set it
  const paused = AutomationRule.hydrate({ _id: '507f1f77bcf86cd799439013', name: 'Old', enabled: false, enabledAt: new Date('2026-01-01') });
  setEnabledAt.call(paused);
  assert.equal(paused.enabledAt.toISOString(), '2026-01-01T00:00:00.000Z');
  paused.enabled = true;
  setEnabledAt.call(paused);
  assert.ok(paused.enabledAt.getTime() >= before);
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
    platform: 'instagram', entryId: '178', commentId: 'c1', parentId: '', mediaId: 'm1', text: 'link', fromId: 'u1', fromUsername: 'sam', fromName: '',
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

test('only numeric Graph object IDs are accepted from user input', () => {
  assert.equal(isGraphObjectId('17895695668004550'), true);
  assert.equal(isGraphObjectId('me/messages'), false);
  assert.equal(isGraphObjectId('123?fields=x'), false);
  assert.equal(isGraphObjectId(''), false);
});

test('templates fall back to the Facebook display name', () => {
  assert.equal(fillTemplate('Thanks {{username}}! Check your DMs', { name: 'Sam Lee' }), 'Thanks Sam Lee! Check your DMs');
});

test('parses Facebook Page feed comments and ignores other feed changes', () => {
  const topLevel = facebook.parseCommentChange('555', {
    field: 'feed',
    value: {
      item: 'comment', verb: 'add', comment_id: '111_222', post_id: '555_111', parent_id: '555_111',
      message: 'price?', from: { id: '9', name: 'Sam Lee' },
    },
  });
  assert.deepEqual(topLevel, {
    platform: 'facebook', entryId: '555', commentId: '111_222', parentId: '', mediaId: '555_111', text: 'price?', fromId: '9', fromUsername: '', fromName: 'Sam Lee',
  });

  const reply = facebook.parseCommentChange('555', {
    field: 'feed',
    value: { item: 'comment', verb: 'add', comment_id: '111_333', post_id: '555_111', parent_id: '111_222', message: 'me too' },
  });
  assert.equal(reply.parentId, '111_222');

  assert.equal(facebook.parseCommentChange('555', { field: 'feed', value: { item: 'reaction', verb: 'add' } }), null);
  assert.equal(facebook.parseCommentChange('555', { field: 'feed', value: { item: 'comment', verb: 'remove', comment_id: '1_2' } }), null);
});

test('accepts Instagram and Facebook Graph IDs only', () => {
  assert.equal(isGraphObjectId('17890001234'), true);
  assert.equal(isGraphObjectId('555_111'), true);
  assert.equal(isGraphObjectId('../me'), false);
  assert.equal(isGraphObjectId('1_2_3'), false);
});

test('validates YouTube video and comment IDs', async () => {
  const { isValidObjectId, supportsDm } = await import('../src/services/socialProviders/index.js');
  assert.equal(isValidObjectId('youtube', 'dQw4w9WgXcQ'), true);
  assert.equal(isValidObjectId('youtube', 'UgzAbc123-_xyz.9xYz'), true);
  assert.equal(isValidObjectId('youtube', '../channels?mine=true'), false);
  assert.equal(isValidObjectId('instagram', 'dQw4w9WgXcQ'), false);
  assert.equal(supportsDm('youtube'), false);
  assert.equal(supportsDm('facebook'), true);
});
