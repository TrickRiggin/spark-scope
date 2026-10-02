import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { collectNode, uncollectedNode, InferenceCollector, applyNetworkRates } from "./lib/collectors.mjs";
import { buildRingLinks, clusterStatus, combineServerStatus, servingSummary, DEFAULT_LINK_MIN_GBPS } from "./lib/cluster.mjs";
import { downsampleHistory, summarizeHistory } from "./lib/history.mjs";
import { hostAllowed, hostRules, SECURITY_HEADERS } from "./lib/http-guard.mjs";
import { publicState } from "./lib/public-state.mjs";
import { loadTopology, nodeInterfaces, publicTopology, serverTopology, topologyServers } from "./lib/topology.mjs";

// node:sqlite (the token ledger) needs Node 22.13 or later; say so instead of failing on the import.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Spark Scope needs Node.js 22.13 or later; this is ${process.versions.node}. See "Requirements" in README.md.`);
  process.exit(1);
}
const { UsageStore } = await import("./lib/usage-store.mjs");

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");

// Whole numbers only: "2s" or "1e4" are rejected instead of being read as 2 or 1.
function positiveInteger(name, fallback, minimum = 1) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a whole number of at least ${minimum}, got "${raw}"`);
  return value;
}

function portNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} must be a port number (0 picks a free one), got "${raw}"`);
  return value;
}

function validTimeZone(timeZone) {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    throw new Error(`SPARK_SCOPE_TIME_ZONE is not a valid IANA time zone: "${timeZone}"`);
  }
}

const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
const config = {
  host: process.env.SPARK_SCOPE_HOST || "127.0.0.1",
  port: portNumber("SPARK_SCOPE_PORT", 8787),
  apiUrl: process.env.SPARK_SCOPE_API_URL || "http://127.0.0.1:8000",
  nodeIntervalMs: positiveInteger("SPARK_SCOPE_NODE_INTERVAL_MS", 5000, 1000),
  apiIntervalMs: positiveInteger("SPARK_SCOPE_API_INTERVAL_MS", 2000, 500),
  usageDbPath: process.env.SPARK_SCOPE_USAGE_DB || path.join(dataHome, "spark-scope", "usage.sqlite"),
  timeZone: validTimeZone(process.env.SPARK_SCOPE_TIME_ZONE),
  linkMinGbps: positiveInteger("SPARK_SCOPE_LINK_MIN_GBPS", DEFAULT_LINK_MIN_GBPS),
  allowedHosts: process.env.SPARK_SCOPE_ALLOWED_HOSTS || "",
};
const hosts = hostRules({ bindHost: config.host, allowed: config.allowedHosts });
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const HISTORY_LIMIT = Math.ceil(HISTORY_WINDOW_MS / Math.min(config.nodeIntervalMs, config.apiIntervalMs)) + 20;

// Nodes, SSH targets and links come from topology.json (or the file named by SPARK_SCOPE_TOPOLOGY).
const topology = loadTopology();
const nodeDefinitions = topology.nodes.map((node) => ({ ...node, interfaces: nodeInterfaces(topology, node.id) }));

// One inference collector, token ledger and history per model server. Without "servers" in topology.json there is
// one server on every node at SPARK_SCOPE_API_URL, with the ledger at SPARK_SCOPE_USAGE_DB, as upstream.
const usageDbPath = (server) => (server.implicit ? config.usageDbPath
  : path.join(path.dirname(config.usageDbPath), `usage-${server.id}.sqlite`));
