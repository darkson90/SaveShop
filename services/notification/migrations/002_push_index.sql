-- Controllo "ultima push all'utente" a ogni giro di offerte.
CREATE INDEX notifications_user_pushed ON notifications (user_id, pushed_at DESC) WHERE pushed_at IS NOT NULL;
