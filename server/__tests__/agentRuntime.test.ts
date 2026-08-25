import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers';
import { hermesProvider } from '../src/providers';

/**
 * D5 gate (tier-3 multi-server hook fan-out plan): the hook script now
 * broadcasts every event to every live server (server/src/providers/hook/
 * claude/hooks/claude-hook.ts), so a server must never adopt a session it
 * doesn't own just because it received the event. HookEventHandler's own
 * isTrackedSession only gates debug logging (hookEventHandler.ts:173-174);
 * the actual gate is one hop downstream, in AgentRuntime's
 * onExternalSessionDetected callback (agentRuntime.ts:96-101), which drops
 * the session unless its project dir was scanned by this instance
 * (isTrackedProjectDir) or watchAllSessions is on. These tests exercise
 * that real callback end-to-end via handleHookEvent, not a mock.
 */
describe('AgentRuntime -- D5 foreign-session gate', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    // Clears the project-scan interval and any polling timer from adoption.
    runtime?.dispose();
  });

  /** A directory guaranteed untracked by any other test in this file or
   *  process (isTrackedProjectDir's backing Set is module-level and only
   *  ever grows -- see fileWatcher.ts -- so uniqueness is what keeps tests
   *  from leaking into each other). */
  function untrackedDir(): string {
    return path.join(os.tmpdir(), `pxl-d5-test-${crypto.randomUUID()}`);
  }

  function fireSessionStartThenStop(sessionId: string, cwd: string): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd,
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: sessionId,
    });
  }

  it('drops a foreign session (unowned dir, watchAllSessions off): no agent created', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    // watchAllSessions defaults to false; this dir was never scanned/owned
    // by this instance -- exactly the "other server's session" scenario
    // fan-out introduces.
    fireSessionStartThenStop('d5-foreign-off', untrackedDir());
    expect(store.size).toBe(0);
  });

  it('adopts a foreign session when watchAllSessions is on', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    fireSessionStartThenStop('d5-foreign-on', untrackedDir());
    expect(store.size).toBe(1);
  });

  it('adopts a session under a project dir this instance has scanned, even with watchAllSessions off', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const dir = untrackedDir();
    runtime.startProjectScan(dir); // marks `dir` as owned/tracked
    fireSessionStartThenStop('d5-tracked-dir', dir);
    expect(store.size).toBe(1);
  });
});

describe('AgentRuntime -- Hermes hook-only lifecycle', () => {
  let runtime: AgentRuntime;

  afterEach(() => runtime?.dispose());

  it('adopts, animates, and removes one Hermes session', () => {
    const store = new AgentStateStore();
    const broadcasts: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => broadcasts.push(message));
    runtime = new AgentRuntime(store, hermesProvider);
    runtime.watchAllSessions.current = true;

    const session = 'telegram:chat-123';
    runtime.handleHookEvent('hermes', {
      hook_event_name: 'on_session_start',
      session_id: session,
      platform: 'telegram',
      cwd: '/workspace/hermes',
    });
    expect(store.size).toBe(0);

    runtime.handleHookEvent('hermes', {
      hook_event_name: 'pre_tool_call',
      session_id: session,
      tool_call_id: 'call-1',
      tool_name: 'read_file',
      args: { path: '/workspace/hermes/README.md' },
    });

    expect(store.size).toBe(1);
    expect(store.get(1)).toMatchObject({
      sessionId: session,
      hooksOnly: true,
      providerId: 'hermes',
      projectDir: '/workspace/hermes',
    });
    expect(broadcasts).toContainEqual({
      type: 'agentToolStart',
      id: 1,
      toolId: expect.stringMatching(/^hook-/),
      status: 'Reading README.md',
      toolName: 'read_file',
    });

    runtime.handleHookEvent('hermes', {
      hook_event_name: 'on_session_finalize',
      session_id: session,
    });
    expect(store.size).toBe(0);
  });

  it('ignores events sent to another provider route', () => {
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, hermesProvider);
    runtime.watchAllSessions.current = true;

    runtime.handleHookEvent('claude', {
      hook_event_name: 'on_session_start',
      session_id: 'telegram:wrong-route',
      cwd: '/workspace/hermes',
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'post_llm_call',
      session_id: 'telegram:wrong-route',
    });

    expect(store.size).toBe(0);
  });
});
