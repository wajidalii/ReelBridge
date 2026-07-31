import { Link, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { ConnectFacebook } from './routes/ConnectFacebook.js';

function Home() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        Bulk-post Reels, everywhere.
      </h1>
      <p className="mt-3 text-lg text-slate-600">
        Schedule and publish Reels and videos across Facebook, Instagram, and YouTube from one
        place.
      </p>
      <Link
        to="/connect/facebook"
        className="mt-8 inline-flex items-center rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
      >
        Connect Facebook
      </Link>
    </div>
  );
}

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/connect/facebook" element={<ConnectFacebook />} />
      </Routes>
    </AppShell>
  );
}
