/**
 * Lo que la persona dijo, leído de sus propios mensajes.
 *
 * El modelo a veces omite un dato que sí venía (el nombre del cliente), a
 * veces lo inventa (un celular sacado de la nada) y a veces hace algo que
 * nadie pidió (borrar un apunte, cambiar el catálogo). Estas funciones cotejan
 * cada cosa contra el texto de la persona, sin modelo de por medio.
 */
import { readings } from "./montos.js";

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** ¿Ese celular aparece en lo que escribió la persona? "55 22 22 33 33" y "+52 55…" cuentan. */
export function saidPhone(texts: string[], phone: string): boolean {
  if (!/^\d{10}$/.test(phone)) return false;
  return texts.some((text) => text.replace(/[^\d]/g, "").includes(phone));
}

const NOT_A_NAME = new Set([
  "mi", "mis", "tu", "su", "sus", "el", "la", "los", "las", "un", "una", "unos", "unas", "todos", "todas", "alguien", "nadie",
  "cliente", "clienta", "clientes", "persona", "ella", "ellos", "usted", "ustedes", "quien", "que", "cada", "partir",
  "ver", "las", "pagar", "cobrar", "favor", "tiempo", "veces", "medias", "credito", "contado", "plazos", "domicilio",
  "cuenta", "tarjeta", "banco", "celular", "cel", "numero", "whats", "whatsapp", "link", "qr", "mitad", "meses", "nombre",
  "partes", "pagos", "esta", "este", "ese", "esa", "mismo", "misma", "otro", "otra",
]);

/**
 * A quién le cobran, cuando lo dice el mensaje: "cóbrale 200 a Ana 5522…",
 * "mándale el cobro a la señora María", "cóbrale a mi comadre". El modelo deja
 * fuera el nombre muy seguido; sin él, "¿ya pagó Ana?" no encuentra nada.
 */
