import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTRA_TOOLS, github_create_pr } from "../rex-tools.mjs";
import {
  CONFIRM_REQUIRED_TOOLS,
  parseTextToolCalls,
  prerequisiteError,
  registryToTools,
  runAgentLoop,
  truncateToolOutput,
  userAskedForTool,
} from "../agent-loop.mjs";

function toolMessage(id, name, args) {
  return {
    message: {
      content: null,
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args || {}) },
      }],
    },
  };
}

test("a tool result is fed back and used by the next tool", async () => {
  const seen = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "read the note you just made" }],
    tools: [{ type: "function", function: { name: "create_note", parameters: { type: "object", properties: {} } } }],
    confirmRequired: [],
    executeTool: async (name, args) => {
      seen.push({ name, args });
      if (name === "create_note") return { success: true, id: "note-7", text: "hello" };
      if (name === "read_note") return { success: true, id: args.id, text: "hello" };
      return { success: false, error: `unexpected ${name}` };
    },
    chat: async (messages) => {
      const toolMsgs = messages.filter((message) => message.role === "tool");
      if (toolMsgs.length === 0) return toolMessage("a", "create_note", {});
      if (toolMsgs.length === 1) {
        const created = JSON.parse(toolMsgs[0].content);
        return toolMessage("b", "read_note", { id: created.id });
      }
      const read = JSON.parse(toolMsgs[1].content);
      return { message: { content: `The note says ${read.text}` } };
    },
  });
  assert.equal(result.stopReason, "final");
  assert.equal(result.text, "The note says hello");
  assert.equal(seen[0].name, "create_note");
  assert.equal(seen[1].name, "read_note");
  assert.equal(seen[1].args.id, "note-7");
  assert.equal(result.trace.length, 2);
});

test("parallel tool calls in one reply all run", async () => {
  const seen = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "look up both" }],
    confirmRequired: [],
    executeTool: async (name) => {
      seen.push(name);
      return { success: true, name };
    },
    chat: async (messages) => {
      if (messages.some((message) => message.role === "tool")) {
        return { message: { content: "both done" } };
      }
      return {
        message: {
          content: null,
          tool_calls: [
            { id: "1", type: "function", function: { name: "alpha", arguments: "{}" } },
            { id: "2", type: "function", function: { name: "beta", arguments: "{}" } },
          ],
        },
      };
    },
  });
  assert.deepEqual(seen.sort(), ["alpha", "beta"]);
  assert.equal(result.steps, 1);
  assert.equal(result.text, "both done");
});

test("TOOL: text and tool_call tags run when the model has no native tool calls", async () => {
  const seen = [];
  const toolResult = await runAgentLoop({
    messages: [{ role: "user", content: "find lidar" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    confirmRequired: [],
    executeTool: async (name, args) => {
      seen.push({ name, args });
      return { success: true, hit: args.q };
    },
    chat: async (messages) => {
      const last = messages[messages.length - 1];
      if (last.role === "user" && String(last.content).includes("Tool results:")) {
        assert.match(last.content, /lidar-note/);
        return { message: { content: "Found the lidar note." } };
      }
      return { message: { content: 'TOOL:lookup:{"q":"lidar-note"}' } };
    },
  });
  assert.equal(toolResult.text, "Found the lidar note.");
  assert.equal(seen[0].args.q, "lidar-note");

  seen.length = 0;
  const tagResult = await runAgentLoop({
    messages: [{ role: "user", content: "find lidar" }],
    confirmRequired: [],
    nativeTools: false,
    executeTool: async (_name, args) => {
      seen.push(args.q);
      return { success: true, hit: args.q };
    },
    chat: async (messages) => {
      const last = messages[messages.length - 1];
      if (last.role === "user" && String(last.content).includes("Tool results:")) {
        return { message: { content: "tag done" } };
      }
      return { message: { content: '<tool_call>{"tool":"lookup","params":{"q":"from-tag"}}</tool_call>' } };
    },
  });
  assert.equal(tagResult.text, "tag done");
  assert.deepEqual(seen, ["from-tag"]);
});

test("a model that rejects tools falls back to text tool calls", async () => {
  let calls = 0;
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "find lidar" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    confirmRequired: [],
    executeTool: async () => ({ success: true, hit: "lidar" }),
    chat: async (_messages, tools) => {
      calls += 1;
      if (tools.length > 0) {
        const err = new Error("LLM 400: tools are not supported");
        err.status = 400;
        err.body = "tools are not supported by this model";
        throw err;
      }
      if (calls < 3) return { message: { content: 'TOOL:lookup:{"q":"lidar"}' } };
      return { message: { content: "answered without native tools" } };
    },
  });
  assert.equal(result.text, "answered without native tools");
  assert.equal(result.trace[0].tool, "lookup");
  assert.ok(calls >= 3);
});

