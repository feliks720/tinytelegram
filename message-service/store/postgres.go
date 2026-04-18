package store

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"os"
	"sort"
	"strings"

	_ "github.com/lib/pq"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

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
	if err = runMigrations(); err != nil {
		log.Fatalf("Migration failed: %v", err)
	}
	log.Println("Postgres connected")
}

func runMigrations() error {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		content, err := fs.ReadFile(migrationFS, "migrations/"+name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if _, err := DB.Exec(string(content)); err != nil {
			return fmt.Errorf("exec %s: %w", name, err)
		}
		log.Printf("Applied migration: %s", name)
	}
	return nil
}
