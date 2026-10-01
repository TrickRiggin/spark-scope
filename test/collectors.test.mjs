import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  applyNetworkRates,
  buildRemoteScript,
  collectNode,
  collectorCommand,
  knownEngine,
  metricsEngine,
  parseNetworkLines,
  histogramMean,
  histogramQuantile,
  holdPrefillRates,
  metricSum,
  metricValue,
  parseInferenceProcess,
  parseKernelEvents,
  parsePrometheus,
  parseThermals,
  resolveModelIdentity,
} from "../lib/collectors.mjs";

test("the last completed prefill rate is held until the next prefill completes", () => {
  const first = {
    at: Date.parse("2026-08-23T00:00:00Z"),
    modelName: "model-a",
    promptTotal: 200_000,
    promptComputeTotal: 160_000,
    promptCacheTotal: 40_000,
    prefillTimeTotal: 100,
    prefillCount: 1,
  };
  const sampled = holdPrefillRates(first);
  assert.equal(sampled.promptTokensPerSecond, 2000);
  assert.equal(sampled.promptComputeTokensPerSecond, 1600);
  assert.equal(sampled.promptCacheTokensPerSecond, 400);

  const unchanged = holdPrefillRates({ ...first, at: first.at + 2000 }, first, sampled);
  assert.deepEqual(unchanged, sampled);

  const next = {
    ...first,
    at: first.at + 4000,
    promptTotal: 210_000,
    promptComputeTotal: 168_000,
    promptCacheTotal: 42_000,
    prefillTimeTotal: 105,
    prefillCount: 2,
  };
  const refreshed = holdPrefillRates(next, first, sampled);
  assert.equal(refreshed.promptTokensPerSecond, 2000);
  assert.equal(refreshed.promptComputeTokensPerSecond, 1600);
  assert.equal(refreshed.promptCacheTokensPerSecond, 400);
  assert.equal(refreshed.updatedAt, "2026-08-23T00:00:04.000Z");

  const reset = holdPrefillRates({
    ...first,
    at: first.at + 6000,
    modelName: "model-b",
    promptTotal: 0,
    promptComputeTotal: 0,
    promptCacheTotal: 0,
    prefillTimeTotal: 0,
    prefillCount: 0,
  }, next, refreshed);
  assert.equal(reset.promptTokensPerSecond, 0);
  assert.equal(reset.updatedAt, null);
});

test("Prometheus samples and labels are parsed", () => {
  const metrics = parsePrometheus(`
# HELP vllm:num_requests_running running
vllm:num_requests_running{engine="0",model_name="model-a"} 2
vllm:request_success_total{finished_reason="error",model_name="model-a"} 3
`);
  assert.equal(metricValue(metrics, "vllm:num_requests_running"), 2);
  assert.equal(metricValue(metrics, "vllm:request_success_total", { finished_reason: "error" }), 3);
});

test("p95 is the first cumulative histogram bucket at or above 95%", () => {
  const metrics = parsePrometheus(`
vllm:time_to_first_token_seconds_bucket{le="0.1"} 2
vllm:time_to_first_token_seconds_bucket{le="0.5"} 8
vllm:time_to_first_token_seconds_bucket{le="1"} 10
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 10
`);
  assert.equal(histogramQuantile(metrics, "vllm:time_to_first_token_seconds", 0.95), 1);
});

test("histogram means and per-label counter sums are computed", () => {
  const metrics = parsePrometheus(`
vllm:request_prefill_time_seconds_count{model_name="model-a"} 4
vllm:request_prefill_time_seconds_sum{model_name="model-a"} 10
vllm:request_success_total{finished_reason="stop"} 7
vllm:request_success_total{finished_reason="length"} 2
vllm:request_success_total{finished_reason="error"} 1
`);
  assert.equal(histogramMean(metrics, "vllm:request_prefill_time_seconds"), 2.5);
  assert.equal(metricSum(metrics, "vllm:request_success_total"), 10);
  assert.equal(metricSum(metrics, "vllm:request_success_total", { finished_reason: "error" }), 1);
});

