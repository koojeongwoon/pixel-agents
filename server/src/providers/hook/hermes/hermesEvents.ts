import * as path from 'path';

import type { AgentEvent } from '../../../../../core/src';

export const HERMES_OBSERVER_SCHEMA_VERSION = 'hermes.observer.v1';

export interface NormalizedHermesHookEvent {
  sessionId: string;
  event: AgentEvent;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sessionIdFrom(raw: Record<string, unknown>): string | undefined {
  return nonEmptyString(raw.session_id) ?? nonEmptyString(raw.session_key);
}

/**
 * Normalize Hermes observer hooks into Pixel Agents' provider-neutral event model.
 *
 * Only visualization metadata crosses this boundary. Prompt text, assistant output,
 * tool results, and approval commands are intentionally ignored.
 */
export function normalizeHermesHookEvent(
  raw: Record<string, unknown>,
): NormalizedHermesHookEvent | null {
  const eventName = nonEmptyString(raw.hook_event_name);
  const sessionId = sessionIdFrom(raw);
  if (!eventName || !sessionId) return null;

  switch (eventName) {
    case 'on_session_start':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: nonEmptyString(raw.platform),
          cwd: nonEmptyString(raw.cwd),
        },
      };

    case 'pre_tool_call': {
      const toolName = nonEmptyString(raw.tool_name);
      if (!toolName) return null;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: nonEmptyString(raw.tool_call_id) ?? `hermes-tool-${Date.now()}`,
          toolName,
          input:
            typeof raw.tool_input === 'object' && raw.tool_input !== null
              ? raw.tool_input
              : typeof raw.args === 'object' && raw.args !== null
                ? raw.args
                : undefined,
        },
      };
    }

    case 'post_tool_call':
      return {
        sessionId,
        event: {
          kind: 'toolEnd',
          toolId: nonEmptyString(raw.tool_call_id) ?? 'current',
        },
      };

    case 'pre_approval_request':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'post_llm_call':
    case 'on_session_end':
      // Both events are turn-scoped in Hermes. The session remains available
      // for the next gateway message, so the character should wait, not despawn.
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };

    case 'on_session_finalize':
      return {
        sessionId,
        event: { kind: 'sessionEnd', reason: nonEmptyString(raw.reason) ?? 'finalize' },
      };

    case 'on_session_reset':
      return {
        sessionId,
        event: { kind: 'sessionEnd', reason: nonEmptyString(raw.reason) ?? 'reset' },
      };

    // pre_llm_call marks the beginning of a turn but AgentEvent has no generic
    // "thinking" state. Session/tool hooks provide the visible transitions for v1.
    case 'pre_llm_call':
    case 'post_approval_response':
    default:
      return null;
  }
}

export function formatHermesToolStatus(toolName: string, input?: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const basename = (value: unknown) =>
    typeof value === 'string' && value.length > 0 ? path.basename(value) : '';

  switch (toolName) {
    case 'read_file':
      return `Reading ${basename(args.path ?? args.file_path)}`;
    case 'write_file':
      return `Writing ${basename(args.path ?? args.file_path)}`;
    case 'patch':
      return `Editing ${basename(args.path ?? args.file_path)}`;
    case 'terminal':
      return 'Running a command';
    case 'web_search':
      return 'Searching the web';
    case 'web_fetch':
      return 'Fetching web content';
    case 'browser':
      return 'Using the browser';
    case 'delegate_task':
      return 'Running a delegated task';
    default:
      return `Using ${toolName}`;
  }
}
