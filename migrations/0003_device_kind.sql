ALTER TABLE devices ADD COLUMN device_kind text NOT NULL DEFAULT 'DESKTOP' CHECK(device_kind IN ('DESKTOP','PHONE'));
