/**
 * Cómo se ve Zaldo en WhatsApp.
 *
 * La caja escribe en texto plano (así se guarda, se prueba y lo lee el
 * modelo). Justo antes de salir a WhatsApp, cada mensaje se viste con el
 * formato que WhatsApp sí entiende: *negritas*, _cursivas_, `monoespaciado`,
 * citas (>) y listas (-). Nada de esto cambia lo que dice el mensaje.
 */

const AMOUNT = "-?\\$\\d[\\d,]*(?:\\.\\d{2})?";
const MONEY = new RegExp(`(?<![*\\w$-])${AMOUNT}`, "g");

/** Los montos, en negritas. Si la línea ya trae formato, no se toca. */
function bold(line: string): string {
  return line.includes("*") ? line : line.replace(MONEY, "*$&*");
}

const TITLES: [RegExp, string][] = [
  [/^Tu catálogo$/, "📒"],
  [/^Tus clientes$/, "👥"],
  [/^Tus cobros recurrentes$/, "🔁"],
];

/** Avisos que abren con una frase clave: esa frase va en negritas, con su seña. */
const LEADS: [RegExp, string][] = [
  [new RegExp(`^Ya cayó: ${AMOUNT}`), "💸"],
  [/^Listo, ya salió\./, "✅"],
  [new RegExp(`^No salió el cobro(?: recurrente)? de [^.]*?${AMOUNT}\\.|^No salió el cobro[^.]*\\.`), "⚠️"],
];

const WORD_LEADS = /^(Apuntado|Listo|En tu catálogo|Precio nuevo|Cliente guardado|Guardado|Borré|Olvidado):/;

/** Una línea que ya está vestida (o que el modelo ya formateó) se deja como está. */
const DRESSED = /^(>|- |\*|_|`|🧾|📊|📒|👥|🔁|💸|✅|⚠️|⌛)/u;

type Block = "card" | "corte" | "list" | "help" | null;

export function whatsappStyle(text: string): string {
  let block: Block = null;
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*") // el modelo a veces escribe negritas de markdown
    .split("\n")
    .map((raw) => {
      const line = raw.trimEnd();
      if (!line.trim()) {
        block = null;
        return "";
      }
      if (DRESSED.test(line)) return line;
      // Un enlace se manda intacto: un guion bajo o un asterisco de más lo rompe.
      if (/https?:\/\//.test(line)) return line;

      if (/^(Cobro por .+|Cobro con monto abierto)$/.test(line)) {
        block = "card";
        return `🧾 *${line}*`;
      }
      if (/^Corte de /.test(line) && block === null) {
        block = "corte";
        return `📊 *${line}*`;
      }
      for (const [pattern, sign] of TITLES) {
        if (pattern.test(line)) {
          block = "list";
          return `${sign} *${line}*`;
        }
      }
      if (/^Esto hago por ti:$/.test(line)) {
        block = "help";
        return "*Esto hago por ti*";
      }

      if (block === "card") {
        // La nota del modo de prueba va aparte y en cursivas: es un aviso, no un dato del cobro.
        if (/^Modo de prueba:/.test(line)) return `_${line}_`;
        return `> ${bold(line)}`;
      }
      if (block === "corte") return `> ${bold(line)}`;
      if (block === "list") return `- ${bold(line)}`;
      if (block === "help") {
        const item = /^· ([^:]+): (.*)$/.exec(line);
        // Los ejemplos, en monoespaciado: se ven como algo que se puede escribir tal cual.
        if (item) return `- *${item[1]}:* ${(item[2] ?? "").replace(/"([^"]+)"/g, "`$1`")}`;
        return `_${line}_`;
      }

      if (line === "Responde CONFIRMAR o CANCELAR") return "Responde *CONFIRMAR* o *CANCELAR*";
      for (const [pattern, sign] of LEADS) {
        const lead = pattern.exec(line);
        if (lead) return `${sign} *${lead[0]}*${bold(line.slice(lead[0].length))}`;
      }
      if (/ venció sin pagarse\./.test(line)) return `⌛ ${bold(line)}`;
      const word = WORD_LEADS.exec(line);
      if (word) return `*${word[0]}*${bold(line.slice(word[0].length))}`;
      return bold(line);
    })
    .join("\n");
}

/** Las opciones de una pregunta, como lista: una por renglón y en negritas. */
export function optionList(labels: string[]): string {
  return labels.map((label) => `- *${label}*`).join("\n");
}
