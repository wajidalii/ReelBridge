import { GraphApiError, graphGet, graphPost } from './graphClient.js';

export interface CreateContainerResult {
  creationId: string;
}

/**
 * Phase 1 (TDD.md §1.2): Instagram pulls the video from a URL rather than
 * accepting a raw binary body — `video_url` must be publicly fetchable by
 * Meta's servers, which is why the caller hands this a signed storage URL
 * rather than a buffer the way Facebook/YouTube's adapters do.
 */
export async function createMediaContainer(
  igUserId: string,
  accessToken: string,
  videoUrl: string,
  caption: string,
): Promise<CreateContainerResult> {
  const result = await graphPost<{ id: string }>(`/${igUserId}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    access_token: accessToken,
  });
  return { creationId: result.id };
}

export type ContainerStatusCode = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

export async function getContainerStatus(
  containerId: string,
  accessToken: string,
): Promise<{ statusCode: ContainerStatusCode; statusText?: string }> {
  const result = await graphGet<{ status_code: ContainerStatusCode; status?: string }>(
    `/${containerId}`,
    { fields: 'status_code,status', access_token: accessToken },
  );
  return { statusCode: result.status_code, statusText: result.status };
}

export class ContainerProcessingError extends Error {}
export class ContainerPollingTimeoutError extends Error {}

export interface PollOptions {
  /** Polling interval — Meta's own docs suggest not polling faster than a
   *  few seconds; defaults to 3s. */
  intervalMs?: number;
  /** Total time budget before giving up — a container that's still not
   *  FINISHED well past typical processing time likely means something's
   *  actually wrong, and an unbounded poll loop would hold a worker slot
   *  (and a BullMQ job) forever. Defaults to 2 minutes. */
  timeoutMs?: number;
}

/**
 * Phase 2: bounded poll of `GET /{container-id}?fields=status_code` until
 * FINISHED (AC: "bounded timeout/backoff, not an infinite loop"). ERROR and
 * EXPIRED are terminal failures reported immediately rather than retried —
 * Meta won't recover a container in either of those states.
 */
export async function waitForContainerFinished(
  containerId: string,
  accessToken: string,
  options: PollOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 2 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { statusCode, statusText } = await getContainerStatus(containerId, accessToken);

    if (statusCode === 'FINISHED') return;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new ContainerProcessingError(
        `Instagram media container ${containerId} entered a terminal ${statusCode} state${
          statusText ? `: ${statusText}` : ''
        }`,
      );
    }

    if (Date.now() >= deadline) {
      throw new ContainerPollingTimeoutError(
        `Instagram media container ${containerId} did not finish processing within ${timeoutMs}ms (last status: ${statusCode})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface PublishContainerResult {
  mediaId: string;
}

/** Phase 3: the actual publish, using the finished container's creation_id. */
export async function publishContainer(
  igUserId: string,
  accessToken: string,
  creationId: string,
): Promise<PublishContainerResult> {
  const result = await graphPost<{ id: string }>(`/${igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: accessToken,
  });
  return { mediaId: result.id };
}

/** Best-effort — a missing permalink shouldn't fail an otherwise-successful publish. */
export async function fetchPermalink(
  mediaId: string,
  accessToken: string,
): Promise<string | undefined> {
  try {
    const result = await graphGet<{ permalink?: string }>(`/${mediaId}`, {
      fields: 'permalink',
      access_token: accessToken,
    });
    return result.permalink;
  } catch (error) {
    if (error instanceof GraphApiError) return undefined;
    throw error;
  }
}
