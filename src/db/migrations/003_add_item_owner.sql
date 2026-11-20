-- Every item now belongs to a user. Items created before auth existed have no
-- owner, so they are deleted (owner_id is required).
DELETE FROM items;

ALTER TABLE items
  ADD COLUMN owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE;

-- Non-admin queries always filter by owner
CREATE INDEX items_owner_id_idx ON items (owner_id);
