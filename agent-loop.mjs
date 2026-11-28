// Shared multi-step tool loop for OpenAI-compatible chat completions.
// Native tool_calls are preferred. TOOL: lines, <tool_call>, and <task_plan>
// still run when a model only returns text.

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_CHARS = 8000;

export const CONFIRM_REQUIRED_TOOLS = [
  "github_merge_pr",
  "do_restart_app",
  "send_email",
  "send_slack",
  "discord_send_message",
  "stripe_create_invoice",
];

const CONFIRM_PATTERNS = {
  github_merge_pr: /\bmerge\b/i,
  do_restart_app: /\b(restart|redeploy)\b/i,
  send_email: /\b(e-?mail|mail)\b/i,
  send_slack: /\bslack\b/i,
  discord_send_message: /\bdiscord\b/i,
  stripe_create_invoice: /\b(stripe|invoice)\b/i,
};

const ARRAY_PARAMS = new Set(["headers", "rows", "sections", "sheets", "items", "permissions"]);
const OBJECT_PARAMS = new Set(["fields"]);
const BOOLEAN_PARAMS = new Set(["private", "auto_register", "auto_load", "loaded_only"]);
const NUMBER_PARAMS = new Set(["width", "height", "numResults", "maxResults", "limit", "pr_number"]);

function clamp(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function jsonType(name) {
  if (ARRAY_PARAMS.has(name)) return "array";
  if (OBJECT_PARAMS.has(name)) return "object";
  if (BOOLEAN_PARAMS.has(name)) return "boolean";
  if (NUMBER_PARAMS.has(name)) return "number";
  return "string";
}

export function registryToTools(registry) {
  return Object.entries(registry || {}).map(([name, info]) => {
    const properties = {};
    const required = [];
    for (const raw of info?.params || []) {
      const optional = String(raw).endsWith("?");
      const key = String(raw).replace(/\?$/, "");
      if (!key) continue;
      properties[key] = { type: jsonType(key), description: key };
      if (!optional) required.push(key);
    }
    const parameters = { type: "object", properties };
    if (required.length > 0) parameters.required = required;
    return {
      type: "function",
      function: {
        name,
        description: info?.description || name,
        parameters,
      },
    };
  });
}

export function prepareArgs(name, args) {
  const clean = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
  delete clean.confirm;
  delete clean._positional;
  if (name === "github_create_pr" && !clean.head && clean.branch) clean.head = clean.branch;
  return clean;
}

export function prerequisiteError(name, args) {
  const params = args || {};
  if (name === "discord_send_message" && !params.channelId) {
    return {
      success: false,
      error: "channelId is required.",
      missing: "channelId",
      hint: "call discord_list_channels first",
    };
  }
  if (name === "stripe_create_invoice" && !params.customer_id) {
    return {
      success: false,
      error: "customer_id is required.",
      missing: "customer_id",
      hint: "call stripe_list_customers first",
    };
  }
  if (name === "github_create_pr" && !params.head) {
    return {
      success: false,
      error: "A branch is required to open a pull request.",
      missing: "head",
      hint: "Push a branch first, then call github_create_pr with head set to that branch name.",
    };
  }
  if (name === "upload_to_drive" && !params.filename) {
    return {
      success: false,
      error: "filename is required.",
      missing: "filename",
      hint: "Create the file first, then call upload_to_drive with that filename.",
    };
  }
  if (name === "execute_skill" && !params.skill_id && !params.name) {
    return {
      success: false,
      error: "skill_id is required.",
      missing: "skill_id",
      hint: "call load_skill first",
    };
  }
  return null;
}

export function latestUserText(messages) {
  const users = (messages || []).filter((message) => message && message.role === "user" && typeof message.content === "string");
  return users.length ? users[users.length - 1].content : "";
}

export function userAskedForTool(name, messages) {
  const pattern = CONFIRM_PATTERNS[name];
  if (!pattern) return true;
  return pattern.test(latestUserText(messages));
}

export function truncateToolOutput(value, maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const limit = clamp(maxChars, DEFAULT_MAX_OUTPUT_CHARS, 200, 100000);
  let text;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} characters]`;
}

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch { return { input: raw }; }
}

function parseToolLine(rest) {
  const colon = rest.indexOf(":");
  if (colon === -1) {
    const name = rest.trim();
    return name ? { name, args: {} } : null;
  }
  const name = rest.slice(0, colon).trim();
  if (!name) return null;
  const rawArgs = rest.slice(colon + 1).trim();
  if (!rawArgs) return { name, args: {} };
  if (rawArgs.startsWith("{") || rawArgs.startsWith("[")) {
    return { name, args: parseArguments(rawArgs) };
  }
  return { name, args: { _positional: rawArgs.split(":").map((part) => part.trim()) } };
}

export function parseTextToolCalls(text) {
  const calls = [];
  let plan = null;
  if (typeof text !== "string" || !text.trim()) return { calls, plan };
  const toolCallRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  while ((match = toolCallRe.exec(text))) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const name = parsed && (parsed.tool || parsed.name);
      if (!name) continue;
      calls.push({ name, args: parsed.params || parsed.arguments || {} });
    } catch { /* skip a malformed block */ }
  }
  const planMatch = text.match(/<task_plan>([\s\S]*?)<\/task_plan>/);
  if (planMatch) {
    try {
      const parsed = JSON.parse(planMatch[1].trim());
      if (Array.isArray(parsed)) plan = parsed;
    } catch { /* skip a malformed plan */ }
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TOOL:")) continue;
    const parsed = parseToolLine(trimmed.slice(5));
    if (parsed) calls.push(parsed);
  }
  return { calls, plan };
}

function normalizeNativeCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call, index) => {
    const fn = call && call.function ? call.function : {};
    const name = fn.name || call.name || "";
    const rawArgs = fn.arguments !== undefined ? fn.arguments : call.arguments;
    return {
      id: (call && call.id) || `call_${index}_${name || "tool"}`,
      type: "function",
      function: {
        name,
        arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs || {}),
      },
    };
  }).filter((call) => call.function.name);
}

function resolvePlanParams(params, prior) {
  let raw = JSON.stringify(params || {});
  for (const [key, value] of Object.entries(prior)) {
    if (!value || typeof value !== "object") continue;
    if (value.file) raw = raw.split(`{{${key}.file}}`).join(String(value.file));
    if (value.output !== undefined && value.output !== null) {
      raw = raw.split(`{{${key}.output}}`).join(String(value.output));
    }
  }
  try { return JSON.parse(raw); }
  catch { return params || {}; }
}

function addUsage(total, usage) {
  if (!usage) return;
  total.prompt_tokens += usage.prompt_tokens || 0;
  total.completion_tokens += usage.completion_tokens || 0;
}

function isToolsUnsupported(err) {
  const status = err && err.status;
  if (status && status !== 400 && status !== 422) return false;
  const text = `${err && err.message ? err.message : ""} ${err && err.body ? err.body : ""}`.toLowerCase();
  return /tool|function.?call|unsupported/.test(text);
}

function formatToolFeedback(items, maxChars) {
  const lines = ["Tool results:"];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.name}: ${truncateToolOutput(item.result, maxChars)}`);
  });
  lines.push("");
  lines.push("Use these results. Call another tool if you still need one, or answer the user.");
  return lines.join("\n");
}

