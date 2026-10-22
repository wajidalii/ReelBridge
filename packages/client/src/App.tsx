import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { RequireAuth } from './components/RequireAuth.js';
import { ForgotPassword } from './routes/auth/ForgotPassword.js';
import { Login } from './routes/auth/Login.js';
import { ResetPassword } from './routes/auth/ResetPassword.js';
import { Signup } from './routes/auth/Signup.js';
import { VerifyEmail } from './routes/auth/VerifyEmail.js';
import { BatchesList } from './routes/BatchesList.js';
import { BatchPreview } from './routes/BatchPreview.js';
import { BatchTargets } from './routes/BatchTargets.js';
import { BatchUpload } from './routes/BatchUpload.js';
import { ConnectFacebook } from './routes/ConnectFacebook.js';
import { ConnectYouTube } from './routes/ConnectYouTube.js';
import { Home } from './routes/Home.js';
import { PostsDashboard } from './routes/PostsDashboard.js';
import { Settings } from './routes/Settings.js';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />

        <Route element={<RequireAuth />}>
          <Route path="/" element={<Home />} />
          <Route path="/connect/facebook" element={<ConnectFacebook />} />
          <Route path="/connect/youtube" element={<ConnectYouTube />} />
          <Route path="/upload" element={<BatchUpload />} />
          <Route path="/batches" element={<BatchesList />} />
          <Route path="/batches/:batchId/targets" element={<BatchTargets />} />
          <Route path="/batches/:batchId/preview" element={<BatchPreview />} />
          <Route path="/posts" element={<PostsDashboard />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </AppShell>
  );
}
