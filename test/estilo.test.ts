import assert from "node:assert/strict";
import test from "node:test";
import { optionList, whatsappStyle } from "../src/estilo.js";

test("la tarjeta de cobro: título en negritas, detalle en cita y la nota en cursivas", () => {
  const card = [
    "Cobro por $70.00",
    "2 × café · $35.00 c/u",
    "Le llega a: Ana · 55 4433 2211, en la app de su banco",
    "Por: notificación CoDi",
    'Modo de prueba: el pago va a la cuenta de pruebas de pey, no a tu banco, y no se devuelve. Para recibir en tu banco dime "registrar mi cuenta".',
    "",
    "Responde CONFIRMAR o CANCELAR",
  ].join("\n");
  assert.equal(
    whatsappStyle(card),
    [
      "🧾 *Cobro por $70.00*",
      "> 2 × café · *$35.00* c/u",
      "> Le llega a: Ana · 55 4433 2211, en la app de su banco",
      "> Por: notificación CoDi",
      '_Modo de prueba: el pago va a la cuenta de pruebas de pey, no a tu banco, y no se devuelve. Para recibir en tu banco dime "registrar mi cuenta"._',
      "",
      "Responde *CONFIRMAR* o *CANCELAR*",
    ].join("\n"),
  );
});

test("el corte, el catálogo y la ayuda", () => {
  assert.equal(
    whatsappStyle("Corte de hoy\nVentas CoDi: $0.00\nGastos: $250.00 (otros $250.00)\nTe queda: -$250.00"),
    "📊 *Corte de hoy*\n> Ventas CoDi: *$0.00*\n> Gastos: *$250.00* (otros *$250.00*)\n> Te queda: *-$250.00*",
  );
  assert.equal(whatsappStyle("Tu catálogo\ncafé · $35.00\ncorte dama · $1,200.00"), "📒 *Tu catálogo*\n- café · *$35.00*\n- corte dama · *$1,200.00*");
  assert.equal(
    whatsappStyle('Esto hago por ti:\n· Cobrar con CoDi: "cobra 150", "link de 500 con propina"\nEscríbeme o mándame nota de voz, como te salga.'),
    "*Esto hago por ti*\n- *Cobrar con CoDi:* `cobra 150`, `link de 500 con propina`\n_Escríbeme o mándame nota de voz, como te salga._",
  );
});

test("los avisos: lo importante en negritas, y los montos siempre", () => {
  assert.equal(
    whatsappStyle("Ya cayó: $70.00 de Ana. Confirmado por CoDi. Lo aboné a su fiado: le quedan $230.00."),
    "💸 *Ya cayó: $70.00* de Ana. Confirmado por CoDi. Lo aboné a su fiado: le quedan *$230.00*.",
  );
  assert.equal(
    whatsappStyle("Listo, ya salió. A Ana le llega la notificación CoDi por $70.00 en la app de su banco. Te aviso cuando caiga."),
    "✅ *Listo, ya salió.* A Ana le llega la notificación CoDi por *$70.00* en la app de su banco. Te aviso cuando caiga.",
  );
  assert.equal(whatsappStyle("Apuntado: gasto de $250.00 · leche (otros)."), "*Apuntado:* gasto de *$250.00* · leche (otros).");
  assert.equal(whatsappStyle("QR CoDi por $0.01. Vale 1 hora. Te aviso cuando caiga."), "QR CoDi por *$0.01*. Vale 1 hora. Te aviso cuando caiga.");
  assert.equal(whatsappStyle('El cobro de $50.00 a Ana venció sin pagarse. Dime "repítelo" y lo mando otra vez.'), '⌛ El cobro de *$50.00* a Ana venció sin pagarse. Dime "repítelo" y lo mando otra vez.');
  assert.equal(whatsappStyle("¿Cuál de los dos cobro?"), "¿Cuál de los dos cobro?");
  assert.equal(optionList(["$100.00", "$150.00"]), "- *$100.00*\n- *$150.00*");
});

test("lo que ya trae formato, y los enlaces, no se tocan", () => {
  // Vestir dos veces da lo mismo.
  const once = whatsappStyle("Cobro por $70.00\nPor: QR CoDi\n\nResponde CONFIRMAR o CANCELAR");
  assert.equal(whatsappStyle(once), once);
  // El modelo escribió negritas de markdown: quedan como las de WhatsApp, sin anidar asteriscos.
  assert.equal(whatsappStyle("Te quedan **$200.00** del tope de hoy."), "Te quedan *$200.00* del tope de hoy.");
  assert.equal(whatsappStyle("Va: *Ana* te debe $300.00."), "Va: *Ana* te debe $300.00.");
  const link = "https://zaldo.ih0st.app/cuenta?t=abc_def_ghi&monto=$5";
  assert.equal(whatsappStyle(`Registra tu cuenta aquí:\n${link}\nVale 30 minutos.`), `Registra tu cuenta aquí:\n${link}\nVale 30 minutos.`);
});