export function spokenPayer(texts: string[]): string | null {
  const last = texts[texts.length - 1] ?? "";
  if (!/c[oó]bra(le|selo)|m[aá]nda(le|selo)|env[ií]a(le|selo)|p[aá]sa(le|selo)/i.test(last)) return null;
  const pattern =
    /\ba(?:l)?\s+((?:mi\s+|la\s+|el\s+)?(?:se[ñn]ora?\s+|se[ñn]orita\s+|do[ñn]a\s+|don\s+|profe\s+|doctor[a]?\s+|dr[a]?\.?\s+)?)([A-Za-zÁÉÍÓÚÑáéíóúñü]{2,})(\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñü]{2,})?/g;
  for (const match of last.matchAll(pattern)) {
    const lead = (match[1] ?? "").trim();
    const word = match[2] ?? "";
    if (NOT_A_NAME.has(plain(word))) {
      // "a mi comadre", "a la vecina": con artículo o posesivo, lo que sigue es a quién.
      continue;
    }
    const full = `${lead ? `${lead} ` : ""}${word}${match[3] ?? ""}`.replace(/\s+/g, " ").trim();
    // Sin título ni mayúscula, una palabra suelta tras "a" suele no ser un nombre ("a domicilio").
    if (!lead && !/^[A-ZÁÉÍÓÚÑ]/.test(word) && !/\d{10}|su (cel|celular|n[uú]mero)/i.test(last)) continue;
    return full.slice(0, 40);
  }
  // "a mi comadre", "a la vecina", "a mi hermano Luis".
  const kin = /\ba\s+(mi|la|el)\s+([a-záéíóúñü]{3,})(\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñü]{2,})?/i.exec(last);
  if (kin && !NOT_A_NAME.has(plain(kin[2] ?? ""))) {
    return `${(kin[1] ?? "").toLowerCase()} ${kin[2]}${kin[3] ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 40);
  }
  return null;
}

/** ¿Pidió borrar o corregir un apunte? Sin esto, undo_last no corre. */
export function wantsDelete(text: string): boolean {
  return /b[oó]rr|elimin|anula|cancela (ese|el|esa|la|mi) (apunte|gasto|venta|nota|[uú]ltim)|s[aá]calo|ese (gasto|apunte) no va|qu[ií]ta(lo|la|me)?\b|me equivoqu|equivocaci|deshaz|no era|no fue|estaba mal|est[aá] mal|corrige|corr[ií]gelo|no,? (fueron|eran|era|fue)\b|olv[ií]da (eso|ese|el [uú]ltimo)/i.test(
    text,
  );
}

/** ¿Habla de que alguien pagó o abonó? Sin esto, settle_debt no corre. */
export function saysPayment(text: string): boolean {
  return /pag[oó]|pagaron|transfiri|transferir|a mano\b|ya est[aá] pagad|pagu[eé]|abon|me dio|me dieron|le di\b|liquid|sald[oó]|ya me|ya le|deposit[oó]|transfiri[oó]|cubri[oó]|ya qued[oó]/i.test(
    text,
  );
}

/** ¿Pidió cambiar su catálogo? Sin esto, set_product no corre (salvo que conteste el precio que se le preguntó). */
export function wantsCatalogChange(text: string): boolean {
  // Un catálogo dictado: "tinte 450, corte 150 y barba 80".
  const pairs = text.match(/[a-záéíóúñü]{3,}\s+(a\s+|en\s+)?\$?\d+/gi) ?? [];
  if (pairs.length >= 2 && !/c[oó]bra|cobro|\bqr\b|\blink\b|gast|pagu|pag[oó]|deb/i.test(text)) return true;
  return /agrega|a[ñn]ade|anade|sube|s[uú]bele|baja|b[aá]jale|cambia|pon(le|me)?\b|guarda|registra|quita|borra|elimina|precio|cat[aá]logo|ahora (cuesta|vale|es)|cuesta|vale\b|vendo|manejo/i.test(
    text,
  );
}

/** ¿Pidió que se recuerde algo? Sin esto, remember no corre. */
export function wantsMemory(text: string): boolean {
  return /recuerd|acu[eé]rdate|ap[uú]ntate que|que no se te pase|^\s*ojo\b|no le f[ií]es|ten presente|no (se te )?olvides?|no olvides|ten en cuenta|toma nota|anota que|apunta que|para que sepas|que sepas que|gu[aá]rdate/i.test(
    text,
  );
}

export function mentionsTip(texts: string[]): boolean {
  return texts.slice(-3).some((text) => /propina|tip\b/i.test(text));
}

/** Una pregunta hipotética no es un movimiento: "¿qué pasaría si gasto 3000?". */
export function hypothetical(text: string): boolean {
  return /qu[eé] pasar[ií]a|qu[eé] pasa si|si (gasto|gastara|gastase|vendo|vendiera|cobro|cobrara|compro|comprara)\b|supongamos|sup[oó]n que|imagina|hipot[eé]tic|cu[aá]nto ser[ií]a|cu[aá]nto me quedar[ií]a/i.test(
    text,
  );
}

/** Los recurrentes son por semana, quincena o mes: "cada día" no existe. */
export function asksDaily(text: string): boolean {
  return /cada d[ií]a|diari[oa]|todos los d[ií]as|cada hora|cada \d+ (horas|minutos|d[ií]as)/i.test(text);
}

/** "150 más 20 de envío", "1.00 + 499": dos montos que se suman. Devuelve [a, b] en pesos. */
export function plusPair(text: string): [number, number] | null {
  const match = /(\$?\s*\d[\d.,]*)\s*(?:pesos\s*)?(?:m[aá]s|\+)\s*(\$?\s*\d[\d.,]*)(?![\d.,]*\s*(?:%|por ?ciento))/i.exec(text);
  if (!match) return null;
  const a = readings((match[1] ?? "").trim().replace(/[.,]+$/, ""))[0];
  const b = readings((match[2] ?? "").trim().replace(/[.,]+$/, ""))[0];
  return a !== undefined && b !== undefined && a > 0 && b > 0 ? [a, b] : null;
}

const JUNK_CONCEPT = new Set([
  "pesos", "peso", "varos", "varo", "bolas", "baros", "baro", "feria", "lana", "morralla", "xfa", "xfavor", "porfa", "porfis",
  "por favor", "favor", "dls", "dolares", "usd", "mxn", "iva", "mas iva", "ya", "cobro", "un cobro", "el cobro", "pago", "un pago",
  "dinero", "luca", "lucas", "efectivo", "tarjeta", "qr", "link", "codi", "mi", "x", "a", "de", "persona", "personas",
]);

/** Un concepto que no dice nada ("varos", "xfa", "IVA") no se manda: mejor ninguno. */
export function cleanConcept(concept: string | null): string | null {
  if (!concept) return null;
  const text = concept.replace(/\s+/g, " ").trim();
  if (text.length < 2 || JUNK_CONCEPT.has(plain(text))) return null;
  return text;
}

/**
 * "150 de uñas", "500 de renta a Ana", "cobra el viaje de 85", "la clase de
 * mate": el concepto que dijo la persona, si el modelo no lo mandó.
 */
export function spokenConcept(texts: string[]): string | null {
  const last = texts[texts.length - 1] ?? "";
  const stop = /^(para|cada|con|por|que|del|sus?|mis?|porfa|favor|al|a|y|de|en|su|hoy|ya)$/i;
  const trim = (raw: string) => {
    const words = raw.trim().split(/\s+/);
    const cut = words.findIndex((word, index) => index > 0 && stop.test(word));
    return cleanConcept((cut === -1 ? words : words.slice(0, cut)).join(" "));
  };
  // "150 de uñas", "500 pesos de renta a Ana cada mes"
  const after = /\d\s*(?:pesos\s+|varos\s+)?(?:de|por concepto de)\s+((?:la |el |los |las |un |una |unos |unas |mi |su )?[a-záéíóúñü]{3,}(?:\s+[a-záéíóúñü]{2,}){0,2})/i.exec(last);
  if (after?.[1]) {
    const concept = trim(after[1]);
    if (concept && !/^(prueba de|pesos|varos)$/i.test(concept)) return concept;
  }
  // "cobra el viaje de 85", "cóbrale la clase de mate 200"
  const before = /c[oó]bra(?:le|me|selo)?\s+(?:el|la|los|las|un|una|unos|unas)\s+([a-záéíóúñü]{3,}(?:\s+de\s+[a-záéíóúñü]{3,})?)(?=[^\d]{0,25}\d)/i.exec(last);
  if (before?.[1]) return cleanConcept(before[1]);
  return null;
}

/**
 * ¿Ese es el nombre de quien escribe? "me llamo Isabel", "soy Toro" (con
 * mayúscula: "soy dentista" es un oficio), o el puro nombre como respuesta.
 */
export function saidOwnName(texts: string[], name: string): boolean {
  const key = plain(name.trim());
  if (!key) return false;
  return texts.some((text) => {
    const folded = plain(text.trim());
    if (folded === key) return true;
    const at = folded.indexOf(key);
    if (at === -1) return false;
    const before = folded.slice(0, at);
    if (/(me llamo|mi nombre es|me dicen|me puedes decir|puedes llamarme|llamame|dime)\s*(el |la )?$/.test(before)) return true;
    // "soy X": solo si X viene con mayúscula en lo que escribió ("soy dentista" es un oficio).
    if (!/(soy|habla|aqui)\s*(el |la )?$/.test(before)) return false;
    const first = key.split(" ")[0] ?? "";
    for (const match of text.matchAll(/(?:soy|habla|aqu[ií])\s+(?:el\s+|la\s+)?([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü]+)/g)) {
      if (plain(match[1] ?? "") === first) return true;
    }
    return false;
  });
}
