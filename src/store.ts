export type ChargeMethod = "push" | "qr" | "link";

export type ChargeStatus =
  | "awaiting_confirm"
  | "pending"
  | "paid"
  | "expired"
  | "cancelled"
  | "failed";

export interface Charge {
  id: string;
  owner: string;
  payerName: string;
  payerPhone: string | null;
  amountCents: number;
  concept: string;
  method: ChargeMethod;
  status: ChargeStatus;
  numRef: string | null;
  peyTransactionId: string | null;
  peyExternalId: string | null;
  linkUrl: string | null;
  createdAt: number;
  confirmBy: number;
  expiresAt: number | null;
  paidAt: number | null;
  expiryNotified: boolean;
  paidNoticeSent: boolean;
}

export interface Note {
  id: string;
  owner: string;
  kind: "gasto" | "deuda" | "ingreso";
  amountCents: number;
  concept: string;
  who: string | null;
  createdAt: number;
}

export interface Contact {
  owner: string;
  name: string;
  phone: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
  at: number;
}

interface Data {
  charges: Charge[];
  notes: Note[];
  contacts: Contact[];
  turns: Record<string, Turn[]>;
  claims: Record<string, "open" | "done">;
}

function empty(): Data {
  return { charges: [], notes: [], contacts: [], turns: {}, claims: {} };
}

export class Store {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private data: Data = empty(),
    private persist: (() => void) | null = null,
  ) {}

  async tx<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private save(): void {
    this.persist?.();
  }

  snapshot(): Data {
    return structuredClone(this.data);
  }

  claim(key: string): "go" | "skip" {
    const state = this.data.claims[key];
    if (state === "done" || state === "open") return "skip";
    this.data.claims[key] = "open";
    this.save();
    return "go";
  }

  complete(key: string): void {
    this.data.claims[key] = "done";
    this.save();
  }

  release(key: string): void {
    if (this.data.claims[key] === "open") {
      delete this.data.claims[key];
      this.save();
    }
  }

  insertCharge(charge: Charge): void {
    this.data.charges.push(charge);
    this.save();
  }

  updateCharge(charge: Charge): void {
    const index = this.data.charges.findIndex((item) => item.id === charge.id);
    if (index === -1) throw new Error(`Cobro desconocido ${charge.id}`);
    this.data.charges[index] = charge;
    this.save();
  }

  getCharge(id: string): Charge | null {
    return this.data.charges.find((item) => item.id === id) ?? null;
  }

  listCharges(owner?: string): Charge[] {
    return this.data.charges.filter((item) => !owner || item.owner === owner);
  }

  usedNumRefs(): Set<string> {
    return new Set(
      this.data.charges.map((item) => item.numRef).filter((ref): ref is string => !!ref),
    );
  }

  findCharge(match: (charge: Charge) => boolean): Charge | null {
    return this.data.charges.find(match) ?? null;
  }

  confirmedCentsSince(owner: string, since: number): number {
    return this.data.charges
      .filter(
        (item) =>
          item.owner === owner &&
          item.createdAt >= since &&
          (item.status === "pending" || item.status === "paid"),
      )
      .reduce((sum, item) => sum + item.amountCents, 0);
  }

  insertNote(note: Note): void {
    this.data.notes.push(note);
    this.save();
  }

  listNotes(owner: string): Note[] {
    return this.data.notes.filter((item) => item.owner === owner);
  }

  upsertContact(contact: Contact): void {
    const key = contact.name.trim().toLocaleLowerCase("es-MX");
    const index = this.data.contacts.findIndex(
      (item) => item.owner === contact.owner && item.name.toLocaleLowerCase("es-MX") === key,
    );
    if (index === -1) this.data.contacts.push({ ...contact, name: contact.name.trim() });
    else this.data.contacts[index] = { ...contact, name: contact.name.trim() };
    this.save();
  }

  findContact(owner: string, name: string): Contact | null {
    const key = name.trim().toLocaleLowerCase("es-MX");
    return (
      this.data.contacts.find(
        (item) => item.owner === owner && item.name.toLocaleLowerCase("es-MX") === key,
      ) ?? null
    );
  }

  listContacts(owner: string): Contact[] {
    return this.data.contacts.filter((item) => item.owner === owner);
  }

  appendTurn(owner: string, turn: Turn): void {
    const list = this.data.turns[owner] ?? [];
    list.push(turn);
    this.data.turns[owner] = list.slice(-24);
    this.save();
  }

  recentTurns(owner: string): Turn[] {
    return this.data.turns[owner] ?? [];
  }
}

export function memoryStore(): Store {
  return new Store();
}
