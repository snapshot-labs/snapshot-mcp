const SEARCH_API_URL =
  process.env.SEARCH_API_URL ?? 'https://search.snapshot.box';

interface SearchRow {
  id: string;
  type: string;
  $score: number;
  title?: string;
  body?: string;
  space?: string;
  name?: string;
  about?: string;
  spaceId?: string;
}

export async function search(
  q: string,
  space?: string,
  type?: 'proposal' | 'space'
) {
  const params = new URLSearchParams({ q });
  if (space) params.set('space', space);
  if (type) params.set('type', type);

  const res = await fetch(`${SEARCH_API_URL}/search?${params}`);
  if (!res.ok) throw new Error(`Search API returned ${res.status}`);

  const json = (await res.json()) as { result: SearchRow[] };

  return json.result.map(({ body, about, ...rest }) => ({
    ...rest,
    ...(body !== undefined && { body: body.slice(0, 500) }),
    ...(about !== undefined && { about: about.slice(0, 500) })
  }));
}
