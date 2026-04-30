# LLM tool-calling event contracts: research notes

Context: in Aegis we subscribed to `Agent.subscribe()` from
`@mariozechner/pi-agent-core` and listened for `toolcall_end` to count tool
invocations. The handler never matched. The cause was a layer confusion - the
`toolcall_*` events live on the streaming proxy from `@mariozechner/pi-ai`,
while the `Agent` class re-emits them as `tool_execution_*`. This document
walks through the underlying contracts (Anthropic and OpenAI), the
two-layer pattern that almost every agent framework adopts, and the specific
shape used by pi-agent-core. The goal is to make the same mistake unlikely
in future integrations.

## 1. The Anthropic tool-use contract

### Declaring tools and reading results (non-streaming)

Tools are declared on the `tools` parameter of the Messages API request, as a
list of objects with `name`, `description`, and a JSON-Schema `input_schema`.
The model returns an `AssistantMessage` whose `content` array is a sequence of
typed blocks. Each tool invocation is a `tool_use` block with `id`, `name`,
and `input` (an object). The signal that the model has stopped to ask for
tool execution is `stop_reason: "tool_use"` on the message, alongside the
usual `end_turn`, `max_tokens`, and `stop_sequence` values.

To continue the turn you append a new user message whose content includes one
`tool_result` block per `tool_use`, keyed by `tool_use_id` and carrying either
text content or `is_error: true`. The model may then emit another `tool_use`
turn or `end_turn`. This is the classic agent loop, and Anthropic's docs
spell it out as "check `stop_reason`, execute, post `tool_result`, repeat".

