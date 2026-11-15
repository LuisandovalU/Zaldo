import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { serveLanding } from "../src/landing.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await serveLanding(req, res, url.pathname)) return;
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test("la landing se sirve en / con sus archivos", async () => {
  await withServer(async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await home.text(), /<html/i);

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const img = await fetch(`${base}/assets/zaldo-cube.png`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");

    const three = await fetch(`${base}/vendor/three.module.min.js`);
    assert.equal(three.status, 200);
    assert.match(three.headers.get("content-type") ?? "", /javascript/);
  });
});

test("la landing no sale de su carpeta ni inventa rutas", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fsrc%2fconfig.ts`)).status, 404);
    assert.equal((await fetch(`${base}/no-existe.js`)).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 404);
  });
});
