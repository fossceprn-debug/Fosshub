import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CalendarDays, Check, Copy, Link as LinkIcon, Plus, Search, Shield, Video } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from '../store-context'
import { APP_NAME, DASHBOARD_GREETING } from '../config'
import { createMeetingId } from '../utils/meeting'
import { useAuth } from '../auth'
import { requireSupabase } from '../services/supabase'
import type { MeetingVisibility } from '../types'

const TODAY_LABEL = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

function MeetingRow({ title, date, people, meetingId }: {
  title: string; date: Date; people?: number; meetingId?: string
}) {
  return (
    <div className="meeting-row">
      <div className="date-block"><span>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>{date.getDate()}</strong></div>
      <div className="meeting-row-copy"><strong>{title}</strong><span>{date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{people ? ` · ${people} participants` : ''}</span></div>
      {meetingId ? <Link className="btn btn-secondary btn-small" to={`/join/${meetingId}`}>Open</Link> : <span className="status-pill"><i className="status-dot" /> Upcoming</span>}
    </div>
  )
}

export function DashboardPage() {
  const { meetings, meetingsLoading, dataError, refreshMeetings } = useStore()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [now] = useState(() => Date.now())
  const savedMeetings = useMemo(() => meetings.slice(0, 3), [meetings])
  const displayName = user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'there'

  return (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">{TODAY_LABEL}</span><h1>{DASHBOARD_GREETING}, {displayName}</h1><p>Welcome to your {APP_NAME} workspace.</p></div>
        <Link className="btn btn-primary" to="/create"><Plus size={16} /> New meeting</Link>
      </div>
      <div className="quick-grid">
        <button className="quick-card" onClick={() => navigate('/create')}><span className="quick-icon"><Video size={19} /></span><span><strong>Start instant meeting</strong><span>Launch a room right away</span></span></button>
        <button className="quick-card" onClick={() => navigate('/join')}><span className="quick-icon"><LinkIcon size={18} /></span><span><strong>Join with a code</strong><span>Have a meeting link handy?</span></span></button>
        <button className="quick-card" onClick={() => navigate('/schedule')}><span className="quick-icon"><CalendarDays size={18} /></span><span><strong>Schedule a meeting</strong><span>Plan ahead with your team</span></span></button>
      </div>
      <div className="dashboard-grid">
        <section className="card panel">
          <div className="panel-head"><h2>Upcoming meetings</h2><Link to="/schedule">View schedule</Link></div>
          <div className="meeting-list">
            {meetingsLoading && <div className="empty-state" role="status">Loading your meetings…</div>}
            {dataError && <div className="error-banner" role="alert">{dataError} <button className="auth-text-button" onClick={() => void refreshMeetings()}>Try again</button></div>}
            {meetings.filter((meeting) => meeting.scheduledFor && new Date(meeting.scheduledFor).getTime() >= now).map((meeting) => (
              <MeetingRow key={meeting.id} title={meeting.title} date={new Date(meeting.scheduledFor!)} meetingId={meeting.id} />
            ))}
            {!meetingsLoading && !dataError && !meetings.some((meeting) => meeting.scheduledFor && new Date(meeting.scheduledFor).getTime() >= now) && <div className="empty-state">No upcoming meetings. Schedule one to get started.</div>}
          </div>
        </section>
        <div>
          <section className="card room-card">
            <span className="eyebrow">Ready to meet?</span>
            <h3>Start a new room</h3>
            <p>Create a secure meeting link and invite your class or team.</p>
            <Link to="/create" className="btn btn-primary" style={{ width: '100%' }}><Video size={15} /> Create meeting</Link>
          </section>
          <div className="card stat-card"><span>Meetings in your workspace</span><strong>{meetings.length}</strong></div>
        </div>
      </div>
      <section className="card panel section-spacer">
        <div className="panel-head"><h2>Recent meetings</h2><span className="text-link">Last 3 meetings</span></div>
        <div className="meeting-list">
          {meetingsLoading ? <div className="empty-state" role="status">Loading your meeting history…</div> : savedMeetings.length > 0 ? savedMeetings.map((meeting) => (
            <MeetingRow key={meeting.id} title={meeting.title} date={new Date(meeting.createdAt)} meetingId={meeting.id} />
          )) : <div className="empty-state">Your meeting history will appear here.</div>}
        </div>
      </section>
    </>
  )
}

export function CreateMeetingPage() {
  const navigate = useNavigate()
  const { createMeeting, notify } = useStore()
  const [title, setTitle] = useState('')
  const [id, setId] = useState(createMeetingId)
  const [visibility, setVisibility] = useState<MeetingVisibility>('anyone')
  const [waitingRoom, setWaitingRoom] = useState(true)
  const [participantMic, setParticipantMic] = useState(false)
  const [participantCamera, setParticipantCamera] = useState(true)
  const [password, setPassword] = useState('')
  const [invitedEmails, setInvitedEmails] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const meetingLink = `${window.location.origin}/join/${id}`

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(meetingLink)
      notify('Meeting link copied')
    } catch {
      setError('Could not access the clipboard. You can copy the link from the field.')
    }
  }
  const start = async (event: FormEvent) => {
    event.preventDefault()
    if (title.trim().length < 3) { setError('Add a meeting title with at least 3 characters.'); return }
    if (!/^[a-z0-9]{4}(?:-[a-z0-9]{4}){2}$/.test(id)) { setError('Use a valid meeting ID or generate a new one.'); return }
    if (password && password.length < 4) { setError('Meeting password must be at least 4 characters.'); return }
    const invites = invitedEmails.split(',').map((email) => email.trim()).filter(Boolean)
    if (visibility === 'invited' && (!invites.length || invites.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
      setError('Enter one or more valid invitee email addresses, separated by commas.')
      return
    }
    setBusy(true)
    setError('')
    try {
      let targetId = id.toLowerCase()
      try {
        const meeting = await createMeeting({ code: id, title: title.trim(), visibility, waitingRoom, participantMic, participantCamera, password: password || undefined, invitedEmails: invites })
        targetId = meeting.id
      } catch (backendErr) {
        console.warn('Backend create meeting unauthenticated, continuing in instant mode:', backendErr)
      }
      navigate(`/join/${targetId}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create meeting.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-heading"><div><span className="eyebrow">Make space for a good conversation</span><h1>Create a meeting</h1><p>Set up a room and invite your people in.</p></div></div>
      <form className="form-layout" onSubmit={start}>
        <section className="form-card">
          <h2>Meeting details</h2><p>Choose the basics. You can adjust the experience anytime.</p>
          <div className="field"><label htmlFor="meeting-title">Meeting title</label><input id="meeting-title" value={title} onChange={(event) => { setTitle(event.target.value); setError('') }} placeholder="e.g. Weekly team sync" maxLength={80} required /></div>
          <div className="field"><label htmlFor="meeting-id">Meeting ID</label><div style={{ display: 'flex', gap: 8 }}><input id="meeting-id" value={id} onChange={(event) => setId(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /><button className="btn btn-secondary" type="button" onClick={() => setId(createMeetingId())}>Generate</button></div><span className="field-hint">Share this code or its meeting link with guests.</span></div>
          <div className="field"><label htmlFor="visibility">Who can join</label><select id="visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as MeetingVisibility)}><option value="anyone">Anyone with the link</option><option value="invited">Only invited people</option></select></div>
          {visibility === 'invited' && <div className="field"><label htmlFor="create-invitees">Invitee email addresses</label><input id="create-invitees" type="text" value={invitedEmails} onChange={(event) => setInvitedEmails(event.target.value)} placeholder="name@example.com, person@example.com" autoComplete="email" /><span className="field-hint">Only authenticated accounts with these email addresses can join.</span></div>}
          <div className="field"><label htmlFor="password">Meeting password <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label><input id="password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Add an extra layer of privacy" /><span className="field-hint">The server stores a one-way password hash, never the plain-text password.</span></div>
          <Toggle label="Waiting room" detail="People wait until you let them in." value={waitingRoom} onChange={setWaitingRoom} />
          <Toggle label="Participant microphones on" detail="Allow participants to join with their microphone enabled." value={participantMic} onChange={setParticipantMic} />
          <Toggle label="Participant cameras on" detail="Allow participants to join with their camera enabled." value={participantCamera} onChange={setParticipantCamera} />
          {error && <div className="field-error" role="alert" style={{ margin: '12px 0' }}>{error}</div>}
          <div className="form-actions"><button type="button" className="btn btn-secondary" onClick={copyLink}><Copy size={14} /> Copy invite link</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : <><Video size={15} /> Continue to lobby</>}</button></div>
        </section>
        <aside>
          <div className="form-card">
            <h2>Your invite link</h2><p>Anyone with the link can request to join this room.</p>
            <div className="field"><label htmlFor="meeting-link">Meeting link</label><input id="meeting-link" value={meetingLink} readOnly onFocus={(event) => event.target.select()} /></div>
            <button type="button" onClick={copyLink} className="btn btn-secondary" style={{ width: '100%' }}><Copy size={14} /> Copy link</button>
          </div>
          <div className="card room-card section-spacer"><Shield size={20} color="var(--brand)" /><h3>Your room, your rules</h3><p>Meeting access, waiting-room settings, and password checks are enforced by Supabase.</p></div>
        </aside>
      </form>
    </>
  )
}

function Toggle({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="toggle-row"><div className="toggle-copy"><strong>{label}</strong><span>{detail}</span></div><button type="button" role="switch" aria-checked={value} aria-label={label} className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)} /></div>
}

export function JoinMeetingPage() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    let meetingCode = code.trim()
    try {
      if (/^https?:\/\//i.test(meetingCode)) meetingCode = new URL(meetingCode).pathname.split('/').filter(Boolean).pop() || ''
      else meetingCode = meetingCode.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''
    } catch { meetingCode = '' }
    if (!/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(meetingCode)) { setError('Enter a valid FOSSHub meeting code or link.'); return }
    if (!name.trim()) { setError('Enter your display name to continue.'); return }
    sessionStorage.setItem('fosshub-display-name', name.trim())
    navigate(`/join/${meetingCode.toLowerCase()}`)
  }
  return (
    <>
      <div className="page-heading"><div><span className="eyebrow">Come on in</span><h1>Join a meeting</h1><p>Enter the meeting code or paste the invitation link.</p></div></div>
      <form className="form-card" style={{ maxWidth: 610 }} onSubmit={submit}>
        <h2>Meeting details</h2><p>You can check your camera and microphone before joining.</p>
        <div className="field"><label htmlFor="join-code">Meeting code or link</label><input id="join-code" value={code} onChange={(event) => { setCode(event.target.value); setError('') }} placeholder="e.g. team-sync-042 or a meeting link" autoComplete="url" required /></div>
        <div className="field"><label htmlFor="display-name">Your name</label><input id="display-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="How should others see you?" maxLength={40} required /></div>
        {error && <div className="field-error" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
        <div className="form-actions"><button className="btn btn-primary" type="submit">Continue to preview <Search size={14} /></button></div>
      </form>
    </>
  )
}

export function SchedulePage() {
  const { meetings, createMeeting, notify } = useStore()
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [duration, setDuration] = useState('30')
  const [password, setPassword] = useState('')
  const [participants, setParticipants] = useState('')
  const [waitingRoom, setWaitingRoom] = useState(true)
  const [visibility, setVisibility] = useState<MeetingVisibility>('anyone')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const scheduledDate = new Date(`${date}T${time}`)
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() < Date.now()) { setError('Choose a time in the future.'); return }
    const invitedEmails = participants.split(',').map((participant) => participant.trim()).filter(Boolean)
    if (invitedEmails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) { setError('Enter valid email addresses, separated by commas.'); return }
    if (visibility === 'invited' && !invitedEmails.length) { setError('Add at least one invitee for a restricted meeting.'); return }
    setBusy(true)
    setError('')
    try {
      await createMeeting({
        code: createMeetingId(),
        title: title.trim(),
        visibility,
        waitingRoom,
        participantMic: false,
        participantCamera: true,
        password: password || undefined,
        scheduledFor: scheduledDate.toISOString(),
        durationMinutes: Number(duration),
        invitedEmails,
      })
      setTitle(''); setDate(''); setTime(''); setParticipants(''); setPassword('')
      notify(`Meeting scheduled for ${scheduledDate.toLocaleString()}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not schedule meeting.')
    } finally {
      setBusy(false)
    }
  }
  const scheduled = meetings.filter((meeting) => meeting.scheduledFor)
  return (
    <>
      <div className="page-heading"><div><span className="eyebrow">Make time for your team</span><h1>Schedule a meeting</h1><p>Plan ahead and send a link to your participants.</p></div></div>
      <div className="form-layout">
        <form className="form-card" onSubmit={save}>
          <h2>Meeting details</h2><p>Times use your device’s local time zone.</p>
          <div className="field"><label htmlFor="schedule-title">Meeting title</label><input id="schedule-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Project kickoff" required minLength={3} maxLength={80} /></div>
          <div className="two-fields">
            <div className="field"><label htmlFor="schedule-date">Date</label><input id="schedule-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></div>
            <div className="field"><label htmlFor="schedule-time">Time</label><input id="schedule-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></div>
          </div>
          <div className="two-fields">
            <div className="field"><label htmlFor="duration">Duration</label><select id="duration" value={duration} onChange={(event) => setDuration(event.target.value)}><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">1 hour</option></select></div>
            <div className="field"><label htmlFor="schedule-password">Password (optional)</label><input id="schedule-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Optional" /></div>
          </div>
          <div className="field"><label htmlFor="schedule-visibility">Who can join</label><select id="schedule-visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as MeetingVisibility)}><option value="anyone">Anyone with the link</option><option value="invited">Only invited people</option></select></div>
          <div className="field"><label htmlFor="invitees">Invitees</label><input id="invitees" value={participants} onChange={(event) => setParticipants(event.target.value)} placeholder="Email addresses, separated by commas" /><span className="field-hint">Invitees must sign in with these email addresses when access is restricted.</span></div>
          <Toggle label="Waiting room" detail="People wait until you let them in." value={waitingRoom} onChange={setWaitingRoom} />
          {error && <div className="field-error" role="alert">{error}</div>}
          <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : <><CalendarDays size={15} /> Save meeting</>}</button></div>
        </form>
        <section className="card panel">
          <div className="panel-head"><h2>Upcoming</h2><span className="eyebrow">{scheduled.length} scheduled</span></div>
          {scheduled.length ? <div className="meeting-list">{scheduled.map((meeting) => <MeetingRow key={meeting.id} title={meeting.title} date={new Date(meeting.scheduledFor!)} meetingId={meeting.id} />)}</div> : <div className="empty-state">Your scheduled meetings will appear here.</div>}
        </section>
      </div>
    </>
  )
}

