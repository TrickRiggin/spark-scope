// Development check: renders the rack panel and the web dashboard with synthetic data (tools/fixtures.mjs) for
// one to four nodes in headless Chrome, saves PNGs and reports clipped or overlapping text on the rack panel and
// horizontal overflow or script errors on the web page. Nothing is collected and no other machine is contacted.
//
//   node tools/render.mjs                 # PNGs go to $OUT or <tmp>/spark-scope-renders
//   CHROME=/path/to/chrome node tools/render.mjs
//
// It needs Chrome or Chromium; it drives it over the DevTools protocol with Node's built-in WebSocket.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureState, usageMonth, MODES } from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const OUT = process.env.OUT || path.join(os.tmpdir(), "spark-scope-renders");
const COUNTS = (process.env.COUNTS || "1,2,3,4").split(",").map(Number);
mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const candidate of candidates) {
    if (candidate.startsWith("/") ? existsSync(candidate) : spawnSync("which", [candidate]).status === 0) return candidate;
  }
  throw new Error("Chrome or Chromium not found; set CHROME=/path/to/chrome");
}

// ---- fixture server: the real public/ files, /api/state from fixtures ----
let current = { count: 4, mode: "serving" };
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/state") {
    if (current.mode === "lost") { response.writeHead(503).end("{}"); return; }
    const state = fixtureState(current.count, current.mode);
    const minutes = Number(url.searchParams.get("minutes") || 60);
    state.history = state.history.filter((point) => point.at >= Date.now() - minutes * 60_000);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state));
    return;
  }
  if (url.pathname === "/api/usage") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(usageMonth(url.searchParams.get("month"), Date.now())));
    return;
  }
  const file = path.join(PUBLIC, url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- minimal DevTools protocol client ----
const profile = mkdtempSync(path.join(os.tmpdir(), "spark-scope-chrome-"));
const chrome = spawn(findChrome(), [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-color-profile=srgb", "--disable-extensions", "about:blank",
], { stdio: "ignore" });
const portFile = path.join(profile, "DevToolsActivePort");
for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
const [debugPort, browserPath] = readFileSync(portFile, "utf8").trim().split("\n");
const socket = new WebSocket(`ws://127.0.0.1:${debugPort}${browserPath}`);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
const listeners = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  } else if (message.method) {
    for (const listener of listeners) listener(message);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

async function openPage({ width, height, colorScheme = "dark" }) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  listeners.push((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
  });
  const call = (method, params) => send(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: colorScheme }] });
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
  const go = async (url) => {
    await call("Page.navigate", { url });
    for (let i = 0; i < 50 && (await evaluate("document.readyState")) !== "complete"; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    await evaluate("document.fonts.ready.then(() => true)");
  };
  const waitFor = async (expression, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (await evaluate(expression)) return true; await new Promise((resolve) => setTimeout(resolve, 150)); }
    throw new Error(`timed out waiting for ${expression}`);
  };
  const shoot = async (file, { fullPage = false } = {}) => {
    let clip = { x: 0, y: 0, width, height, scale: 1 };
    if (fullPage) {
      const fullHeight = await evaluate("document.documentElement.scrollHeight");
      await call("Emulation.setDeviceMetricsOverride", { width, height: fullHeight, deviceScaleFactor: 1, mobile: width < 600 });
      clip = { x: 0, y: 0, width, height: fullHeight, scale: 1 };
    }
    const { data } = await call("Page.captureScreenshot", { format: "png", clip });
    writeFileSync(path.join(OUT, file), Buffer.from(data, "base64"));
    if (fullPage) await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  };
  const close = () => send("Target.closeTarget", { targetId });
  return { evaluate, go, waitFor, shoot, close, errors };
}

// Text that leaves the panel, overflows its box or overlaps other text (big figures are trimmed to their glyph band).
const CHECK_RACK = `(() => {
  const screen = document.querySelector(".screen");
  const S = screen.getBoundingClientRect();
  const issues = [], texts = [];
  const walker = document.createTreeWalker(screen, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const r = range.getBoundingClientRect(); if (!r.width) continue;
    const el = node.parentElement, fig = Boolean(el.closest(".num"));
    const box = fig ? { left: r.left, right: r.right, top: r.top + r.height * 0.18, bottom: r.bottom - r.height * 0.22 } : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    const text = node.textContent.trim().slice(0, 40);
    texts.push({ el, text, box });
    if (r.left < S.left - 1 || r.right > S.right + 1 || box.top < S.top - 1 || box.bottom > S.bottom + 1) issues.push("outside panel: " + text);
    for (let a = el; a && a !== screen; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display.startsWith("inline") && cs.display !== "inline-flex" && cs.display !== "inline-block") continue;
      const ar = a.getBoundingClientRect();
      if (r.left < ar.left - 1 || r.right > ar.right + 1) { issues.push("overflow: " + text + " exceeds ." + a.className); break; }
    }
  }
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const p = texts[i], q = texts[j]; if (p.el === q.el) continue;
    const w = Math.min(p.box.right, q.box.right) - Math.max(p.box.left, q.box.left);
    const h = Math.min(p.box.bottom, q.box.bottom) - Math.max(p.box.top, q.box.top);
    if (w > 1 && h > 1) issues.push("overlap: " + p.text + " / " + q.text);
  }
  const fonts = { archivo: document.fonts.check('20px "Archivo"'), bebas: document.fonts.check('100px "Bebas Neue"') };
  const bays = [...document.querySelectorAll(".bay")].map((bay) => bay.querySelector(".name")?.textContent + " [" + bay.className + "] " + bay.querySelector(".reason")?.textContent + " | " + (bay.querySelector(".lk")?.textContent ?? "no link dots"));
  const band = [...document.querySelectorAll(".cl > *")].map((el) => el.textContent).join(" / ");
  return { issues, fonts, bays, band, texts: texts.length };
})()`;

