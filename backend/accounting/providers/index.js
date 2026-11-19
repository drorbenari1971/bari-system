// Provider registry. Adding a provider = a folder under providers/ and one line here.
import { assertProvider } from './base.js';
import morning from './morning/index.js';

const providers = new Map([morning].map((p) => [p.id, assertProvider(p)]));

/** @returns {import('./base.js').AccountingProvider} */
export function getProvider(id) {
  const p = providers.get(id);
  if (!p) throw new Error(`Unknown accounting provider: ${id}`);
  return p;
}

export const listProviders = () => [...providers.values()];
export const hasProvider = (id) => providers.has(id);
