export interface StoryRow {
  id: string; kind: string; status: string; section: string; area: string; headline: string; dek: string;
  facts: string; body: string; means: string; actions: string; status_label: string; superseded_by: string | null;
  read_min: number; reason: string; source_url: string; published_at: string; version: number; updated_at: string;
  message_count: number | null; here_now: number | null; last_message_at: number | null;
  last_author_id: string | null; last_author_name: string | null;
  stage: string; developing_since: string | null; archived_at: string | null; last_newsroom_update: string | null; update_note: string;
  comment_count: number; last_comment_at: number | null;
  author_id: string | null; author_name: string | null; author_bio: string | null;
}

export const storyOut = (r: StoryRow, full = false) => ({
  id: r.id, kind: r.kind, status: r.status, section: r.section, area: r.area,
  headline: r.headline, dek: r.dek, statusLabel: r.status_label, supersededBy: r.superseded_by,
  readMin: r.read_min, reason: r.reason, source: r.source_url, publishedAt: r.published_at,
  version: r.version, updatedAt: r.updated_at,
  stage: r.stage, developingSince: r.developing_since || r.published_at, archivedAt: r.archived_at,
  lastUpdate: r.last_newsroom_update, updateNote: r.update_note,
  comments: { count: r.comment_count ?? 0, lastAt: r.last_comment_at },
  room: { messages: r.message_count ?? 0, here: r.here_now ?? 0, lastAt: r.last_message_at, lastAuthor: r.last_author_name || null },
  author: r.author_id && r.author_name ? { id: r.author_id, name: r.author_name, bio: r.author_bio || "" } : null,
  ...(full ? { facts: JSON.parse(r.facts), body: JSON.parse(r.body), means: JSON.parse(r.means), actions: JSON.parse(r.actions) } : {}),
});

export const STORY_SELECT = `
  SELECT s.*, rs.message_count, rs.here_now, rs.last_message_at, rs.last_author_id, u.name AS last_author_name,
         au.name AS author_name, au.bio AS author_bio,
         (SELECT COUNT(*) FROM comments c WHERE c.story_id = s.id AND c.deleted = 0) AS comment_count,
         (SELECT MAX(created_at) FROM comments c WHERE c.story_id = s.id AND c.deleted = 0) AS last_comment_at
    FROM stories s
    LEFT JOIN room_stats rs ON rs.story_id = s.id
    LEFT JOIN users u ON u.id = rs.last_author_id
    LEFT JOIN users au ON au.id = s.author_id`;
