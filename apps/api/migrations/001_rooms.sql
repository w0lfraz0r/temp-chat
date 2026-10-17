CREATE TABLE rooms (
  id uuid PRIMARY KEY,
  creator_token_hash text NOT NULL,
  guest_access_hash text NOT NULL,
  guest_token_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '60 minutes')
);
CREATE INDEX rooms_expiry_idx ON rooms (expires_at);

-- Replay metadata only: no ciphertext, plaintext, IVs, or encryption keys.
CREATE TABLE message_receipts (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender text NOT NULL CHECK (sender IN ('creator', 'guest')),
  message_id uuid NOT NULL,
  PRIMARY KEY (room_id, sender, message_id)
);
