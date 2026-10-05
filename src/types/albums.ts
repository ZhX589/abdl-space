import type { SponsorQuota } from './index.ts'

/** Album visibility is enforced against the current row, never a cached post. */
export type AlbumVisibility = 'public' | 'private' | 'shared'
/** Quota tiers derive from persisted grants/redemptions and current membership. */
export type AlbumStorageTier = 'free' | 'week' | 'month' | 'quarter' | 'year' | 'permanent'
/** Accessible album DTO; private COS keys are deliberately absent. */
export interface Album {
  id: string; owner_id: number; name: string; visibility: AlbumVisibility; is_default: boolean
  photo_count: number; cover_url: string | null; created_at: number; can_upload: boolean; is_owner: boolean; member_count: number
}
/** Storage counts include every owned variant and unpublished reservations. */
export interface StorageQuota {
  limit_bytes: number; used_bytes: number; reserved_bytes: number; remaining_bytes: number
  tier: AlbumStorageTier; sponsor_active: boolean; original_upload_allowed: boolean
}
/** Photo DTO includes only signed previews and explicitly permitted owner HD. */
export interface Photo {
  id: string; album_id: string; batch_id: string; description: string; captured_at: number | null
  uploaded_at: number; sort_at: number; preview_url: string; hd_url: string | null; original_available: boolean
  width: number; height: number; likes_count: number; comments_count: number; liked: boolean; is_owner: boolean; owner_sponsor: boolean
}
/** Persisted, display-safe comment author projection. */
export interface AlbumComment {
  id: string; user_id: number; username: string; display_name: string | null; avatar: string | null; content: string; created_at: number
}
/** One private integrity-bound COS upload, with no public object URL. */
export interface AlbumUploadAuthorization {
  photo_id: string; client_id: string; kind: 'preview' | 'hd' | 'original'; upload_id: string
  upload_url: string; required_headers: Record<string, string>; expires_at: number
}
/** All variants are reserved in the same transaction before signing uploads. */
export interface AlbumBatchAuthorization { batch_id: string; uploads: AlbumUploadAuthorization[]; published?: boolean; album_id?: string; post_id?: number | null }
/** Publication retries return the original post, never creating duplicates. */
export interface AlbumPublishResponse { album_id: string; batch_id: string; post_id: number | null }
/** Explicit viewing authorization shares the existing sponsor quota contract. */
export interface AlbumPhotoAuthorization { url: string; expires_at: number; charged: boolean; quota?: SponsorQuota }
/** Invite tokens are returned once; only SHA-256 is stored. */
export interface AlbumInvite { url: string; token: string; expires_at: number }
/** Native timeline metadata is rehydrated only for currently public albums. */
export interface AlbumPostUpdate {
  album_id: string; album_name: string; description: string; photo_count: number; cover_url: string; width: number; height: number
}
/** Bounded album pagination. */
export interface AlbumListResponse { albums: Album[]; has_more: boolean }
/** Accessible album detail. */
export interface AlbumDetailResponse { album: Album }
/** A refreshed accessible photo DTO, with no implicit original authorization. */
export interface PhotoDetailResponse { photo: Photo }
/** Stable photo pagination, descending by local-grouping timestamp then ID. */
export interface AlbumPhotosResponse { photos: Photo[]; has_more: boolean }
/** Accessible comment pagination. */
export interface AlbumCommentsResponse { comments: AlbumComment[]; has_more: boolean }
/** Shared-album member projection. */
export interface AlbumMembersResponse { members: Array<{ user_id: number; username: string }> }
/** Bounded retryable history import progress. */
export interface AlbumImportResponse { imported: number; skipped: number; remaining: boolean }