function limitText(stopReason, trace, maxChars) {
  const why = stopReason === "timeout"
    ? "I stopped because this took too long."
    : "I stopped after the tool step limit.";
  const last = trace[trace.length - 1];
  if (!last) return why;
  return `${why}\n\nLast tool (${last.tool}): ${truncateToolOutput(last.result, Math.min(maxChars, 2000))}`;
}

export async function runAgentLoop(options = {}) {
  if (typeof options.chat !== "function") throw new Error("runAgentLoop requires a chat function.");
  const messages = Array.isArray(options.messages) ? options.messages.map((message) => ({ ...message })) : [];
  const originalMessages = messages.map((message) => ({ ...message }));
  const tools = Array.isArray(options.tools) ? options.tools : [];
  const executeTool = options.executeTool;
  const maxSteps = clamp(options.maxSteps, DEFAULT_MAX_STEPS, 1, 32);
  const deadline = Date.now() + clamp(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 600000);
  const maxOutputChars = clamp(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 200, 100000);
  const confirmRequired = new Set(Array.isArray(options.confirmRequired) ? options.confirmRequired : CONFIRM_REQUIRED_TOOLS);
  const userConfirmed = options.userConfirmed;
  const trace = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let steps = 0;
  let nativeTools = tools.length > 0 && options.nativeTools !== false;
  let stopReason = "final";

  const toolAllowed = (name) => {
    if (userConfirmed === true) return true;
    if (userConfirmed === false) return false;
    return userAskedForTool(name, originalMessages);
  };

  const expandArgs = (name, args) => {
    const source = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
    if (Array.isArray(source._positional)) {
      const positional = source._positional;
      delete source._positional;
      const bound = typeof options.bindArgs === "function" ? options.bindArgs(name, positional) : {};
      return prepareArgs(name, { ...bound, ...source });
    }
    return prepareArgs(name, source);
  };

  const invokeOne = async (name, rawArgs) => {
    const args = expandArgs(name, rawArgs);
    const missing = prerequisiteError(name, args);
    if (missing) return { name, args, result: missing };
    if (confirmRequired.has(name) && !toolAllowed(name)) {
      return {
        name,
        args,
        result: {
          success: false,
          error: `${name} needs confirmation and was not run.`,
          confirmRequired: true,
          hint: "This action only runs when the latest user message asks for it. Tell the user what will happen and wait for a message that names the send, merge, restart, or invoice.",
        },
      };
    }
    if (typeof executeTool !== "function") {
      return { name, args, result: { success: false, error: `No executor for ${name}.` } };
    }
    try {
      const result = await executeTool(name, args);
      return { name, args, result: result === undefined ? { success: false, error: "Tool returned no result." } : result };
    } catch (err) {
      return { name, args, result: { success: false, error: err.message || String(err) } };
    }
  };

  const record = (outcome, extra) => {
    trace.push({ step: steps, tool: outcome.name, args: outcome.args, result: outcome.result, ...extra });
  };

  try {
    while (steps < maxSteps && Date.now() <= deadline) {
      let response;
      try {
        response = await options.chat(messages, nativeTools ? tools : [], { nativeTools });
      } catch (err) {
        if (nativeTools && isToolsUnsupported(err)) {
          nativeTools = false;
          continue;
        }
        throw err;
      }
      addUsage(usage, response && response.usage);
      const message = response && response.message ? response.message : {};
      const nativeCalls = normalizeNativeCalls(message.tool_calls);
      if (nativeCalls.length > 0) {
        steps += 1;
        messages.push({
          role: "assistant",
          content: message.content ?? null,
          tool_calls: nativeCalls,
        });
        const outcomes = await Promise.all(nativeCalls.map((call) => invokeOne(call.function.name, parseArguments(call.function.arguments))));
        outcomes.forEach((outcome, index) => {
          record(outcome, { via: "native" });
          messages.push({
            role: "tool",
            tool_call_id: nativeCalls[index].id,
            content: truncateToolOutput(outcome.result, maxOutputChars),
          });
        });
        continue;
      }

      const content = typeof message.content === "string" ? message.content : "";
      const parsed = parseTextToolCalls(content);
      const hasPlan = Array.isArray(parsed.plan) && parsed.plan.length > 0;
      if (parsed.calls.length === 0 && !hasPlan) {
        return { text: content, trace, steps, stopReason: "final", usage };
      }

      messages.push({ role: "assistant", content });
      const feedback = [];
      if (hasPlan) {
        const prior = {};
        for (let i = 0; i < parsed.plan.length; i++) {
          if (steps >= maxSteps || Date.now() > deadline) {
            stopReason = Date.now() > deadline ? "timeout" : "max_steps";
            break;
          }
          const step = parsed.plan[i] || {};
          const stepNum = step.step || i + 1;
          steps += 1;
          const outcome = await invokeOne(step.tool, resolvePlanParams(step.params || {}, prior));
          prior[`step${stepNum}`] = outcome.result;
          record(outcome, { via: "task_plan", planStep: stepNum, description: step.description || "" });
          feedback.push(outcome);
          if (outcome.result && outcome.result.success === false) break;
        }
      }
      if (parsed.calls.length > 0 && steps < maxSteps && Date.now() <= deadline) {
        steps += 1;
        const outcomes = await Promise.all(parsed.calls.map((call) => invokeOne(call.name, call.args)));
        outcomes.forEach((outcome) => {
          record(outcome, { via: "text" });
          feedback.push(outcome);
        });
      }
      if (feedback.length > 0) {
        messages.push({ role: "user", content: formatToolFeedback(feedback, maxOutputChars) });
      }
    }
  } catch (err) {
    err.trace = trace;
    throw err;
  }

  if (Date.now() > deadline) stopReason = "timeout";
  else if (stopReason === "final") stopReason = "max_steps";
  return { text: limitText(stopReason, trace, maxOutputChars), trace, steps, stopReason, usage };
}
