import { describe, expect, it } from 'vitest';

import { hermesProvider } from '../src/providers';
import {
  formatHermesToolStatus,
  HERMES_OBSERVER_SCHEMA_VERSION,
  normalizeHermesHookEvent,
} from '../src/providers/hook/hermes/hermesEvents.js';

const base = {
  telemetry_schema_version: HERMES_OBSERVER_SCHEMA_VERSION,
  session_id: 'telegram:chat-123',
  cwd: '/workspace/project',
};

describe('Hermes observer event contract', () => {
  it('is exposed as a protocol-v1 hook provider', () => {
    expect(hermesProvider).toMatchObject({
      kind: 'hook',
      id: 'hermes',
      displayName: 'Hermes Agent',
      protocolVersion: 1,
    });
    expect(hermesProvider.team).toBeUndefined();
  });

  it('publishes Hermes reading capabilities', () => {
    expect(hermesProvider.readingTools).toEqual(
      new Set(['read_file', 'web_search', 'web_fetch', 'browser']),
    );
    expect(hermesProvider.subagentToolNames.size).toBe(0);
  });

  it('creates an external session without requiring a transcript', () => {
    expect(
      normalizeHermesHookEvent({
        ...base,
        hook_event_name: 'on_session_start',
        platform: 'telegram',
      }),
    ).toEqual({
      sessionId: 'telegram:chat-123',
      event: {
        kind: 'sessionStart',
        source: 'telegram',
        cwd: '/workspace/project',
      },
    });
  });

  it('keeps the Hermes tool-call id across tool start and end', () => {
    const start = normalizeHermesHookEvent({
      ...base,
      hook_event_name: 'pre_tool_call',
      tool_call_id: 'call-7',
      tool_name: 'read_file',
      args: { path: '/workspace/project/README.md' },
    });
    const end = normalizeHermesHookEvent({
      ...base,
      hook_event_name: 'post_tool_call',
      tool_call_id: 'call-7',
      tool_name: 'read_file',
      result: 'sensitive content that must not be forwarded',
    });

    expect(start?.event).toEqual({
      kind: 'toolStart',
      toolId: 'call-7',
      toolName: 'read_file',
      input: { path: '/workspace/project/README.md' },
    });
    expect(end?.event).toEqual({ kind: 'toolEnd', toolId: 'call-7' });
    expect(end).not.toHaveProperty('event.result');
  });

  it('maps an approval request by session_id', () => {
    expect(
      normalizeHermesHookEvent({
        ...base,
        hook_event_name: 'pre_approval_request',
        command: 'sensitive command',
      }),
    ).toEqual({
      sessionId: 'telegram:chat-123',
      event: { kind: 'permissionRequest' },
    });
  });

  it('accepts session_key for approval-hook compatibility', () => {
    expect(
      normalizeHermesHookEvent({
        hook_event_name: 'pre_approval_request',
        session_key: 'telegram:chat-123',
      })?.sessionId,
    ).toBe('telegram:chat-123');
  });

  it.each(['post_llm_call', 'on_session_end'])('%s leaves the session waiting', (eventName) => {
    expect(normalizeHermesHookEvent({ ...base, hook_event_name: eventName })?.event).toEqual({
      kind: 'turnEnd',
      awaitingInput: true,
    });
  });

  it.each(['on_session_finalize', 'on_session_reset'])(
    '%s ends the session identity',
    (eventName) => {
      expect(normalizeHermesHookEvent({ ...base, hook_event_name: eventName })?.event).toEqual({
        kind: 'sessionEnd',
        reason: eventName === 'on_session_finalize' ? 'finalize' : 'reset',
      });
    },
  );

  it.each(['pre_llm_call', 'post_approval_response', 'future_hook'])(
    'ignores %s because it has no required v1 visual transition',
    (eventName) => {
      expect(normalizeHermesHookEvent({ ...base, hook_event_name: eventName })).toBeNull();
    },
  );

  it('rejects malformed events', () => {
    expect(normalizeHermesHookEvent({ hook_event_name: 'on_session_start' })).toBeNull();
    expect(normalizeHermesHookEvent({ session_id: 'session-1' })).toBeNull();
    expect(
      normalizeHermesHookEvent({
        ...base,
        hook_event_name: 'pre_tool_call',
        tool_call_id: 'call-1',
      }),
    ).toBeNull();
  });
});

describe('Hermes tool status formatting', () => {
  it('does not expose terminal command contents', () => {
    expect(formatHermesToolStatus('terminal', { command: 'cat /run/secrets/token' })).toBe(
      'Running a command',
    );
  });

  it('formats common tools', () => {
    expect(formatHermesToolStatus('read_file', { path: '/workspace/README.md' })).toBe(
      'Reading README.md',
    );
    expect(formatHermesToolStatus('web_search')).toBe('Searching the web');
    expect(formatHermesToolStatus('custom_tool')).toBe('Using custom_tool');
  });
});
