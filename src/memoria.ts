/**
 * Las notas de Zaldo sobre cada persona: un markdown corto, por secciones,
 * que el agente lee antes de contestar y va llenando solo.
 *
 * La persona nunca ve este archivo ni tiene que saber que existe: para ella,
 * Zaldo simplemente "se acuerda". Por eso lo que entra aquí se coteja con lo
 * que ella escribió (nada inventado, nada secreto, nada que cambie las reglas).
 */
import { fold } from "./store.js";

export const SECTIONS = ["Negocio", "Clientes", "Costumbres", "Pendientes"] as const;
export type Section = (typeof SECTIONS)[number];

/** Renglones por sección, y largo máximo de cada uno: son notas, no un expediente. */
const PER_SECTION = 8;
const MAX_NOTE = 140;

export function sectionOf(raw: unknown): Section {
  const value = fold(String(raw ?? ""));
  if (value.startsWith("negoc")) return "Negocio";
  if (value.startsWith("client")) return "Clientes";
  if (value.startsWith("pend")) return "Pendientes";
  return "Costumbres";
}

type Notes = Record<Section, string[]>;

function empty(): Notes {
  return { Negocio: [], Clientes: [], Costumbres: [], Pendientes: [] };
}

export function parseMemory(markdown: string): Notes {
  const notes = empty();
  let current: Section = "Costumbres";
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line.trim());
    if (heading) {
      current = sectionOf(heading[1]);
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line.trim());
    if (item?.[1]) notes[current].push(item[1].trim());
  }
  return notes;
}

export function writeMemory(notes: Notes): string {
  return SECTIONS.filter((section) => notes[section].length)
    .map((section) => [`## ${section}`, ...notes[section].map((note) => `- ${note}`)].join("\n"))
    .join("\n\n");
}

/** Las notas de un perfil. Lo que antes se guardaba como lista suelta entra en Costumbres. */
export function memoryOf(profile: { memory?: string; facts?: string[] }): string {
  if (profile.memory !== undefined) return profile.memory;
  const legacy = (profile.facts ?? []).filter(Boolean);
  if (!legacy.length) return "";
  return writeMemory({ ...empty(), Costumbres: legacy.slice(-PER_SECTION) });
}

export function cleanNote(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/^[-*#\s]+/, "")
    .replace(/[.\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE);
}

/**
 * Agrega una nota. Si ya había una que dice lo mismo (o una versión más corta
 * de lo mismo), la reemplaza; si la sección está llena, sale la más vieja.
 */
export function addNote(markdown: string, section: Section, raw: string): string {
  const note = cleanNote(raw);
  if (note.length < 3) return markdown;
  const notes = parseMemory(markdown);
  const key = fold(note);
  for (const name of SECTIONS) {
    notes[name] = notes[name].filter((item) => {
      const other = fold(item);
      return other !== key && !key.includes(other) && !other.includes(key);
    });
  }
  notes[section] = [...notes[section], note].slice(-PER_SECTION);
  return writeMemory(notes);
}

/** Quita las notas que hablan de eso. Devuelve cuáles se fueron. */
export function dropNotes(markdown: string, query: string): { markdown: string; gone: string[] } {
  const key = fold(query);
  const notes = parseMemory(markdown);
  const gone: string[] = [];
  if (key.length < 3) return { markdown, gone };
  const words = key.split(" ").filter((word) => word.length >= 4);
  for (const name of SECTIONS) {
    notes[name] = notes[name].filter((item) => {
      const other = fold(item);
      const hit = other.includes(key) || key.includes(other) || (words.length > 0 && words.every((word) => other.includes(word.slice(0, 5))));
      if (hit) gone.push(item);
      return !hit;
    });
  }
  return { markdown: writeMemory(notes), gone };
}

export function countNotes(markdown: string): number {
  const notes = parseMemory(markdown);
  return SECTIONS.reduce((total, section) => total + notes[section].length, 0);
}

/**
 * ¿Esa nota sale de lo que la persona escribió? Las palabras de contenido
 * tienen que venir de sus mensajes ("cierra" vale por "cierro") y todo número
 * tiene que estar tal cual: una nota no puede traer un dato que nadie dijo.
 */
export function grounded(note: string, texts: string[]): boolean {
  const said = fold(texts.join(" "));
  const saidWords = said.split(/[^a-z0-9ñ]+/).filter(Boolean);
  const words = fold(note)
    .split(/[^a-z0-9ñ]+/)
    .filter(Boolean);
  const numbers = words.filter((word) => /^\d+$/.test(word));
  if (numbers.some((number) => !saidWords.includes(number))) return false;
  const content = words.filter((word) => word.length >= 4 && !/^\d+$/.test(word));
  if (!content.length) return numbers.length > 0;
  const found = content.filter((word) => saidWords.some((other) => other.length >= 4 && other.slice(0, 4) === word.slice(0, 4)));
  return found.length / content.length >= 0.6;
}