test("the model name comes from the metrics; the model list is kept as aliases", () => {
  const metrics = parsePrometheus(`
vllm:num_requests_running{model_name="current-model"} 0
`);
  const identity = resolveModelIdentity(metrics, [
    { id: "current-model", root: "org/new-checkpoint" },
    { id: "writing-alias", root: "org/new-checkpoint" },
  ]);
  assert.deepEqual(identity, {
    modelName: "current-model",
    modelRoot: "org/new-checkpoint",
    modelAliases: ["current-model", "writing-alias"],
  });
});

test("without a model label in the metrics, the API model list names the model", () => {
  const identity = resolveModelIdentity(new Map(), [{ id: "replacement-model", root: "org/replacement" }]);
  assert.equal(identity.modelName, "replacement-model");
  assert.equal(identity.modelRoot, "org/replacement");
});

test("engine, TP rank and readiness are read from the GPU process name and /proc state", () => {
  assert.deepEqual(parseInferenceProcess("152952, VLLM::Worker_TP0, 109270, S"), {
    up: true,
    alive: true,
    ready: true,
    pid: 152952,
    processName: "VLLM::Worker_TP0",
    engine: "vLLM",
    rank: 0,
    memoryBytes: 109270 * 1024 * 1024,
    state: "S",
  });
  assert.equal(parseInferenceProcess("42, llama-server, 8192, R").rank, null);
  assert.equal(parseInferenceProcess("42, llama-server, 8192, R").engine, "llama.cpp");
  assert.equal(parseInferenceProcess("42, VLLM::Worker_TP1, 8192, Z").ready, false);
  assert.equal(parseInferenceProcess("42, VLLM::Worker_TP1, 8192, ").ready, false);
});

test("only the TSOC and TS1P ACPI thermal zones are converted to Celsius", () => {
  assert.deepEqual(parseThermals("TSOC=46800,TS1P=46300"), {
    tsocCelsius: 46.8,
    ts1pCelsius: 46.3,
  });
  assert.deepEqual(parseThermals(""), { tsocCelsius: null, ts1pCelsius: null });
});

test("the bounded kernel journal summary yields counts and the last message", () => {
  assert.deepEqual(parseKernelEvents("ok\t263\t97\t2\t0\t1787414172.25\tNVRM: NV_ERR_NO_MEMORY"), {
    available: true,
    status: "ok",
    windowHours: 24,
    total: 263,
    noMemory: 97,
    xid: 2,
    capped: false,
    lastAt: "2026-08-22T15:56:12.250Z",
    lastMessage: "NVRM: NV_ERR_NO_MEMORY",
  });
  const noMatch = parseKernelEvents("ok\t0\t0\t0\t0\t\t");
  assert.equal(noMatch.available, true);
  assert.equal(noMatch.total, 0);
  assert.equal(noMatch.lastAt, null);
  assert.equal(noMatch.lastMessage, null);

  const timedOut = parseKernelEvents("timeout\t3\t2\t0\t0\t\t");
  assert.equal(timedOut.available, false);
  assert.equal(timedOut.status, "timeout");

  const unavailable = parseKernelEvents("unavailable\t0\t0\t0\t0\t\t");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.status, "unavailable");
});

test("Gb/s rates come from the network counters of two snapshots", () => {
  const previous = {
    ok: true,
    updatedAt: "2026-08-22T00:00:00.000Z",
    network: {
      a: { rxBytes: 1000, txBytes: 2000, rateGbps: 0 },
      b: { rxBytes: 3000, txBytes: 4000, rateGbps: 0 },
    },
  };
  const current = {
    ok: true,
    updatedAt: "2026-08-22T00:00:02.000Z",
    network: {
      a: { rxBytes: 1_000_001_000, txBytes: 1_000_002_000, rateGbps: 0 },
      b: { rxBytes: 500_003_000, txBytes: 500_004_000, rateGbps: 0 },
    },
  };
  applyNetworkRates(current, previous);
  assert.equal(current.network.a.rateGbps, 8);
  assert.equal(current.network.b.rateGbps, 4);
});

