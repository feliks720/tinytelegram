package main

import (
	"log"
	"net/http"
	"os"

	"tinytelegram/message-service/handler"
	"tinytelegram/message-service/store"
)

func main() {
	store.InitRedis()
	store.InitPostgres()

	port := os.Getenv("PORT")
	if port == "" {
		port = "9090"
	}

	http.HandleFunc("/health", handler.HealthHandler)
	http.HandleFunc("/message", handler.SendMessageHandler)
	http.HandleFunc("/diff", handler.GetDiffHandler)

	log.Printf("Message service starting on port %s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
