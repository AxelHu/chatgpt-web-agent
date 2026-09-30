import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BridgeFactory, LocalChatBridge, JsonObject } from './local-chat-continuation.js';

export function submissionFromJournal(data: unknown, threadId: string, matchKey: string, requestId: string): JsonObject | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_bridge_journal');
  const body = data as JsonObject;
  if (body.version !== 1 || !Array.isArray(body.operations)) throw new Error('invalid_bridge_journal');
  const rows = body.operations.filter((r: unknown): r is JsonObject => !!r && typeof r === 'object' && !Array.isArray(r))
    .filter(r => r.kind === 'send' && r.thread_id === threadId && r.match_key === matchKey &&
      r.mcp_request_id === requestId && typeof r.message_id === 'string' && typeof r.operation_id === 'string');
  // Journal expiration is not evidence that a submission failed. A retained
  // exact ID can still be independently verified in the correct cloud Chat.
  if (!rows.length || new Set(rows.map(r => r.message_id)).size !== 1) return;
  const row = rows[rows.length - 1]!;
  return { message_id: row.message_id, thread_id: threadId, operation_id: row.operation_id,
    operation_outcome: row.outcome };
}

/** Load only the operator-selected installed high-level Desktop bridge. No raw
 * ChatGPT API/authentication, Work task or model coordinator is introduced. */
export function installedDesktopBridge(root: string, stateDirectory: string): BridgeFactory {
  if (!path.isAbsolute(root)) throw new Error('desktop_bridge_root_must_be_absolute');
  const operations = path.join(stateDirectory, 'desktop-operations');
  fs.mkdirSync(operations, { recursive: true, mode: 0o700 });
  return async (eventKey: string) => {
    if (!/^[a-f0-9]{64}$/.test(eventKey)) throw new Error('invalid_event_key');
    const module = await import(pathToFileURL(path.join(root, 'dist/bridge.js')).href);
    const configModule = await import(pathToFileURL(path.join(root, 'dist/config.js')).href);
    const journalModule = await import(pathToFileURL(path.join(root, 'dist/operation-journal.js')).href);
    const journalPath = path.join(operations, `${eventKey}.json`);
    const bridge: LocalChatBridge = new module.ChatGptDesktopBridge({
      ...configModule.loadConfig(),
      // One operation journal per logical event avoids cross-process overwrites
      // of the bridge's JSON journal and leaves its existing MCP journal alone.
      operationJournalPath: journalPath,
    });
    if (typeof bridge.get !== 'function' || typeof bridge.send !== 'function')
      throw new Error('installed_bridge_contract_unavailable');
    return {
      get: bridge.get.bind(bridge), send: bridge.send.bind(bridge),
      markResponseDelivered: bridge.markResponseDelivered?.bind(bridge),
      async submissionEvidence(threadId, prompt, model, thinking, requestId) {
        let text: string;
        try { text = fs.readFileSync(journalPath, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        const hash = journalModule.operationHash({ kind: 'send', thread_id: threadId, prompt, model, thinking });
        return submissionFromJournal(JSON.parse(text), threadId, hash, requestId);
      },
    };
  };
}
