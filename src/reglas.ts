/**
 * Lo que Zaldo no cobra ni guarda, diga lo que diga el modelo.
 *
 * Un cobro CoDi le llega a una persona en la app de su banco con un concepto
 * escrito por quien cobra. Las reglas del hackatón y los términos del API de
 * pey prohíben engañar al pagador sobre quién cobra y por qué, el phishing, y
 * giros como apuestas, préstamos, cripto y remesas. Estas listas son la última
 * barrera: el modelo ya está instruido, pero aquí se decide con código.
 */

/** Sin acentos y en minúsculas, para comparar. */
function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Nombres que un cobro no puede usar: hacerse pasar por ellos es suplantación. */
const IMPERSONATES =
  /\b(sat|hacienda|shcp|banxico|banco de mexico|condusef|cnbv|imss|issste|infonavit|fovissste|gobierno|policia|fiscalia|ministerio publico|juzgado|tribunal|aduana|bbva|bancomer|banamex|citibanamex|santander|banorte|hsbc|scotiabank|inbursa|banco azteca|bancoppel|afirme|banregio|nu bank|nubank|mercado pago|mercadopago|paypal|pey)\b/;

/** Urgencia y miedo: el tono del fraude. */
const PRESSURE =
  /\b(evita (el )?bloqueo|cuenta bloqueada|bloqueo de (tu |su )?cuenta|cargo de seguridad|pago seguro|verificacion de (cuenta|seguridad|identidad)|adeudo fiscal|embargo|orden de aprehension|ultimo aviso|pague hoy|paga hoy o|suspension del servicio|recibo (de luz )?vencido|reactiva(r)? tu cuenta|actualiza tus datos|ganaste|felicidades ganaste|paga el envio de tu premio)\b/;

/** Pedirle al pagador datos que nadie debe dar. */
const ASKS_SECRETS =
  /\b(nip|pin|contrasena|password|clave (de acceso|secreta|dinamica|bancaria|del banco)|token|cvv|codigo de (seguridad|verificacion)|numero de tarjeta|datos de (tu |su )?tarjeta|responde con|contesta con|envia tu|manda tu)\b/;

/** Amenazas: nunca son un concepto de cobro. */
const THREAT =
  /\b(o te|o le|si no pagas|si no paga|sabemos donde|tu familia|te va a pasar|consecuencias|secuestr|te vamos|los vamos|te voy a|levanton|derecho de piso|cuota de piso)\b/;

/** Giros que pey no permite sin autorización escrita (Anexo C de sus términos y §7.1 de las reglas). */
const RESTRICTED: [RegExp, string][] = [
  [/\b(apuesta|apuestas|casino|quiniela|momios|parlay|ruleta|poker|tragamonedas|loteria clandestina)\b/, "apuestas"],
  [/\b(interes semanal|interes diario|\d+ ?% (semanal|diario|a la semana|al dia)|gota a gota|montadeuda|agiotista|prestamos? con interes(es)?|presto con interes(es)?)\b/, "préstamos con interés"],
  [/\b(rifa|rifas|sorteo|sorteos|tanda con premio)\b/, "rifas y sorteos"],
  [/\b(cripto|criptomoneda|criptomonedas|bitcoin|btc|ethereum|usdt|tether|binance|trading|forex)\b/, "criptomonedas"],
  [/\b(remesa|remesas|envio de dinero al extranjero|western union|moneygram)\b/, "remesas"],
  [/\b(droga|drogas|marihuana|cocaina|fentanilo|metanfetamina|armas|pistola|municiones)\b/, "eso"],
  [/\b(piramide|esquema ponzi|multinivel de inversion|invierte y gana|duplica tu dinero|rendimiento garantizado)\b/, "esquemas de inversión"],
];

export interface Violation {
  kind: "suplantacion" | "datos" | "amenaza" | "giro";
  /** Lo que se le dice a quien cobra, tal cual. */
  message: string;
}

/**
 * ¿Ese concepto (o lo que pidió la persona) no se puede mandar como cobro?
 * `own` es el nombre del negocio de quien cobra: nombrarse a sí mismo sí se vale.
 */
export function chargeViolation(text: string, own = ""): Violation | null {
  const value = plain(text);
  const mine = plain(own);
  if (THREAT.test(value)) {
    return { kind: "amenaza", message: "Eso no lo mando: un cobro no lleva amenazas ni presión. Si es una deuda de verdad, dime el monto y un concepto claro." };
  }
  if (ASKS_SECRETS.test(value)) {
    return {
      kind: "datos",
      message: "Eso no lo mando: un cobro nunca le pide a nadie su NIP, contraseñas, tokens ni datos de tarjeta. Dime un concepto que diga qué estás cobrando.",
    };
  }
  const who = IMPERSONATES.exec(value);
  if (who && !(mine && mine.includes(who[0]))) {
    return {
      kind: "suplantacion",
      message: `Ese concepto no lo puedo mandar: no se puede cobrar a nombre de ${who[0].toUpperCase()} ni de otra institución o empresa. El cobro tiene que decir claro quién cobra y por qué. ¿Qué concepto le pongo?`,
    };
  }
  if (PRESSURE.test(value)) {
    return {
      kind: "suplantacion",
      message: "Ese concepto no lo puedo mandar: suena a aviso de banco, multa o premio, y eso confunde a quien paga. Dime qué estás cobrando en realidad.",
    };
  }
  for (const [pattern, label] of RESTRICTED) {
    if (pattern.test(value)) {
      return {
        kind: "giro",
        message: `Eso no lo cobro: las reglas de pey no permiten cobrar ${label} por CoDi sin una autorización especial.`,
      };
    }
  }
  return null;
}

const SECRET_WORDS =
  /\b(nip|pin|contrasena|password|clave|token|cvv|codigo de seguridad|combinacion|caja fuerte|usuario y|credenciales)\b/;

/** Un texto con secretos (o números de tarjeta o CLABE) que no se guardan en ningún lado. */
export function looksSensitive(text: string): boolean {
  const value = plain(text);
  if (SECRET_WORDS.test(value)) return true;
  // 13 a 19 dígitos seguidos (con o sin espacios o guiones): una tarjeta o una CLABE.
  return /(?:\d[ -]?){13,19}/.test(value);
}

/**
 * Una "cosa para recordar" que en realidad es una orden para el bot: cómo
 * hablar, qué decir, quién es. La memoria guarda datos del negocio, no reglas.
 */
export function looksLikeInstruction(text: string): boolean {
  const value = plain(text);
  return /\b(a partir de ahora|de ahora en adelante|desde ahora|siempre (di|responde|contesta|termina|empieza|firma|agrega|anade)|nunca (digas|respondas|pidas)|termina (cada|todos|tus)|empieza (cada|todos|tus)|firma (cada|todos|tus)|responde (como|en|con|siempre)|contesta (como|en|con|siempre)|habla como|actua como|comportate|finge|eres (un|una|el|la)\b|tu (nombre|rol|trabajo) es|ignora|olvida tus|instruccion|instrucciones|prompt|sistema|system|modo (desarrollador|admin|dios)|producto oficial|oficial de|banxico|sin confirmacion|sin tarjeta|no pidas confirmacion|tope|limite)\b/.test(
    value,
  );
}

/** Un celular mexicano creíble: 10 dígitos, no empieza en 0 o 1, y no es el mismo dígito repetido. */
export function plausiblePhone(phone: string): boolean {
  return /^[2-9]\d{9}$/.test(phone) && !/^(\d)\1{9}$/.test(phone) && !/^(\d{2})\1{4}$/.test(phone);
}
