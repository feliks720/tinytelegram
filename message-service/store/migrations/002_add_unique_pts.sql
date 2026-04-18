-- Layer 2 of the two-layer PTS defense (spec §5.3).
-- A duplicate PTS value surviving past Redis WAIT will hit these constraints,
-- causing INSERT to fail and message-service to return codes.Unavailable to the client.
DO $$ BEGIN
    ALTER TABLE messages ADD CONSTRAINT uniq_receiver_pts UNIQUE (receiver_id, receiver_pts);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE messages ADD CONSTRAINT uniq_sender_pts UNIQUE (sender_id, sender_pts);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
