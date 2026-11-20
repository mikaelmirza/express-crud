CREATE TABLE items (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text          NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description text          CHECK (char_length(description) <= 500),
  price       numeric(12,2) CHECK (price >= 0),
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

-- Supports the default list order (created_at, id) used for sorting and paging
CREATE INDEX items_created_at_id_idx ON items (created_at, id);
