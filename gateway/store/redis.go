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

const presenceTTL = 30 * time.Second

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
