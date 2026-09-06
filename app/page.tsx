import { PersonList } from './PersonList';
import { WorldView } from './WorldView';
import { SpawnCreature } from './SpawnCreature';
import { FirstLoadOverlay } from './FirstLoadOverlay';
import { Toasts } from './Toasts';
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
    <main
      style={{
        maxWidth: '58rem',
        margin: '0 auto',
        padding: '2.5rem 1.5rem 4rem',
      }}
    >
      <FirstLoadOverlay />
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.6rem', letterSpacing: '-0.01em', margin: 0 }}>
          Prompt Wars
        </h1>
        <p style={{ margin: '0.3rem 0 0', color: 'var(--muted)', maxWidth: '38rem' }}>
          A shared petri dish of LLM-compiled creatures. The world keeps ticking
          whether or not anyone is watching.
        </p>
      </header>
      <PersonList initialPeople={initialPeople} />
      <SpawnCreature />
      <WorldView />
      <Toasts />
    </main>
  );
}