test("the collector script reads only the topology's interfaces and stays valid bash", () => {
  const script = buildRemoteScript(["enp1s0f1np1", "enP2p1s0f1np1", "eth9"]);
  assert.match(script, /^SCOPE_IFACES='enp1s0f1np1 rocep1s0f1 enP2p1s0f1np1 roceP2p1s0f1 eth9 -'\n/);
  assert.ok(!/enp1s0f0np0/.test(script), "no hard-coded interfaces");
  const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.throws(() => buildRemoteScript(["eth0'; reboot; '"]));
});

test("interface lines are read by name and missing interfaces stay unavailable", () => {
  const network = parseNetworkLines({ "net:enp1s0f0np0": "1,200000,10,20,0,0,1,2", "net:enp1s0f1np1": "" }, ["enp1s0f0np0", "enp1s0f1np1", "enP2p1s0f1np1"]);
  assert.equal(network.enp1s0f0np0.up, true);
  assert.equal(network.enp1s0f0np0.speedGbps, 200);
  assert.equal(network.enp1s0f0np0.dropped, 3);
  assert.equal(network.enp1s0f1np1.available, false);
  assert.equal(network.enP2p1s0f1np1.available, false);
});

test("engine names come only from metric prefixes and known process or image names", () => {
  assert.equal(metricsEngine(parsePrometheus("vllm:num_requests_running 0\n")), "vLLM");
  assert.equal(metricsEngine(parsePrometheus("sglang:num_running_reqs 2\n")), "SGLang");
  assert.equal(metricsEngine(parsePrometheus("process_start_time_seconds 1\n")), null);
  assert.equal(knownEngine("sglang::scheduler_TP0"), "SGLang");
  assert.equal(knownEngine("lmsysorg/sglang:spark"), "SGLang");
  assert.equal(knownEngine("vllm/vllm-openai:latest"), "vLLM");
  assert.equal(knownEngine("ollama"), "Ollama");
  assert.equal(knownEngine("python3"), null);
});

