import test from 'node:test';
import assert from 'node:assert/strict';

import { getCampaignAccessQuery } from '../src/routes/bulkAgent.js';

test('owners retain workspace-wide campaign access', () => {
  assert.deepEqual(getCampaignAccessQuery({
    _id: 'owner-1',
    role: 'owner',
    email: 'owner@example.com',
  }), {});
});

test('non-owners are scoped by identity and normalized assignment email', () => {
  assert.deepEqual(getCampaignAccessQuery({
    _id: 'editor-1',
    role: 'editor',
    email: '  Editor@Example.COM ',
  }), {
    $or: [
      { createdBy: 'editor-1' },
      { 'channels.assignedHandlerUserId': 'editor-1' },
      { mainEmail: 'editor@example.com' },
      { 'channels.assignedHandlerEmail': 'editor@example.com' },
    ],
  });
});

test('blank user email never grants access through blank campaign fields', () => {
  assert.deepEqual(getCampaignAccessQuery({
    _id: 'editor-without-email',
    role: 'editor',
    email: '   ',
  }), {
    $or: [
      { createdBy: 'editor-without-email' },
      { 'channels.assignedHandlerUserId': 'editor-without-email' },
    ],
  });
});
