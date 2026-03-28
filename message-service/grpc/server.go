package grpc

import (
	"context"
	"log"
	"net"
	"time"

	"github.com/google/uuid"

	pb "tinytelegram/message-service/proto"
	"tinytelegram/message-service/store"

	"google.golang.org/grpc"
)

type messageServer struct {
	pb.UnimplementedMessageServiceServer
}

func (s *messageServer) PersistMessage(ctx context.Context, msg *pb.ChatMessage) (*pb.PersistedMessage, error) {
	receiverPTS, err := store.NextUserPTS(msg.ReceiverId)
	if err != nil {
		return nil, err
	}

	senderPTS, err := store.NextUserPTS(msg.SenderId)
	if err != nil {
		return nil, err
	}

	msgID := uuid.NewString()
	_, err = store.DB.ExecContext(
		ctx,
		`INSERT INTO messages (id, sender_id, receiver_id, content, sender_pts, receiver_pts)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		msgID,
		msg.SenderId,
		msg.ReceiverId,
		msg.Content,
		senderPTS,
		receiverPTS,
	)
	if err != nil {
		return nil, err
	}

	return &pb.PersistedMessage{
		Id:              msgID,
		Message:         msg,
		ReceiverPts:     receiverPTS,
		SenderPts:       senderPTS,
		ServerTimestamp: time.Now().UnixMilli(),
	}, nil
}

func (s *messageServer) GetDiff(ctx context.Context, req *pb.GetDiffRequest) (*pb.GetDiffResponse, error) {
	limit := req.Limit
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}

	rows, err := store.DB.QueryContext(
		ctx,
		`SELECT id, sender_id, receiver_id, content,
		        CASE WHEN receiver_id = $1 THEN receiver_pts ELSE sender_pts END AS pts,
		        created_at
		 FROM messages
		 WHERE (receiver_id = $1 OR sender_id = $1)
		   AND CASE WHEN receiver_id = $1 THEN receiver_pts ELSE sender_pts END > $2
		 ORDER BY pts ASC
		 LIMIT $3`,
		req.UserId,
		req.ClientPts,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	messages := make([]*pb.PersistedMessage, 0)
	for rows.Next() {
		var (
			id         string
			senderID   string
			receiverID string
			content    string
			pts        int64
			createdAt  time.Time
		)

		if err := rows.Scan(&id, &senderID, &receiverID, &content, &pts, &createdAt); err != nil {
			return nil, err
		}

		pm := &pb.PersistedMessage{
			Id: id,
			Message: &pb.ChatMessage{
				SenderId:   senderID,
				ReceiverId: receiverID,
				Content:    content,
			},
			ServerTimestamp: createdAt.UnixMilli(),
		}
		if receiverID == req.UserId {
			pm.ReceiverPts = pts
		} else {
			pm.SenderPts = pts
		}
		messages = append(messages, pm)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	currentPTS, err := store.GetUserPTS(req.UserId)
	if err != nil {
		return nil, err
	}

	return &pb.GetDiffResponse{
		Messages:   messages,
		CurrentPts: currentPTS,
	}, nil
}

func (s *messageServer) GetUserPts(ctx context.Context, req *pb.PtsRequest) (*pb.PtsResponse, error) {
	pts, err := store.GetUserPTS(req.UserId)
	if err != nil {
		return nil, err
	}
	return &pb.PtsResponse{Pts: pts}, nil
}

func StartGRPCServer(port string) {
	lis, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf("MessageService gRPC listen error: %v", err)
	}

	server := grpc.NewServer()
	pb.RegisterMessageServiceServer(server, &messageServer{})

	log.Printf("MessageService gRPC server starting on port %s", port)
	if err := server.Serve(lis); err != nil {
		log.Fatalf("MessageService gRPC serve error: %v", err)
	}
}
