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
	_, err := DB.Exec(`
		CREATE TABLE IF NOT EXISTS messages (
			pts         BIGINT PRIMARY KEY,
			sender_id   TEXT NOT NULL,
			receiver_id TEXT NOT NULL,
			content     TEXT NOT NULL,
			created_at  TIMESTAMP DEFAULT NOW()
		)
	`)
	return err
}
