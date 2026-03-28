package store

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

var RDB *redis.Client

const presenceTTL = 15 * time.Second
const heartbeatInterval = 5 * time.Second

func InitRedis() {
	addr := os.Getenv("REDIS_ADDR")
	if addr == "" {
		addr = "localhost:6379"
	}

	RDB = redis.NewClient(&redis.Options{
		Addr: addr,
	})

	if err := RDB.Ping(context.Background()).Err(); err != nil {
		log.Fatalf("Redis connection failed: %v", err)
	}

	log.Println("Redis connected")
}

func RegisterUser(userID string, gatewayAddr string) error {
	key := fmt.Sprintf("presence:%s", userID)
	return RDB.Set(context.Background(), key, gatewayAddr, presenceTTL).Err()
}

func UnregisterUser(userID string) error {
	key := fmt.Sprintf("presence:%s", userID)
	return RDB.Del(context.Background(), key).Err()
}

func GetUserGateway(userID string) (string, error) {
	key := fmt.Sprintf("presence:%s", userID)
	return RDB.Get(context.Background(), key).Result()
}

func StartHeartbeat(userID string, gatewayAddr string) func() {
	ticker := time.NewTicker(heartbeatInterval)
	done := make(chan struct{})

	go func() {
		for {
			select {
			case <-ticker.C:
				if err := RegisterUser(userID, gatewayAddr); err != nil {
					log.Printf("Heartbeat failed for user %s: %v", userID, err)
				}
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()

	return func() { close(done) }
}

func RegisterGateway(gatewayID string, grpcAddr string) error {
	if err := RDB.HSet(context.Background(), "gateways", gatewayID, grpcAddr).Err(); err != nil {
		return err
	}
	key := fmt.Sprintf("gateway:%s:alive", gatewayID)
	return RDB.Set(context.Background(), key, "1", presenceTTL).Err()
}

func UnregisterGateway(gatewayID string) {
	RDB.HDel(context.Background(), "gateways", gatewayID)
	RDB.Del(context.Background(), fmt.Sprintf("gateway:%s:alive", gatewayID))
}

func StartGatewayHeartbeat(gatewayID string, grpcAddr string) func() {
	ticker := time.NewTicker(heartbeatInterval)
	done := make(chan struct{})

	go func() {
		for {
			select {
			case <-ticker.C:
				if err := RegisterGateway(gatewayID, grpcAddr); err != nil {
					log.Printf("Gateway heartbeat failed for %s: %v", gatewayID, err)
				}
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()

	return func() { close(done) }
}
