const SEARCH_API_URL =
  process.env.SEARCH_API_URL ?? 'https://search.snapshot.box';

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

  const json = (await res.json()) as { result: unknown };
  return json.result;
}