let failures = 0;
const report = (name, lines, problems) => {
  console.log(`${problems.length ? "FAIL" : "ok  "} ${name}`);
  for (const line of lines) console.log(`       ${line}`);
  for (const problem of problems) console.log(`     - ${problem}`);
  if (problems.length) failures++;
};

try {
  // Rack panel, 1920 x 480.
  const rack = await openPage({ width: 1920, height: 480 });
  for (const count of COUNTS) {
    for (const mode of MODES) {
      current = { count, mode };
      await rack.go(`${base}/rack/`);
      await rack.waitFor("document.querySelectorAll('.bay').length > 0 && !document.querySelector('.bay:empty')");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await rack.evaluate(CHECK_RACK);
      const name = `rack-${count}-node-${mode}.png`;
      await rack.shoot(name);
      const missingFonts = Object.entries(result.fonts).filter(([, ok]) => !ok).map(([font]) => `font not loaded: ${font}`);
      report(name, [...result.bays, `band: ${result.band}`], [...result.issues, ...missingFonts, ...rack.errors.splice(0)]);
    }
    // Lost connection: the next poll fails and the panel dims.
    current = { count, mode: "serving" };
    await rack.go(`${base}/rack/`);
    await rack.waitFor("document.querySelectorAll('.bay').length > 0");
    current = { count, mode: "lost" };
    await rack.waitFor("document.querySelector('#screen').classList.contains('stale')");
    const lost = await rack.evaluate(CHECK_RACK);
    await rack.shoot(`rack-${count}-node-lost.png`);
    report(`rack-${count}-node-lost.png`, [`band: ${lost.band}`], lost.issues);
    rack.errors.splice(0);
  }
  // A wider bar display (2560 x 480) with the width parameter.
  const wide = await openPage({ width: 2560, height: 480 });
  current = { count: 4, mode: "serving" };
  await wide.go(`${base}/rack/?width=2560`);
  await wide.waitFor("document.querySelectorAll('.bay').length > 0");
  const wideResult = await wide.evaluate(CHECK_RACK);
  await wide.shoot("rack-4-node-serving-2560.png");
  report("rack-4-node-serving-2560.png", [], [...wideResult.issues, ...wide.errors]);
  await wide.close();
  await rack.close();

  // Web dashboard at desktop and phone widths.
  for (const [label, width, height, scheme] of [["desktop", 1440, 1000, "light"], ["phone", 390, 844, "dark"]]) {
    const web = await openPage({ width, height, colorScheme: scheme });
    for (const count of COUNTS) {
      for (const mode of ["serving", "fault"]) {
        current = { count, mode };
        await web.go(`${base}/`);
        await web.waitFor("document.querySelectorAll('#nodes .node').length > 0 && document.querySelector('#updated-at').textContent !== 'waiting'");
        await new Promise((resolve) => setTimeout(resolve, 300));
        const info = await web.evaluate(`(() => ({
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          cards: [...document.querySelectorAll('.node')].map((n) => n.querySelector('h2').textContent + ' ' + n.querySelector('.badge').textContent).join(' / '),
          fabric: document.querySelector('#fabric-panel').hidden ? 'interconnect hidden' : [...document.querySelectorAll('#link-rows tr')].map((r) => r.innerText.replace(/\\t/g, ' ')).join(' / '),
          status: document.querySelector('#status-title').textContent,
        }))()`);
        const name = `web-${label}-${count}-node-${mode}.png`;
        await web.shoot(name, { fullPage: true });
        report(name, [`status: ${info.status}`, `cards: ${info.cards}`, `links: ${info.fabric}`], [...(info.overflow > 0 ? [`horizontal overflow ${info.overflow}px`] : []), ...web.errors.splice(0)]);
      }
    }
    await web.close();
  }
} finally {
  socket.close();
  chrome.kill();
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(profile, { recursive: true, force: true });
}
console.log(`\nPNGs in ${OUT}`);
process.exit(failures ? 1 : 0);
