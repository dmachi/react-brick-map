import * as jsonld from 'jsonld';
import * as $rdf from 'rdflib';

export type RdfStore = $rdf.IndexedFormula;
export type RdfSelectRow = Record<string, string>;

type QueryBindingTerm = {
  value?: string;
} | null | undefined;

function normalizeJsonLdInput(jsonLdContent: string | object): object {
  let data: unknown;

  if (typeof jsonLdContent === 'string') {
    try {
      data = JSON.parse(jsonLdContent);
    } catch (err) {
      throw new Error(`JSON-LD parse error: ${err instanceof Error ? err.message : 'Invalid JSON'}`);
    }
  } else {
    data = jsonLdContent;
  }

  if (!data || (typeof data !== 'object' && !Array.isArray(data))) {
    throw new Error('JSON-LD must be an object, array, or valid JSON string');
  }

  return data as object;
}

export function createRdfStore(): RdfStore {
  return $rdf.graph();
}

export async function loadRdfStoreFromJsonLd(
  jsonLdContent: string | object,
  rdfStore?: RdfStore,
): Promise<RdfStore> {
  const normalizedInput = normalizeJsonLdInput(jsonLdContent);
  const nquads = await jsonld.toRDF(normalizedInput, { format: 'application/n-quads' });

  if (typeof nquads !== 'string' || nquads.trim().length === 0) {
    throw new Error('JSON-LD did not produce RDF quads');
  }

  const store = rdfStore ?? createRdfStore();

  await new Promise<void>((resolve, reject) => {
    $rdf.parse(
      nquads,
      store,
      'https://example.local/base#',
      'application/n-quads',
      (error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error('Failed to parse N-Quads into RDF store'));
          return;
        }

        resolve();
      },
    );
  });

  return store;
}

export async function selectRdfStore(store: RdfStore, sparql: string): Promise<RdfSelectRow[]> {
  const query = $rdf.SPARQLToQuery(sparql, false, store);
  if (!query) {
    throw new Error('SPARQL query could not be parsed');
  }

  return new Promise((resolve, reject) => {
    const rows: RdfSelectRow[] = [];

    try {
      store.query(
        query,
        (bindings) => {
          const row: RdfSelectRow = {};
          for (const [key, term] of Object.entries(bindings as Record<string, QueryBindingTerm>)) {
            if (!term || typeof term.value !== 'string') {
              continue;
            }
            row[key.startsWith('?') ? key.slice(1) : key] = term.value;
          }
          rows.push(row);
        },
        undefined,
        () => resolve(rows),
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error('SPARQL query execution failed'));
    }
  });
}