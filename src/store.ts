export type ChargeMethod = "push" | "qr" | "link";

export type ChargeStatus =
  | "awaiting_confirm"
  | "pending"
  | "paid"
  | "expired"
  | "cancelled"
  | "failed";

/** Un renglón del ticket: 2 × uñas acrílicas a $350.00. */
export interface ChargeItem {
  name: string;
  qty: number;
  unitCents: number;
}

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
  /** El ticket, cuando la venta salió del catálogo. */
  items?: ChargeItem[];
  /** Lo que se sumó o restó al total del ticket: descuento, propina fija, envío, IVA. */
  adjustCents?: number;
  /**
   * QR fijo del mostrador: no vence y recibe muchos pagos. Se queda abierto y
   * cada pago queda como una venta aparte (parentId apunta a este QR).
   */
  reusable?: boolean;
  /** QR sin monto: quien paga escribe la cantidad en la app de su banco. */
  openAmount?: boolean;
  /** Pagos de pey ya contados en este QR fijo, para no contar uno dos veces. */
  seenTransactions?: string[];
  parentId?: string;
  /** Link de pago que deja agregar propina, y la propina que llegó. */
  tip?: boolean;
  tipCents?: number;
  /** Al confirmarlo queda como cobro recurrente con esta frecuencia. */
  repeat?: Frequency;
  /** El cobro recurrente que lo mandó, si salió solo. */
  recurringId?: string;
  /** La cuenta propia de quien cobra a la que se mandó este cobro, si tiene una activa. */
  bankAccountId?: string;
}

export type Frequency = "semanal" | "quincenal" | "mensual";

/**
 * Un cobro que se repite solo: cada periodo Zaldo le manda la notificación
 * CoDi al mismo cliente, sin volver a pedir confirmación.
 */
export interface Recurring {
  id: string;
  owner: string;
  payerName: string;
  payerPhone: string;
  amountCents: number;
  concept: string;
  every: Frequency;
  /** Cuándo toca el siguiente, en milisegundos. */
  nextAt: number;
  active: boolean;
  createdAt: number;
  lastChargeId: string | null;
  /** Cobros seguidos sin pagar. A los tres se pausa solo. */
  missed: number;
  /** Veces seguidas que pey no dejó salir el cobro del periodo. No es un impago: se reintenta con calma. */
  failures?: number;
  /** La fecha en que tocaba el periodo que se está reintentando: el siguiente no se recorre por el reintento. */
  dueAt?: number;
}

/**
 * Lo que la caja apunta sin mover dinero.
 * gasto: salida del negocio, con categoría. ingreso: venta en efectivo u otra entrada.
 * deuda: fiado, un cliente le debe al negocio. debo: el negocio le debe a alguien.
 * Las deudas se van saldando con paidCents.
 */
export type NoteKind = "gasto" | "ingreso" | "deuda" | "debo";

export interface Note {
  id: string;
  owner: string;
  kind: NoteKind;
  amountCents: number;
  concept: string;
  who: string | null;
  createdAt: number;
  category?: string | null;
  /** Lo ya pagado de una deuda. Saldada cuando llega a amountCents. */
  paidCents?: number;
}

/** Un producto o servicio del catálogo, con su precio. */
export interface Product {
  owner: string;
  name: string;
  priceCents: number;
}

export interface Profile {
  owner: string;
  name: string | null;
  phone: string | null;
  /** Nombre del negocio: sale en el corte de caja. */
  business?: string | null;
  /** Meta de venta diaria. */
  dailyGoalCents?: number | null;
  /** Lo que la persona pidió recordar (formato viejo: ahora vive en `memory`). */
  facts?: string[];
  /** Las notas de Zaldo sobre esta persona, en markdown por secciones. Ella nunca las ve. */
  memory?: string;
  /** La cuenta donde recibe sus cobros, si registró una. */
  bank?: BankLink;
  /** Cuentas que ha registrado en total: hay un tope. */
  bankCount?: number;
  /** Cómo ve las opciones en su WhatsApp: botones (si ya tocó uno), o texto si pidió no usarlos. */
  choiceStyle?: "buttons" | "poll" | "text";
  /** Ya se le explicó el modo demo al llegar. */
  onboarded?: boolean;
}

/**
 * La cuenta de una persona, registrada en pey. Aquí NO vive la CLABE: solo el
 * id que devolvió pey y sus últimos 4 dígitos.
 */
export interface BankLink {
  id: string;
  last4: string;
  holder: string;
  status: "PENDING" | "PROCESSING" | "ACTIVE" | "ERROR";
  error: string | null;
  registeredAt: number;
  checkedAt?: number;
  /** Ya se le avisó por WhatsApp de su estado actual. */
  announced?: boolean;
}

