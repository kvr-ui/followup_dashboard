const CREATIVE_FIELDS = [
  'id',
  'name',
  'title',
  'body',
  'image_url',
  'video_id',
  'call_to_action_type',
  'url_tags',
  'object_story_spec',
];

/** @returns {import('../types').Creative} */
function normalizeCreative(raw) {
  const spec = raw.object_story_spec;
  const ctaFromSpec =
    spec?.link_data?.call_to_action?.type ??
    spec?.video_data?.call_to_action?.type ??
    null;
  return {
    id: raw.id,
    name: raw.name ?? null,
    title: raw.title ?? null,
    body: raw.body ?? null,
    imageUrl: raw.image_url ?? null,
    videoId: raw.video_id ?? null,
    callToActionType: raw.call_to_action_type ?? ctaFromSpec,
    linkUrl: spec?.link_data?.link ?? null,
    urlTags: raw.url_tags ?? null,
  };
}

class CreativeService {
  /**
   * @param {import('../client/MetaClient').MetaClient} client
   * @param {string} accountPath
   */
  constructor(client, accountPath) {
    this.client = client;
    this.accountPath = accountPath;
  }

  /** Fetch all ad creatives for the configured ad account. */
  async list() {
    const raw = await this.client.getEdge(`/${this.accountPath}/adcreatives`, {
      fields: CREATIVE_FIELDS.join(','),
      limit: 100,
    });
    return raw.map(normalizeCreative);
  }
}

module.exports = { CreativeService, normalizeCreative };
