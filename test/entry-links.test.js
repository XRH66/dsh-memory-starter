import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_END,
  TOPIC_LINE_PREFIX,
  isTopicPath,
  topicFileName,
  topicFileNames,
  topicLinkLine,
  topicPageContent,
  topicPageMetadata,
  topicsDirectory,
  withEntryTopics,
} from '../lib/entry-links.js';

const managed=`# 条目\n\n<!-- dsh-memory-entry:start -->\n受管正文\n${ENTRY_END}`;

test('topic names use the same sanitized filename and link text in tag order', () => {
  assert.deepEqual(topicFileNames([' 工作/夜班 ', '工作:夜班', '夜班', '.休息.', '...']), ['工作_夜班', '夜班', '休息']);
  assert.equal(topicLinkLine(['工作/夜班', '工作:夜班', '夜班']), '主题：[[工作_夜班]] [[夜班]]');
  assert.equal(topicFileName('v1.2'), 'v1.2');
  assert.equal(topicsDirectory('chats/entries'), 'chats/topics');
  assert.equal(isTopicPath('chats/topics/工作.md', 'chats/entries'), true);
  assert.equal(isTopicPath('chats/entries/工作.md', 'chats/entries'), false);
});

test('topic lines stay outside the managed block and are replaced as a single line', () => {
  const first=withEntryTopics(managed, ['工作', '夜班', '工作']);
  assert.equal(first.slice(0, managed.length), managed);
  assert.equal(first.slice(managed.length), `\n${TOPIC_LINE_PREFIX}[[工作]] [[夜班]]`);
  const withManual=first+'\n人工补充：保留。\n'+TOPIC_LINE_PREFIX+'[[重复]]';
  const changed=withEntryTopics(withManual, ['夜班', '个人']);
  assert.equal(changed.slice(0, managed.length), managed);
  assert.equal((changed.match(/^主题：/gm)??[]).length, 1);
  assert.match(changed, /主题：\[\[夜班\]\] \[\[个人\]\]/);
  assert.match(changed, /人工补充：保留。/);
  const removed=withEntryTopics(changed, []);
  assert.equal((removed.match(/^主题：/gm)??[]).length, 0);
  assert.match(removed, /人工补充：保留。/);
});

test('topic pages carry the required frontmatter and stable body', () => {
  assert.deepEqual(topicPageMetadata('工作_夜班'), {
    title: '工作_夜班',
    type: 'note',
    tags: ['dsh-topic'],
    embed: false,
  });
  assert.equal(topicPageContent('工作_夜班'), '# 工作_夜班\n\n本页由记忆框架自动维护，可在下方自由补充\n');
});
