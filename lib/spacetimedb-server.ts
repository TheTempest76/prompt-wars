import { DbConnection, tables } from '../src/module_bindings';

const HOST = process.env.SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? 'prompt-wars';

// Deliberately just `{ name }`, not the full generated Person row -- `owner`
// (Identity) and `createdAt` (Timestamp) are class instances, and Next.js's
// server->client component boundary rejects passing those directly (only
// plain objects/built-ins cross it). PersonList only ever renders `.name`,
// so this SSR path never needs the rest; the live `useTable` path (entirely
// client-side, never crossing that boundary) still gets the full row.
export type PersonData = { name: string };

/**
 * Fetches the initial list of people from SpacetimeDB.
 * This function is designed for use in Next.js Server Components.
 *
 * It establishes a WebSocket connection, subscribes to the person table,
 * waits for the initial data, and then disconnects.
 */
export async function fetchPeople(): Promise<PersonData[]> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('SpacetimeDB connection timeout'));
    }, 10000);

    const connection = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .onConnect(conn => {
        // Subscribe to all people
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timeoutId);
            // Get all people from the cache -- mapped to a plain-object
            // shape, see the PersonData comment above.
            const people = Array.from(conn.db.person.iter()).map(p => ({ name: p.name }));
            conn.disconnect();
            resolve(people);
          })
          .onError((ctx) => {
            clearTimeout(timeoutId);
            conn.disconnect();
            reject(ctx.event ?? new Error('Subscription error'));
          })
          .subscribe(tables.person);
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timeoutId);
        reject(error);
      })
      .build();
  });
}
