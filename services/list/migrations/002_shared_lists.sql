-- v1.2: liste condivise. Il proprietario resta in shopping_lists.user_id ed è anche membro.
CREATE TABLE list_members (
  list_id    UUID NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','editor')),
  label      TEXT NOT NULL,               -- nome mostrato agli altri membri
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);
CREATE INDEX list_members_user ON list_members (user_id, list_id DESC);

INSERT INTO list_members (list_id, user_id, role, label)
SELECT id, user_id, 'owner', 'Proprietario' FROM shopping_lists;

-- Codici di invito brevi da condividere (scadono dopo 48 ore, utilizzabili più volte fino a 5 membri).
CREATE TABLE list_invites (
  code        TEXT PRIMARY KEY,
  list_id     UUID NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

-- Chi ha aggiunto ogni articolo, per mostrarlo nelle liste condivise.
ALTER TABLE list_items ADD COLUMN added_by UUID;
