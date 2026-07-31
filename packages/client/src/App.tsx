import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { ConnectFacebook } from './routes/ConnectFacebook.js';
import { Onboarding } from './routes/Onboarding.js';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route path="/connect/facebook" element={<ConnectFacebook />} />
      </Routes>
    </AppShell>
  );
}
