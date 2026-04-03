const SNAPSHOT_API_URL = 'https://hub.snapshot.org/graphql';

export async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(SNAPSHOT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.SNAPSHOT_API_KEY && {
        'x-api-key': process.env.SNAPSHOT_API_KEY
      })
    },
    body: JSON.stringify({ query, variables })
  });

  const json = (await res.json()) as {
    data: Record<string, unknown> | null;
    errors?: { message: string }[];
  };

  if (!json.data) {
    throw new Error(json.errors?.[0]?.message ?? 'GraphQL returned no data');
  }

  return json.data;
}

const BUILTIN_TYPES = new Set(['String', 'Boolean', 'Int', 'Float', 'ID']);

export const schemaCache: Promise<unknown> = gql(`{
  __schema {
    queryType {
      fields {
        name
        description
        args { name type { name kind ofType { name kind ofType { name kind } } } }
        type { name kind ofType { name kind } }
      }
    }
    types {
      name
      kind
      description
      fields { name type { name kind ofType { name kind } } }
      inputFields { name type { name kind ofType { name kind } } }
      enumValues { name }
    }
  }
}`).then(data => {
  const schema = data.__schema as {
    queryType: unknown;
    types: { name: string }[];
  };
  schema.types = schema.types.filter(
    t => !t.name.startsWith('__') && !BUILTIN_TYPES.has(t.name)
  );

  return schema;
});
