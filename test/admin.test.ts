import assert from "node:assert/strict";
import test from "node:test";
import {
  chargesToCsv,
  ownerFromRef,
  ownerRef,
  computeMetrics,
  dailySeries,
  filterCharges,
  findMismatches,
  ownerSummaries,
  reconcile,
  ReconcileCache,
  repairCharge,
  sumTotals,
  type PeyReader,
} from "../src/admin/index.js";
import { maskPhone, renderDashboard, renderOwners } from "../src/admin/views.js";
import { loadAuthConfig, parseAdminUsers } from "../src/auth/config.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { AuthService } from "../src/auth/service.js";
import { createSession, csrfOk, parseCookies, readSession } from "../src/auth/session.js";
import { Throttle } from "../src/auth/throttle.js";
import { safeNext } from "../src/auth/routes.js";
import { parseTransaction, type PeyTransaction } from "../src/pey.js";
import { memoryStore, type Charge, type Store } from "../src/store.js";

const OWNER = "5215511111111";
const NOW = Date.parse("2026-11-14T18:00:00.000Z");
const SECRET = "x".repeat(40);

function charge(over: Partial<Charge> = {}): Charge {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    owner: OWNER,
    payerName: "Ana",
    payerPhone: "5511111111",
    amountCents: 10_000,
    concept: "Comida",
    method: "push",
    status: "pending",
    numRef: "1234567",
    peyTransactionId: null,
    peyExternalId: null,
    linkUrl: null,
    createdAt: NOW,
    confirmBy: NOW + 900_000,
    expiresAt: NOW + 360_000,
    paidAt: null,
    expiryNotified: false,
    paidNoticeSent: false,
    ...over,
  };
}

function tx(over: Partial<PeyTransaction> = {}): PeyTransaction {
  return {
    id: "tx_1",
    status: "PAID",
    amountCents: 10_000,
    breakdown: { baseCents: 10_000, tipCents: 0, feeCents: 300 },
    currency: "MXN",
    paymentMethod: "CODI",
    payableType: "API_CODI_PN",
    payableId: "codi_1",
    description: "Comida",
    applicationFeeCents: 0,
    dateCreated: NOW,
    datePaid: NOW,
    chargeId: null,
    ...over,
  };
}

test("contraseñas: scrypt verifica, rechaza y no se rompe con basura", async () => {
  const hash = await hashPassword("una-contraseña-larguísima");
  assert.ok(hash.startsWith("scrypt$16384$8$1$"));
  assert.equal(await verifyPassword("una-contraseña-larguísima", hash), true);
  assert.equal(await verifyPassword("otra", hash), false);
  // Un .env mal escrito no debe lanzar, solo negar el acceso.
  for (const bad of ["", "scrypt$", "scrypt$a$b$c$d$e", "bcrypt$1$1$1$aa$bb", "scrypt$99$8$1$aa$bb"]) {
    assert.equal(await verifyPassword("x", bad), false, bad);
  }
  // Dos hashes de la misma contraseña difieren: la sal es nueva cada vez.
  assert.notEqual(hash, await hashPassword("una-contraseña-larguísima"));
});

test("ADMIN_USERS se parsea y el panel se apaga sin configuración", () => {
  const users = parseAdminUsers("Ana:scrypt$16384$8$1$aa$bb, luis:scrypt$16384$8$1$cc$dd");
  assert.equal(users.length, 2);
  assert.equal(users[0].user, "ana");
  assert.equal(users[0].passwordHash, "scrypt$16384$8$1$aa$bb");
  // Repetido, vacío y sin ":" se descartan.
  assert.equal(parseAdminUsers("ana:h,ana:otro").length, 1);
  assert.equal(parseAdminUsers("sinhash").length, 0);
  assert.equal(parseAdminUsers(undefined).length, 0);

  const off = loadAuthConfig({} as NodeJS.ProcessEnv);
  assert.equal(off.users.length, 0);
  assert.equal(off.cookieSecure, true);
  assert.equal(off.trustProxy, false);
  // Un secreto corto es un error de despliegue, no algo que se ignore.
  assert.throws(() =>
    loadAuthConfig({ ADMIN_USERS: "ana:h", ADMIN_SESSION_SECRET: "corto" } as NodeJS.ProcessEnv),
  );
});

