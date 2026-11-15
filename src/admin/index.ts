/**
 * Panel administrador. Solo lee el Store: no crea cobros ni llama a Pey,
 * así que entrar aquí nunca mueve dinero.
 */
export {
  chargesToCsv,
  computeMetrics,
  dailySeries,
  filterCharges,
  ownerDetail,
  ownerFromRef,
  ownerRef,
  ownerSummaries,
  type ChargePage,
  type DayPoint,
  type Filters,
  type Metrics,
  type OwnerDetail,
  type OwnerSummary,
} from "./data.js";
export { renderLayout, type LayoutInput } from "./layout.js";
export {
  findMismatches,
  reconcile,
  ReconcileCache,
  repairCharge,
  sumTotals,
  type Mismatch,
  type PeyReader,
  type PeyTotals,
  type Reconciliation,
  type RepairOutcome,
} from "./reconcile.js";
export { handleAdminRoutes, type AdminDeps } from "./routes.js";
export {
  maskPhone,
  renderCharges,
  renderDashboard,
  renderOwnerDetail,
  renderOwners,
  renderReconcile,
  renderSettings,
  when,
  type ReconcileBanner,
  type RefOf,
} from "./views.js";
