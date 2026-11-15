import assert from "node:assert/strict";
import test from "node:test";
import { derivable, eitherOr, foreignCurrency, mentions, readings, saidAmount, soleMoney } from "../src/montos.js";

test("un número escrito se lee como lo escribe la gente", () => {
  assert.deepEqual(readings("150"), [150]);
  assert.deepEqual(readings("1,500"), [1500]);
  assert.deepEqual(readings("1,500.50"), [1500.5]);
  assert.deepEqual(readings("$1,500.50"), [1500.5]);
  assert.deepEqual(readings("1 500"), [1500]);
  assert.deepEqual(readings("150,50"), [150.5]);
  assert.deepEqual(readings(".50"), [0.5]);
  assert.deepEqual(readings("0.01"), [0.01]);
  // "1.500" es casi siempre mil quinientos; uno cincuenta queda como segunda lectura.
  assert.deepEqual(readings("1.500"), [1500, 1.5]);
  assert.deepEqual(readings("15.000"), [15000, 15]);
  assert.deepEqual(readings("99.999"), [99999, 99.999]);
  assert.deepEqual(readings("1.500,50"), [1500.5]);
  assert.deepEqual(readings("abc"), []);
});

test("los montos de un mensaje: k, mil, millones, centavos; nunca un celular", () => {
  const first = (text: string) => mentions(text).map((item) => item.values[0]);
  assert.deepEqual(first("cobra 2.5k"), [2500]);
  assert.deepEqual(first("cobra 1,5 mil"), [1500]);
  assert.deepEqual(first("cobra 15 mil"), [15000]);
  assert.deepEqual(first("cobra 1k"), [1000]);
  assert.deepEqual(first("cobra 2 millones"), [2_000_000]);
  assert.deepEqual(first("cobra medio millón"), [500_000]);
  assert.deepEqual(first("cobra 1 500"), [1500]);
  assert.deepEqual(first("cobra 50 centavos"), [0.5]);
  assert.deepEqual(first("cóbrale 200 a Ana 5522223333"), [200]);
  assert.deepEqual(first("mi CLABE es 012180015826225713 y cobra 80"), [80]);
  assert.deepEqual(first("2 cortes a 150 con 10% de descuento"), [2, 150, 10]);
  assert.equal(mentions("con 10% de descuento")[0]?.percent, true);
  assert.equal(mentions("10 por ciento")[0]?.percent, true);
  assert.equal(mentions("cobra 150")[0]?.money, false, "un número suelto no se dijo como dinero");
  assert.equal(mentions("cobra $150")[0]?.money, true);
  assert.equal(mentions("cobra 150 pesos")[0]?.money, true);
});

test("¿la persona dijo ese monto?", () => {
  const said = (text: string, pesos: number) => saidAmount([text], Math.round(pesos * 100));
  assert.equal(said("cobra 150", 150), true);
  assert.equal(said("cobra 150", 15), false);
  assert.equal(said("cobra 2.5k", 2500), true);
  assert.equal(said("cobra 2.5k", 2.5), false, "2.5k no son dos pesos cincuenta");
  assert.equal(said("cobra 1,5 mil", 1500), true);
  assert.equal(said("cobra 1.500", 1500), true);
  assert.equal(said("cobra 1.500", 1.5), true, "la otra lectura también vale si es la que mandan");
  assert.equal(said("cobra 15.000 pesos", 15000), true);
  assert.equal(said("cobra 1 500", 1500), true);
  assert.equal(said("cobra 1 500", 500), false);
  assert.equal(said("cobra .50", 0.5), true);
  assert.equal(said("cobra 150 pesos con 50 centavos", 150.5), true);
  assert.equal(said("cobra 50 centavos", 0.5), true);
  assert.equal(said("cobra 50 centavos", 50), false);
  assert.equal(said("cóbrale 200 a Ana 5522223333", 200), true);
  assert.equal(said("con 10% de descuento", 10), false, "un porcentaje no es un monto");
  assert.equal(said("cobra una gringa", 60), false);
});

test("el único monto dicho como dinero corrige al modelo; con dos, no se adivina", () => {
  assert.equal(soleMoney("dame un QR de 0.01 de prueba"), 1);
  assert.equal(soleMoney("cobra 2.5k"), 250_000);
  assert.equal(soleMoney("cobra 1,5 mil"), 150_000);
  assert.equal(soleMoney("cobra 150 pesos de uñas"), 15_000);
  assert.equal(soleMoney("cobra $80 de un corte"), 8_000);
  assert.equal(soleMoney("cobra 150 pesos con 50 centavos"), 15_050);
  assert.equal(soleMoney("cobra 50 centavos de un chicle"), 50);
  assert.equal(soleMoney("cobra 150 pesos y 300 pesos"), null);
  assert.equal(soleMoney("cobra 3 tintes"), null, "una cantidad suelta no es dinero");
  assert.equal(soleMoney("cobra una gringa"), null);
  assert.deepEqual(eitherOr("cobra 150 o 200, no me acuerdo"), [15_000, 20_000]);
  assert.equal(eitherOr("cobra 150"), null);
  assert.equal(eitherOr("cobra 2 cortes o un tinte"), null);
  assert.equal(foreignCurrency("cobra 150 dls"), true);
  assert.equal(foreignCurrency("cobra 20 USD"), true);
  assert.equal(foreignCurrency("cobra 150 pesos"), false);
});

test("una cuenta que la persona sí pidió es válida; un precio inventado no", () => {
  const ok = (text: string, pesos: number, extras: number[] = []) => derivable(Math.round(pesos * 100), [text], extras);
  assert.equal(ok("cobra 150 más 20 de envío", 170), true);
  assert.equal(ok("cobra 100 pesos por persona, somos 4", 400), true);
  assert.equal(ok("cobra la mitad de 300", 150), true);
  assert.equal(ok("cobra el 50% de anticipo de 3000", 1500), true);
  assert.equal(ok("cobra 150 + IVA", 174), true);
  assert.equal(ok("cobra 150 más 16%", 174), true);
  assert.equal(ok("cobra 2 cortes a 150 cada uno", 300), true);
  assert.equal(ok("cobra 2 cortes a 150 más 50 de envío", 350), true);
  assert.equal(ok("cobra 150 entre 3", 50), true);
  assert.equal(ok("3 x 50", 150), true);
  assert.equal(ok("cobra 500 con 10% de descuento", 450), true);
  assert.equal(ok("cobra 200 con 15% de propina", 230), true);
  // Sobre el cobro anterior, solo si el mensaje se refiere a él.
  assert.equal(ok("mejor el doble", 300, [150]), true);
  assert.equal(ok("bájale a la mitad", 150, [300]), true);
  assert.equal(ok("súbele 50", 200, [150]), true);
  assert.equal(ok("quítale 20", 130, [150]), true);
  assert.equal(ok("con 10% de descuento", 270, [300]), true);
  assert.equal(ok("cobra 3 tintes", 450, [150]), false, "el cobro anterior no es el precio del tinte");
  // Lo que nadie dijo no pasa.
  assert.equal(ok("cobra una gringa", 60), false);
  assert.equal(ok("cobra dos gringas", 130), false);
  assert.equal(ok("cobra 150", 999), false);
  assert.equal(ok("cobra 150 más 20 de envío", 200), false);
});
