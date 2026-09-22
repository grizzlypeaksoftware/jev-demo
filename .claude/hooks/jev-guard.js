// Claude Code PreToolUse hook: run each side-effecting tool call through the
// Jev guard before it executes.
//
// The hook only ever tightens permissions, never loosens them:
//   allow          → no output, Claude Code's normal permission flow decides
//   confirm/review → "ask": you get a permission prompt with Jev's reasons
//   deny           → "deny": the call is blocked and Claude sees why
// If Jev is unreachable or anything else fails, the hook also stays silent,
// so the worst case is plain Claude Code behavior.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGuard } from "../../guard.js";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const LOG_FILE = join(projectDir, ".claude", "jev-guard.log");

// What code knows for certain about Claude Code's tools.
const TOOLS = {
  Bash: { sideEffects: "runs a shell command on the developer's machine" },
  Edit: { sideEffects: "edits a file in the project" },
  Write: { sideEffects: "creates or overwrites a file" },
  NotebookEdit: { sideEffects: "edits a Jupyter notebook cell" },
  WebFetch: { sideEffects: "fetches a URL; the URL itself can carry data off the machine" },
};

// Layer 1 for coding agents: things we can state exactly.
function codingRules({ tool, args }) {
  const cmd = args.command ?? "";
  const path = args.file_path ?? args.notebook_path ?? "";
  if (tool === "Bash") {
    if (/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/.test(cmd)) return { floor: "deny", reason: "deletes the root or home directory" };
    if (/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/.test(cmd)) return { floor: "deny", reason: "pipes a download straight into a shell" };
    if (/\bgit\s+push\b.*(--force|-f\b)|\bgit\s+reset\s+--hard\b/.test(cmd)) return { floor: "confirm", reason: "rewrites git history" };
    if (/\.env\b|credentials|\.ssh\//.test(cmd)) return { floor: "confirm", reason: "touches secrets" };
    if (/\brm\s+-[a-z]*r/.test(cmd)) return { floor: "confirm", reason: "recursive delete" };
  }
  if (/(^|\/)\.env$|\.claude\/(settings[^/]*\.json|hooks\/)/.test(path)) {
    return { floor: "confirm", reason: "edits secrets or the agent's own guardrails" };
  }
  return { floor: "allow", reason: null };
}

// What the user asked for most recently, and what the agent has read since.
function readTranscript(transcriptPath) {
  const entries = readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const text = (content) =>
    typeof content === "string" ? content : content.map((b) => b.text ?? text(b.content ?? "")).join("\n");
  const isPrompt = (e) =>
    e.type === "user" && !e.isMeta && !e.isSidechain && [e.message?.content].flat().some((b) => typeof b === "string" || b.type === "text");

  // Coding prompts are terse ("let's build both"), so send the last few for context.
  const prompts = entries.flatMap((e, i) => (isPrompt(e) ? [i] : [])).slice(-3);
  const lastPrompt = prompts.at(-1) ?? -1;
  const userRequest = prompts
    .map((i) => text(entries[i].message.content).replace(/<(system-reminder|ide_[a-z_]+)>[\s\S]*?<\/\1>/g, "").trim())
    .filter(Boolean)
    .map((p, i, all) => (i === all.length - 1 ? `Latest: ${p}` : `Earlier: ${p.slice(0, 600)}`))
    .join("\n\n");
  const contentRead = entries
    .slice(lastPrompt + 1)
    .flatMap((e) => (e.type === "user" && Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((b) => b.type === "tool_result")
    .map((b) => text(b.content ?? ""))
    .join("\n")
    .slice(-4000); // Jev does worse with large, mostly irrelevant state

  return { userRequest, contentRead };
}

// Keep Jev's state small: long file bodies become a size note plus a preview.
function summarize(input) {
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) =>
      typeof v === "string" && v.length > 1500 ? [k, `${v.slice(0, 1500)}… (${v.length} chars)`] : [k, v],
    ),
  );
}

function respond(decision, reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
    }),
  );
}

try {
  const event = JSON.parse(readFileSync(0, "utf8"));
  if (!TOOLS[event.tool_name]) process.exit(0);

  process.loadEnvFile(join(projectDir, ".env"));
  const guard = createGuard({ apiKey: process.env["JEV-KEY"], tools: TOOLS, rules: codingRules, requireMatch: false });
  const { userRequest, contentRead } = readTranscript(event.transcript_path);

  const result = await guard({
    userRequest,
    tool: event.tool_name,
    args: summarize(event.tool_input),
    contentRead: contentRead || "(none)",
  });

  appendFileSync(
    LOG_FILE,
    JSON.stringify({
      at: new Date().toISOString(),
      tool: event.tool_name,
      input: summarize(event.tool_input),
      verdict: result.verdict,
      reasons: result.reasons,
      jev: {
        recommendation: `${result.answers.recommendation.choice} ${result.answers.recommendation.confidence.toFixed(2)}`,
        match: +result.answers.matches_request.noul.toFixed(2),
        scope: +result.answers.exceeds_scope.noul.toFixed(2),
        injected: +result.answers.injected.noul.toFixed(2),
        risk: +result.answers.risk.score.toFixed(1),
      },
    }) + "\n",
  );

  const why = `JEV guard: ${result.verdict} (${result.reasons.join("; ") || "no reason given"})`;
  if (result.verdict === "deny") respond("deny", why);
  else if (result.verdict !== "allow") respond("ask", why);
} catch (err) {
  // Fail to Claude Code's normal permission flow, never to "allow".
  console.error(`jev-guard: ${err.message}`);
  process.exit(0);
}
