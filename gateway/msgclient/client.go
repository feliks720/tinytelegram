package msgclient

import (
	"context"
	"log"

	pb "tinytelegram/gateway/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

var client pb.MessageServiceClient

func Init(addr string) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("Failed to connect to message-service: %v", err)
	}
	client = pb.NewMessageServiceClient(conn)
	log.Printf("Connected to message-service at %s", addr)
}

func PersistMessage(ctx context.Context, msg *pb.ChatMessage) (*pb.PersistedMessage, error) {
	return client.PersistMessage(ctx, msg)
}

func GetDiff(ctx context.Context, userID string, clientPTS int64) (*pb.GetDiffResponse, error) {
	return client.GetDiff(ctx, &pb.GetDiffRequest{
		UserId:    userID,
		ClientPts: clientPTS,
	})
}

func GetUserPts(ctx context.Context, userID string) (int64, error) {
	resp, err := client.GetUserPts(ctx, &pb.PtsRequest{UserId: userID})
	if err != nil {
		return 0, err
	}
	return resp.Pts, nil
}