const servers = topologyServers(topology, config.apiUrl).map((definition) => {
  const server = {
    definition,
    topology: serverTopology(topology, definition),
    collector: new InferenceCollector(definition.api),
    usageStore: null,
    usageOpenError: null,
    inference: null,
    serving: null,
    usage: null,
    history: [],
    status: "starting",
    message: "Waiting for the first measurements",
    inferenceState: "unknown",
    // The model of the last successful poll: a restart in between (failed polls) does not hide a model switch.
    lastServedModel: null,
    // Ledger errors repeat every poll; log a message when it changes and at most every ten minutes otherwise.
    lastUsageError: { message: null, at: 0 },
  };
  // A ledger that cannot be opened (corrupt file, wrong permissions) turns off token counting, not the dashboard.
  try {
    server.usageStore = new UsageStore(usageDbPath(definition), { timeZone: config.timeZone });
  } catch (error) {
    server.usageOpenError = `Token ledger unavailable: ${error.message}`;
    console.error(`${server.usageOpenError} (${usageDbPath(definition)})`);
  }
  server.usage = server.usageStore ? server.usageStore.summary() : unavailableUsage(server);
  return server;
});
function unavailableUsage(server) {
  return { persistent: false, error: server.usageOpenError, updatedAt: new Date().toISOString() };
}
const serverById = (id) => servers.find((server) => server.definition.id === id) ?? servers[0];
const state = {
  status: "starting",
  message: "Waiting for the first measurements",
  topology: publicTopology(topology),
  nodes: Object.fromEntries(topology.nodes.map((node) => [node.id, null])),
  ringLinks: {},
  startedAt: new Date().toISOString(),
  updatedAt: null,
};

let collectingNodes = false;
let collectingInference = false;
// Full node collection errors go to the log when they change; the browser only gets a short reason.
const lastNodeErrors = new Map();
// Refused Host names, logged once each so a missing SPARK_SCOPE_ALLOWED_HOSTS entry is easy to spot.
const refusedHosts = new Set();

function refreshClusterStatus() {
  state.ringLinks = buildRingLinks(state.nodes, topology, { minGbps: config.linkMinGbps });
  for (const server of servers) {
    const links = Object.fromEntries(server.topology.links.map((link) => [link.id, state.ringLinks[link.id]]));
    server.serving = servingSummary(state.nodes, server.inference, server.topology);
    Object.assign(server, clusterStatus(state.nodes, server.inference, links, server.topology));
  }
  Object.assign(state, combineServerStatus(servers.map((server) => ({
    server: server.definition, status: server.status, message: server.message, inferenceState: server.inferenceState,
  }))));
  // Cables between two servers' nodes, or to a node in no server, still count toward the overall status.
  const shared = topology.links.filter((link) => !servers.some((server) => server.topology.links.includes(link)));
  const sharedDown = shared.find((link) => !["pending", "unknown"].includes(state.ringLinks[link.id]?.state)
    && !(state.ringLinks[link.id]?.state === "up" && !state.ringLinks[link.id]?.slow));
  if (sharedDown && state.status === "healthy") Object.assign(state, { status: "degraded", message: "QSFP link needs attention" });
  state.updatedAt = new Date().toISOString();
}

function addHistoryPoint(server) {
  const inference = server.inference;
  if (!inference) return;
  const point = {
    at: Date.now(),
    outputTokensPerSecond: inference.ok ? inference.outputTokensPerSecond : null,
    promptTokensPerSecond: inference.ok ? inference.promptTokensPerSecond : null,
    runningRequests: inference.ok ? inference.runningRequests : null,
    queue: inference.ok ? inference.waitingRequests : null,
    // Per node id: { temperature, memoryAvailableBytes }. Unreachable or uncollected nodes stay null.
    nodes: Object.fromEntries(topology.nodes.map(({ id }) => {
      const node = state.nodes[id];
      return [id, {
        temperature: node?.ok ? node.gpu?.temperature ?? null : null,
        memoryAvailableBytes: node?.ok ? node.memory?.availableBytes ?? null : null,
      }];
    })),
  };
  server.history.push(point);
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  while (server.history.length > HISTORY_LIMIT || (server.history[0] && server.history[0].at < cutoff)) {
    server.history.shift();
  }
}

