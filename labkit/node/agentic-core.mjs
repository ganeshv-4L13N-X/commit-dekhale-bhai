// Shared lab infrastructure - NOT an agent framework.
// Plumbing only: gateway client, tracing, cost, budget ceiling.
// The agent loop is Lab 1.1. Writing it is the point.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadDotenv() {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      for (const line of fs.readFileSync(candidate, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const idx = trimmed.indexOf("=");
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return;
    }
    dir = path.dirname(dir);
  }
}

export class Config {
  constructor() {
    loadDotenv();
    this.baseUrl = (process.env.ANTHROPIC_BASE_URL || "").replace(/\/$/, "");
    this.apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
    this.model = process.env.LAB_MODEL || "claude-sonnet";
    this.maxSteps = Number(process.env.LAB_MAX_STEPS || 8);
    this.budgetUsd = Number(process.env.LAB_BUDGET_USD || 0.5);
  }
  require() {
    const missing = [];
    if (!this.baseUrl) missing.push("ANTHROPIC_BASE_URL");
    if (!this.apiKey) missing.push("ANTHROPIC_AUTH_TOKEN");
    if (missing.length) {
      throw new Error(`Missing: ${missing.join(", ")}\n` +
        "Copy .env.example to .env and paste the gateway URL and your key. See setup/05-verify.md.");
    }
    return this;
  }
}

export class GatewayError extends Error {
  constructor(status, body) {
    super(`gateway returned ${status}: ${String(body).slice(0, 400)}`);
    this.status = status;
  }
}

export class GatewayClient {
  constructor(config) { this.cfg = (config || new Config()).require(); }

  async messages({ messages, tools, system, maxTokens = 1024, model, retries = 3 }) {
    const payload = { model: model || this.cfg.model, max_tokens: maxTokens, messages };
    if (tools) payload.tools = tools;
    if (system) payload.system = system;

    let last;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(180000),
        });
        if (response.ok) return await response.json();
        const body = await response.text();
        // 429 = your daily budget or rate limit at the gateway.
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
          last = new GatewayError(response.status, body);
          continue;
        }
        throw new GatewayError(response.status, body);
      } catch (err) {
        if (err instanceof GatewayError) throw err;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
          last = err;
          continue;
        }
        throw err;
      }
    }
    throw last;
  }
}

export class Tracer {
  constructor(name, root) {
    this.runId = `${name}-${Math.random().toString(16).slice(2, 10)}`;
    let base = root;
    if (!base) {
      let dir = HERE;
      for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, "labkit"))) { base = path.join(dir, "traces"); break; }
        dir = path.dirname(dir);
      }
      base = base || path.join(HERE, "traces");
    }
    fs.mkdirSync(base, { recursive: true });
    this.path = path.join(base, `${this.runId}.jsonl`);
    this.t0 = Date.now();
  }
  emit(kind, fields = {}) {
    const record = { run_id: this.runId, t: (Date.now() - this.t0) / 1000, kind, ...fields };
    fs.appendFileSync(this.path, JSON.stringify(record) + "\n");
  }
  step(n, stopReason, text = "", tools = []) {
    this.emit("step", { n, stop_reason: stopReason, text: String(text).slice(0, 400), tools });
  }
  tool(name, args, result, ok = true) {
    this.emit("tool_result", { name, args, ok, result: String(result).slice(0, 400) });
  }
}

export class BudgetExceeded extends Error {}

// Exported so a lab needing a pre-call cost estimate (a budget *reservation*,
// charged before spending rather than only recorded after) can compute one
// without hardcoding a price itself - CLAUDE.md's rule that "nothing in a lab
// constructs... a price" applies to estimates just as much as to the real
// per-call cost this file already computes in record().
export const PRICES = {
  "claude-sonnet": [0.000002, 0.00001],
  "claude-opus": [0.000005, 0.000025],
  "claude-haiku": [0.000001, 0.000005],
};

export class BudgetGuard {
  constructor(limitUsd, model = "claude-sonnet") {
    this.limit = limitUsd; this.model = model; this.spent = 0; this.calls = 0;
  }
  check() {
    if (this.spent >= this.limit) {
      throw new BudgetExceeded(
        `Budget ceiling hit: $${this.spent.toFixed(4)} of $${this.limit.toFixed(2)} ` +
        `after ${this.calls} calls. Raise LAB_BUDGET_USD to continue.`);
    }
  }
  record(usage = {}) {
    const [rin, rout] = PRICES[this.model] || PRICES["claude-sonnet"];
    const cost = (usage.input_tokens || 0) * rin
      + (usage.cache_read_input_tokens || 0) * rin * 0.1
      + (usage.cache_creation_input_tokens || 0) * rin * 1.25
      + (usage.output_tokens || 0) * rout;
    this.spent += cost; this.calls += 1;
    return cost;
  }
  summary() {
    return `${this.calls} calls, $${this.spent.toFixed(4)} of $${this.limit.toFixed(2)}`;
  }
}
