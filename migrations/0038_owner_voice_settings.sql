-- Owner preferences, following attention-budgets; microphone consent is session-local.
CREATE TABLE voice_settings (
 owner_scope_id uuid PRIMARY KEY REFERENCES owner_scopes(id),
 speech_enabled boolean NOT NULL DEFAULT true,
 provider text NOT NULL DEFAULT 'local' CHECK(provider IN ('local','remote')),
 remote_enabled boolean NOT NULL DEFAULT false,
 language text NOT NULL DEFAULT 'device' CHECK(length(language) BETWEEN 1 AND 64),
 voice text NOT NULL DEFAULT 'local' CHECK(length(voice) BETWEEN 1 AND 256),
 speaking_rate double precision NOT NULL DEFAULT 1 CHECK(speaking_rate BETWEEN 0.1 AND 10),
 hands_free_enabled boolean NOT NULL DEFAULT false,
 CHECK(provider='local' OR remote_enabled)
);
ALTER TABLE voice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON voice_settings FOR SELECT TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='settings.voice');
CREATE POLICY owner_insert ON voice_settings FOR INSERT TO unai_app
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='settings.voice');
CREATE POLICY owner_update ON voice_settings FOR UPDATE TO unai_app
 USING(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='settings.voice')
 WITH CHECK(unai_private.has_owner_access(owner_scope_id) AND current_setting('unai.purpose',true)='settings.voice');
GRANT SELECT,INSERT ON voice_settings TO unai_app;
GRANT UPDATE(speech_enabled,provider,remote_enabled,language,voice,speaking_rate,hands_free_enabled) ON voice_settings TO unai_app;
