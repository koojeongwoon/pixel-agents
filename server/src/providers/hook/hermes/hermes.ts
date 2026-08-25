import type { HookProvider } from '../../../../../core/src';
import { formatHermesToolStatus, normalizeHermesHookEvent } from './hermesEvents.js';

const INSTALLER_NOT_AVAILABLE =
  'Hermes hook installation is not bundled yet; install the Pixel Agents Hermes plugin in the Hermes runtime.';

export const hermesProvider: HookProvider = {
  kind: 'hook',
  id: 'hermes',
  displayName: 'Hermes Agent',
  protocolVersion: 1,

  normalizeHookEvent: normalizeHermesHookEvent,

  async installHooks(): Promise<void> {
    throw new Error(INSTALLER_NOT_AVAILABLE);
  },
  async uninstallHooks(): Promise<void> {
    throw new Error(INSTALLER_NOT_AVAILABLE);
  },
  async areHooksInstalled(): Promise<boolean> {
    return false;
  },
  consentDisclosure(): { headline: string; disclosure: string } {
    return {
      headline: 'Connect Hermes hooks',
      disclosure: INSTALLER_NOT_AVAILABLE,
    };
  },

  formatToolStatus: formatHermesToolStatus,
  permissionExemptTools: new Set(),
  subagentToolNames: new Set(),
  readingTools: new Set(['read_file', 'web_search', 'web_fetch', 'browser']),
};