test("SGLang metrics are summed into the vLLM names the collector reads", async () => {
  const { normalizeSglangMetrics } = await import("../lib/collectors.mjs");
  const text = [
    'sglang:num_running_reqs{model_name="example-model",tp_rank="0"} 3',
    'sglang:num_queue_reqs{model_name="example-model",tp_rank="0"} 1',
    'sglang:token_usage{model_name="example-model",tp_rank="0"} 0.25',
    'sglang:generation_tokens_total{is_streaming="false",model_name="example-model"} 100',
    'sglang:generation_tokens_total{is_streaming="true",model_name="example-model"} 50',
    'sglang:prompt_tokens_total{model_name="example-model"} 1000',
    'sglang:cached_tokens_total{cache_source="device",model_name="example-model"} 400',
    'sglang:time_to_first_token_seconds_bucket{is_streaming="false",le="1.0"} 2',
    'sglang:time_to_first_token_seconds_bucket{is_streaming="true",le="1.0"} 1',
    'sglang:time_to_first_token_seconds_count{is_streaming="false"} 2',
    'sglang:time_to_first_token_seconds_count{is_streaming="true"} 1',
    'sglang:time_to_first_token_seconds_sum{is_streaming="false"} 1.5',
    'sglang:time_to_first_token_seconds_sum{is_streaming="true"} 0.5',
  ].join("\n");
  const metrics = parsePrometheus(text);
  assert.equal(metricsEngine(metrics), "SGLang");
  normalizeSglangMetrics(metrics);
  assert.equal(metricValue(metrics, "vllm:num_requests_running"), 3);
  assert.equal(metricValue(metrics, "vllm:num_requests_waiting"), 1);
  assert.equal(metricValue(metrics, "vllm:kv_cache_usage_perc"), 0.25);
  assert.equal(metricValue(metrics, "vllm:generation_tokens_total"), 150);
  assert.equal(metricValue(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_cache_hit" }), 400);
  assert.equal(metricValue(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_compute" }), 600);
  assert.equal(metricValue(metrics, "vllm:prefix_cache_queries_total"), 1000);
  assert.equal(metricValue(metrics, "vllm:prefix_cache_hits_total"), 400);
  assert.equal(metricValue(metrics, "vllm:request_prefill_time_seconds_count"), 3);
  assert.equal(metricValue(metrics, "vllm:request_prefill_time_seconds_sum"), 2);
  assert.equal(metricValue(metrics, "vllm:time_to_first_token_seconds_bucket", { le: "1.0" }), 3);
  assert.equal(resolveModelIdentity(metrics).modelName, "example-model");
});

test("SGLang inter-token latency stands in for TPOT and its accept-rate gauge for spec acceptance", async () => {
  const { normalizeSglangMetrics, speculativeAcceptancePercent } = await import("../lib/collectors.mjs");
  const text = [
    'sglang:num_running_reqs{model_name="example-model",tp_rank="0"} 1',
    'sglang:inter_token_latency_seconds_bucket{is_streaming="true",le="0.02"} 90',
    'sglang:inter_token_latency_seconds_bucket{is_streaming="true",le="0.04"} 100',
    'sglang:inter_token_latency_seconds_bucket{is_streaming="true",le="+Inf"} 100',
    'sglang:inter_token_latency_seconds_count{is_streaming="true"} 100',
    'sglang:inter_token_latency_seconds_sum{is_streaming="true"} 1.8',
    'sglang:spec_accept_rate{model_name="example-model",tp_rank="0"} 0.335',
  ].join("\n");
  const metrics = normalizeSglangMetrics(parsePrometheus(text));
  assert.equal(metricValue(metrics, "vllm:request_time_per_output_token_seconds_count"), 100);
  assert.equal(metricValue(metrics, "vllm:inter_token_latency_seconds_bucket", { le: "0.04" }), 100);
  assert.ok(Math.abs(speculativeAcceptancePercent(metrics) - 33.5) < 1e-9);
  assert.equal(speculativeAcceptancePercent(parsePrometheus("vllm:num_requests_running 0\n")), 0);
});

test("a local node runs the collector with bash directly; any other node goes over SSH", () => {
  assert.deepEqual(collectorCommand({ local: true, host: "local" }), { command: "bash", args: ["-s"], label: "local collector" });
  const remote = collectorCommand({ host: "spark-2" });
  assert.equal(remote.command, "ssh");
  // Never prompt, and the host is its own argument right before the remote command, never part of a shell string.
  assert.deepEqual(remote.args.slice(0, 2), ["-o", "BatchMode=yes"]);
  assert.deepEqual(remote.args.slice(-2), ["spark-2", "bash -s"]);
});

test("local collection runs on this machine and leaves what it cannot read unknown instead of failing", async () => {
  const node = await collectNode({ id: "1", name: "this", host: "local", local: true, interfaces: ["spkmissing0"] });
  assert.equal(node.ok, true, node.error ?? "");
  assert.equal(node.local, true);
  assert.equal(typeof node.hostname, "string");
  assert.ok(node.hostname.length > 0);
  // On a machine without nvidia-smi, /proc or systemd (e.g. macOS) these stay null, never a made-up zero.
  for (const value of [node.gpu.utilization, node.gpu.temperature, node.memory.totalBytes, node.memory.availableBytes, node.disk.availableBytes]) {
    assert.ok(value === null || Number.isFinite(value), `unexpected value ${value}`);
  }
  assert.equal(node.memory.usedBytes === null, node.memory.totalBytes === null || node.memory.availableBytes === null);
  assert.equal(node.network.spkmissing0.available, false);
});
