/**
 * Walk every page of a Graph API edge by following `paging.next`,
 * accumulating all `data` items into a single array.
 *
 * @template T
 * @param {(url: string) => Promise<import('../types').GraphListResponse<T>>} fetchPage
 *   Fetches (and parses) one page given its full URL.
 * @param {string} firstUrl The fully-built URL of the first page.
 * @param {number} [maxPages] Safety limit to avoid runaway pagination. Defaults to 1000.
 * @returns {Promise<T[]>}
 */
async function paginate(fetchPage, firstUrl, maxPages = 1000) {
  const results = [];
  let url = firstUrl;
  let pages = 0;

  while (url && pages < maxPages) {
    const page = await fetchPage(url);
    if (Array.isArray(page.data)) {
      results.push(...page.data);
    }
    url = page.paging?.next;
    pages += 1;
  }

  return results;
}

module.exports = { paginate };
