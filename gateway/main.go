package main

import (
	"log"
	"net/http"
	"os"

	"tinytelegram/gateway/handler"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}

	http.HandleFunc("/ws", handler.WebSocketHandler)
	http.HandleFunc("/health", handler.HealthHandler)

	log.Printf("Gateway starting on port %s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
