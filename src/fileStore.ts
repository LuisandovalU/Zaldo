import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Store } from "./store.js";

export function fileStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  let store!: Store;
  const persist = () => {
    const next = `${path}.tmp`;
    writeFileSync(next, JSON.stringify(store.snapshot(), null, 2));
    renameSync(next, path);
  };
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  store = new Store(data, persist);
  return store;
}
