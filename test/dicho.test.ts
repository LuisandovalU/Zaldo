import assert from "node:assert/strict";
import test from "node:test";
import {
  asksDaily,
  cleanConcept,
  hypothetical,
  plusPair,
  saidOwnName,
  saidPhone,
  saysPayment,
  spokenConcept,
  spokenPayer,
  wantsCatalogChange,
  wantsDelete,
  wantsMemory,
} from "../src/dicho.js";

test("el celular de un cobro tiene que haberlo dicho la persona", () => {
  assert.equal(saidPhone(["cóbrale 200 a Ana 5522223333"], "5522223333"), true);
  assert.equal(saidPhone(["su cel es 55 22 22 33 33"], "5522223333"), true);
  assert.equal(saidPhone(["su número es +52 1 55 2222 3333"], "5522223333"), true);
  assert.equal(saidPhone(["cóbrale a Ana"], "5522223333"), false, "el modelo lo sacó de otro lado");
  assert.equal(saidPhone(["cóbrale a Ana", "350"], "5522223333"), false);
  assert.equal(saidPhone(["5522223333"], "552222333"), false);
});

test("a quién le cobran, aunque el modelo deje fuera el nombre", () => {
  const who = (text: string) => spokenPayer([text]);
  assert.equal(who("cóbrale 200 a Ana 5522223333"), "Ana");
  assert.equal(who("cóbrale 200 a Ana, su cel es 5522223333"), "Ana");
  assert.equal(who("cóbrale ochenta pesos a pedro su cel es 55 22 22 33 33"), "pedro");
  assert.equal(who("mándale el cobro a la señora María 5522223333"), "la señora María");
  assert.equal(who("cóbrale 500 de renta a Ana cada mes, su cel es 5522223333"), "Ana");
  assert.equal(who("cóbrale a Ana María 5522223333"), "Ana María");
  assert.equal(who("cóbrale a mi comadre"), "mi comadre");
  assert.equal(who("cóbrale a mi hermano Luis"), "mi hermano Luis");
  assert.equal(who("cóbrale 300 a mi cliente"), null);
  assert.equal(who("cóbrale 300 al 5522223333"), null);
  assert.equal(who("cóbrale 150 a domicilio"), null);
  assert.equal(who("mándale 200 a la cuenta"), null);
  assert.equal(who("cobra 150"), null);
  assert.equal(who("cobra 2 cortes a 150 cada uno"), null);
});

test("lo que sí se pidió: borrar, abonar, cambiar el catálogo, recordar", () => {
  assert.equal(wantsDelete("me equivoqué, bórralo"), true);
  assert.equal(wantsDelete("no, fueron 90"), true);
  assert.equal(wantsDelete("quita el último"), true);
  assert.equal(wantsDelete("gasté 11 en chicles"), false, "un apunte nuevo no borra el anterior");
  assert.equal(wantsDelete("gasté 50 en café"), false);

  assert.equal(saysPayment("ya me pagó Ana"), true);
  assert.equal(saysPayment("Ana me abonó 120 en efectivo"), true);
  assert.equal(saysPayment("Ana ya me dio 100"), true);
  assert.equal(saysPayment("Ana me quedó a deber 50"), false, "otro fiado no es un pago");

  assert.equal(wantsCatalogChange("agrega corte a 150"), true);
  assert.equal(wantsCatalogChange("sube el gel a 250"), true);
  assert.equal(wantsCatalogChange("quita el gel"), true);
  assert.equal(wantsCatalogChange("cobra 2 cortes con 10% de descuento"), false);
  assert.equal(wantsCatalogChange("cobra 37.50 de unas sabritas y un refresco"), false);
  assert.equal(wantsCatalogChange("me pagaron 350.50 en efectivo de un tinte"), false);

  assert.equal(wantsMemory("recuerda que cierro a las 8"), true);
  assert.equal(wantsMemory("acuérdate que los lunes no abro"), true);
  assert.equal(wantsMemory("cóbrale 500 de renta a Ana cada mes"), false);
  assert.equal(wantsMemory("¿a qué hora cierro?"), false);

  assert.equal(hypothetical("¿qué pasaría si gasto 3000 en publicidad?"), true);
  assert.equal(hypothetical("gasté 3000 en publicidad"), false);
  assert.equal(asksDaily("cóbrale 100 a Ana cada día"), true);
  assert.equal(asksDaily("cóbrale 100 a Ana cada mes"), false);
  assert.deepEqual(plusPair("cobra 150 más 20 de envío"), [150, 20]);
  assert.deepEqual(plusPair("cobra 1.00 más 499 de envío"), [1, 499]);
  assert.equal(plusPair("cobra 150 más 16%"), null);
  assert.equal(plusPair("cobra 150"), null);
});

test("el concepto: el que dijo la persona, y nunca basura", () => {
  assert.equal(spokenConcept(["cobra 150 de uñas"]), "uñas");
  assert.equal(spokenConcept(["cóbrale 500 de renta a Ana cada mes, su cel es 5522223333"]), "renta");
  assert.equal(spokenConcept(["cobra el viaje de 85"]), "viaje");
  assert.equal(spokenConcept(["cóbrale la clase de mate 200 a la mamá de Dani"]), "clase de mate");
  assert.equal(spokenConcept(["dame un QR de 0.01 de prueba"]), "prueba");
  assert.equal(spokenConcept(["cobra 150"]), null);
  assert.equal(spokenConcept(["cobra 150 xfa"]), null);
  assert.equal(spokenConcept(["un QR de 50 para el mostrador"]), null);
  for (const junk of ["varos", "xfa", "IVA", "más IVA", "dls", "pesos", "bolas", "feria", "Cobro"]) {
    assert.equal(cleanConcept(junk), null, junk);
  }
  assert.equal(cleanConcept("uñas"), "uñas");
  assert.equal(cleanConcept("  renta   de noviembre "), "renta de noviembre");
});

test("el nombre de quien escribe, no su oficio ni el de un cliente", () => {
  assert.equal(saidOwnName(["me llamo Isabel"], "Isabel"), true);
  assert.equal(saidOwnName(["hola, soy Toro y vendo tacos"], "Toro"), true);
  assert.equal(saidOwnName(["Mario"], "Mario"), true);
  assert.equal(saidOwnName(["mi nombre es josé luis"], "José Luis"), true);
  assert.equal(saidOwnName(["soy dentista, cobra 500 de una limpieza"], "Dentista"), false);
  assert.equal(saidOwnName(["cóbrale 500 a Ana"], "Ana"), false);
  assert.equal(saidOwnName(["cobra 150"], "Cliente"), false);
});
