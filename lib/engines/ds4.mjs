import { metricTotal } from "./prometheus.mjs";

// ds4-server (Entrpi ds4 0.5.4) exports cumulative ds4_ counters. Its rate gauges average a 60-second wall-clock window,
// idle seconds included, so output speed comes from the decoded-token counter instead. There is no prefill time,
// latency histogram or KV use, and ds4_uptime_seconds moves the derived start time by a second between polls, so the
// process start is left unknown and a restart is seen by counters going down, as for SGLang.
export function readDs4Metrics(metrics) {
  const value = (name, labels) => metricTotal(metrics, `ds4_${name}`, labels);
  const computed = value("tokens_prefilled_total", { kind: "computed" });
  const cached = value("tokens_prefilled_total", { kind: "cached" });
  const drafts = value("spec_drafts_total");
  const hits = value("spec_hits_total");
  return {
    generationTotal: value("tokens_decoded_total"),
    liveGenerationTotal: null,
    metricKinds: { prefixCacheHitPercent: "sinceStart" },
    promptTotal: computed === null ? null : computed + (cached ?? 0),
    promptComputeTotal: computed,
    promptCacheTotal: cached,
    prefillTimeTotal: null,
    prefillCount: null,
    runningRequests: value("requests_inflight"),
    waitingRequests: null,
    kvCachePercent: null,
    prefixCacheHitPercent: computed !== null && cached !== null && computed + cached > 0 ? cached / (computed + cached) * 100 : null,
    speculativeAcceptancePercent: drafts > 0 && hits !== null ? hits / drafts * 100 : null,
    ttftP95Seconds: null,
    tpotP95Seconds: null,
    ttftBuckets: [],
    tpotBuckets: [],
    completedRequestsTotal: value("requests_total", { outcome: "completed" }),
    processStartedAt: null,
    reported: { promptComputeTokensPerSecond: false, promptCacheTokensPerSecond: false },
  };
}
