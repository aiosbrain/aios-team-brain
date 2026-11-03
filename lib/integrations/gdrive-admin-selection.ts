/**
 * Which Google Drive connection the Admin Drive panel is acting on (AIO-1167 r38).
 *
 * A team may have several named Drive connections, each with its own immutable id, connector
 * principal, run requests and coordinator status. Every Drive-specific status line and action in
 * Admin binds to exactly ONE of them — the selected one — and never silently to another:
 *
 *   · nothing chosen yet  → the first connection the Admin is SHOWN is latched, by immutable id,
 *                           exactly once (`latchDriveSelection`). From then on it is an ordinary
 *                           choice: a refresh can find it or report it missing, never re-pick "the
 *                           first" (the single-connection case behaves exactly as before);
 *   · a chosen connection → that exact connection, matched by immutable id;
 *   · a chosen connection that no longer exists (disconnected, removed by another Admin) → `missing`:
 *                           no status and no action until the Admin chooses again. Falling back to a
 *                           neighbour would run, reconnect or rotate a key on a connection nobody chose.
 *
 * Pure and client-safe (no server imports).
 */

export interface DriveConnectionLike {
  id: string;
  type: string;
  name: string;
}

export type DriveSelection<T extends DriveConnectionLike> =
  | { kind: "none" }
  | { kind: "selected"; connection: T }
  | { kind: "missing"; selectedId: string };

/** Every Drive connection, in the order Admin lists integrations. */
export function driveConnections<T extends DriveConnectionLike>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.type === "gdrive");
}

/**
 * The selection state's one implicit transition: `null` (nothing chosen, nothing shown yet) latches
 * the first connection of the first NON-EMPTY list. Any id — latched or chosen — is kept as-is,
 * whatever the list now holds, so a connection that disappears becomes `missing` instead of
 * silently handing its place (and its Run now / key rotation) to whichever connection is now first.
 * Changes state at most once: only from `null`, only to an id.
 */
export function latchDriveSelection(
  selectedId: string | null,
  connections: readonly DriveConnectionLike[],
): string | null {
  return selectedId ?? connections[0]?.id ?? null;
}

/**
 * Resolve a LATCHED selection id (see `latchDriveSelection`). `null` means there has never been a
 * connection to select; an id resolves only to that exact connection.
 */
export function resolveDriveSelection<T extends DriveConnectionLike>(
  connections: readonly T[],
  selectedId: string | null,
): DriveSelection<T> {
  if (selectedId === null) return { kind: "none" };
  const exact = connections.find((connection) => connection.id === selectedId);
  return exact ? { kind: "selected", connection: exact } : { kind: "missing", selectedId };
}

/**
 * A per-connection result (a preview message, a preview continuation, a one-time connector key) is
 * shown only while the connection it belongs to is the selected one, so a result that arrives after
 * the Admin switched connections can never be read as the new connection's.
 */
export interface ForConnection<V> {
  connectionId: string;
  value: V;
}

export function valueFor<V>(entry: ForConnection<V> | null, selection: DriveSelection<DriveConnectionLike>): V | null {
  if (!entry || selection.kind !== "selected") return null;
  return entry.connectionId === selection.connection.id ? entry.value : null;
}
