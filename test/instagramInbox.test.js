import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLY_WINDOW_MS,
  getReplyWindowClosesAt,
  isReplyWindowOpen,
  parseMessagingEvent,
} from '../src/services/inboxService.js';

test('parses an inbound DM from the webhook', () => {
  const event = parseMessagingEvent('900', {
    sender: { id: '123' },
    recipient: { id: '900' },
    timestamp: 1760000000000,
    message: { mid: 'mid.1', text: 'Is this still available?' },
  });
  assert.deepEqual(event, {
    platform: 'instagram',
    entryId: '900',
    mid: 'mid.1',
    direction: 'in',
    participantId: '123',
    text: 'Is this still available?',
    attachments: [],
    sentAt: new Date(1760000000000),
  });
});

test('treats echoes as outbound messages to the recipient', () => {
  const event = parseMessagingEvent('900', {
    sender: { id: '900' },
    recipient: { id: '123' },
    timestamp: 1760000000000,
    message: { mid: 'mid.2', is_echo: true, attachments: [{ type: 'image', payload: { url: 'https://x/y.jpg' } }] },
  });
  assert.equal(event.direction, 'out');
  assert.equal(event.participantId, '123');
  assert.deepEqual(event.attachments, [{ type: 'image', url: 'https://x/y.jpg' }]);
});

test('ignores deleted messages and non-message events', () => {
  assert.equal(parseMessagingEvent('900', { sender: { id: '1' }, message: { mid: 'm', is_deleted: true } }), null);
  assert.equal(parseMessagingEvent('900', { sender: { id: '1' }, read: { mid: 'm' } }), null);
});

test('reply window is open for 24 hours after their last message', () => {
  const now = Date.now();
  assert.equal(isReplyWindowOpen({ lastInboundAt: new Date(now - 60 * 1000) }, now), true);
  assert.equal(isReplyWindowOpen({ lastInboundAt: new Date(now - REPLY_WINDOW_MS - 1000) }, now), false);
  assert.equal(isReplyWindowOpen({ lastInboundAt: null }, now), false);
  const lastInboundAt = new Date('2026-10-15T10:00:00Z');
  assert.equal(getReplyWindowClosesAt({ lastInboundAt }).toISOString(), '2026-10-16T10:00:00.000Z');
});

test('tags Messenger events with the Facebook platform', () => {
  const event = parseMessagingEvent('555', {
    sender: { id: '42' }, recipient: { id: '555' }, timestamp: 1760000000000, message: { mid: 'm_1', text: 'hi' },
  }, 'facebook');
  assert.equal(event.platform, 'facebook');
  assert.equal(event.participantId, '42');
});
