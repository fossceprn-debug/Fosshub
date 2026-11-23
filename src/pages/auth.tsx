import { useState, type FormEvent } from 'react'
import { ArrowLeft, Video } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { APP_NAME } from '../config'
import { useAuth } from '../auth'

export function AuthPage({ mode }: { mode: 'signin' | 'signup' }) {
  const { configured, recoveryPending, signIn, signUp, resendConfirmation, resetPassword, updatePassword } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const isSignup = mode === 'signup'
  const isRecovery = mode === 'signin' && recoveryPending
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!configured) {
      setError('Supabase is not configured. Add the project URL and anon key to .env.local.')
      return
    }
    setBusy(true)
    setError('')
    setInfo('')
    try {
      if (isRecovery) {
        await updatePassword(password)
        setInfo('Your password has been updated.')
      } else if (isSignup) {
        const hasSession = await signUp(email.trim(), password, name.trim())
        if (hasSession) navigate('/dashboard', { replace: true })
        else setInfo('Account created. Check your email to confirm the address, then sign in.')
      } else {
        await signIn(email.trim(), password)
        navigate('/dashboard', { replace: true })
      }
    } catch (reason) {
      const msg = reason instanceof Error ? reason.message : 'Authentication failed. Please try again.'
      if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('over_email_send_rate_limit')) {
        setError('Email sending limit reached by the server. You can start or join a meeting directly as a guest below without creating an account.')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const recover = async () => {
    if (!configured) {
      setError('Supabase is not configured. Add the project URL and anon key to .env.local.')
      return
    }
    if (!email.trim()) {
      setError('Enter your email address first.')
      return
    }
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await resetPassword(email.trim())
      setInfo('If an account exists for that email, a password reset link has been sent.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not request a password reset.')
    } finally {
      setBusy(false)
    }
  }

  const resendVerificationEmail = async () => {
    if (!configured) {
      setError('Supabase is not configured. Add the project URL and anon key to .env.local.')
      return
    }
    if (!email.trim()) {
      setError('Enter your email address first.')
      return
    }
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await resendConfirmation(email.trim())
      setInfo('If this address has an unconfirmed account, a new confirmation email has been sent.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not resend the confirmation email.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <header className="auth-header">
        <Link className="brand" to="/"><span className="brand-mark"><Video size={18} /></span>{APP_NAME}</Link>
        <Link className="text-link" to="/"><ArrowLeft size={14} /> Back to home</Link>
      </header>
      <form className="form-card auth-card" onSubmit={submit}>
        <span className="eyebrow">Your meetings, in one place</span>
        <h1>{isRecovery ? 'Choose a new password' : isSignup ? 'Create your account' : 'Welcome back'}</h1>
        <p>{isRecovery ? 'Choose a new password for your FOSSHub account.' : isSignup ? 'Get your workspace ready for the next great conversation.' : 'Sign in to pick up where you left off.'}</p>
        {isSignup && <div className="field"><label htmlFor="auth-name">Your name</label><input id="auth-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required maxLength={60} /></div>}
        {!isRecovery && <div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></div>}
        <div className="field"><label htmlFor="auth-password">{isRecovery ? 'New password' : 'Password'}</label><input id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={isSignup || isRecovery ? 'new-password' : 'current-password'} required minLength={8} /></div>
        {!isSignup && !isRecovery && <button className="auth-text-button" type="button" onClick={() => void recover()} disabled={busy}>Forgot password?</button>}
        {!isRecovery && <button className="auth-text-button" type="button" onClick={() => void resendVerificationEmail()} disabled={busy}>Resend confirmation email</button>}
        {!configured && <div className="error-banner auth-note" role="status"><span aria-hidden="true">i</span><span>Authentication is unavailable until Supabase is configured.</span></div>}
        {error && <div className="field-error" role="alert">{error}</div>}
        {info && <div className="error-banner auth-note" role="status">{info}</div>}
        <button className="btn btn-primary" type="submit" style={{ width: '100%' }} disabled={busy}>{busy ? 'Please wait…' : isRecovery ? 'Update password' : isSignup ? 'Create account' : 'Sign in'}</button>
        {!isRecovery && <div className="auth-switch">{isSignup ? 'Already have an account?' : `New to ${APP_NAME}?`} <Link to={isSignup ? '/signin' : '/signup'}>{isSignup ? 'Sign in' : 'Create account'}</Link></div>}
        {!isRecovery && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb', textAlign: 'center' }}>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--muted)' }}>No account needed to meet:</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <Link to="/create" className="btn btn-secondary" style={{ flex: 1, textAlign: 'center', fontSize: 13 }}>Start as Guest</Link>
              <Link to="/join" className="btn btn-secondary" style={{ flex: 1, textAlign: 'center', fontSize: 13 }}>Join a Meeting</Link>
            </div>
          </div>
        )}
      </form>
    </main>
  )
}
