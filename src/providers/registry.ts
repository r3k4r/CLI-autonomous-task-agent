import { UnknownProviderError } from '../util/errors.js';
import { MockProvider } from './mock.js';
import type { Provider } from './types.js';

/**
 * Maps a provider name to an implementation.
 *
 * NOTE: providers are constructed lazily so that selecting `mock` never loads
 * the claude-code adapter, and tests can never accidentally reach a real agent.
 */

export interface ProviderOptions {
  /** Milliseconds before a stuck agent is aborted. */
  timeoutMs?: number;
  /** 'api' keeps ANTHROPIC_API_KEY in the child env; anything else strips it. */
  billing?: 'subscription' | 'api';
}

type ProviderFactory = (options: ProviderOptions) => Provider | Promise<Provider>;

const factories = new Map<string, ProviderFactory>([
  ['mock', () => new MockProvider()],
  [
    'claude-code',
    async (options) => {
      // Imported lazily so choosing `mock` never loads the real agent adapter.
      const { ClaudeCodeProvider } = await import('./claudeCode.js');
      return new ClaudeCodeProvider(options);
    },
  ],
]);

/** Register a provider implementation under a name. */
export function registerProvider(name: string, factory: ProviderFactory): void {
  factories.set(name, factory);
}

export function providerNames(): string[] {
  return [...factories.keys()];
}

export async function getProvider(name: string, options: ProviderOptions = {}): Promise<Provider> {
  const factory = factories.get(name);
  if (!factory) throw new UnknownProviderError(name, providerNames());
  return factory(options);
}
