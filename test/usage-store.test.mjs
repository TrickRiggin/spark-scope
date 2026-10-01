import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageStore } from "../lib/usage-store.mjs";

function snapshot(overrides = {}) {
  return {
    ok: true,
    modelName: "model-a",
    processStartedAt: "2026-08-22T15:00:00.000Z",
    promptTokensTotal: 1000,
    promptComputeTokensTotal: 800,
    promptCacheTokensTotal: 200,
    generationTokensTotal: 100,
    completedRequestsTotal: 2,
    ...overrides,
  };
}

test("token totals persist and the same counters are never counted twice", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const at = Date.parse("2026-08-23T00:10:00Z");
  let store = new UsageStore(databasePath, { timeZone: "UTC" });
  try {
    const first = store.record(snapshot(), at);
    assert.equal(first.day, "2026-08-23");
    assert.deepEqual(first.today, {
      input: 1000,
      compute: 800,
      cache: 200,
      output: 100,
      requests: 2,
      total: 1100,
    });

    const duplicate = store.record(snapshot(), at + 2000);
    assert.deepEqual(duplicate.today, first.today);

    const increased = store.record(snapshot({
      promptTokensTotal: 1500,
      promptComputeTokensTotal: 1000,
      promptCacheTokensTotal: 500,
      generationTokensTotal: 150,
      completedRequestsTotal: 3,
    }), at + 4000);
    assert.equal(increased.today.total, 1650);
    assert.equal(increased.today.requests, 3);
    store.close();

    store = new UsageStore(databasePath, { timeZone: "UTC" });
    const afterRestart = store.record(snapshot({
      promptTokensTotal: 1500,
      promptComputeTokensTotal: 1000,
      promptCacheTokensTotal: 500,
      generationTokensTotal: 150,
      completedRequestsTotal: 3,
    }), at + 6000);
    assert.equal(afterRestart.allTime.total, 1650);

    const nextSession = store.record(snapshot({
      modelName: "model-b",
      processStartedAt: "2026-08-22T16:00:00.000Z",
      promptTokensTotal: 10,
      promptComputeTokensTotal: 10,
      promptCacheTokensTotal: 0,
      generationTokensTotal: 5,
      completedRequestsTotal: 1,
    }), at + 8000);
    assert.equal(nextSession.session.total, 15);
    assert.equal(nextSession.allTime.total, 1665);
    assert.equal(nextSession.allTime.requests, 4);
    assert.deepEqual(nextSession.models.map((model) => model.modelName), ["model-a", "model-b"]);
  } finally {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a month returns its daily rows oldest first with period totals", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-month-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const store = new UsageStore(databasePath, { timeZone: "UTC" });
  try {
    store.record(snapshot(), Date.parse("2026-07-31T23:50:00Z"));
    store.record(snapshot({
      promptTokensTotal: 1400,
      promptComputeTokensTotal: 1100,
      promptCacheTokensTotal: 300,
      generationTokensTotal: 140,
      completedRequestsTotal: 3,
    }), Date.parse("2026-08-02T00:10:00Z"));
    store.record(snapshot({
      promptTokensTotal: 1900,
      promptComputeTokensTotal: 1450,
      promptCacheTokensTotal: 450,
      generationTokensTotal: 200,
      completedRequestsTotal: 5,
    }), Date.parse("2026-08-24T10:00:00Z"));

    const august = store.month("2026-08", Date.parse("2026-08-24T10:00:01Z"));
    assert.equal(august.day, "2026-08-24");
    assert.deepEqual(august.days.map((day) => day.day), ["2026-08-02", "2026-08-24"]);
    assert.deepEqual(august.totals, {
      input: 900,
      compute: 650,
      cache: 250,
      output: 100,
      requests: 3,
      total: 1000,
    });
    assert.equal(august.firstMonth, "2026-07");
    assert.equal(august.lastMonth, "2026-08");
    assert.deepEqual(store.month("2026-09").days, []);
    assert.throws(() => store.month("2026-13"), /Invalid month/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("calendar days follow the configured time zone, and default to the server's own", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-zone-"));
  const tokyo = new UsageStore(path.join(directory, "tokyo.sqlite"), { timeZone: "Asia/Tokyo" });
  const local = new UsageStore(path.join(directory, "local.sqlite"));
  try {
    // 15:30 UTC on 31 July is already 1 August in UTC+9.
    assert.equal(tokyo.record(snapshot(), Date.parse("2026-07-31T15:30:00Z")).day, "2026-08-01");
    assert.equal(local.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally {
    tokyo.close();
    local.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
