export const GRAPH_API_VERSION = 'v21.0';
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export class GraphApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
    this.body = body;
  }
}

function buildUrl(base: string, path: string, params: Record<string, string>): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function graphGet<T>(
  path: string,
  params: Record<string, string>,
  base: string = GRAPH_API_BASE,
): Promise<T> {
  const res = await fetch(buildUrl(base, path, params));
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new GraphApiError(
      `Graph API GET ${path} failed with status ${res.status}`,
      res.status,
      body,
    );
  }
  return body as T;
}

export async function graphPost<T>(
  path: string,
  params: Record<string, string>,
  base: string = GRAPH_API_BASE,
): Promise<T> {
  const url = new URL(`${base}${path}`);
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new GraphApiError(
      `Graph API POST ${path} failed with status ${res.status}`,
      res.status,
      body,
    );
  }
  return body as T;
}
