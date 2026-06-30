/**
 * Mastodon API Entity Types
 * https://docs.joinmastodon.org/entities/
 */

export interface MastodonAccount {
  id: string
  username: string
  acct: string
  display_name: string
  locked: boolean
  bot: boolean
  discoverable: boolean
  group: boolean
  created_at: string
  note: string
  url: string
  uri: string
  avatar: string
  avatar_static: string
  header: string
  header_static: string
  followers_count: number
  following_count: number
  statuses_count: number
  last_status_at: string | null
  emojis: unknown[]
  fields: { name: string; value: string; verified_at: string | null }[]
  roles: { id: string; name: string; color: string; permissions: string; highlighted: boolean }[]
  hide_collections: boolean
  noindex: boolean
  source?: { note: string; fields: { name: string; value: string; verified_at: string | null }[]; privacy: string; sensitive: boolean; language: string }
}

export interface MastodonStatus {
  id: string
  created_at: string
  in_reply_to_id: string | null
  in_reply_to_account_id: string | null
  sensitive: boolean
  spoiler_text: string
  visibility: 'public' | 'unlisted' | 'private' | 'direct'
  language: string | null
  uri: string
  url: string
  replies_count: number
  reblogs_count: number
  favourites_count: number
  bookmarks_count: number
  shares_count: number
  favourited: boolean
  reblogged: boolean
  muted: boolean
  bookmarked: boolean
  pinned?: boolean
  content: string
  reblog: MastodonStatus | null
  application: { name: string; website: string | null } | null
  account: MastodonAccount
  media_attachments: MastodonMediaAttachment[]
  mentions: { id: string; username: string; url: string; acct: string }[]
  tags: { name: string; url: string }[]
  emojis: unknown[]
  card: MastodonPreviewCard | null
  poll: MastodonPoll | null
  text?: string | null
  edited_at?: string | null
}

export interface MastodonMediaAttachment {
  id: string
  type: 'image' | 'video' | 'gifv' | 'audio' | 'unknown'
  url: string
  preview_url: string
  remote_url: string | null
  text_url: string | null
  meta: {
    original?: { width: number; height: number; size: string; aspect: number }
    small?: { width: number; height: number; size: string; aspect: number }
    focus?: { x: number; y: number }
  }
  description: string | null
  blurhash: string | null
}

export interface MastodonPreviewCard {
  url: string
  title: string
  description: string
  type: string
  author_name: string
  author_url: string
  provider_name: string
  provider_url: string
  html: string
  width: number
  height: number
  image: string | null
  embed_url: string
  blurhash: string | null
}

export interface MastodonPoll {
  id: string
  expires_at: string | null
  expired: boolean
  multiple: boolean
  votes_count: number
  voters_count: number
  options: { title: string; votes_count: number }[]
  emojis: unknown[]
  voted?: boolean
  own_votes?: number[]
}

export interface MastodonNotification {
  id: string
  type: 'mention' | 'status' | 'reblog' | 'follow' | 'follow_request' | 'favourite' | 'poll' | 'update' | 'admin.sign_up' | 'admin.report'
  created_at: string
  account: MastodonAccount
  status?: MastodonStatus
}

export interface MastodonInstance {
  uri: string
  domain: string
  title: string
  version: string
  source_url: string
  description: string
  usage: { users: { active_month: number } }
  thumbnail: string
  languages: string[]
  short_description?: string
  stats?: { user_count: number; status_count: number; domain_count: number }
  configuration: {
    urls: { streaming: string | null; status: string | null; about: string | null; privacy_policy: string | null; terms_of_service: string | null }
    vapid: { public_key: string }
    accounts: { max_featured_tags: number; max_pinned_statuses: number }
    statuses: { max_characters: number; max_media_attachments: number; characters_reserved_per_url: number }
    media_attachments: {
      supported_mime_types: string[]
      image_size_limit: number
      image_matrix_limit: number
      video_size_limit: number
      video_frame_rate_limit: number
      video_matrix_limit: number
    }
    polls: { max_options: number; max_characters_per_option: number; min_expiration: number; max_expiration: number }
  }
  registrations: boolean
  contact: { email: string | null; account: MastodonAccount | null }
  rules: { id: string; text: string; hint: string }[]
  api_versions?: { [key: string]: number }
}