test("la sesión se firma, caduca y no se puede alterar", () => {
  const { token, session } = createSession(SECRET, "ana", NOW, 3_600_000);
  assert.equal(readSession(SECRET, token, NOW)?.user, "ana");
  assert.equal(session.expiresAt, NOW + 3_600_000);
  // Vencida.
  assert.equal(readSession(SECRET, token, NOW + 3_600_001), null);
  // Otra llave.
  assert.equal(readSession("y".repeat(40), token, NOW), null);
  // Payload alterado: la firma deja de cuadrar.
  const forged = `${Buffer.from(JSON.stringify({ user: "root", sid: "s", expiresAt: NOW + 9e9 })).toString("base64url")}.${token.split(".")[1]}`;
  assert.equal(readSession(SECRET, forged, NOW), null);
  assert.equal(readSession(SECRET, undefined, NOW), null);
  assert.equal(readSession(SECRET, "sinpunto", NOW), null);
});

test("cookies, CSRF y next solo apuntan adentro", () => {
  const jar = parseCookies("zaldo_admin=abc; zaldo_csrf=t1; otra=x");
  assert.equal(jar.zaldo_admin, "abc");
  assert.equal(jar.zaldo_csrf, "t1");
  assert.deepEqual(parseCookies(undefined), {});

  assert.equal(csrfOk("t1", "t1"), true);
  assert.equal(csrfOk("t1", "t2"), false);
  assert.equal(csrfOk(undefined, "t1"), false);

  assert.equal(safeNext("/admin/cobros"), "/admin/cobros");
  // Nada de mandar al usuario fuera del panel.
  assert.equal(safeNext("//evil.com"), undefined);
  assert.equal(safeNext("https://evil.com"), undefined);
  assert.equal(safeNext("/webhooks/pey"), undefined);
  assert.equal(safeNext(null), undefined);
});

test("el login acepta, niega y frena los intentos", async () => {
  const hash = await hashPassword("contraseña-de-prueba-1");
  const service = new AuthService({
    users: [{ user: "ana", passwordHash: hash }],
    sessionSecret: SECRET,
    sessionTtlMs: 3_600_000,
    maxAttempts: 3,
    lockoutMs: 600_000,
    cookieSecure: true,
    trustProxy: false,
  });
  assert.equal(service.enabled, true);

  const ok = await service.login("Ana", "contraseña-de-prueba-1", "ip1", NOW);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(service.session(ok.token, NOW)?.user, "ana");

  // Tres fallos desde otra IP y queda frenada.
  for (let i = 0; i < 3; i++) {
    const bad = await service.login("ana", "mala", "ip2", NOW);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.reason, "bad_credentials");
  }
  const locked = await service.login("ana", "contraseña-de-prueba-1", "ip2", NOW);
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.equal(locked.reason, "locked");
  // Pasado el castigo, vuelve a dejar entrar.
  const after = await service.login("ana", "contraseña-de-prueba-1", "ip2", NOW + 600_001);
  assert.equal(after.ok, true);

  // Un usuario que no existe se niega igual que una contraseña mala.
  const ghost = await service.login("nadie", "x", "ip3", NOW);
  assert.equal(ghost.ok, false);
  if (!ghost.ok) assert.equal(ghost.reason, "bad_credentials");

  // Sin admins, el panel está apagado.
  const off = new AuthService({
    users: [],
    sessionSecret: "",
    sessionTtlMs: 1,
    maxAttempts: 1,
    lockoutMs: 1,
    cookieSecure: true,
    trustProxy: false,
  });
  assert.equal(off.enabled, false);
  const disabled = await off.login("ana", "x", "ip", NOW);
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.reason, "disabled");
});

