import { googleGet } from './googleClient.js';

export interface YouTubeChannel {
  id: string;
  title: string;
  thumbnailUrl?: string;
}

/**
 * `mine=true` resolves to whichever identity (personal or Brand Account) the
 * user picked on Google's consent screen — Google typically surfaces at most
 * one channel per that choice, unlike Facebook's one-connection-to-many-Pages
 * shape. The `publish_targets` upsert loop still handles N>1 defensively in
 * case that assumption doesn't hold for every account.
 */
export async function fetchUserChannels(accessToken: string): Promise<YouTubeChannel[]> {
  const result = await googleGet<{
    items?: Array<{
      id: string;
      snippet?: { title?: string; thumbnails?: { default?: { url?: string } } };
    }>;
  }>('/channels', { part: 'snippet', mine: 'true' }, accessToken);
  return (result.items ?? []).map((item) => ({
    id: item.id,
    title: item.snippet?.title ?? item.id,
    thumbnailUrl: item.snippet?.thumbnails?.default?.url,
  }));
}
