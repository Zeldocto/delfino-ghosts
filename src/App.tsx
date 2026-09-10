import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AuthProvider, useAuth } from './lib/auth'
import { ThemeProvider } from './hooks/useTheme'
import { MdpProvider } from './hooks/useMdp'
import { isSupabaseConfigured } from './lib/supabase'
import { Home } from './pages/Home'
import { Browse } from './pages/Browse'
import { GhostDetail } from './pages/GhostDetail'
import { Upload } from './pages/Upload'
import { EditGhost } from './pages/EditGhost'
import { Profile } from './pages/Profile'
import { Community } from './pages/Community'
import { About } from './pages/About'
import { Login } from './pages/Login'
import { Register } from './pages/Register'
import { ResetPassword } from './pages/ResetPassword'
import { Settings } from './pages/Settings'
import { NotFound } from './pages/NotFound'

/** GitHub Pages serves the app from a subpath; the router must agree. */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

/** Scrolls to the top on navigation, the way a document site should. */
function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

/**
 * A password-reset link signs the visitor in at the site root. When Supabase
 * reports that, send them to the form where they can choose a new password.
 */
function RecoveryRedirect() {
  const { recoveryMode } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  useEffect(() => {
    if (recoveryMode && pathname !== '/reset-password') {
      navigate('/reset-password', { replace: true })
    }
  }, [recoveryMode, pathname, navigate])

  return null
}

function ConfigurationNeeded() {
  return (
    <main className="shell page">
      <h1 className="page-title">Delfino Ghosts is not configured</h1>
      <div className="prose" style={{ marginTop: 14 }}>
        <p>
          This build has no Supabase connection. Copy <code>.env.example</code> to <code>.env</code>,
          fill in <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> from your
          Supabase project, then restart the dev server. For the deployed site, set the same two
          values as repository secrets so the Actions workflow can build with them.
        </p>
        <p>The README walks through the whole setup, including the database migrations.</p>
      </div>
    </main>
  )
}

export default function App() {
  if (!isSupabaseConfigured) return <ConfigurationNeeded />

  return (
    <ThemeProvider>
      <BrowserRouter basename={basename}>
        <AuthProvider>
          <MdpProvider>
            <ScrollToTop />
            <RecoveryRedirect />
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="browse" element={<Browse />} />
                <Route path="ghost/:id" element={<GhostDetail />} />
                <Route
                  path="ghost/:id/edit"
                  element={
                    <ProtectedRoute>
                      <EditGhost />
                    </ProtectedRoute>
                  }
                />
                <Route path="upload" element={<Upload />} />
                <Route path="profile/:username" element={<Profile />} />
                <Route path="community" element={<Community />} />
                <Route path="about" element={<About />} />
                <Route path="login" element={<Login />} />
                <Route path="register" element={<Register />} />
                <Route path="reset-password" element={<ResetPassword />} />
                <Route
                  path="settings"
                  element={
                    <ProtectedRoute>
                      <Settings />
                    </ProtectedRoute>
                  }
                />
                <Route path="index.html" element={<Navigate to="/" replace />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </MdpProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  )
}