test("el freno se limpia cuando vence", () => {
  const throttle = new Throttle(2, 1_000);
  throttle.fail("k", NOW);
  assert.equal(throttle.retryAfterMs("k", NOW), 0);
  throttle.fail("k", NOW);
  assert.equal(throttle.retryAfterMs("k", NOW), 1_000);
  assert.equal(throttle.retryAfterMs("k", NOW + 1_001), 0);
  throttle.fail("k", NOW);
  throttle.succeed("k");
  assert.equal(throttle.retryAfterMs("k", NOW), 0);
});

test("las métricas cuentan el día de México y la conversión", () => {
  const ayer = NOW - 86_400_000;
  const charges = [
    charge({ id: "a", status: "paid", amountCents: 5_000, paidAt: NOW }),
    charge({ id: "b", status: "pending", amountCents: 2_500 }),
    charge({ id: "c", status: "expired", amountCents: 1_000 }),
    charge({ id: "d", status: "failed", amountCents: 900 }),
    charge({ id: "e", status: "cancelled", amountCents: 800 }),
    charge({ id: "f", status: "paid", amountCents: 3_000, createdAt: ayer, paidAt: ayer }),
  ];
  const metrics = computeMetrics(charges, NOW, 500_000);
  // Hoy confirmado = pagado + pendiente de hoy, sin el de ayer.
  assert.equal(metrics.todayCents, 7_500);
  assert.equal(metrics.todayPaidCents, 5_000);
  assert.equal(metrics.pendingCents, 2_500);
  assert.equal(metrics.paidCents, 8_000);
  assert.equal(metrics.paidCount, 2);
  assert.equal(metrics.expiredCount, 1);
  assert.equal(metrics.failedCount, 1);
  // Cancelado y fallido nunca llegaron a Pey: 2 pagados de 4 que sí llegaron.
  assert.equal(metrics.conversionPct, 50);
  assert.equal(computeMetrics([], NOW, 500_000).conversionPct, null);

  const series = dailySeries(charges, NOW, 3);
  assert.equal(series.length, 3);
  assert.equal(series.at(-1)?.paidCents, 5_000);
  assert.equal(series.at(-2)?.paidCents, 3_000);
});