References: [Tool use with Claude (overview)](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview),
[Handling stop reasons](https://docs.anthropic.com/en/api/handling-stop-reasons).

### Streaming differences

In streaming mode the response is an SSE stream with this top-level event
sequence: `message_start`, then per-block `content_block_start` /
`content_block_delta` / `content_block_stop`, then `message_delta` (which
carries the final `stop_reason`), then `message_stop`. `ping` events may
appear anywhere ([Streaming Messages](https://docs.anthropic.com/en/api/messages-streaming)).

For a `tool_use` block the deltas are not text - they are partial JSON
fragments for the `input` field. Each `content_block_delta` carries
`delta.type: "input_json_delta"` and a `delta.partial_json` string. You
accumulate those strings and parse exactly once you receive
`content_block_stop`. The final `tool_use.input` is always a complete object
even though the wire format is a string-by-string accumulator. Anthropic
warns that current models only emit one complete key/value at a time, so you
will see latency stalls between deltas while the model "thinks".

The crucial observation: streaming gives you fine-grained progress
(`partial_json` chunks), but the semantically meaningful unit is still the
finished `tool_use` block at `content_block_stop`. Most agent runtimes hide
the deltas and only surface the final block to user code - exactly the layer
distinction that bit us.

## 2. The OpenAI tool/function-calling contract

### Old vs new shape

The original (deprecated) shape used top-level `functions: [...]` on the
request and returned a single `function_call: { name, arguments }` field on
the assistant message. Arguments were a JSON string. This API supported
exactly one call per turn.

The current shape uses `tools: [{ type: "function", function: {...} }]` on
the request and returns an array `assistant.tool_calls: [{ id, type:
"function", function: { name, arguments } }]` on the response. `arguments`
is still a JSON string (you must `JSON.parse` it - this is a frequent
foot-gun). To feed back results, you append role-`tool` messages with
`tool_call_id` matching the call's `id` and `content` carrying the result.
Multiple tool calls per turn are supported in this shape; this is "parallel
tool calls" ([Function calling guide](https://developers.openai.com/api/docs/guides/function-calling),
[Functions vs Tools community thread](https://community.openai.com/t/what-is-deference-between-function-call-and-tool-call/686481)).

### `tool_choice`

`tool_choice` controls whether the model is allowed or required to call a
tool:

- `"auto"` - default; model decides. Multiple tools may be called in
  parallel.
- `"none"` - model must not call any tool, even if `tools` is set.
- `"required"` - the model must call at least one tool.
- `{ "type": "function", "function": { "name": "X" } }` - force a specific
  function. Note: the OpenAI community has documented that forcing a
  specific function in this way restricts the turn to that one call -
  parallel calls are effectively suppressed (see
  [community thread](https://community.openai.com/t/giving-a-value-to-tool-choice-no-longer-allows-functions-to-be-called-in-parallel/623433)).

Parallel tool calling is also gated by `parallel_tool_calls: true|false`.
Set it to `false` to guarantee at most one call per turn.

### Streaming

In Chat Completions streaming, each chunk has `choices[i].delta` rather than
`choices[i].message`. Tool calls arrive as `delta.tool_calls[]` entries with
an `index` (the position in the eventual `tool_calls` array). Only the first
chunk for an index carries `id`, `type`, and `function.name`; subsequent
chunks for the same index carry only `function.arguments` deltas, which you
concatenate as a string and parse at the end. The turn ends with a chunk
whose `finish_reason` is `"tool_calls"` (or `"stop"` if the model decided
not to call a tool, or `"length"` if it ran out of tokens).

The two cross-provider pitfalls are: (a) `arguments` is a string that
arrives in pieces and must be accumulated by `index`; (b) some providers,
particularly proxies and non-OpenAI models behind an OpenAI-compatible
gateway, terminate streams with `finish_reason: "length"` after only a
partial `arguments` payload, leaving the buffer un-parseable
([LiteLLM bug](https://github.com/google/adk-python/issues/4482)).

References: [Streaming responses guide](https://developers.openai.com/api/docs/guides/streaming-responses),
[Streaming events reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events),
[OpenAI cookbook on streaming](https://cookbook.openai.com/examples/how_to_stream_completions).

### The Responses API

OpenAI's newer Responses API and Agents SDK collapse some of this. Tool
calls and outputs are surfaced as typed "items" rather than raw chat
messages, and the streaming events are coarser (per-item rather than
per-token). That is exactly the same two-layer split discussed below, just
inside one product.

## 3. The two-layer pattern: streaming events vs agent-execution events

Every serious agent framework I have looked at draws the same line:

- Layer A - the LLM stream. Events describe what is arriving on the wire
  from the model: text deltas, tool-call argument deltas, finish reasons,
  the assembled assistant message at the end.
- Layer B - the agent loop. Events describe what the runtime is doing with
  that message: dispatching a tool to a handler, receiving its result,
  feeding the result back, starting the next turn.

These are different state machines. Layer A advances on bytes from the
provider. Layer B advances on whole turns. Layer A may emit a `tool_use` or
`tool_calls` block that Layer B then refuses to execute (denied by a hook,
unknown tool, schema validation failure, abort) - in that case Layer A says
"the model asked for tool X" but Layer B never says "tool X executed".

Concrete examples:

- Vercel AI SDK: the low-level `streamText` returns a stream of typed parts
  (`text-delta`, `tool-call`, `tool-result`, `finish`). The higher-level
  agent loop runs to completion and exposes `onStepFinish` (per turn) and
  `onFinish` (whole run). Client-side tool execution uses `onToolCall` plus
  `addToolOutput` ([Vercel AI SDK 5 blog](https://vercel.com/blog/ai-sdk-5),
  [Chatbot tool usage docs](https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-with-tool-calling)).
  Mixing layers means you either get raw deltas you have to assemble, or
  finished steps you cannot interrupt.

- LangChain callbacks: `on_llm_new_token` fires for each streamed token from
  the model. `on_tool_start` and `on_tool_end` fire when the agent
  executor invokes a registered tool. `on_agent_action` and
  `on_agent_finish` are above both ([Callbacks concept doc](https://python.langchain.com/docs/concepts/callbacks/)).
  Three layers, not two, because LangChain also distinguishes the agent
  reasoning layer from the tool-runtime layer.

- OpenAI Agents SDK: `RawResponseStreamEvent` exposes the underlying
  Responses-API stream verbatim. `RunItemStreamEvent` wraps fully-formed
  items - `MessageOutputItem`, `ToolCallItem`, `ToolCallOutputItem`,
  `HandoffCallItem`, etc. - with semantic names like `tool_called` and
  `tool_output` ([Streaming docs](https://openai.github.io/openai-agents-python/streaming/),
  [Items reference](https://openai.github.io/openai-agents-python/ref/items/)).
  The docs explicitly recommend `RunItemStreamEvent` "instead of each
  token".

- Pi Agent: see section 4. Same pattern.

Why the split exists. The streaming layer is a transport concern - parsing
SSE, accumulating partial JSON, handling provider-specific quirks. The
agent layer is a semantics concern - validating arguments, dispatching to
handlers, gating with `beforeToolCall` / `afterToolCall`, retrying, deciding
when to stop. They evolve at different rates. Providers churn on the wire
format constantly (Anthropic added `input_json_delta`, OpenAI rolled out
parallel tool calls, the Responses API is a partial rewrite). The agent loop
above stays mostly stable.

What each is good for:

- Streaming events: live token rendering, fine-grained progress UI for long
  tool-call arguments, abort decisions while the model is still typing.
- Agent events: counting tool invocations, audit trails, billing, top-level
  UI states ("thinking", "running tool X", "done"), conversation
  persistence.

If you are counting "did this turn invoke a tool", you want the agent layer.
If you are streaming a typing indicator, you want the LLM layer. Mixing
them up is the canonical bug, and we hit it.

## 4. The pi-agent-core design

Confirmed against
`/Users/hgg/work/dotnet-skills/aegis/node_modules/.pnpm/@mariozechner+pi-agent-core@0.70.5_*/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`
and the shipped `agent-loop.js`.

### Two distinct event types

`AgentEvent` (in `pi-agent-core/dist/types.d.ts`, lines 308-346):

```
agent_start
agent_end           { messages }
turn_start
turn_end            { message, toolResults }
message_start       { message }
message_update      { message, assistantMessageEvent }
message_end         { message }
tool_execution_start  { toolCallId, toolName, args }
tool_execution_update { toolCallId, toolName, args, partialResult }
tool_execution_end    { toolCallId, toolName, result, isError }
```

`AssistantMessageEvent` (in `pi-ai/dist/types.d.ts`, lines 182-235):

```
start | text_start | text_delta | text_end
      | thinking_start | thinking_delta | thinking_end
      | toolcall_start | toolcall_delta | toolcall_end
      | done | error
```

The pi-ai stream is an `AssistantMessageEventStream`
(`pi-ai/dist/utils/event-stream.d.ts`) - an `AsyncIterable` of those
events with a final `result()` Promise.

### How they connect

`agent-loop.js` (lines 166-208) iterates the pi-ai stream and re-emits
each `AssistantMessageEvent` as a single `message_update` agent event,
wrapping the inner event in `assistantMessageEvent`:

```
case "toolcall_start":
case "toolcall_delta":
case "toolcall_end":
    if (partialMessage) {
        partialMessage = event.partial;
        context.messages[...] = partialMessage;
        await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
        });
    }
    break;
```

So at the `Agent.subscribe()` level there is no top-level `toolcall_end`.
There is `message_update` whose `assistantMessageEvent.type` may be
`toolcall_end`. Aegis's listener was looking for the outer name and
silently never matched.

The actually-executed tool produces the separate
`tool_execution_start` / `tool_execution_update` / `tool_execution_end`
trio. These are emitted in `executeToolCalls` (called from the runLoop at
`agent-loop.js:115`) and represent the agent calling the registered
`AgentTool.execute()` and observing its result.

### Why both exist

The two layers represent different points in the agent loop:

- `toolcall_*` is the **streaming event from the LLM provider**: it fires
  during the LLM's response stream as the model emits its `tool_use` /
  `tool_calls` block. This is "the LLM is asking for a tool now."
- `tool_execution_*` is the **agent loop event**: it fires after the LLM
  turn finishes and the agent loop iterates the assistant message's
  `toolCall` content blocks to dispatch them. The `tool_execution_end`
  event carries the final `result` (an `AgentToolResult<T>`) and an
  `isError` flag.

Verified against `agent-loop.js:232-275`: `tool_execution_start` fires
unconditionally for every `toolCall` block in the assistant message,
**before** any `beforeToolCall`, validation, or dispatch logic. The
`beforeToolCall` hook can only affect what `result` and `isError` look
like in the corresponding `tool_execution_end`. So both layers count the
same number of tool calls; the difference is timing (during the LLM
stream vs after the agent loop dispatches) and the data attached to
each event (partial JSON arguments vs final result).

For "did the LLM actually call a tool" - either layer works. For "did
the tool succeed" - look at `tool_execution_end.isError`. For
"how many tools the LLM tried to call this turn" - `tool_execution_start`
is what we use in Aegis.

### Where the docs fall short

The TypeScript declarations have JSDoc on individual types but no
high-level "two layers" diagram. The `AgentEvent` JSDoc says only "events
emitted by the Agent for UI updates". The relationship between
`message_update.assistantMessageEvent` and the lower-level stream is not
spelled out. `AssistantMessageEvent` is documented in pi-ai's types but
that is a different package, and a consumer of `pi-agent-core` is unlikely
to read it. This is the doc gap that allowed the bug.

A pragmatic mitigation in our own code: when subscribing, define a
discriminator helper that maps the pair of `(event.type, event.assistantMessageEvent?.type)`
to a single string, and assert exhaustiveness.

## 5. Common mistakes in tool-calling event handling

### Listening on the wrong layer

The bug we hit. Variants seen in other codebases:

- Subscribing to OpenAI Agents SDK `RawResponseStreamEvent` to count tool
  calls. Easier and correct: `RunItemStreamEvent` with `name === "tool_called"`.
- Counting Vercel AI SDK `tool-call` parts on a `streamText` while the agent
  loop is also configured to auto-execute, then double-counting because the
  same call surfaces as a `tool-result` part too.
- Listening to LangChain `on_llm_new_token` and trying to detect tool
  invocations from the token stream rather than `on_tool_start`.

### Forgetting `arguments` is a string

OpenAI's `tool_calls[].function.arguments` is a JSON string. People assume
it is an object, blow up on `args.foo`, or lose precision when the model
emits a number that exceeds JS's safe integer range. The fix is
`JSON.parse(arguments)` and, for big numbers, `JSON.parse` with a reviver or
just typing them as strings in the schema.

### Streaming `arguments` accumulation bugs

Multiple flavours:

- O(n^2) reparsing. Each chunk arrives, library reparses the entire
  buffer. For a 12 KB tool argument this is 15 million characters of
  parsing work. Maintain incremental parser state instead
  ([aha.io article](https://www.aha.io/engineering/articles/streaming-ai-responses-incomplete-json)).
- Not keying by `index`. With parallel tool calls, OpenAI sends interleaved
  deltas across multiple `tool_calls[]` entries. Concatenating into a
  single string corrupts both arguments. Always accumulate per-`index`
  buffer.
- Not waiting for `content_block_stop` (Anthropic) or `finish_reason: "tool_calls"`
  (OpenAI) before parsing. Partial JSON is not parseable.
- Stream truncation. Some providers/proxies drop the tail of `arguments`
  when `finish_reason` is `"length"` or when SSE terminates early. The
  buffer is invalid JSON and the agent loop either crashes or silently
  passes `{}` to the tool. Documented across LiteLLM, vertex-gemini, and
  Claude 4.5 ([example issue](https://github.com/google/adk-python/issues/4482),
  [LiteLLM/Anthropic issue](https://github.com/BerriAI/litellm/issues/25561),
  [Continue discussion](https://github.com/continuedev/continue/discussions/8265)).
  Mitigation: detect `finish_reason: "length"` (or stop without a
  `content_block_stop`) and either retry, fail loudly, or treat the call as
  invalid - never call the tool with a guessed object.
- `partialJson` vs `arguments` field confusion. Some intermediate libraries
  expose the streaming buffer as `partialJson` until completion and only
  populate `arguments` at the end. Validators that read `arguments` early
  see `""` and either fail or call the tool with empty input
  ([pi-mono issue 3131](https://github.com/badlogic/pi-mono/issues/3131)).

### Fire-and-forget listeners

`Agent.subscribe()` in pi-agent-core awaits listener promises as part of
run settlement (the `agent_end` JSDoc states this explicitly). If you
subscribe with an `async` handler that does I/O without `await`-ing it,
the agent will think the run is complete while your side-effect is still
pending. Symmetric problem in LangChain (callback handlers awaited) and
OpenAI Agents (item handlers).

### Double-execution from "auto" + manual

Vercel AI SDK and OpenAI Agents both run tools automatically by default.
Adding a manual `onToolCall` handler that also calls the tool, or
short-circuiting the loop and feeding the same `tool_call_id` back as a
new `tool` message, leads to duplicates. Pick one execution site.

### Forgetting `tool_call_id` round-tripping

OpenAI requires the `tool_call_id` on the response message; Anthropic
requires `tool_use_id` on the `tool_result`. Mismatched ids cause the
provider to ignore your result and the model to re-issue the same call,
producing infinite loops. This is especially likely when you store
conversations and rebuild them with new ids.

### Mixing `tool_choice: "required"` with the expectation of follow-up text

Forcing a tool means the assistant message will not contain the natural
text reply you would normally show in the UI. If your UI listens for
text events to mark the turn as "complete", the spinner never stops.
Listen for the agent-layer "turn end" instead.

### Not de-duplicating `tool_execution_*` in parallel mode

In pi-agent-core's `"parallel"` mode (default), `tool_execution_end`
events are emitted in completion order, while the corresponding
`toolResult` message artifacts are emitted later in source order
(`types.d.ts` lines 19-21 and 170-176). If you also subscribe to
`message_*` to derive tool counts, you will see each tool result twice -
once via `tool_execution_end` and once via the trailing tool-result
message. Choose one. For Aegis the correct counter is
`tool_execution_end`.

## Concrete takeaways for future agent integrations

- Before writing a single line, read the framework's event-type union and
  ask "which layer am I on?". If the union has both `tool_call*` and
  `tool_execution*` (or equivalents), assume they are different things
  until proven otherwise.
- For "did a tool actually run" counters, use the agent-execution layer.
  For UI streaming, use the LLM layer.
- When parsing streamed tool arguments, always: key by index, wait for the
  end-of-block signal, treat truncation as failure rather than empty
  input.
- Round-trip `tool_call_id` / `tool_use_id` exactly. Persist them.
- Treat the agent run's "idle" state as awaitable. In pi-agent-core that's
  `Agent.waitForIdle()`. Never assume `agent_end` returning to
  synchronous code means listeners are done.
- If the framework's docs are thin (as with pi-agent-core's two-layer
  split), write a small comment in your own subscribe handler explaining
  which event you are listening to and why. Future-you, on the next bug,
  will thank present-you.

## Sources

- [Tool use with Claude (overview)](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview)
- [Define tools (Claude)](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)
- [Handling stop reasons](https://docs.anthropic.com/en/api/handling-stop-reasons)
- [Streaming Messages (Claude)](https://docs.anthropic.com/en/api/messages-streaming)
- [Function calling (OpenAI)](https://developers.openai.com/api/docs/guides/function-calling)
- [Using tools (OpenAI)](https://developers.openai.com/api/docs/guides/tools)
- [Streaming responses (OpenAI guide)](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Chat completions streaming events reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
- [OpenAI cookbook: how to stream completions](https://cookbook.openai.com/examples/how_to_stream_completions)
- [OpenAI community: forcing function calling via tool_choice required](https://community.openai.com/t/new-api-feature-forcing-function-calling-via-tool-choice-required/731488)
- [OpenAI community: tool_choice and parallel calls](https://community.openai.com/t/giving-a-value-to-tool-choice-no-longer-allows-functions-to-be-called-in-parallel/623433)
- [OpenAI Agents SDK - Streaming](https://openai.github.io/openai-agents-python/streaming/)
- [OpenAI Agents SDK - Items reference](https://openai.github.io/openai-agents-python/ref/items/)
- [Vercel AI SDK 5 blog](https://vercel.com/blog/ai-sdk-5)
- [Vercel AI SDK - Chatbot tool usage](https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-with-tool-calling)
- [LangChain callbacks concept](https://python.langchain.com/docs/concepts/callbacks/)
- [aha.io: streaming AI responses and the incomplete JSON problem](https://www.aha.io/engineering/articles/streaming-ai-responses-incomplete-json)
- [LiteLLM streaming truncation issue (google/adk-python#4482)](https://github.com/google/adk-python/issues/4482)
- [LiteLLM Anthropic-streaming bug (BerriAI/litellm#25561)](https://github.com/BerriAI/litellm/issues/25561)
- [Continue Claude 4.5 partial-args discussion](https://github.com/continuedev/continue/discussions/8265)
- [Anthropic claude-code premature stop bug (anthropics/claude-code#19143)](https://github.com/anthropics/claude-code/issues/19143)
- [pi-mono partialJson vs arguments issue (badlogic/pi-mono#3131)](https://github.com/badlogic/pi-mono/issues/3131)

## Local source references

- `/Users/hgg/work/dotnet-skills/aegis/node_modules/.pnpm/@mariozechner+pi-agent-core@0.70.5_@modelcontextprotocol+sdk@1.29.0_zod@3.25.76__ws@8.20.0_zod@3.25.76/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts` - `AgentEvent` union, lines 308-346
- `/Users/hgg/work/dotnet-skills/aegis/node_modules/.pnpm/@mariozechner+pi-agent-core@0.70.5_@modelcontextprotocol+sdk@1.29.0_zod@3.25.76__ws@8.20.0_zod@3.25.76/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` - bridge from pi-ai stream to agent events, lines 166-208
- `/Users/hgg/work/dotnet-skills/aegis/node_modules/.pnpm/@mariozechner+pi-ai@0.70.5_@modelcontextprotocol+sdk@1.29.0_zod@3.25.76__ws@8.20.0_zod@3.25.76/node_modules/@mariozechner/pi-ai/dist/types.d.ts` - `AssistantMessageEvent` union, lines 182-235
- `/Users/hgg/work/dotnet-skills/aegis/node_modules/.pnpm/@mariozechner+pi-ai@0.70.5_@modelcontextprotocol+sdk@1.29.0_zod@3.25.76__ws@8.20.0_zod@3.25.76/node_modules/@mariozechner/pi-ai/dist/utils/event-stream.d.ts` - `AssistantMessageEventStream`