test("the step cap stops a model that keeps calling tools", async () => {
  let chats = 0;
  let runs = 0;
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "keep going" }],
    maxSteps: 2,
    confirmRequired: [],
    executeTool: async () => {
      runs += 1;
      return { success: true, n: runs };
    },
    chat: async () => {
      chats += 1;
      return toolMessage(`c${chats}`, "ping", {});
    },
  });
  assert.equal(chats, 2);
  assert.equal(runs, 2);
  assert.equal(result.steps, 2);
  assert.equal(result.stopReason, "max_steps");
  assert.match(result.text, /tool step limit/);
});

test("a missing prerequisite is returned to the model so the next call can recover", async () => {
  const seen = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "post hello in discord" }],
    confirmRequired: [],
    executeTool: async (name, args) => {
      seen.push({ name, args });
      if (name === "discord_list_channels") return { success: true, channels: [{ id: "42", name: "general" }] };
      if (name === "discord_send_message") return { success: true, message: "sent" };
      return { success: false, error: name };
    },
    chat: async (messages) => {
      const toolMsgs = messages.filter((message) => message.role === "tool");
      if (toolMsgs.length === 0) return toolMessage("1", "discord_send_message", { message: "hello" });
      const last = JSON.parse(toolMsgs[toolMsgs.length - 1].content);
      if (last.missing === "channelId") return toolMessage("2", "discord_list_channels", {});
      if (last.channels) return toolMessage("3", "discord_send_message", { channelId: last.channels[0].id, message: "hello" });
      return { message: { content: "Posted hello." } };
    },
  });
  assert.equal(result.text, "Posted hello.");
  assert.equal(seen[0].name, "discord_list_channels");
  assert.equal(seen[1].name, "discord_send_message");
  assert.equal(seen[1].args.channelId, "42");
  assert.equal(result.trace[0].result.missing, "channelId");
  assert.match(result.trace[0].result.hint, /discord_list_channels/);
});

test("confirm-required tools do not run unless the latest message asks for them", async () => {
  const executed = [];
  const blocked = await runAgentLoop({
    messages: [{ role: "user", content: "list my open pull requests" }],
    executeTool: async (name) => {
      executed.push(name);
      return { success: true };
    },
    chat: async (messages) => {
      const last = messages[messages.length - 1];
      if (last.role === "tool") return { message: { content: "I will not merge that." } };
      return toolMessage("m", "github_merge_pr", { repo: "a/b", pr_number: 4, confirm: true });
    },
  });
  assert.deepEqual(executed, []);
  assert.equal(blocked.trace[0].result.confirmRequired, true);
  assert.equal(blocked.text, "I will not merge that.");

  const allowed = await runAgentLoop({
    messages: [{ role: "user", content: "please merge pull request 4 in a/b" }],
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { success: true, merged: true };
    },
    chat: async (messages) => {
      if (messages.some((message) => message.role === "tool")) return { message: { content: "Merged." } };
      return toolMessage("m2", "github_merge_pr", { repo: "a/b", pr_number: 4 });
    },
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, "github_merge_pr");
  assert.equal(executed[0].args.confirm, undefined);
  assert.equal(allowed.text, "Merged.");
});

