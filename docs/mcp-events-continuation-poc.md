# MCP Events continuation PoC

Date: 2026-09-30

> 2026-09-30 后续实现：参见 [监工实施方案](mcp-events/supervisor-plan.md) 与 [验收矩阵](mcp-events/test-plan.md)。
> 下文是最初16c8e60的PoC快照：JSON存储、CLI-only发射与95tests已被后续SQLite/outbox、明确跨会话工具及148tests取代；真实OpenAI续轮仍必须单独验收。

## Goal

Explore MCP Events as a generic durable continuation mechanism for ChatGPT chats,
not merely as a completion signal for a long-running local process.

OpenAI's MCP Events documentation says ChatGPT supplies the callback URL and
signing secret when it subscribes, the MCP server later delivers matching
events, and ChatGPT receives the event in the subscribed chat and follows the
user's saved instructions:

- https://developers.openai.com/plugins/build/mcp-events

That means the durable association to the chat lives on the ChatGPT side. The
local MCP server does not need a ChatGPT chat ID and an event does not need to
be tied to one particular process.

## PoC surface

The PoC declares one intentionally generic semantic event:

workflow.continue

Subscription filter:

- topic: stable local workflow/topic key, for example
  light-alchemy:item-expansion or research:collatz.

Event data:

- topic
- trigger_reason
- optional summary
- optional state_ref
- optional source
- optional sequence

The event payload is data only. The instruction for what ChatGPT should do is
captured when the user asks ChatGPT to subscribe.

This lets many different local producers use the same continuation mechanism:

- a process or Codex run completing;
- a test/build/deployment reaching a terminal state;
- a research checkpoint becoming ready;
- a Git/Gitea state change;
- a coarse timer or local supervisor deciding that the chat should resume;
- an explicit local workflow signal that is not associated with any process.

## Protocol implementation

The existing modern MCP endpoint already serves protocol 2026-07-28. When
events are explicitly enabled, the PoC adds:

- events: {} to the raw server/discover capabilities;
- events/list;
- events/subscribe;
- events/unsubscribe.

The PoC also updates @modelcontextprotocol/client and
@modelcontextprotocol/server from 2.0.0 to 2.2.0 and passes the existing full
test suite on that release.

Subscriptions are stored durably in a mode-0600 JSON file. IDs are derived
deterministically from the owner, callback URL, event name, and canonicalized
arguments, so refreshes are idempotent.

Webhook handling implements:

- HTTPS-only callback URLs;
- DNS resolution and public-address validation;
- connection pinning to the validated address while preserving TLS SNI;
- no redirect handling;
- Standard Webhooks signatures;
- callback verification challenge;
- 256 KiB event payload limit;
- bounded retry for transient delivery failures;
- non-replayable events with cursor: null;
- finite subscriptions or ttlMs: null.

The implementation remains opt-in via:

CHATGPT_WEB_AGENT_EVENTS_ENABLED=true

No production service has been switched in this PoC.

## Local emitter

The event is deliberately not exposed as a normal MCP tool. Local workflows
emit it through the chatgpt-web-agent-event CLI with a topic, reason, optional
summary/state reference, and source.

Keeping emission outside the MCP tool catalog reduces accidental model-created
feedback loops. A model with authorized shell access can still invoke the CLI
when that is deliberately part of a workflow.

## What this enables

The target lifecycle is:

1. In a chat, the user asks ChatGPT to continue a workflow whenever a named
   workflow.continue topic fires, and specifies what to do on each event.
2. ChatGPT creates the subscription and gives WebAgentTools a callback URL.
3. The current model turn can finish normally.
4. Any authorized local producer emits the topic later.
5. WebAgentTools posts the signed event to the stored callback.
6. ChatGPT starts a new asynchronous run in the subscribed chat and can inspect
   durable local state with normal tools before continuing.

The model inference itself is not suspended between steps 3 and 6.

## Loop guard

Generic continuation makes deliberate multi-run loops possible, but the saved
prompt must not blindly cause the same event to be emitted again. For any
automated continuation loop, keep durable workflow state and include an
explicit stop condition such as:

- completion state;
- deadline;
- maximum hop/sequence count;
- cooldown;
- user-decision boundary.

OpenAI also recommends checking for feedback loops when the action taken by an
event-triggered run can itself produce another matching event.

## Verification

The PoC tests:

- event catalog and topic filtering;
- idempotent persistent subscriptions;
- Standard Webhooks signatures;
- raw server/discover advertising events: {};
- events/list over the real modern MCP HTTP path;
- events/subscribe plus callback verification over the MCP HTTP path;
- events/unsubscribe over the MCP HTTP path;
- existing legacy and modern tool behavior unchanged.

Current result:

15 test files, 95 tests passed.

## Remaining end-to-end step

OpenAI's docs require the plugin to be rescanned when tools or events change.
After enabling the event surface in the production WebAgentTools service:

1. Rescan the MCP server on the WebAgentTools plugin page.
2. Confirm workflow.continue appears alongside the tools.
3. In a fresh normal chat, ask ChatGPT to subscribe to a unique PoC topic.
4. Confirm the server receives events/subscribe and callback verification.
5. End the chat turn.
6. Emit the PoC topic locally.
7. Verify the same subscribed chat receives a new run and follows its saved
   instruction.

That final ChatGPT callback test is intentionally not claimed by the local
unit/integration suite.
