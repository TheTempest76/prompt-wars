import { PersonList } from './PersonList';
import { WorldView } from './WorldView';
import { SpawnCreature } from './SpawnCreature';
import { FirstLoadOverlay } from './FirstLoadOverlay';
import { fetchPeople } from '../lib/spacetimedb-server';

// fetchPeople has its own 10s internal timeout; give the Vercel serverless
// function headroom above that so a slow Maincloud round-trip hits our
// graceful catch below instead of a hard platform timeout.
export const maxDuration = 15;

export default async function Home() {
  // Fetch initial data on the server
  let initialPeople: Awaited<ReturnType<typeof fetchPeople>> = [];

  try {
    initialPeople = await fetchPeople();
  } catch (error) {
    // If server-side fetch fails, the client will still work
    // This can happen if the database is not yet published
    console.error('Failed to fetch initial data:', error);
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <FirstLoadOverlay />
      <h1>Prompt Wars</h1>
      <PersonList initialPeople={initialPeople} />
      <WorldView />
      <SpawnCreature />
    </main>
  );
}
