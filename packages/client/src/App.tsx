import { Link, Route, Routes } from 'react-router-dom';
import { ConnectFacebook } from './routes/ConnectFacebook.js';

function Home() {
  return (
    <main>
      <h1>ReelBridge</h1>
      <p>Bulk-post and schedule Reels and videos across Facebook, Instagram, and YouTube.</p>
      <Link to="/connect/facebook">Connect Facebook</Link>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/connect/facebook" element={<ConnectFacebook />} />
    </Routes>
  );
}