test("huge tool output is truncated before it is sent back", async () => {
  let echoed = "";
  await runAgentLoop({
    messages: [{ role: "user", content: "read the log" }],
    maxOutputChars: 200,
    confirmRequired: [],
    executeTool: async () => ({ success: true, log: "x".repeat(500) }),
    chat: async (messages) => {
      const toolMsgs = messages.filter((message) => message.role === "tool");
      if (toolMsgs.length === 0) return toolMessage("t", "read_log", {});
      echoed = toolMsgs[0].content;
      return { message: { content: "short answer" } };
    },
  });
  assert.ok(echoed.length < 280);
  assert.match(echoed, /truncated/);
  assert.equal(truncateToolOutput("y".repeat(50), 200).length, 50);
});

test("a task plan passes an earlier file into the next step", async () => {
  const seen = [];
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "make a doc and upload it" }],
    confirmRequired: [],
    nativeTools: false,
    executeTool: async (name, args) => {
      seen.push({ name, args });
      if (name === "create_pdf") return { success: true, file: "doc_1.md" };
      if (name === "upload_to_drive") return { success: true, file: args.filename };
      return { success: false, error: name };
    },
    chat: async (messages) => {
      const last = messages[messages.length - 1];
      if (last.role === "user" && String(last.content).includes("Tool results:")) {
        return { message: { content: "Uploaded." } };
      }
      return {
        message: {
          content: '<task_plan>[{"step":1,"tool":"create_pdf","params":{"title":"Notes"},"description":"Write"},{"step":2,"tool":"upload_to_drive","params":{"filename":"{{step1.file}}"},"description":"Upload"}]</task_plan>',
        },
      };
    },
  });
  assert.equal(seen[1].args.filename, "doc_1.md");
  assert.equal(result.text, "Uploaded.");
  assert.equal(result.trace[1].via, "task_plan");
});

test("prerequisite errors name the missing field", () => {
  assert.equal(prerequisiteError("discord_send_message", {}).missing, "channelId");
  assert.equal(prerequisiteError("stripe_create_invoice", {}).missing, "customer_id");
  assert.equal(prerequisiteError("github_create_pr", { repo: "a/b", title: "Fix" }).missing, "head");
  assert.equal(prerequisiteError("github_create_pr", { head: "feature" }), null);
  assert.equal(prerequisiteError("upload_to_drive", {}).missing, "filename");
  assert.equal(prerequisiteError("execute_skill", {}).missing, "skill_id");
  assert.equal(userAskedForTool("send_slack", [{ role: "user", content: "list files" }]), false);
  assert.equal(userAskedForTool("send_slack", [{ role: "user", content: "send this to slack" }]), true);
});

test("github_create_pr refuses to call GitHub without a branch", async () => {
  const result = await github_create_pr("owner/repo", "Fix bug", "");
  assert.equal(result.success, false);
  assert.equal(result.missing, "head");
  assert.match(result.hint, /branch/);
});

test("text parser reads TOOL lines, tool_call tags, and task plans", () => {
  const parsed = parseTextToolCalls('TOOL:lookup:{"q":"a"}\n<tool_call>{"tool":"other","params":{"n":1}}</tool_call>\n<task_plan>[{"step":1,"tool":"create_pdf","params":{}}]</task_plan>');
  assert.equal(parsed.calls[0].name, "other");
  assert.equal(parsed.calls[1].name, "lookup");
  assert.equal(parsed.calls[1].args.q, "a");
  assert.equal(parsed.plan[0].tool, "create_pdf");
});

test("the tool schema list includes the seven execution tools", () => {
  for (const name of ["elevenlabs_tts", "create_pdf", "run_python", "web_scrape", "create_csv", "create_html", "send_slack"]) {
    assert.ok(EXTRA_TOOLS[name], name);
  }
  const schemas = registryToTools(EXTRA_TOOLS);
  const names = schemas.map((tool) => tool.function.name);
  assert.ok(names.includes("create_pdf"));
  assert.ok(names.includes("web_scrape"));
  const send = schemas.find((tool) => tool.function.name === "send_slack");
  assert.equal(send.function.parameters.properties.channel.type, "string");
  assert.ok(CONFIRM_REQUIRED_TOOLS.includes("send_slack"));
  assert.ok(CONFIRM_REQUIRED_TOOLS.includes("github_merge_pr"));
  assert.ok(CONFIRM_REQUIRED_TOOLS.includes("do_restart_app"));
});
