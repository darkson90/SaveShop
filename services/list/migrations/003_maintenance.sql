-- Pulizia periodica degli inviti scaduti.
CREATE INDEX list_invites_expires ON list_invites (expires_at);