test("los filtros y el paginado del listado de cobros", () => {
  const charges = [
    charge({ id: "a", concept: "Renta", status: "paid", method: "link" }),
    charge({ id: "b", concept: "Taco", status: "pending", method: "push", createdAt: NOW - 1_000 }),
    charge({ id: "c", concept: "Café", status: "paid", method: "qr", owner: "521552", createdAt: NOW - 2_000 }),
  ];
  // Lo más nuevo primero.
  assert.deepEqual(filterCharges(charges, { page: 1, perPage: 10 }).rows.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(filterCharges(charges, { status: "paid", page: 1, perPage: 10 }).rows.map((r) => r.id), ["a", "c"]);
  assert.deepEqual(filterCharges(charges, { method: "qr", page: 1, perPage: 10 }).rows.map((r) => r.id), ["c"]);
  assert.deepEqual(filterCharges(charges, { owner: "521552", page: 1, perPage: 10 }).rows.map((r) => r.id), ["c"]);
  // La búsqueda ignora acentos de más y mayúsculas.
  assert.deepEqual(filterCharges(charges, { q: "taco", page: 1, perPage: 10 }).rows.map((r) => r.id), ["b"]);
  assert.deepEqual(filterCharges(charges, { q: "1234567", page: 1, perPage: 10 }).rows.length, 3);

  const page2 = filterCharges(charges, { page: 2, perPage: 2 });
  assert.equal(page2.pages, 2);
  assert.deepEqual(page2.rows.map((r) => r.id), ["c"]);
  // Una página fuera de rango se acota, no truena.
  assert.equal(filterCharges(charges, { page: 99, perPage: 2 }).page, 2);
});

test("el CSV escapa comillas y neutraliza fórmulas", () => {
  const csv = chargesToCsv([
    charge({ concept: 'Dijo "hola"', payerName: "=CMD()", amountCents: 12_345 }),
  ]);
  const [header, row] = csv.trimEnd().split("\r\n");
  assert.ok(header.startsWith("id,owner,payerName"));
  assert.ok(row.includes('"Dijo ""hola"""'));
  // Excel no debe ejecutar una celda que empieza por "=".
  assert.ok(row.includes(`"'=CMD()"`));
  assert.ok(row.includes('"123.45"'));
});

test("el resumen por usuario junta cobros, contactos y apuntes", () => {
  const store = memoryStore();
  store.insertCharge(charge({ id: "a", status: "paid", amountCents: 5_000, paidAt: NOW }));
  store.insertCharge(charge({ id: "b", status: "pending", amountCents: 2_000 }));
  store.upsertContact({ owner: OWNER, name: "Ana", phone: "5511111111" });
  store.insertNote({ id: "n1", owner: OWNER, kind: "gasto", amountCents: 500, concept: "Café", who: null, createdAt: NOW });

  const [summary] = ownerSummaries(store, store.listCharges());
  assert.equal(summary.owner, OWNER);
  assert.equal(summary.charges, 2);
  assert.equal(summary.paidCents, 5_000);
  assert.equal(summary.pendingCents, 2_000);
  assert.equal(summary.contacts, 1);
  assert.equal(summary.notes, 1);
});

test("el celular se enmascara y nunca se muestra completo", () => {
  assert.equal(maskPhone("5215511111111"), "52•••••111");
  assert.equal(maskPhone(null), "—");
  assert.ok(!maskPhone("5511111111").includes("5511111111"));
});

test("Pey: una transacción se lee en centavos y con su chargeId", () => {
  const parsed = parseTransaction({
    id: "tx_9",
    status: "PAID",
    amount: 123.45,
    amountBreakdown: { base: 120, tip: 0, fee: 3.45 },
    currency: "MXN",
    paymentMethod: "CODI",
    payableType: "API_CODI_PN",
    payableId: "pn_1",
    description: "Comida",
    applicationFee: 0,
    dateCreated: 1763143200,
    datePaid: 1763143500,
    metadata: { chargeId: "abc" },
  });
  assert.ok(parsed);
  // Pesos con decimales entran como centavos enteros: nada de flotantes.
  assert.equal(parsed.amountCents, 12_345);
  assert.equal(parsed.breakdown?.feeCents, 345);
  assert.equal(parsed.chargeId, "abc");
  // Segundos de Pey, milisegundos adentro.
  assert.equal(parsed.datePaid, 1763143500000);
  // El chargeId también se lee anidado, como lo manda el endpoint de CLABE.
  assert.equal(parseTransaction({ id: "t", metadata: { externalMetadata: { chargeId: "z" } } })?.chargeId, "z");
  assert.equal(parseTransaction({ sinId: true }), null);
});

test("los totales de Pey separan comisión, neto y método", () => {
  const totals = sumTotals([
    tx({ id: "t1", amountCents: 10_000, breakdown: { baseCents: 10_000, tipCents: 0, feeCents: 300 } }),
    tx({ id: "t2", amountCents: 5_000, paymentMethod: "CARD", payableType: "PAYMENT_LINK", breakdown: { baseCents: 5_000, tipCents: 200, feeCents: 150 } }),
    tx({ id: "t3", status: "PENDING", amountCents: 2_000 }),
  ]);
  assert.equal(totals.paidCents, 15_000);
  assert.equal(totals.paidCount, 2);
  assert.equal(totals.feeCents, 450);
  // Neto = cobrado menos la comisión que Pey ya descontó.
  assert.equal(totals.netCents, 14_550);
  assert.equal(totals.pendingCents, 2_000);
  assert.equal(totals.byMethod.codi, 10_000);
  assert.equal(totals.byMethod.card, 5_000);
  assert.equal(totals.byPayable.link, 5_000);
});

test("la conciliación detecta el webhook perdido y el cobro ajeno", () => {
  const charges = [
    // Pey dice pagado, Zaldo sigue en pending: webhook perdido.
    charge({ id: "c1", status: "pending" }),
    // Zaldo dice pagado y Pey no lo reporta.
    charge({ id: "c2", status: "paid", paidAt: NOW, peyTransactionId: "tx_fantasma" }),
  ];
  const mismatches = findMismatches(charges, [
    tx({ id: "tx_1", chargeId: "c1" }),
    // Esta no corresponde a ningún cobro de Zaldo.
    tx({ id: "tx_ajena", chargeId: null, payableId: "otro", amountCents: 7_700 }),
  ]);
  const kinds = mismatches.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ["pagado_en_pey_no_en_zaldo", "pagado_en_zaldo_no_en_pey", "sin_cobro_local"]);

  // Cuando todo cuadra, no hay descuadres.
  assert.equal(
    findMismatches([charge({ id: "ok", status: "paid", paidAt: NOW })], [tx({ id: "tx", chargeId: "ok" })]).length,
    0,
  );
  // Monto distinto se reporta aparte.
  const amount = findMismatches(
    [charge({ id: "m", status: "paid", amountCents: 10_000, paidAt: NOW })],
    [tx({ id: "tx", chargeId: "m", amountCents: 9_000 })],
  );
  assert.ok(amount.some((item) => item.kind === "monto_distinto"));
});

