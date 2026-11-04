-- Parametri modificati dal pannello: solo quelli diversi dal predefinito (le definizioni sono nel
-- codice, packages/common/src/settings.ts).
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL
);

-- Registro di ogni modifica: chi, quando, da quale valore a quale.
CREATE TABLE settings_audit (
  id          UUID PRIMARY KEY,
  key         TEXT NOT NULL,
  old_value   JSONB,                -- NULL = era il valore predefinito
  new_value   JSONB,                -- NULL = riportato al predefinito
  changed_by  TEXT NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settings_audit_time ON settings_audit (changed_at DESC);