export interface Contact {
  owner: string;
  name: string;
  phone: string;
}

/** Una herramienta que el agente usó en un turno: así recuerda que las cosas se hacen llamándolas. */
export interface TurnTool {
  name: string;
  args: string;
  output: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
  at: number;
  tools?: TurnTool[];
  /** Este turno fue la tarjeta de ese cobro: un "sí" justo después es para él. */
  cardOf?: string;
}

interface Data {
  charges: Charge[];
  notes: Note[];
  contacts: Contact[];
  turns: Record<string, Turn[]>;
  claims: Record<string, "open" | "done">;
  products: Product[];
  profiles: Profile[];
  recurrings: Recurring[];
}

function empty(): Data {
  return { charges: [], notes: [], contacts: [], turns: {}, claims: {}, products: [], profiles: [], recurrings: [] };
}

/** Mensajes de la conversación que se conservan por persona. Lo duradero vive en el libro, no aquí. */
const TURNS_KEPT = 30;

export class Store {
  private tail: Promise<unknown> = Promise.resolve();

  private data: Data;

  constructor(
    data: Partial<Data> = {},
    private persist: (() => void) | null = null,
  ) {
    // Un archivo de antes no trae catálogo ni perfiles: se completan vacíos.
    this.data = { ...empty(), ...data };
  }

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

  /** ¿Esa llave ya se usó? (No la aparta.) */
  claimed(key: string): boolean {
    return this.data.claims[key] !== undefined;
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
          // Un QR abierto no tiene monto, y sus pagos los decide el cliente: no gastan el tope.
          !item.openAmount &&
          !item.parentId &&
          (item.status === "pending" || item.status === "paid" || item.status === "expired"),
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

  updateNote(note: Note): void {
    const index = this.data.notes.findIndex((item) => item.id === note.id);
    if (index === -1) throw new Error(`Apunte desconocido ${note.id}`);
    this.data.notes[index] = note;
    this.save();
  }

  removeNote(id: string): Note | null {
    const index = this.data.notes.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const [removed] = this.data.notes.splice(index, 1);
    this.save();
    return removed ?? null;
  }

  listProducts(owner: string): Product[] {
    return this.data.products.filter((item) => item.owner === owner);
  }

  /** priceCents 0 lo quita del catálogo. */
  setProduct(product: Product): void {
    const key = fold(product.name);
    this.data.products = this.data.products.filter(
      (item) => !(item.owner === product.owner && fold(item.name) === key),
    );
    if (product.priceCents > 0) this.data.products.push({ ...product, name: product.name.trim() });
    this.save();
  }

  /** Por nombre exacto; si no, el único producto que lo contiene ("acrílicas" → "uñas acrílicas"). */
  findProduct(owner: string, name: string): Product | null {
    const key = fold(name);
    if (!key) return null;
    const mine = this.listProducts(owner);
    const exact = mine.find((item) => fold(item.name) === key);
    if (exact) return exact;
    const singular = key.replace(/(es|s)$/, "");
    const close = mine.filter((item) => {
      const candidate = fold(item.name);
      return candidate.includes(key) || key.includes(candidate) || (singular.length >= 3 && candidate.includes(singular));
    });
    return close.length === 1 ? (close[0] ?? null) : null;
  }

  listRecurrings(owner?: string): Recurring[] {
    return this.data.recurrings.filter((item) => !owner || item.owner === owner);
  }

  upsertRecurring(plan: Recurring): void {
    const index = this.data.recurrings.findIndex((item) => item.id === plan.id);
    if (index === -1) this.data.recurrings.push(plan);
    else this.data.recurrings[index] = plan;
    this.save();
  }

  listProfiles(): Profile[] {
    return [...this.data.profiles];
  }

  getProfile(owner: string): Profile {
    return this.data.profiles.find((item) => item.owner === owner) ?? { owner, name: null, phone: null };
  }

  setProfile(profile: Profile): void {
    this.data.profiles = this.data.profiles.filter((item) => item.owner !== profile.owner);
    this.data.profiles.push(profile);
    this.save();
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
    this.data.turns[owner] = list.slice(-TURNS_KEPT);
    this.save();
  }

  recentTurns(owner: string): Turn[] {
    return this.data.turns[owner] ?? [];
  }
}

/** Sin acentos, sin mayúsculas y con un solo espacio: para comparar nombres. */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es-MX");
}

export function memoryStore(): Store {
  return new Store();
}
