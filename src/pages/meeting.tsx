import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  AlertCircle, ArrowLeft, Camera, CameraOff, Copy, Hand, LayoutGrid,
  Mic, MicOff, PhoneOff, Send, Settings2, Share, Smile, Users, Video, X,
} from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { RemoteTrackPublication, Room, RoomEvent, Track, VideoPresets, type Participant, type VideoTrack } from 'livekit-client'
import { Modal } from '../components/Toast'
import { useAuth } from '../auth'
import { useStore } from '../store-context'
import {
  approveParticipant,
  endMeeting,
  getParticipantState,
  joinMeeting,
  leaveMeeting,
  listMessages,
  listParticipants,
  previewMeeting,
  sendMessage as sendMessageToServer,
  subscribeToMessages,
  updateParticipantState,
} from '../services/meeting-service'
import { requireSupabase } from '../services/supabase'
import type { ChatMessage } from '../types'
import type { MeetingPreviewRow, ParticipantRow, ParticipantStateRow } from '../services/database.types'

const PARTICIPANT_PAGE_SIZE = 50
const VISIBLE_VIDEO_COUNT = 8
const ACTIVE_AUDIO_COUNT = 4
const JOIN_STATE_PREFIX = 'fosshub-join:'

function useLocalPreview() {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState('')
  const [cameraOn, setCameraOn] = useState(false)
  const [micOn, setMicOn] = useState(false)

  useEffect(() => () => stream?.getTracks().forEach((track) => track.stop()), [stream])

  const start = async (only: 'camera' | 'microphone' | 'both' = 'both') => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera preview is unavailable in this browser or page context. Use HTTPS or localhost.')
      return
    }
    try {
      const cameraId = localStorage.getItem('fosshub-camera')
      const microphoneId = localStorage.getItem('fosshub-microphone')
      const next = await navigator.mediaDevices.getUserMedia({
        video: only === 'microphone' ? false : cameraId ? { deviceId: { exact: cameraId } } : true,
        audio: only === 'camera' ? false : microphoneId ? { deviceId: { exact: microphoneId } } : true,
      })
      setStream((previous) => {
        const replacedKind = only === 'camera' ? 'video' : only === 'microphone' ? 'audio' : null
        const retainedTracks = previous?.getTracks().filter((track) => {
          if (track.kind === replacedKind || replacedKind === null) {
            track.stop()
            return false
          }
          return true
        }) ?? []
        return new MediaStream([...retainedTracks, ...next.getTracks()])
      })
      if (only !== 'microphone') setCameraOn(true)
      if (only !== 'camera') setMicOn(true)
      setDevices(await navigator.mediaDevices.enumerateDevices())
      setError('')
    } catch (reason) {
      const errorName = reason instanceof DOMException ? reason.name : ''
      setError(errorName === 'NotAllowedError'
        ? 'Camera or microphone permission was denied. Allow access in browser settings and try again.'
        : errorName === 'NotFoundError'
          ? 'No camera or microphone was found. You can still join with both turned off.'
          : 'Could not start the camera preview. Check that the devices are available.')
    }
  }
  const toggle = (kind: 'camera' | 'microphone') => {
    const hasTrack = kind === 'camera' ? Boolean(stream?.getVideoTracks().length) : Boolean(stream?.getAudioTracks().length)
    if (!stream || !hasTrack) { void start(kind); return }
    const enabled = kind === 'camera' ? !cameraOn : !micOn
    const tracks = kind === 'camera' ? stream?.getVideoTracks() : stream?.getAudioTracks()
    tracks?.forEach((track) => { track.enabled = enabled })
    if (kind === 'camera') setCameraOn(enabled)
    else setMicOn(enabled)
  }
  const selectDevice = async (kind: 'videoinput' | 'audioinput', deviceId: string) => {
    localStorage.setItem(kind === 'videoinput' ? 'fosshub-camera' : 'fosshub-microphone', deviceId)
    if (!stream || (!cameraOn && !micOn)) return
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: cameraOn ? (kind === 'videoinput' && deviceId ? { deviceId: { exact: deviceId } } : true) : false,
        audio: micOn ? (kind === 'audioinput' && deviceId ? { deviceId: { exact: deviceId } } : true) : false,
      })
      setStream((previous) => {
        previous?.getTracks().forEach((track) => track.stop())
        return next
      })
      setDevices(await navigator.mediaDevices.enumerateDevices())
    } catch (reason) {
      setError(reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? 'Device permission was denied.'
        : 'Could not switch devices. Check the selected device and try again.')
    }
  }
  return { stream, devices, error, cameraOn, micOn, start, toggle, selectDevice }
}

function LocalPreviewVideo({ stream }: { stream: MediaStream }) {
  const element = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (!element.current) return
    const node = element.current
    node.srcObject = stream
    return () => { node.srcObject = null }
  }, [stream])
  return <video ref={element} autoPlay muted playsInline aria-label="Your local camera preview" />
}

