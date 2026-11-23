import { requireSupabase } from './supabase'
import type { ChatMessageRow, JoinedMeeting, MeetingPreviewRow, MeetingRow, ParticipantRow, ParticipantStateRow } from './database.types'
import type { ChatMessage, Meeting, MeetingVisibility } from '../types'

const MEETING_COLUMNS = 'id,code,title,host_id,visibility,waiting_room,participant_mic,participant_camera,scheduled_for,duration_minutes,status,created_at,ended_at'

export interface MeetingInput {
  code: string
  title: string
  visibility: MeetingVisibility
  waitingRoom: boolean
  participantMic: boolean
  participantCamera: boolean
  password?: string
  scheduledFor?: string | null
  durationMinutes?: number | null
  invitedEmails?: string[]
}

export function mapMeeting(row: MeetingRow): Meeting {
  return {
    id: row.code,
    databaseId: row.id,
    title: row.title,
    hostId: row.host_id,
    visibility: row.visibility,
    waitingRoom: row.waiting_room,
    participantMic: row.participant_mic,
    participantCamera: row.participant_camera,
    passwordRequired: false,
    scheduledFor: row.scheduled_for,
    durationMinutes: row.duration_minutes,
    participants: [],
    status: row.status,
    createdAt: row.created_at,
  }
}

export async function listMeetings(): Promise<Meeting[]> {
  const { data, error } = await requireSupabase()
    .from('meetings')
    .select(MEETING_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return (data as MeetingRow[]).map(mapMeeting)
}

export async function createMeeting(input: MeetingInput): Promise<Meeting> {
  const client = requireSupabase()
  const { data: meetingId, error: createError } = await client.rpc('create_meeting', {
    p_code: input.code,
    p_title: input.title,
    p_visibility: input.visibility,
    p_waiting_room: input.waitingRoom,
    p_participant_mic: input.participantMic,
    p_participant_camera: input.participantCamera,
    p_password: input.password || null,
    p_scheduled_for: input.scheduledFor || null,
    p_duration_minutes: input.durationMinutes || null,
    p_invited_emails: input.invitedEmails || [],
  })
  if (createError) throw createError
  const { data, error } = await client.from('meetings').select(MEETING_COLUMNS).eq('id', meetingId).single()
  if (error) throw error
  return { ...mapMeeting(data as MeetingRow), passwordRequired: Boolean(input.password) }
}

export async function previewMeeting(code: string): Promise<MeetingPreviewRow | null> {
  const { data, error } = await requireSupabase().rpc('get_meeting_preview', { p_code: code })
  if (error) throw error
  return data?.[0] ?? null
}

export async function joinMeeting(code: string, displayName: string, password?: string): Promise<JoinedMeeting> {
  const { data, error } = await requireSupabase().rpc('join_meeting', {
    p_code: code,
    p_display_name: displayName,
    p_password: password || null,
  })
  if (error) throw error
  return data
}

export async function updateParticipantState(meetingId: string, micEnabled: boolean, cameraEnabled: boolean, handRaised: boolean) {
  const { error } = await requireSupabase().rpc('update_participant_state', {
    p_meeting_id: meetingId,
    p_mic_enabled: micEnabled,
    p_camera_enabled: cameraEnabled,
    p_hand_raised: handRaised,
  })
  if (error) throw error
}

export async function getParticipantState(code: string): Promise<ParticipantStateRow | null> {
  const { data, error } = await requireSupabase().rpc('get_participant_state', { p_code: code })
  if (error) throw error
  return data?.[0] ?? null
}

export async function leaveMeeting(meetingId: string) {
  const { error } = await requireSupabase().rpc('leave_meeting', { p_meeting_id: meetingId })
  if (error) throw error
}

export async function endMeeting(meetingId: string) {
  const client = requireSupabase()
  try {
    const { error } = await client.functions.invoke('end-livekit-meeting', { body: { meetingId } })
    if (!error) return
  } catch {
    // Edge function not available; fallback to DB RPC
  }
  const { error } = await client.rpc('end_meeting', { p_meeting_id: meetingId })
  if (error) throw error
}

export async function approveParticipant(participantId: string) {
  const { error } = await requireSupabase().rpc('approve_participant', { p_participant_id: participantId })
  if (error) throw error
}

export async function listMessages(meetingId: string, limit = 100): Promise<ChatMessage[]> {
  const { data, error } = await requireSupabase()
    .from('chat_messages')
    .select('id,meeting_id,sender_id,display_name,content,created_at')
    .eq('meeting_id', meetingId)
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data as ChatMessageRow[]).reverse().map(mapMessage)
}

function mapMessage(row: ChatMessageRow): ChatMessage {
  return { id: row.id, senderId: row.sender_id, name: row.display_name, text: row.content, createdAt: row.created_at, time: new Date(row.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
}

export async function sendMessage(meetingId: string, content: string): Promise<ChatMessage> {
  const { data, error } = await requireSupabase().rpc('send_meeting_message', {
    p_meeting_id: meetingId,
    p_content: content,
  })
  if (error) throw error
  return mapMessage(data as ChatMessageRow)
}

export function subscribeToMessages(
  meetingId: string,
  onMessage: (message: ChatMessage) => void,
  onError: (message: string) => void,
  onParticipantChange: () => void,
  isHost: boolean,
) {
  const client = requireSupabase()
  const channel = client.channel(`meeting:${meetingId}`, { config: { private: true } })
    .on('broadcast', { event: 'chat_message' }, ({ payload }) => {
      if (!payload || typeof payload !== 'object') return
      const envelope = payload as { record?: unknown }
      const row = (envelope.record ?? payload) as Partial<ChatMessageRow>
      if (typeof row.id === 'number' && typeof row.sender_id === 'string' && typeof row.content === 'string') {
        onMessage(mapMessage(row as ChatMessageRow))
      }
    })
    .on('broadcast', { event: 'participant_change' }, onParticipantChange)
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onError('Live chat connection was interrupted. Reconnecting…')
    })
  const hostChannel = isHost
    ? client.channel(`meeting-host:${meetingId}`, { config: { private: true } })
      .on('broadcast', { event: 'participant_change' }, onParticipantChange)
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onError('Waiting-room updates were interrupted. Reconnecting…')
      })
    : null
  return () => {
    void client.removeChannel(channel)
    if (hostChannel) void client.removeChannel(hostChannel)
  }
}

export async function listParticipants(meetingId: string, offset: number, limit = 25): Promise<ParticipantRow[]> {
  const { data, error } = await requireSupabase()
    .from('meeting_participants')
    .select('id,meeting_id,user_id,display_name,role,status,mic_enabled,camera_enabled,hand_raised,joined_at')
    .eq('meeting_id', meetingId)
    .in('status', ['active', 'waiting'])
    .order('joined_at', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw error
  return data as ParticipantRow[]
}

export async function getMeetingById(databaseId: string): Promise<Meeting> {
  const { data, error } = await requireSupabase().from('meetings').select(MEETING_COLUMNS).eq('id', databaseId).single()
  if (error) throw error
  return mapMeeting(data as MeetingRow)
}