test("reconcile pagina, respeta la ventana y sobrevive a un fallo de Pey", async () => {
  const store = memoryStore();
  store.insertCharge(charge({ id: "c1", status: "pending" }));

  let calls = 0;
  const pey: PeyReader = {
    async transactionsByApiKey(token) {
      calls += 1;
      if (!token) return { items: [tx({ id: "tx_1", chargeId: "c1" })], nextToken: "p2" };
      // Página vieja: cae fuera de la ventana y corta el recorrido.
      return { items: [tx({ id: "tx_old", dateCreated: NOW - 90 * 86_400_000 })], nextToken: "p3" };
    },
  };
  const result = await reconcile(pey, store, NOW, { maxPages: 5 });
  assert.equal(calls, 2);
  // La transacción vieja no cuenta en los totales.
  assert.equal(result.transactions.length, 1);
  assert.equal(result.totals.paidCents, 10_000);
  assert.equal(result.error, null);
  assert.ok(result.mismatches.some((m) => m.kind === "pagado_en_pey_no_en_zaldo"));

  const broken: PeyReader = {
    async transactionsByApiKey() {
      throw new Error("Pey respondió 500");
    },
  };
  const failed = await reconcile(broken, store, NOW);
  // Un fallo de Pey se reporta, no tumba el panel ni inventa descuadres.
  assert.equal(failed.error, "Pey respondió 500");
  assert.deepEqual(failed.mismatches, []);
});

test("la caché evita llamadas de más y el botón de actualizar las fuerza", async () => {
  const store = memoryStore();
  let calls = 0;
  const pey: PeyReader = {
    async transactionsByApiKey() {
      calls += 1;
      return { items: [tx({ id: "tx_1" })], nextToken: null };
    },
  };
  const cache = new ReconcileCache(pey, store, 60_000);
  await cache.get(NOW);
  await cache.get(NOW + 1_000);
  assert.equal(calls, 1, "dentro del TTL no se vuelve a pedir");
  await cache.get(NOW + 61_000);
  assert.equal(calls, 2, "pasado el TTL sí");
  await cache.get(NOW + 61_000, true);
  assert.equal(calls, 3, "forzar salta la caché");
  cache.invalidate();
  await cache.get(NOW + 61_000);
  assert.equal(calls, 4, "invalidar obliga a releer");

  // Dos cargas a la vez comparten una sola llamada.
  const cache2 = new ReconcileCache(pey, store, 60_000);
  const before = calls;
  await Promise.all([cache2.get(NOW), cache2.get(NOW), cache2.get(NOW)]);
  assert.equal(calls, before + 1);
});

