package store

import (
	"database/sql"
	"log"
	"os"

	_ "github.com/lib/pq"
)

var DB *sql.DB

func InitPostgres() {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		dsn = "postgres://tt_user:tt_pass@localhost:5432/tinytelegram?sslmode=disable"
	}

	var err error
	DB, err = sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("Postgres open error: %v", err)
	}

	if err = DB.Ping(); err != nil {
		log.Fatalf("Postgres connection failed: %v", err)
	}

	if err = migrate(); err != nil {
		log.Fatalf("Migration failed: %v", err)
	}

	log.Println("Postgres connected")
}

func migrate() error {
	_, _ = DB.Exec(`DROP TABLE IF EXISTS messages`)

	_, err := DB.Exec(`
		CREATE EXTENSION IF NOT EXISTS "pgcrypto";

		CREATE TABLE IF NOT EXISTS messages (
			id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			sender_id    TEXT NOT NULL,
			receiver_id  TEXT NOT NULL,
			content      TEXT NOT NULL,
			sender_pts   BIGINT NOT NULL,
			receiver_pts BIGINT NOT NULL,
			created_at   TIMESTAMPTZ DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_messages_receiver_pts
			ON messages(receiver_id, receiver_pts);
		CREATE INDEX IF NOT EXISTS idx_messages_sender_pts
			ON messages(sender_id, sender_pts);
	`)
	return err
}
