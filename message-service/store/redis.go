package store

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/redis/go-redis/v9"
)

var RDB *redis.Client

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

func NextUserPTS(userID string) (int64, error) {
	key := fmt.Sprintf("user:%s:pts", userID)
	return RDB.Incr(context.Background(), key).Result()
}

func GetUserPTS(userID string) (int64, error) {
	key := fmt.Sprintf("user:%s:pts", userID)
	val, err := RDB.Get(context.Background(), key).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return val, err
}

func GetUserGateway(userID string) (string, error) {
	key := "presence:" + userID
	return RDB.Get(context.Background(), key).Result()
}
