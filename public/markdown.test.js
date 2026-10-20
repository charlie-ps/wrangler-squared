import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownHtml, useMarkdownRenderer } from './markdown.js';

test('until the board hands over its renderer a message is escaped as it stands, its lines kept', () => {
  assert.equal(markdownHtml('**done** <b>x</b>\nnext'), '<p>**done** &lt;b&gt;x&lt;/b&gt;<br>next</p>');
  assert.equal(markdownHtml(undefined), '<p></p>');
});

test('the board\'s renderer draws every message once handed over, and a missing one falls back', (t) => {
  t.after(() => useMarkdownRenderer(null));
  useMarkdownRenderer((md) => `<h1>${md}</h1>`);
  assert.equal(markdownHtml('hi'), '<h1>hi</h1>');
  useMarkdownRenderer(undefined);
  assert.equal(markdownHtml('<i>'), '<p>&lt;i&gt;</p>');
});
