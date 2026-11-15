import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ago, bridgeActivity, sameSecret } from "../src/core.js";

test("el secreto del puente se compara completo y sin atajos", () => {
  const secret = "un-secreto-largo-de-verdad-0123456789";
  assert.equal(sameSecret(secret, secret), true);
  assert.equal(sameSecret(`${secret}x`, secret), false, "más largo no pasa");
  assert.equal(sameSecret(secret.slice(0, -1), secret), false, "un prefijo no pasa");
  assert.equal(sameSecret("", secret), false);
  assert.equal(sameSecret(undefined, secret), false);
  assert.equal(sameSecret(["a", "b"], secret), false, "un encabezado repetido no pasa");
  assert.equal(sameSecret("", ""), false, "sin secreto configurado no entra nadie");
  assert.equal(sameSecret("algo", null), false);
});

test("hace cuánto, en palabras", () => {
  const now = 1_800_000_000_000;
  assert.equal(ago(now - 5_000, now), "hace un momento");
  assert.equal(ago(now - 3 * 60_000, now), "hace 3 min");
  assert.equal(ago(now - 2 * 3_600_000, now), "hace 2 h");
  assert.equal(ago(now - 4 * 86_400_000, now), "hace 4 días");
  assert.equal(ago(now + 9_000, now), "hace un momento", "un reloj adelantado no da tiempos negativos");
});

test("/vincular dice cuándo llegó el último mensaje, y nada de su contenido", () => {
  const dir = mkdtempSync(join(tmpdir(), "zaldo-puente-"));
  const now = 1_800_000_000_000;
  try {
    assert.equal(bridgeActivity(dir, now), "", "sin archivo no se dice nada");
    const file = join(dir, "zaldo-wa-stats.json");
    writeFileSync(file, JSON.stringify({ lastInboundAt: 0, lastReplyAt: 0 }));
    assert.equal(bridgeActivity(dir, now), "Todavía no llega ningún mensaje a este número.");
    writeFileSync(
      file,
      JSON.stringify({ lastInboundAt: now - 3 * 60_000, lastReplyAt: now - 170_000, lastErrorAt: now - 3_600_000, lastError: "puente: HTTP 401" }),
    );
    assert.equal(bridgeActivity(dir, now), "Último mensaje recibido: hace 3 min · última respuesta: hace 3 min");
    // Llegó un mensaje y lo último que pasó fue un tropiezo: se ve.
    writeFileSync(
      file,
      JSON.stringify({ lastInboundAt: now - 60_000, lastReplyAt: now - 3_600_000, lastErrorAt: now - 50_000, lastError: "puente: HTTP 401 <b>x</b>" }),
    );
    const line = bridgeActivity(dir, now);
    assert.equal(line, "Último mensaje recibido: hace 1 min · última respuesta: hace 1 h · último tropiezo: hace un momento");
    assert.equal(line.includes("401"), false, "el detalle del error se queda en el servidor");
    writeFileSync(file, "{no es json");
    assert.equal(bridgeActivity(dir, now), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