export function LobbyPage() {
  const { meetingId = '' } = useParams()
  const navigate = useNavigate()
  const { ensureGuestSession, user } = useAuth()
  const preview = useLocalPreview()
  const [meeting, setMeeting] = useState<MeetingPreviewRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState(() => sessionStorage.getItem('fosshub-display-name') || user?.user_metadata?.display_name || user?.email?.split('@')[0] || '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [waitingMeetingId, setWaitingMeetingId] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    void previewMeeting(meetingId)
      .then((result) => {
        if (!active) return
        if (!result) setError('This meeting link is invalid or the meeting has ended.')
        else setMeeting(result)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load meeting details.')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [meetingId])

  useEffect(() => {
    if (!waiting) return
    let active = true
    const check = async () => {
      try {
        const state = await getParticipantState(meetingId)
        if (!active) return
        if (!state) {
          setError('The meeting ended or your waiting-room request was removed.')
          setWaiting(false)
          return
        }
        if (state.status === 'active') {
          sessionStorage.setItem(`${JOIN_STATE_PREFIX}${meetingId}`, JSON.stringify(state))
          navigate(`/meeting/${meetingId}`, { replace: true })
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not check the waiting room.')
      }
    }
    void check()
    const interval = window.setInterval(() => void check(), 3000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [meetingId, navigate, waiting])

  const join = async () => {
    if (!meeting) return
    if (!name.trim()) { setError('Enter your display name to continue.'); return }
    if (password.length > 128) { setError('The meeting password is too long.'); return }
    setBusy(true)
    setError('')
    try {
      await ensureGuestSession()
      sessionStorage.setItem('fosshub-display-name', name.trim())
      const joined = await joinMeeting(meetingId, name.trim(), password)
      await updateParticipantState(joined.meeting_id, preview.micOn, preview.cameraOn, false)
      const state = await getParticipantState(meetingId)
      if (!state) throw new Error('Your participant session could not be verified.')
      sessionStorage.setItem(`${JOIN_STATE_PREFIX}${meetingId}`, JSON.stringify(state))
      if (joined.waiting || state.status === 'waiting') {
        setWaitingMeetingId(state.meeting_id)
        setWaiting(true)
      } else {
        navigate(`/meeting/${meetingId}`, { replace: true })
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not join this meeting.')
    } finally {
      setBusy(false)
    }
  }

  if (waiting) {
    const cancelRequest = async () => {
      try {
        if (waitingMeetingId) await leaveMeeting(waitingMeetingId)
        sessionStorage.removeItem(`${JOIN_STATE_PREFIX}${meetingId}`)
        navigate('/', { replace: true })
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Could not cancel the waiting-room request.')
      }
    }
    return (
      <section className="form-card" style={{ maxWidth: 620, margin: '36px auto', textAlign: 'center' }}>
        <span className="eyebrow">Waiting room</span>
        <h1>{meeting?.title || 'Meeting'}</h1>
        <p>Your join request has been sent. This page will continue when the host admits you.</p>
        {error && <div className="field-error" role="alert">{error}</div>}
        <button className="btn btn-secondary" onClick={() => void cancelRequest()}>Cancel request</button>
      </section>
    )
  }

  return (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">Before you join</span><h1>Ready when you are</h1><p>Check your setup and say hello to the room.</p></div>
        <Link to="/join" className="btn btn-secondary"><ArrowLeft size={14} /> Back</Link>
      </div>
      <div className="lobby-grid">
        <section>
          <div className="preview-card lobby-preview">
            {preview.cameraOn && preview.stream && <LocalPreviewVideo stream={preview.stream} />}
            {!preview.cameraOn && <div className="preview-placeholder"><span className="avatar">{name.trim().slice(0, 2).toUpperCase() || 'ME'}</span><span>{preview.stream ? 'Camera is off' : 'Your camera preview will appear here'}</span></div>}
            <div className="lobby-tools">
              <button className={`tool-btn ${preview.micOn ? '' : 'off'}`} aria-label={preview.micOn ? 'Mute microphone' : 'Turn microphone on'} onClick={() => preview.toggle('microphone')}>{preview.micOn ? <Mic size={17} /> : <MicOff size={17} />}<span>Mic</span></button>
              <button className={`tool-btn ${preview.cameraOn ? '' : 'off'}`} aria-label={preview.cameraOn ? 'Turn camera off' : 'Turn camera on'} onClick={() => preview.toggle('camera')}>{preview.cameraOn ? <Camera size={17} /> : <CameraOff size={17} />}<span>Camera</span></button>
            </div>
          </div>
          {!preview.stream && <button className="btn btn-secondary section-spacer" onClick={() => void preview.start()}>Enable camera preview</button>}
          {preview.error && <div className="error-banner" role="alert"><AlertCircle size={16} />{preview.error}</div>}
          {preview.devices.some((device) => device.kind === 'videoinput') && <div className="field section-spacer"><label htmlFor="lobby-camera">Camera</label><select id="lobby-camera" defaultValue={localStorage.getItem('fosshub-camera') || ''} onChange={(event) => void preview.selectDevice('videoinput', event.target.value)}><option value="">Default camera</option>{preview.devices.filter((device) => device.kind === 'videoinput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>}
        </section>
        <section className="form-card">
          <span className="eyebrow">Meeting details</span>
          <h2 style={{ marginTop: 9 }}>{loading ? 'Loading meeting…' : meeting?.title || 'Meeting not available'}</h2>
          <p>Room code <strong>{meetingId}</strong> · {meeting?.waiting_room ? 'Waiting room enabled' : 'Open room'}</p>
          <div className="field"><label htmlFor="lobby-name">Your name</label><input id="lobby-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="name" required /></div>
          {meeting?.password_required && <div className="field"><label htmlFor="lobby-password">Meeting password</label><input id="lobby-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></div>}
          {preview.devices.some((device) => device.kind === 'audioinput') && <div className="field"><label htmlFor="lobby-microphone">Microphone</label><select id="lobby-microphone" defaultValue={localStorage.getItem('fosshub-microphone') || ''} onChange={(event) => void preview.selectDevice('audioinput', event.target.value)}><option value="">Default microphone</option>{preview.devices.filter((device) => device.kind === 'audioinput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>}
          {error && <div className="field-error" role="alert">{error}</div>}
          <div className="field-hint">Camera and microphone are sent only after you join the live room.</div>
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 12 }} onClick={() => void join()} disabled={loading || busy || !meeting}>{busy ? 'Joining…' : 'Join meeting'} <Video size={15} /></button>
        </section>
      </div>
    </>
  )
}

function VideoElement({ track }: { track?: VideoTrack }) {
  const element = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (!track || !element.current) return
    const node = element.current
    track.attach(node)
    return () => { track.detach(node) }
  }, [track])
  return <video ref={element} autoPlay muted playsInline />
}

function AudioElement({ participant }: { participant: Participant }) {
  const element = useRef<HTMLAudioElement>(null)
  const track = participant.getTrackPublication(Track.Source.Microphone)?.track
  useEffect(() => {
    if (!track || !element.current) return
    const node = element.current
    track.attach(node)
    return () => { track.detach(node) }
  }, [track])
  return <audio ref={element} autoPlay />
}

export function MeetingRoomPage() {
  const { meetingId = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { notify } = useStore()
  const [membership, setMembership] = useState<ParticipantStateRow | null>(null)
  const [remoteParticipants, setRemoteParticipants] = useState<Participant[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [participants, setParticipants] = useState<ParticipantRow[]>([])
  const [participantOffset, setParticipantOffset] = useState(0)
  const [hasMoreParticipants, setHasMoreParticipants] = useState(true)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(true)
  const [connected, setConnected] = useState(false)
  const [localVideoTrack, setLocalVideoTrack] = useState<VideoTrack>()
  const [localScreenTrack, setLocalScreenTrack] = useState<VideoTrack>()
  const [muted, setMuted] = useState(true)
  const [cameraOff, setCameraOff] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [handRaised, setHandRaised] = useState(false)
  const [layout, setLayout] = useState<'grid' | 'speaker'>('grid')
  const [panel, setPanel] = useState<'participants' | 'chat' | 'settings' | null>(null)
  const [participantQuery, setParticipantQuery] = useState('')
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [page, setPage] = useState(0)
  const [activeSpeakerIds, setActiveSpeakerIds] = useState<string[]>([])
  const [reaction, setReaction] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const roomRef = useRef<Room | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)
  const [reactionMenu, setReactionMenu] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [quality, setQuality] = useState(() => localStorage.getItem('fosshub-video-quality') || 'Auto')

  const refreshParticipants = useCallback(async (offset = 0, append = false) => {
    if (!membership) return
    const next = await listParticipants(membership.meeting_id, offset, PARTICIPANT_PAGE_SIZE)
    setParticipants((current) => append ? [...current, ...next] : next)
    setParticipantOffset(offset + next.length)
    setHasMoreParticipants(next.length === PARTICIPANT_PAGE_SIZE)
  }, [membership])

  useEffect(() => {
    let active = true
    let connectingRoom: Room | null = null
    const connect = async () => {
      try {
        const state = await getParticipantState(meetingId)
        if (!state) throw new Error('You are not an active participant in this meeting. Rejoin using the meeting link.')
        if (state.status === 'waiting') throw new Error('The host has not admitted you yet.')
        if (!active) return
        setMembership(state)
        setMuted(!state.mic_enabled)
        setCameraOff(!state.camera_enabled)

        const { data, error: tokenError } = await requireSupabase().functions.invoke('livekit-token', { body: { code: meetingId } })
        if (tokenError) {
          const status = 'status' in tokenError && typeof tokenError.status === 'number' ? tokenError.status : null
          if (status === 404) throw new Error('The media service is not deployed. Ask the site administrator to deploy the livekit-token Edge Function.')
          throw new Error(tokenError.message || 'Could not request a LiveKit connection.')
        }
        if (!data || typeof data !== 'object' || !('url' in data) || !('token' in data) || typeof data.url !== 'string' || typeof data.token !== 'string') {
          throw new Error('The media service returned an invalid connection response.')
        }

        const room = new Room({ adaptiveStream: true, dynacast: true })
        connectingRoom = room
        roomRef.current = room
        const updateRemoteParticipants = () => {
          if (active) setRemoteParticipants(Array.from(room.remoteParticipants.values()))
        }
        room.on(RoomEvent.ParticipantConnected, updateRemoteParticipants)
        room.on(RoomEvent.ParticipantDisconnected, updateRemoteParticipants)
        room.on(RoomEvent.TrackPublished, updateRemoteParticipants)
        room.on(RoomEvent.TrackSubscribed, updateRemoteParticipants)
        room.on(RoomEvent.TrackUnsubscribed, updateRemoteParticipants)
        room.on(RoomEvent.LocalTrackPublished, (publication) => {
          if (!active) return
          if (publication.source === Track.Source.Camera) setLocalVideoTrack(publication.track as VideoTrack)
          if (publication.source === Track.Source.ScreenShare) setLocalScreenTrack(publication.track as VideoTrack)
        })
        room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (!active) return
          if (publication.source === Track.Source.Camera) setLocalVideoTrack(undefined)
          if (publication.source === Track.Source.ScreenShare) {
            setLocalScreenTrack(undefined)
            setSharing(false)
          }
        })
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          if (!active) return
          setActiveSpeakerIds(speakers.map((speaker) => speaker.identity).filter((identity) => identity !== user?.id))
        })
        room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
          if (!active || topic !== 'reaction') return
          try {
            const event: unknown = JSON.parse(new TextDecoder().decode(payload))
            if (event && typeof event === 'object' && 'emoji' in event && typeof event.emoji === 'string') {
              setReaction(`${event.emoji}${participant ? ` ${participant.name || 'Participant'}` : ''}`)
              window.setTimeout(() => setReaction(''), 1800)
            }
          } catch (reason) {
            console.error('Unable to decode meeting reaction.', reason)
          }
        })
        room.on(RoomEvent.Disconnected, () => {
          if (!active) return
          setConnected(false)
          setError('Your media connection ended. Rejoin the meeting to continue.')
        })
        await room.connect(data.url, data.token, { autoSubscribe: false })
        if (!active) {
          await room.disconnect()
          setLocalVideoTrack(undefined)
          return
        }
        setConnected(true)
        setRemoteParticipants(Array.from(room.remoteParticipants.values()))
        const outputId = localStorage.getItem('fosshub-audio-output')
        if (active && outputId) {
          try {
            const switched = await room.switchActiveDevice('audiooutput', outputId)
            if (active && !switched) notify('Saved audio output is unavailable; using the browser default.')
          } catch {
            if (active) notify('Saved audio output could not be selected; using the browser default.')
          }
        }
        if (!active) { await room.disconnect(); return }
        if (state.mic_enabled) {
          const deviceId = localStorage.getItem('fosshub-microphone')
          await room.localParticipant.setMicrophoneEnabled(true, deviceId ? { deviceId } : {})
          if (!active) { await room.disconnect(); return }
        }
        if (state.camera_enabled) {
          const deviceId = localStorage.getItem('fosshub-camera')
          const preferredQuality = localStorage.getItem('fosshub-video-quality') || 'Auto'
          const preset = preferredQuality === '720p' ? VideoPresets.h720 : preferredQuality === '540p' ? VideoPresets.h540 : preferredQuality === '360p' ? VideoPresets.h360 : undefined
          await room.localParticipant.setCameraEnabled(
            true,
            { ...(deviceId ? { deviceId } : {}), ...(preset ? { resolution: preset.resolution } : {}) },
            preset ? { videoEncoding: preset.encoding } : {},
          )
          if (!active) { await room.disconnect(); return }
        }
      } catch (reason) {
        await connectingRoom?.disconnect()
        if (roomRef.current === connectingRoom) roomRef.current = null
        if (active) {
          setLocalVideoTrack(undefined)
          setLocalScreenTrack(undefined)
          setError(reason instanceof Error ? reason.message : 'Could not connect to the media room.')
        }
      } finally {
        if (active) setConnecting(false)
      }
    }
    void connect()
    return () => {
      active = false
      const room = roomRef.current
      roomRef.current = null
      if (room) void room.disconnect()
    }
  }, [meetingId, notify, user?.id])

  useEffect(() => {
    if (!membership) return
    let active = true
    void refreshParticipants().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not load participants.')
    })
    const timer = window.setInterval(() => {
      void refreshParticipants().catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not refresh participants.')
      })
    }, 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [membership, refreshParticipants])

  useEffect(() => {
    if (!membership) return
    let active = true
    void listMessages(membership.meeting_id).then((rows) => {
      if (active) setMessages((current) => [...rows, ...current].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index).sort((a, b) => a.id - b.id))
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not load meeting chat.')
    })
    const unsubscribe = subscribeToMessages(membership.meeting_id, (incoming) => {
      setMessages((current) => current.some((item) => item.id === incoming.id) ? current : [...current, incoming])
    }, (messageText) => setError(messageText), () => {
      void refreshParticipants().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Could not refresh participant status.')
      })
    }, membership.role === 'host')
    return () => { active = false; unsubscribe() }
  }, [membership, refreshParticipants])

  const pageCount = Math.max(1, Math.ceil(remoteParticipants.length / VISIBLE_VIDEO_COUNT))
  const visiblePage = Math.min(page, pageCount - 1)
  const pageParticipants = useMemo(
    () => [...remoteParticipants]
      .sort((a, b) => {
        const score = (participant: Participant) =>
          Number(Boolean(participant.getTrackPublication(Track.Source.ScreenShare))) * 2
          + Number(layout === 'speaker' && activeSpeakerIds.includes(participant.identity))
        return score(b) - score(a)
      })
      .slice(visiblePage * VISIBLE_VIDEO_COUNT, (visiblePage + 1) * VISIBLE_VIDEO_COUNT),
    [activeSpeakerIds, layout, remoteParticipants, visiblePage],
  )
  const focusedParticipantId = layout === 'speaker'
    ? pageParticipants.find((participant) => participant.getTrackPublication(Track.Source.ScreenShare))?.identity
      || activeSpeakerIds.find((identity) => pageParticipants.some((participant) => participant.identity === identity))
      || pageParticipants[0]?.identity
    : undefined
  useEffect(() => {
    const room = roomRef.current
    if (!room || !connected) return
    const videoIdentities = new Set(pageParticipants.map((participant) => participant.identity))
    const speaking = activeSpeakerIds.length
      ? activeSpeakerIds.slice(0, ACTIVE_AUDIO_COUNT)
      : remoteParticipants.slice(0, ACTIVE_AUDIO_COUNT).map((participant) => participant.identity)
    const audioIdentities = new Set(speaking)
    for (const participant of remoteParticipants) {
      for (const publication of participant.trackPublications.values()) {
        if (!(publication instanceof RemoteTrackPublication)) continue
        if (publication.source === Track.Source.Microphone) publication.setSubscribed(audioIdentities.has(participant.identity))
        if (publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare) {
          publication.setSubscribed(videoIdentities.has(participant.identity))
        }
      }
    }
  }, [activeSpeakerIds, connected, pageParticipants, remoteParticipants])

  useEffect(() => {
    if (!connected) return
    const timer = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000)
    return () => window.clearInterval(timer)
  }, [connected])
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, panel])

  const reportMediaState = async (nextMuted: boolean, nextCameraOff: boolean, nextHand: boolean) => {
    if (!membership) return
    try {
      await updateParticipantState(membership.meeting_id, !nextMuted, !nextCameraOff, nextHand)
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not save your meeting status.')
    }
  }
  const toggleMicrophone = async () => {
    const room = roomRef.current
    if (!room) return
    try {
      const deviceId = localStorage.getItem('fosshub-microphone')
      await room.localParticipant.setMicrophoneEnabled(muted, deviceId ? { deviceId } : {})
      const nextMuted = !muted
      setMuted(nextMuted)
      await reportMediaState(nextMuted, cameraOff, handRaised)
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not change microphone state.')
    }
  }
  const toggleCamera = async () => {
    const room = roomRef.current
    if (!room) return
    try {
      const preset = quality === '720p' ? VideoPresets.h720 : quality === '540p' ? VideoPresets.h540 : quality === '360p' ? VideoPresets.h360 : undefined
      const deviceId = localStorage.getItem('fosshub-camera')
      await room.localParticipant.setCameraEnabled(
        cameraOff,
        { ...(deviceId ? { deviceId } : {}), ...(preset ? { resolution: preset.resolution } : {}) },
        preset ? { videoEncoding: preset.encoding } : {},
      )
      const nextCameraOff = !cameraOff
      setCameraOff(nextCameraOff)
      await reportMediaState(muted, nextCameraOff, handRaised)
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not change camera state.')
    }
  }
  const shareScreen = async () => {
    const room = roomRef.current
    if (!room) return
    try {
      await room.localParticipant.setScreenShareEnabled(!sharing)
      setSharing((current) => !current)
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Screen sharing was cancelled or not available.')
    }
  }
  const toggleHand = async () => {
    const next = !handRaised
    setHandRaised(next)
    await reportMediaState(muted, cameraOff, next)
  }
  const sendMessage = async (event: FormEvent) => {
    event.preventDefault()
    if (!membership || !message.trim()) return
    try {
      const sent = await sendMessageToServer(membership.meeting_id, message.trim())
      setMessages((current) => current.some((item) => item.id === sent.id) ? current : [...current, sent])
      setMessage('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send this message.')
    }
  }
  const react = async (emoji: string) => {
    setReaction(emoji)
    setReactionMenu(false)
    const data = new TextEncoder().encode(JSON.stringify({ emoji }))
    try {
      await roomRef.current?.localParticipant.publishData(data, { reliable: true, topic: 'reaction' })
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not send this reaction.')
    }
    window.setTimeout(() => setReaction(''), 1800)
  }
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/join/${meetingId}`)
      notify('Meeting invitation copied')
    } catch {
      notify('Clipboard unavailable — copy the meeting link from your address bar')
    }
  }
  const leave = async (endForEveryone = false) => {
    if (!membership) return
    try {
      if (endForEveryone && membership.role === 'host') await endMeeting(membership.meeting_id)
      else await leaveMeeting(membership.meeting_id)
      await roomRef.current?.disconnect()
      sessionStorage.removeItem(`${JOIN_STATE_PREFIX}${meetingId}`)
      navigate('/dashboard', { replace: true })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not leave the meeting.')
    }
  }
  const admit = async (participantId: string) => {
    try {
      await approveParticipant(participantId)
      await refreshParticipants()
      notify('Participant admitted')
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not admit this participant.')
    }
  }
  const discoverMeetingDevices = async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices())
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not list media devices.')
    }
  }
  const switchMeetingDevice = async (kind: MediaDeviceKind, deviceId: string) => {
    if (kind === 'videoinput') localStorage.setItem('fosshub-camera', deviceId)
    if (kind === 'audioinput') localStorage.setItem('fosshub-microphone', deviceId)
    if (kind === 'audiooutput') localStorage.setItem('fosshub-audio-output', deviceId)
    if ((kind === 'videoinput' && cameraOff) || (kind === 'audioinput' && muted)) {
      notify('Device preference saved for when you turn it on.')
      return
    }
    try {
      const switched = await roomRef.current?.switchActiveDevice(kind, deviceId)
      if (!switched) throw new Error('This browser could not switch to that device.')
      notify('Meeting device changed.')
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not switch this device.')
    }
  }
  const clock = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`
  const remoteCount = remoteParticipants.length
  const currentUserId = user?.id
  const filteredParticipants = participants.filter((person) => person.display_name.toLowerCase().includes(participantQuery.toLowerCase()))

  if (connecting) return <div className="loading-screen" role="status"><span className="loading-spinner" />Connecting to the live meeting…</div>
  if (error && !connected) {
    return <section className="form-card" role="alert"><h1>Unable to join meeting</h1><p>{error}</p><Link className="btn btn-secondary" to={`/join/${meetingId}`}>Return to meeting lobby</Link></section>
  }

  return (
    <>
      <section className="meeting-stage" aria-label="Live meeting room">
        <header className="stage-top">
          <div className="stage-title"><span className="brand-mark"><Video size={17} /></span><div><strong>{membership?.title || 'FOSSHub meeting'}</strong><span>{meetingId} · {clock}</span></div></div>
          <span className="connection-pill"><i className={`status-dot ${connected ? '' : 'off'}`} /> {connected ? 'Connected' : 'Reconnecting'}</span>
          <button className="icon-button" aria-label="Copy invitation" onClick={() => void copyInvite()}><Copy size={15} /></button>
        </header>
        {error && <div className="error-banner meeting-error" role="alert">{error}</div>}
        <div className="video-stage-body">
          <div className={`video-grid ${layout === 'speaker' ? 'speaker-layout' : ''}`}>
            <div className={`video-tile local-tile ${layout === 'speaker' && !focusedParticipantId ? 'focus-tile' : layout === 'speaker' ? 'speaker-side' : ''}`}>
              {(sharing && localScreenTrack) || (!cameraOff && localVideoTrack)
                ? <VideoElement track={sharing ? localScreenTrack : localVideoTrack} />
                : <div className="tile-avatar">{(membership?.display_name || 'ME').slice(0, 2).toUpperCase()}</div>}
              <div className="tile-flags">{muted && <span className="tile-flag" title="Microphone muted"><MicOff size={13} /></span>}{sharing && <span className="tile-flag" title="Sharing screen"><Share size={13} /></span>}</div>
              <div className="tile-name">{membership?.display_name || 'You'} (You){membership?.role === 'host' ? ' · Host' : ''}</div>
            </div>
            {pageParticipants.map((person) => {
              const screenTrack = person.getTrackPublication(Track.Source.ScreenShare)?.track as VideoTrack | undefined
              const cameraTrack = person.getTrackPublication(Track.Source.Camera)?.track as VideoTrack | undefined
              const microphone = person.getTrackPublication(Track.Source.Microphone)
              return (
                <div className={`video-tile ${person.identity === focusedParticipantId ? 'focus-tile' : layout === 'speaker' ? 'speaker-side' : ''}`} key={person.identity}>
                  {(screenTrack || cameraTrack) ? <VideoElement track={screenTrack || cameraTrack} /> : <div className="tile-avatar">{(person.name || person.identity).slice(0, 2).toUpperCase()}</div>}
                  <div className="tile-flags">{(!microphone || microphone.isMuted) && <span className="tile-flag" title="Microphone muted"><MicOff size={13} /></span>}{!cameraTrack && !screenTrack && <span className="tile-flag" title="Camera off"><CameraOff size={13} /></span>}{screenTrack && <span className="tile-flag" title="Sharing screen"><Share size={13} /></span>}</div>
                  <div className="tile-name">{person.name || person.identity}</div>
                  <AudioElement participant={person} />
                </div>
              )
            })}
            {reaction && <div className="floating-reaction" aria-live="polite">{reaction}</div>}
            {remoteCount > VISIBLE_VIDEO_COUNT && <div className="video-pagination"><button className="btn btn-secondary btn-small" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={visiblePage === 0}>Previous</button><span>Page {visiblePage + 1} of {pageCount}</span><button className="btn btn-secondary btn-small" onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={visiblePage >= pageCount - 1}>Next</button></div>}
          </div>
          {panel && <aside className="stage-panel" aria-label={panel === 'chat' ? 'Meeting chat' : panel === 'settings' ? 'Meeting settings' : 'Participants'}>
            <div className="stage-panel-head"><span>{panel === 'chat' ? 'In-call messages' : panel === 'settings' ? 'Meeting settings' : `Participants (${remoteCount + 1})`}</span><button className="icon-button" aria-label="Close panel" onClick={() => setPanel(null)}><X size={14} /></button></div>
            <div className="side-tab-row">
              <button className={`side-tab ${panel === 'participants' ? 'active' : ''}`} onClick={() => setPanel('participants')}>People</button>
              <button className={`side-tab ${panel === 'chat' ? 'active' : ''}`} onClick={() => setPanel('chat')}>Chat</button>
              <button className={`side-tab ${panel === 'settings' ? 'active' : ''}`} onClick={() => { setPanel('settings'); void discoverMeetingDevices() }}>Settings</button>
            </div>
            {panel === 'participants' ? <div>
              <div className="field" style={{ margin: '12px 13px 4px' }}><label className="sr-only" htmlFor="participant-search">Search participants</label><input id="participant-search" value={participantQuery} onChange={(event) => setParticipantQuery(event.target.value)} placeholder="Search participants" /></div>
              {filteredParticipants.map((person) => <div className="participant-line" key={person.id}><span className="avatar">{person.display_name.slice(0, 2).toUpperCase()}</span><span>{person.display_name}{person.user_id === currentUserId ? ' (You)' : ''}<small>{person.role === 'host' ? ' · Host' : person.status === 'waiting' ? ' · Waiting' : ''}{person.hand_raised ? ' · Hand raised' : ''}</small></span>{person.status === 'waiting' && membership?.role === 'host' ? <button className="btn btn-primary btn-small" onClick={() => void admit(person.id)}>Admit</button> : person.mic_enabled ? <Mic size={13} /> : <MicOff size={13} />}</div>)}
              {hasMoreParticipants && <button className="btn btn-secondary btn-small" style={{ margin: 14 }} onClick={() => void refreshParticipants(participantOffset, true)}>Load more</button>}
              <button className="btn btn-secondary btn-small" style={{ margin: 14 }} onClick={() => void copyInvite()}><Copy size={13} /> Copy invitation</button>
            </div> : panel === 'chat' ? <>
              <div className="chat-messages" aria-live="polite">
                {messages.map((item) => <div className="chat-message" key={item.id}><strong>{item.senderId === currentUserId ? 'You' : item.name}</strong><time>{item.time}</time><p>{item.text}</p></div>)}
                <div ref={chatEnd} />
              </div>
              <form className="chat-compose" onSubmit={(event) => void sendMessage(event)}><input aria-label="Write a message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Send a message..." maxLength={2000} /><button className="tool-btn" aria-label="Send message" type="submit"><Send size={14} /></button></form>
            </> : <div className="meeting-settings">
              <div className="field"><label htmlFor="meeting-microphone">Microphone</label><select id="meeting-microphone" defaultValue={localStorage.getItem('fosshub-microphone') || ''} onChange={(event) => void switchMeetingDevice('audioinput', event.target.value)}><option value="">System default</option>{devices.filter((device) => device.kind === 'audioinput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>
              <div className="field"><label htmlFor="meeting-camera">Camera</label><select id="meeting-camera" defaultValue={localStorage.getItem('fosshub-camera') || ''} onChange={(event) => void switchMeetingDevice('videoinput', event.target.value)}><option value="">System default</option>{devices.filter((device) => device.kind === 'videoinput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>
              <div className="field"><label htmlFor="meeting-audio-output">Audio output</label><select id="meeting-audio-output" defaultValue={localStorage.getItem('fosshub-audio-output') || ''} onChange={(event) => void switchMeetingDevice('audiooutput', event.target.value)}><option value="">System default</option>{devices.filter((device) => device.kind === 'audiooutput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</option>)}</select></div>
              <div className="field"><label htmlFor="meeting-quality">Camera resolution</label><select id="meeting-quality" value={quality} onChange={(event) => { setQuality(event.target.value); localStorage.setItem('fosshub-video-quality', event.target.value) }}><option>Auto</option><option>720p</option><option>540p</option><option>360p</option></select></div>
              <button className="btn btn-secondary btn-small" onClick={() => void discoverMeetingDevices()}>Refresh devices</button>
              <p className="field-hint">Camera and microphone changes apply immediately. Background blur is not enabled in this build.</p>
            </div>}
          </aside>}
        </div>
        <footer className="toolbar" role="toolbar" aria-label="Meeting controls">
          <button className={`tool-btn ${muted ? 'off' : ''}`} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => void toggleMicrophone()}>{muted ? <MicOff size={17} /> : <Mic size={17} />}<span>{muted ? 'Unmute' : 'Mute'}</span></button>
          <button className={`tool-btn ${cameraOff ? 'off' : ''}`} aria-label={cameraOff ? 'Turn camera on' : 'Turn camera off'} onClick={() => void toggleCamera()}>{cameraOff ? <CameraOff size={17} /> : <Camera size={17} />}<span>Camera</span></button>
          <button className={`tool-btn ${sharing ? 'selected' : ''}`} aria-label={sharing ? 'Stop sharing screen' : 'Share screen'} onClick={() => void shareScreen()}><Share size={17} /><span>{sharing ? 'Stop share' : 'Share'}</span></button>
          <button className={`tool-btn ${panel === 'chat' ? 'selected' : ''}`} aria-label="Open chat" onClick={() => setPanel(panel === 'chat' ? null : 'chat')}><Send size={16} /><span>Chat</span></button>
          <button className={`tool-btn ${panel === 'participants' ? 'selected' : ''}`} aria-label="Open participants" onClick={() => setPanel(panel === 'participants' ? null : 'participants')}><Users size={17} /><span>People</span></button>
          <button className={`tool-btn ${handRaised ? 'selected' : ''}`} aria-label={handRaised ? 'Lower hand' : 'Raise hand'} onClick={() => void toggleHand()}><Hand size={17} /><span>{handRaised ? 'Lower hand' : 'Raise hand'}</span></button>
          <div className="reaction-control">
            <button className={`tool-btn ${reactionMenu ? 'selected' : ''}`} aria-label="Choose a reaction" aria-expanded={reactionMenu} onClick={() => setReactionMenu(!reactionMenu)}><Smile size={17} /><span>React</span></button>
            {reactionMenu && <div className="reaction-picker">{['👏', '❤️', '😂', '🎉', '👍'].map((emoji) => <button key={emoji} aria-label={`React ${emoji}`} onClick={() => void react(emoji)}>{emoji}</button>)}</div>}
          </div>
          <button className={`tool-btn ${panel === 'settings' ? 'selected' : ''}`} aria-label="Meeting settings" onClick={() => { setPanel(panel === 'settings' ? null : 'settings'); void discoverMeetingDevices() }}><Settings2 size={17} /><span>Settings</span></button>
          <button className="tool-btn" aria-label="Switch video layout" onClick={() => setLayout((current) => current === 'grid' ? 'speaker' : 'grid')}><LayoutGrid size={17} /><span>{layout === 'grid' ? 'Speaker' : 'Grid'}</span></button>
          <button className="tool-btn leave" aria-label="Leave meeting" onClick={() => setConfirmLeave(true)}><PhoneOff size={17} /><span>Leave</span></button>
        </footer>
      </section>
      {confirmLeave && <Modal title={membership?.role === 'host' ? 'Leave this meeting?' : 'Leave this meeting?'} onClose={() => setConfirmLeave(false)} actions={<><button className="btn btn-secondary" onClick={() => setConfirmLeave(false)}>Stay</button><button className="btn btn-danger" onClick={() => void leave(false)}>Leave meeting</button>{membership?.role === 'host' && <button className="btn btn-quiet" onClick={() => void leave(true)}>End for everyone</button>}</>}>Your camera and microphone will be disconnected when you leave.</Modal>}
    </>
  )
}