test("reparar confirma contra Pey y solo arregla el cobro que corresponde", async () => {
  function withCharge(over: Partial<Charge> = {}): Store {
    const store = memoryStore();
    store.insertCharge(charge({ id: "c1", status: "pending", ...over }));
    return store;
  }
  const reader = (transaction: PeyTransaction | null): PeyReader => ({
    async transactionsByApiKey() {
      return { items: [], nextToken: null };
    },
    async transaction() {
      return transaction;
    },
  });

  // Caso bueno: Pey lo confirma pagado y el libro se corrige.
  const store = withCharge();
  const ok = await repairCharge(reader(tx({ id: "tx_1", chargeId: "c1" })), store, "c1", "tx_1", NOW);
  assert.equal(ok.ok, true);
  const fixed = store.getCharge("c1");
  assert.equal(fixed?.status, "paid");
  assert.equal(fixed?.paidAt, NOW);
  // No reabrimos el aviso de WhatsApp: ya se vio en el panel.
  assert.equal(fixed?.paidNoticeSent, true);

  // Pey no la tiene pagada: no tocamos nada.
  const pending = withCharge();
  const no = await repairCharge(reader(tx({ status: "PENDING", chargeId: "c1" })), pending, "c1", "tx_1", NOW);
  assert.equal(no.ok, false);
  assert.equal(pending.getCharge("c1")?.status, "pending");

  // Una transacción de otro cobro no sirve para marcar este.
  const other = withCharge();
  const mismatched = await repairCharge(reader(tx({ id: "tx_x", chargeId: "otro" })), other, "c1", "tx_x", NOW);
  assert.equal(mismatched.ok, false);
  assert.equal(other.getCharge("c1")?.status, "pending");

  // Pey no conoce la transacción.
  const unknown = await repairCharge(reader(null), withCharge(), "c1", "tx_1", NOW);
  assert.equal(unknown.ok, false);

  // Ya estaba pagado, o el cobro no existe.
  assert.equal((await repairCharge(reader(tx()), withCharge({ status: "paid" }), "c1", "tx_1", NOW)).ok, false);
  assert.equal((await repairCharge(reader(tx()), memoryStore(), "nada", "tx_1", NOW)).ok, false);
});

test("el celular del dueño no viaja en las URL del panel", () => {
  const secret = "s".repeat(40);
  const ref = ownerRef(OWNER, secret);
  // Un ref es opaco, corto y estable.
  assert.match(ref, /^[0-9a-f]{16}$/);
  assert.equal(ownerRef(OWNER, secret), ref);
  // Con otro secreto cambia: no se puede adivinar desde fuera.
  assert.notEqual(ownerRef(OWNER, "x".repeat(40)), ref);

  const store = memoryStore();
  store.insertCharge(charge({ owner: OWNER }));
  assert.equal(ownerFromRef(store, ref, secret), OWNER);
  assert.equal(ownerFromRef(store, "0".repeat(16), secret), null);
  assert.equal(ownerFromRef(store, "no-es-hex", secret), null);

  // Ni el dashboard ni la lista de usuarios deben imprimir el número.
  const refOf = (owner: string) => ownerRef(owner, secret);
  const charges = store.listCharges();
  const dash = renderDashboard(computeMetrics(charges, NOW, 500_000), dailySeries(charges, NOW, 3), charges, refOf);
  const list = renderOwners(ownerSummaries(store, charges), refOf);
  for (const [name, html] of [["dashboard", dash], ["usuarios", list]] as const) {
    assert.ok(!html.includes(OWNER), `${name} no debe incluir el celular del dueño`);
    assert.ok(!html.includes("5511111111"), `${name} no debe incluir el celular del pagador`);
    assert.ok(html.includes(ref), `${name} debe enlazar por ref`);
  }
});
