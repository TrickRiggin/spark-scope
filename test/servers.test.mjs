import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTopology, serverTopology, topologyServers } from "../lib/topology.mjs";
import { combineServerStatus } from "../lib/cluster.mjs";
import { fabricLayout } from "../public/view-data.js";

const nodes = ["w", "m", "c", "p"].map((id) => ({ id, host: id }));
const triangle = [["w", "m"], ["m", "c"], ["c", "w"]].map(([a, b], i) => ({ ends: [{ node: a, a: `ena${i}` }, { node: b, a: `enb${i}` }] }));

test("model servers name their nodes; a node belongs to one server at most", () => {
  const topology = normalizeTopology({ nodes, links: triangle, servers: [
    { id: "glm", name: "GLM", api: "http://127.0.0.1:8888/", nodes: ["w", "m", "c"] },
    { id: "solo", api: "http://127.0.0.1:8000", nodes: ["p"] },
  ] });
  assert.deepEqual(topology.servers.map((s) => [s.id, s.name, s.api]), [["glm", "GLM", "http://127.0.0.1:8888"], ["solo", "solo", "http://127.0.0.1:8000"]]);
  assert.equal(serverTopology(topology, topology.servers[0]).links.length, 3);
  assert.equal(serverTopology(topology, topology.servers[1]).links.length, 0);
  assert.throws(() => normalizeTopology({ nodes, servers: [
    { id: "a", api: "http://x", nodes: ["w"] }, { id: "b", api: "http://y", nodes: ["w"] }] }), /node w is in servers a and b/);
  assert.throws(() => normalizeTopology({ nodes, servers: [{ id: "a", api: "ftp://x", nodes: ["w"] }] }), /http or https/);
});

test("without servers there is one server on every node at the configured API URL", () => {
  const topology = normalizeTopology({ nodes, links: triangle });
  const [only] = topologyServers(topology, "http://127.0.0.1:8000/");
  assert.equal(only.api, "http://127.0.0.1:8000");
  assert.deepEqual(only.nodes, ["w", "m", "c", "p"]);
  assert.equal(only.implicit, true);
});

test("an unloaded box is idle while another server serves; a real fault names its server", () => {
  const glm = { server: { id: "glm", name: "GLM" }, status: "healthy", message: "Nodes and inference API healthy", inferenceState: "serving" };
  const idle = { server: { id: "p", name: "Maple" }, status: "degraded", message: "1 node connected, no inference process", inferenceState: "stopped" };
  assert.deepEqual(combineServerStatus([glm, idle]), { status: "healthy", message: "1 model server healthy, Maple idle" });
  const broken = { ...glm, status: "degraded", message: "QSFP link needs attention" };
  assert.deepEqual(combineServerStatus([broken, idle]), { status: "degraded", message: "GLM: QSFP link needs attention" });
  assert.equal(combineServerStatus([glm, { ...glm, server: { id: "q", name: "Qwen" } }]).message, "All 2 model servers healthy");
});

test("a node without a cable stands beside the ring in the diagram", () => {
  const topology = normalizeTopology({ nodes, links: triangle });
  const layout = fabricLayout({ nodes: topology.nodes, links: topology.links });
  const at = Object.fromEntries(layout.nodes.map((node) => [node.id, node]));
  assert.equal(at.p.x, 340);
  for (const id of ["w", "m", "c"]) assert.ok(at[id].x < 300);
});
