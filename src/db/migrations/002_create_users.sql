CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  role          text        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Emails are unique regardless of case (the API also lowercases them)
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