export function SettingsPage() {
  const { theme, toggleTheme, notify } = useStore()
  const { user } = useAuth()
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('fosshub-display-name') || user?.user_metadata?.display_name || user?.email?.split('@')[0] || '')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceError, setDeviceError] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [testingMic, setTestingMic] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [quality, setQuality] = useState(() => localStorage.getItem('fosshub-video-quality') || 'Auto')
  const testStream = useRef<MediaStream | null>(null)
  const audioContext = useRef<AudioContext | null>(null)
  const animationFrame = useRef(0)

  const stopMicTest = () => {
    cancelAnimationFrame(animationFrame.current)
    testStream.current?.getTracks().forEach((track) => track.stop())
    testStream.current = null
    void audioContext.current?.close()
    audioContext.current = null
    setTestingMic(false)
    setMicLevel(0)
  }
  useEffect(() => () => {
    cancelAnimationFrame(animationFrame.current)
    testStream.current?.getTracks().forEach((track) => track.stop())
    void audioContext.current?.close()
  }, [])

  const discoverDevices = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setDeviceError('Device access is unavailable in this browser or page context.')
      return
    }
    setDiscovering(true)
    setDeviceError('')
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      permissionStream.getTracks().forEach((track) => track.stop())
      setDevices(await navigator.mediaDevices.enumerateDevices())
    } catch (reason) {
      setDeviceError(reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? 'Device permission was denied. Allow camera and microphone access in browser settings.'
        : 'Could not discover devices. Connect a camera or microphone and try again.')
    } finally {
      setDiscovering(false)
    }
  }
  const toggleMicTest = async () => {
    if (testingMic) { stopMicTest(); return }
    if (!navigator.mediaDevices?.getUserMedia) { setDeviceError('Microphone testing is unavailable in this browser.'); return }
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    try {
      const selectedMic = localStorage.getItem('fosshub-microphone')
      stream = await navigator.mediaDevices.getUserMedia({ audio: selectedMic ? { deviceId: { exact: selectedMic } } : true })
      context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      testStream.current = stream
      audioContext.current = context
      setTestingMic(true)
      const measure = () => {
        analyser.getByteTimeDomainData(samples)
        const average = samples.reduce((sum, sample) => sum + Math.abs(sample - 128), 0) / samples.length
        setMicLevel(Math.min(100, Math.round(average * 5)))
        animationFrame.current = requestAnimationFrame(measure)
      }
      measure()
    } catch (reason) {
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close()
      setDeviceError(reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : 'Could not start the microphone test.')
    }
  }

  const microphones = devices.filter((device) => device.kind === 'audioinput')
  const cameras = devices.filter((device) => device.kind === 'videoinput')
  const outputs = devices.filter((device) => device.kind === 'audiooutput')
  const saveDevice = (key: string, value: string) => {
    localStorage.setItem(key, value)
    notify('Device preference saved for your next meeting.')
  }
  const saveDisplayName = async () => {
    const trimmed = displayName.trim()
    if (!trimmed || trimmed.length > 80) { notify('Display name must be between 1 and 80 characters.'); return }
    try {
      const client = requireSupabase()
      const { error: profileError } = await client.from('profiles').update({ display_name: trimmed }).eq('id', user?.id || '')
      if (profileError) throw profileError
      const { error: authError } = await client.auth.updateUser({ data: { display_name: trimmed } })
      if (authError) throw authError
      localStorage.setItem('fosshub-display-name', trimmed)
      notify('Display name saved.')
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not save your display name.')
    }
  }
  return (
    <>
      <div className="page-heading"><div><span className="eyebrow">Make it yours</span><h1>Settings</h1><p>Manage your FOSSHub profile and device preferences.</p></div></div>
      <section className="form-card" style={{ maxWidth: 700 }}>
        <h2>Personal preferences</h2><p>Preferences are saved in this browser only.</p>
        <div className="field"><label htmlFor="settings-name">Display name</label><div style={{ display: 'flex', gap: 8 }}><input id="settings-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} /><button className="btn btn-secondary" onClick={() => void saveDisplayName()}>Save</button></div></div>
        <div className="toggle-row"><div className="toggle-copy"><strong>Dark appearance</strong><span>Use a darker interface throughout your workspace.</span></div><button type="button" role="switch" aria-checked={theme === 'dark'} aria-label="Dark appearance" className={`switch ${theme === 'dark' ? 'on' : ''}`} onClick={toggleTheme} /></div>
        <div className="section-spacer" />
        <h2>Audio & video</h2><p>Choose defaults for future meeting sessions. Device access begins only when requested.</p>
        <button className="btn btn-secondary btn-small" onClick={() => void discoverDevices()} disabled={discovering}>{discovering ? 'Checking devices…' : 'Allow and discover devices'}</button>
        {deviceError && <div className="error-banner" role="alert">{deviceError}</div>}
        {devices.length > 0 && <>
          <div className="field section-spacer"><label htmlFor="settings-mic">Microphone</label><select id="settings-mic" defaultValue={localStorage.getItem('fosshub-microphone') || ''} onChange={(event) => saveDevice('fosshub-microphone', event.target.value)}><option value="">Default microphone</option>{microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>
          <div className="field"><label htmlFor="settings-camera">Camera</label><select id="settings-camera" defaultValue={localStorage.getItem('fosshub-camera') || ''} onChange={(event) => saveDevice('fosshub-camera', event.target.value)}><option value="">Default camera</option>{cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>
          <div className="field"><label htmlFor="settings-output">Audio output</label><select id="settings-output" defaultValue={localStorage.getItem('fosshub-audio-output') || ''} onChange={(event) => saveDevice('fosshub-audio-output', event.target.value)}><option value="">Default output</option>{outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</option>)}</select></div>
        </>}
        <div className="toggle-row"><div className="toggle-copy"><strong>Microphone test</strong><span>{testingMic ? `Listening — input level ${micLevel}%` : 'Check that your microphone is picking up sound.'}</span></div><button className="btn btn-secondary btn-small" onClick={() => void toggleMicTest()}>{testingMic ? 'Stop test' : 'Test microphone'}</button></div>
        <div style={{ height: 5, margin: '0 0 18px', overflow: 'hidden', borderRadius: 5, background: 'var(--line)' }}><div style={{ width: `${micLevel}%`, height: '100%', background: 'var(--mint)', transition: 'width .1s' }} /></div>
        <div className="field"><label htmlFor="video-quality">Video quality preference</label><select id="video-quality" value={quality} onChange={(event) => { setQuality(event.target.value); localStorage.setItem('fosshub-video-quality', event.target.value) }}><option>Auto</option><option>720p</option><option>540p</option><option>360p</option></select></div>
        <div className="field-hint">LiveKit applies this capture resolution when you enable your camera. Background blur is not enabled in this build.</div>
        <div className="section-spacer" />
        <h2>Keyboard shortcuts</h2>
        <div className="toggle-row"><div className="toggle-copy"><strong>Mute or unmute</strong><span>Alt + Shift + M</span></div><span className="field-hint">Meeting room</span></div>
        <div className="toggle-row"><div className="toggle-copy"><strong>Turn camera on or off</strong><span>Alt + Shift + V</span></div><span className="field-hint">Meeting room</span></div>
        <div className="form-actions"><Link className="btn btn-secondary" to="/dashboard"><Check size={14} /> Done</Link></div>
      </section>
    </>
  )
}
