import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { BatchPreview } from './routes/BatchPreview.js';
import { BatchTargets } from './routes/BatchTargets.js';
import { BatchUpload } from './routes/BatchUpload.js';
import { ConnectFacebook } from './routes/ConnectFacebook.js';
import { Onboarding } from './routes/Onboarding.js';
import { PostsDashboard } from './routes/PostsDashboard.js';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route path="/connect/facebook" element={<ConnectFacebook />} />
        <Route path="/upload" element={<BatchUpload />} />
        <Route path="/batches/:batchId/targets" element={<BatchTargets />} />
        <Route path="/batches/:batchId/preview" element={<BatchPreview />} />
        <Route path="/posts" element={<PostsDashboard />} />
      </Routes>
    </AppShell>
  );
}