async function collectNodes() {
  if (collectingNodes) return;
  collectingNodes = true;
  try {
    const snapshots = await Promise.all(nodeDefinitions.map((definition) => (
      definition.collect ? collectNode(definition) : uncollectedNode(definition))));
    for (let index = 0; index < nodeDefinitions.length; index += 1) {
      const definition = nodeDefinitions[index];
      const previous = state.nodes[definition.id];
      state.nodes[definition.id] = applyNetworkRates(snapshots[index], previous);
      const error = snapshots[index]?.error ?? null;
      if (error !== (lastNodeErrors.get(definition.id) ?? null)) {
        console.error(error ? `Node ${definition.name}: ${error}` : `Node ${definition.name}: collecting again`);
        lastNodeErrors.set(definition.id, error);
      }
    }
    refreshClusterStatus();
  } finally {
    collectingNodes = false;
  }
}

function recordInference(server, next) {
  if (next.ok && next.modelName) {
    if (server.lastServedModel && server.lastServedModel !== next.modelName) server.history = [];
    server.lastServedModel = next.modelName;
  }
  server.inference = next;
  try {
    if (!server.usageStore) {
      server.usage = unavailableUsage(server);
    } else if (next.ok) {
      server.usage = server.usageStore.record(next);
    } else {
      const { session, modelName, processStartedAt } = server.usage;
      server.usage = { ...server.usageStore.summary(), session, modelName, processStartedAt };
    }
  } catch (error) {
    server.usage = { ...server.usage, error: error.message, updatedAt: new Date().toISOString() };
    const now = Date.now();
    if (error.message !== server.lastUsageError.message || now - server.lastUsageError.at > 10 * 60_000) {
      console.error(`Token usage store${server.definition.implicit ? "" : ` (${server.definition.name})`}: ${error.message}`);
      server.lastUsageError = { message: error.message, at: now };
    }
  }
}

async function collectInference() {
  if (collectingInference) return;
  collectingInference = true;
  try {
    const readings = await Promise.all(servers.map((server) => server.collector.collect()));
    servers.forEach((server, index) => recordInference(server, readings[index]));
    refreshClusterStatus();
    for (const server of servers) addHistoryPoint(server);
  } finally {
    collectingInference = false;
  }
}

// The servers strip: each model server's headline numbers, so the page can show them all and pick one.
function serverSummaries() {
  return servers.filter((server) => !server.definition.implicit).map(({ definition, inference, serving, status, message, inferenceState }) => ({
    id: definition.id,
    name: definition.name,
    nodes: definition.nodes,
    ok: Boolean(inference?.ok),
    engine: serving?.engine ?? inference?.engine ?? null,
    modelName: inference?.ok ? inference.modelName ?? null : null,
    outputTokensPerSecond: inference?.ok ? inference.outputTokensPerSecond ?? null : null,
    runningRequests: inference?.ok ? inference.runningRequests ?? null : null,
    waitingRequests: inference?.ok ? inference.waitingRequests ?? null : null,
    status,
    message,
    inferenceState,
  }));
}

// What /api/state reports for one server: the shared node and link state, with that server's inference, serving,
// ledger and history in the fields the pages already read.
function serverState(server) {
  return {
    ...state,
    server: server.definition.implicit ? null : server.definition.id,
    servers: serverSummaries(),
    inference: server.inference,
    serving: server.serving,
    inferenceState: server.inferenceState,
    usage: server.usage,
  };
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
]);

async function serveStatic(urlPath, response, root = PUBLIC_ROOT) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.resolve(root, `.${normalized}`);
  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    const data = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

// JSON, gzip-compressed when the client accepts it (the state payload shrinks to a fraction).
function sendJson(request, response, status, body) {
  const text = JSON.stringify(body);
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding" };
  if (text.length > 1024 && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "")) {
    response.writeHead(status, { ...headers, "Content-Encoding": "gzip" });
    response.end(gzipSync(text));
    return;
  }
  response.writeHead(status, headers);
  response.end(text);
}

