import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { RequireAuth } from './components/RequireAuth'
import { Toast } from './components/Toast'
import { StoreProvider } from './store'
import { AuthProvider } from './auth'

const LandingPage = lazy(() => import('./pages/landing').then((module) => ({ default: module.LandingPage })))
const SignInPage = lazy(() => import('./pages/auth').then((module) => ({ default: () => <module.AuthPage mode="signin" /> })))
const SignUpPage = lazy(() => import('./pages/auth').then((module) => ({ default: () => <module.AuthPage mode="signup" /> })))
const DashboardPage = lazy(() => import('./pages/workspace').then((module) => ({ default: module.DashboardPage })))
const CreateMeetingPage = lazy(() => import('./pages/workspace').then((module) => ({ default: module.CreateMeetingPage })))
const JoinMeetingPage = lazy(() => import('./pages/workspace').then((module) => ({ default: module.JoinMeetingPage })))
const SchedulePage = lazy(() => import('./pages/workspace').then((module) => ({ default: module.SchedulePage })))
const SettingsPage = lazy(() => import('./pages/workspace').then((module) => ({ default: module.SettingsPage })))
const LobbyPage = lazy(() => import('./pages/meeting').then((module) => ({ default: module.LobbyPage })))
const MeetingRoomPage = lazy(() => import('./pages/meeting').then((module) => ({ default: module.MeetingRoomPage })))

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <StoreProvider>
          <Toast />
          <Suspense fallback={<div className="loading-screen" role="status"><span className="loading-spinner" />Loading FOSSHub…</div>}>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/signin" element={<SignInPage />} />
              <Route path="/signup" element={<SignUpPage />} />
              <Route element={<AppShell />}>
                <Route path="/dashboard" element={<RequireAuth><DashboardPage /></RequireAuth>} />
                <Route path="/create" element={<RequireAuth registered><CreateMeetingPage /></RequireAuth>} />
                <Route path="/join" element={<JoinMeetingPage />} />
                <Route path="/join/:meetingId" element={<LobbyPage />} />
                <Route path="/meeting/:meetingId" element={<MeetingRoomPage />} />
                <Route path="/schedule" element={<RequireAuth registered><SchedulePage /></RequireAuth>} />
                <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </StoreProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
