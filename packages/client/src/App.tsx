import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { BatchTargets } from './routes/BatchTargets.js';
import { BatchUpload } from './routes/BatchUpload.js';
import { ConnectFacebook } from './routes/ConnectFacebook.js';
import { Onboarding } from './routes/Onboarding.js';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route path="/connect/facebook" element={<ConnectFacebook />} />
        <Route path="/upload" element={<BatchUpload />} />
        <Route path="/batches/:batchId/targets" element={<BatchTargets />} />
      </Routes>
    </AppShell>
  );
}
