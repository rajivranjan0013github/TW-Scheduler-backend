import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChannelHandle,
  toFuzzyHandleKey,
  accountMatchesHandle,
} from '../src/utils/campaignChannels.js';

test('normalizeChannelHandle correctly handles URLs, special characters, and German umlauts', () => {
  // Strips URL prefixes
  assert.equal(
    normalizeChannelHandle('https://www.youtube.com/@DiagnoseitKlinischeFaelle'),
    'diagnoseitklinischefaelle'
  );
  assert.equal(
    normalizeChannelHandle('https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw'),
    'uc_x5xg1ov2p6uzz5fsm9ttw'
  );
  assert.equal(
    normalizeChannelHandle('https://instagram.com/diagnose_it_official/'),
    'diagnose_it_official'
  );
  assert.equal(
    normalizeChannelHandle('@DiagnoseIT'),
    'diagnoseit'
  );

  // Transliterates German umlauts
  assert.equal(
    normalizeChannelHandle('Klinische Fälle'),
    'klinische faelle'
  );
  assert.equal(
    normalizeChannelHandle('Große Ärzte'),
    'grosse aerzte'
  );
});

test('toFuzzyHandleKey removes all whitespace and punctuation for resilient matching', () => {
  assert.equal(
    toFuzzyHandleKey('Diagnose IT - Klinische Fallstudien!'),
    'diagnoseitklinischefallstudien'
  );
  assert.equal(
    toFuzzyHandleKey('https://youtube.com/@Diagnoseit_Klinische-Faelle'),
    'diagnoseitklinischefaelle'
  );
});

test('accountMatchesHandle matches YouTube channels across handles, titles, IDs, and URLs', () => {
  const account = {
    platform: 'youtube',
    accountId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    name: 'Diagnose IT - Klinische Fälle',
    username: '@diagnoseitklinischefaelle',
  };

  // Match by handle with or without @
  assert.equal(accountMatchesHandle(account, 'youtube', '@diagnoseitklinischefaelle'), true);
  assert.equal(accountMatchesHandle(account, 'youtube', 'diagnoseitklinischefaelle'), true);

  // Match by full YouTube URL
  assert.equal(
    accountMatchesHandle(account, 'youtube', 'https://www.youtube.com/@diagnoseitklinischefaelle'),
    true
  );

  // Match by Channel ID (UC...)
  assert.equal(accountMatchesHandle(account, 'youtube', 'UC_x5XG1OV2P6uZZ5FSM9Ttw'), true);
  assert.equal(
    accountMatchesHandle(account, 'youtube', 'https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw'),
    true
  );

  // Match by channel title with spacing/dash differences
  assert.equal(accountMatchesHandle(account, 'youtube', 'Diagnose IT: Klinische Fälle'), true);
  assert.equal(accountMatchesHandle(account, 'youtube', 'Diagnose IT Klinische Faelle'), true);

  // Rejects wrong platform
  assert.equal(accountMatchesHandle(account, 'instagram', '@diagnoseitklinischefaelle'), false);

  // Rejects completely unrelated channel
  assert.equal(accountMatchesHandle(account, 'youtube', '@completelydifferentchannel'), false);
});
