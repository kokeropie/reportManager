'use strict';

// A folder with no rows in folder_access is open to every viewer. Once it has rows, only those viewers (and admins) can open it.
// The Connection folder is never open to viewers. Needs @admin (bit) and @userId bound, and the folders table aliased as f.
const FOLDER_OPEN_SQL = `(@admin = 1 OR (f.is_system = 0 AND (
  NOT EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = f.id)
  OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = f.id AND fa.user_id = @userId))))`;

// Same rule from the scheduler's side: the folder is restricted and the subscription's owner is not on its list.
const FOLDER_BLOCKED_FOR_OWNER_SQL = `CASE WHEN f.is_system = 0
  AND EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM folder_access fa WHERE fa.folder_id = f.id AND fa.user_id = s.user_id)
  THEN 1 ELSE 0 END`;

const who = (user) => ({ admin: user.role === 'admin', userId: user.userId });

module.exports = { FOLDER_OPEN_SQL, FOLDER_BLOCKED_FOR_OWNER_SQL, who };
