/** @typedef {{id: string, name: string|null}} TokenInfo */

/**
 * Lightweight token check. Performs a cheap `/me` call; a valid token
 * resolves with the identity, an invalid one throws a `MetaAuthError`.
 */
class TokenValidator {
  /** @param {import('../client/MetaClient').MetaClient} client */
  constructor(client) {
    this.client = client;
  }

  /** @returns {Promise<TokenInfo>} */
  async validate() {
    const me = await this.client.get('/me', { fields: 'id,name' });
    return { id: me.id, name: me.name ?? null };
  }
}

module.exports = { TokenValidator };
