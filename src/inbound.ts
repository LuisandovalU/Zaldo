export type Inbound =
  | { type: "text"; owner: string; messageId: string; text: string }
  | { type: "audio"; owner: string; messageId: string; mediaId: string; mime: string }
  | { type: "button"; owner: string; messageId: string; buttonId: string };

export type Outbound =
  | { kind: "text"; to: string; text: string }
  | { kind: "buttons"; to: string; text: string; yesId: string; noId: string }
  /** Una pregunta con dos o tres respuestas que se tocan. El id "o:<texto>" vuelve como si la persona lo hubiera escrito. */
  | { kind: "choice"; to: string; text: string; options: { id: string; label: string }[]; style?: "buttons" | "poll" | "text" }
  | { kind: "image"; to: string; png: Buffer; caption: string };
