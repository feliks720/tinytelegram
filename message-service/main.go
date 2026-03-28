package main

import (
	"log"
	"net/http"
	"os"

	mgrpc "tinytelegram/message-service/grpc"
	"tinytelegram/message-service/handler"
	"tinytelegram/message-service/store"
)

func main() {
	store.InitRedis()
	store.InitPostgres()
	mgrpc.DiscoverGateways(store.RDB)

	grpcPort := os.Getenv("GRPC_PORT")
	if grpcPort == "" {
		grpcPort = "5050"
	}
	go mgrpc.StartGRPCServer(grpcPort)

	port := os.Getenv("PORT")
	if port == "" {
		port = "9090"
	}

	http.HandleFunc("/health", handler.HealthHandler)
	http.HandleFunc("/redis-only", handler.RedisOnlyHandler)

	log.Printf("Message service HTTP on :%s, gRPC on :%s", port, grpcPort)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
