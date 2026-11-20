-- Trigram indexes let substring search (ILIKE '%text%') use an index.
-- A normal B-tree index can't help when the pattern starts with a wildcard.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX items_name_trgm_idx        ON items USING gin (name gin_trgm_ops);
CREATE INDEX items_description_trgm_idx ON items USING gin (description gin_trgm_ops);

-- Supports minPrice/maxPrice range filters
CREATE INDEX items_price_idx ON items (price);
