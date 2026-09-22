// Support inbox triage with Jev (TypeSafe's System One model).
//
// For each message in ./inbox, one Jev call answers four typed questions in
// parallel. Plain code then decides what to do with the answers — Jev makes
// the narrow judgments, the script stays in control of the routing.
//
// Run: npm run triage

import { readdir, readFile, writeFile } from "node:fs/promises";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const INBOX_DIR = new URL("./inbox/", import.meta.url);
const RESULTS_FILE = new URL("./triage-results.json", import.meta.url);

// Below this confidence we don't trust the department pick and send it to a human.
const MIN_ROUTING_CONFIDENCE = 0.6;

const apiKey = process.env["JEV-KEY"];
if (!apiKey) {
  console.error("Missing JEV-KEY. Put it in .env and run with `npm run triage`.");
  process.exit(1);
}

const client = new TypeSafeClient({ apiKey });

const questions = {
  department: choice("Which team should handle this message?", {
    billing: "Payments, charges, refunds, invoices, subscriptions",
    technical: "Bugs, errors, outages, integrations not working",
    sales: "Pricing, plans, upgrades, new or expanded accounts",
    feedback: "Praise, suggestions or general comments needing no action",
  }),
  frustration: score("How frustrated does the customer appear?", [
    "Calm or positive",
    "Mildly annoyed",
    "Frustrated but civil",
    "Very angry, threatening to leave or escalate",
  ]),
  is_urgent: noul("The message conveys urgency or time-sensitivity"),
  churn_risk: noul("The customer is threatening to cancel, leave, or dispute a charge"),
};

function route(answers) {
  const { department, frustration, is_urgent, churn_risk } = answers;

  if (department.confidence < MIN_ROUTING_CONFIDENCE) {
    return { queue: "human-review", reason: `unsure of department (confidence ${department.confidence.toFixed(2)})` };
  }
  if (churn_risk.noul >= 0.7) {
    return { queue: `${department.choice}-escalation`, reason: "churn risk" };
  }
  if (is_urgent.noul >= 0.7 || frustration.score >= 2) {
    return { queue: `${department.choice}-priority`, reason: "urgent or frustrated" };
  }
  if (department.choice === "feedback") {
    return { queue: "feedback-log", reason: "no action needed" };
  }
  return { queue: department.choice, reason: "standard" };
}

const files = (await readdir(INBOX_DIR)).filter((f) => f.endsWith(".txt")).sort();
if (files.length === 0) {
  console.log("Inbox is empty.");
  process.exit(0);
}

const results = await Promise.all(
  files.map(async (file) => {
    const message = (await readFile(new URL(file, INBOX_DIR), "utf8")).trim();
    const response = await client.systemOne({ state: { message }, questions });
    return { file, ...route(response.answers), answers: response.answers, usage: response.usage };
  }),
);

console.table(
  results.map((r) => ({
    file: r.file,
    queue: r.queue,
    reason: r.reason,
    dept: `${r.answers.department.choice} (${r.answers.department.confidence.toFixed(2)})`,
    frustration: r.answers.frustration.score,
    urgent: r.answers.is_urgent.noul.toFixed(2),
    churn: r.answers.churn_risk.noul.toFixed(2),
  })),
);

await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2) + "\n");
console.log(`Full answers written to triage-results.json`);