async function handle(request, response) {
  if (!hostAllowed(request.headers.host, hosts)) {
    const name = String(request.headers.host).slice(0, 100);
    if (!refusedHosts.has(name) && refusedHosts.size < 50) {
      refusedHosts.add(name);
      console.error(`Refused a request for host "${name}". If this is how you reach the dashboard, add it to SPARK_SCOPE_ALLOWED_HOSTS.`);
    }
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Host not allowed. Add it to SPARK_SCOPE_ALLOWED_HOSTS on the dashboard server.");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad request");
    return;
  }
  if (url.pathname === "/api/state") {
    const requestedMinutes = Number(url.searchParams.get("minutes") || 60);
    const minutes = [15, 60, 360].includes(requestedMinutes) ? requestedMinutes : 60;
    const server = serverById(url.searchParams.get("server"));
    const history = server.history.filter(point => point.at >= Date.now() - minutes * 60_000);
    // history=0 leaves out the samples: pages poll every two seconds and fetch the full history only now and then.
    const withHistory = url.searchParams.get("history") !== "0";
    sendJson(request, response, 200, publicState(serverState(server), {
      history: withHistory ? downsampleHistory(history) : undefined,
      historyStats: summarizeHistory(history, minutes),
      pollIntervals: { nodeMs: config.nodeIntervalMs, apiMs: config.apiIntervalMs },
    }));
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(request, response, state.status === "offline" ? 503 : 200, { status: state.status, message: state.message, updatedAt: state.updatedAt });
    return;
  }
  if (url.pathname === "/api/usage") {
    const month = url.searchParams.get("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      sendJson(request, response, 400, { error: "month must use YYYY-MM format" });
      return;
    }
    const server = serverById(url.searchParams.get("server"));
    if (!server.usageStore) {
      sendJson(request, response, 503, { error: server.usageOpenError });
      return;
    }
    try {
      sendJson(request, response, 200, server.usageStore.month(month));
    } catch (error) {
      sendJson(request, response, 500, { error: error.message });
    }
    return;
  }
  // The rack panel (public/rack/) for a bar display or kiosk.
  if (url.pathname === "/rack") {
    response.writeHead(302, { Location: `/rack/${url.search}` }).end();
    return;
  }
  await serveStatic(url.pathname, response);
}

const server = createServer((request, response) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  handle(request, response).catch((error) => {
    console.error(`Request ${request.url}: ${error.message}`);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Internal error");
  });
});

await Promise.all([collectNodes(), collectInference()]);
const nodeTimer = setInterval(collectNodes, config.nodeIntervalMs);
const inferenceTimer = setInterval(collectInference, config.apiIntervalMs);
nodeTimer.unref();
inferenceTimer.unref();

server.on("error", (error) => {
  console.error(`Spark Scope cannot listen on ${config.host}:${config.port}: ${error.message}`);
  for (const server of servers) server.usageStore?.close();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const shown = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`Spark Scope: http://${shown}:${server.address().port}/ (rack panel: /rack/)`);
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    console.log("Warning: listening beyond localhost. Spark Scope has no authentication; expose it only on a network you trust.");
    console.log(`Accepted host names: localhost, IP addresses, ${hosts.short}, ${hosts.short}.local, ${hosts.short}.<tailnet>.ts.net${config.allowedHosts ? `, ${config.allowedHosts}` : ""} (SPARK_SCOPE_ALLOWED_HOSTS adds more).`);
  }
  for (const server of servers) {
    const label = server.definition.implicit ? "" : ` (${server.definition.name}: ${server.definition.nodes.join(", ")})`;
    console.log(`Inference API${label}: ${server.definition.api}`);
    console.log(server.usageStore ? `Token ledger: ${usageDbPath(server.definition)} (days in ${server.usageStore.timeZone})` : server.usageOpenError);
  }
  console.log(`Topology: ${topology.source} (${topology.nodes.map((node) => `${node.name}=${!node.collect ? "not collected" : node.local ? "local" : `ssh ${node.host}`}`).join(", ")})`);
});

function shutdown() {
  clearInterval(nodeTimer);
  clearInterval(inferenceTimer);
  server.close(() => {
    for (const modelServer of servers) modelServer.usageStore?.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
