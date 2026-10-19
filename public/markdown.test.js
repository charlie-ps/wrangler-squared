import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownHtml, inlineHtml } from './markdown.js';

test('inline Markdown is marked up only after the text is escaped', () => {
  assert.equal(inlineHtml('**bold** and *it* and _it_ and ~~gone~~ <b>x</b>'), '<strong>bold</strong> and <em>it</em> and <em>it</em> and <del>gone</del> &lt;b&gt;x&lt;/b&gt;');
  assert.equal(inlineHtml('`**not bold** <i>`'), '<code>**not bold** &lt;i&gt;</code>');
  assert.equal(inlineHtml('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4');
});

test('a link only ever points at http(s) or mailto, and a bare URL becomes one', () => {
  assert.equal(inlineHtml('[the PR](https://example.com/acme/widgets/pull/1)'), '<a href="https://example.com/acme/widgets/pull/1" target="_blank" rel="noopener noreferrer">the PR</a>');
  assert.equal(inlineHtml('[`run`](https://example.com/a_(b))'), '<a href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer"><code>run</code></a>');
  assert.equal(inlineHtml('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(inlineHtml('[x](https://example.com/"onmouseover="a)'), '<a href="https://example.com/&quot;onmouseover=&quot;a" target="_blank" rel="noopener noreferrer">x</a>');
  assert.equal(inlineHtml('see https://example.com/a?b=1&c=2.'), 'see <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https://example.com/a?b=1&amp;c=2</a>.');
});

test('headings, rules, quotes and fenced code are blocks of their own', () => {
  assert.equal(markdownHtml('## Summary\nDone.\n\n---\n> was *this*\n> right?'), '<h5>Summary</h5><p>Done.</p><hr><blockquote><p>was <em>this</em><br>right?</p></blockquote>');
  assert.equal(markdownHtml('Run:\n```sh\nnpm test <x>\n\n  ok\n```\nThen'), '<p>Run:</p><pre><code>npm test &lt;x&gt;\n\n  ok</code></pre><p>Then</p>');
  assert.equal(markdownHtml('```\nnever closed'), '<pre><code>never closed</code></pre>');
});

test('lists nest, keep their numbering across blank lines, and hold code under an item', () => {
  assert.equal(markdownHtml('- one\n  - one a\n  - one b\n- two'), '<ul><li>one<ul><li>one a</li><li>one b</li></ul></li><li>two</li></ul>');
  assert.equal(markdownHtml('1. first\n\n2. second\n\nAfter'), '<ol><li>first</li><li>second</li></ol><p>After</p>');
  assert.equal(markdownHtml('3. third\n4. fourth'), '<ol start="3"><li>third</li><li>fourth</li></ol>');
  assert.equal(markdownHtml('1. Do:\n   ```\n   x\n   ```'), '<ol><li>Do:<pre><code>x</code></pre></li></ol>');
});

test('a table is drawn with its header, and its cells are escaped', () => {
  assert.equal(markdownHtml('| File | Change |\n|---|:--:|\n| `a.js` | <b>new</b> |\n| b \\| c |'),
    '<div class="md-table"><table><thead><tr><th>File</th><th>Change</th></tr></thead><tbody><tr><td><code>a.js</code></td><td>&lt;b&gt;new&lt;/b&gt;</td></tr><tr><td>b | c</td><td></td></tr></tbody></table></div>');
});
