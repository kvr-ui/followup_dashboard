const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { paginate } = require('../utils/Pagination');

describe('paginate', () => {
  it("follows paging.next and concatenates every page's data", async () => {
    const pages = {
      a: { data: [1, 2], paging: { next: 'b' } },
      b: { data: [3], paging: { next: 'c' } },
      c: { data: [4] },
    };
    const fetchPage = mock.fn(async (url) => pages[url]);
    const all = await paginate(fetchPage, 'a');
    assert.deepEqual(all, [1, 2, 3, 4]);
    assert.equal(fetchPage.mock.callCount(), 3);
  });

  it('tolerates pages with no data array', async () => {
    const all = await paginate(async () => ({}), 'x');
    assert.deepEqual(all, []);
  });

  it('stops at maxPages to avoid runaway loops', async () => {
    const fetchPage = mock.fn(async () => ({ data: [1], paging: { next: 'loop' } }));
    const all = await paginate(fetchPage, 'loop', 3);
    assert.deepEqual(all, [1, 1, 1]);
    assert.equal(fetchPage.mock.callCount(), 3);
  });
});
