/**
 * Las formas de mandar botones por el puente de WhatsApp.
 *
 * WhatsApp acepta varios formatos de mensaje con botones, pero no todos los
 * teléfonos pintan todos: uno que no lo pinta, no enseña nada. Por eso hay
 * varias variantes, cada chat prueba cuál ve ("probar botones") y el núcleo
 * arma el mensaje con esa. Cambiar o agregar una variante es publicar el bot:
 * el puente solo reenvía lo que aquí se arma.
 */

export interface ButtonOption {
  id: string;
  label: string;
}

/** Un mensaje listo para el puente: contenido, nodos que lo acompañan y las opciones (para leer el toque). */
export interface RawMessage {
  content: Record<string, unknown>;
  nodes: unknown[];
  options: ButtonOption[];
  fallback: string;
}

export const VARIANTS = ["A", "B", "C", "D"] as const;
export type Variant = (typeof VARIANTS)[number];

export function isVariant(value: unknown): value is Variant {
  return typeof value === "string" && (VARIANTS as readonly string[]).includes(value);
}

/** El nodo que le dice al teléfono que el mensaje trae botones de respuesta. */
const NATIVE_FLOW = [
  {
    tag: "biz",
    attrs: {},
    content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }],
  },
];

const CONTEXT = { deviceListMetadata: {}, deviceListMetadataVersion: 2 };

export function buttonMessage(variant: Variant, text: string, options: ButtonOption[], fallback = ""): RawMessage {
  const body = text.slice(0, 1024);
  const classic = {
    messageContextInfo: CONTEXT,
    buttonsMessage: {
      contentText: body,
      headerType: 1,
      buttons: options.map((option) => ({ buttonId: option.id, buttonText: { displayText: option.label }, type: 1 })),
    },
  };
  switch (variant) {
    // A: botones de respuesta rápida, sin envoltura de "ver una vez".
    case "A":
      return {
        content: {
          messageContextInfo: CONTEXT,
          interactiveMessage: {
            body: { text: body },
            nativeFlowMessage: {
              buttons: options.map((option) => ({
                name: "quick_reply",
                buttonParamsJson: JSON.stringify({ display_text: option.label, id: option.id }),
              })),
              messageParamsJson: "",
            },
          },
        },
        nodes: NATIVE_FLOW,
        options,
        fallback,
      };
    // B: botones clásicos con el nodo de respuesta rápida.
    case "B":
      return { content: classic, nodes: NATIVE_FLOW, options, fallback };
    // C: botones clásicos con su nodo de siempre.
    case "C":
      return { content: classic, nodes: [{ tag: "biz", attrs: {}, content: [{ tag: "buttons", attrs: {} }] }], options, fallback };
    // D: una lista que se abre con un botón.
    case "D":
      return {
        content: {
          messageContextInfo: CONTEXT,
          listMessage: {
            description: body,
            buttonText: "Ver opciones",
            listType: 1,
            sections: [{ title: "Opciones", rows: options.map((option) => ({ rowId: option.id, title: option.label })) }],
          },
        },
        nodes: [{ tag: "biz", attrs: {}, content: [{ tag: "list", attrs: { type: "product_list", v: "2" } }] }],
        options,
        fallback,
      };
  }
}
