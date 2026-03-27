package handler

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"

	"tinytelegram/message-service/store"
)

type Message struct {
	SenderID   string `json:"sender_id"`
	ReceiverID string `json:"receiver_id"`
	Content    string `json:"content"`
}

type MessageResponse struct {
	PTS    int64  `json:"pts"`
	Status string `json:"status"`
}

func SendMessageHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var msg Message
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	pts, err := store.NextPTS()
	if err != nil {
		http.Error(w, "failed to acquire PTS", http.StatusInternalServerError)
		return
	}

	_, err = store.DB.Exec(
		`INSERT INTO messages (pts, sender_id, receiver_id, content) VALUES ($1, $2, $3, $4)`,
		pts, msg.SenderID, msg.ReceiverID, msg.Content,
	)
	if err != nil {
		http.Error(w, "failed to persist message", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(MessageResponse{PTS: pts, Status: "ok"})
}

func GetDiffHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	localPTS, err := strconv.ParseInt(r.URL.Query().Get("local_pts"), 10, 64)
	if err != nil {
		http.Error(w, "invalid local_pts", http.StatusBadRequest)
		return
	}

	userID := r.URL.Query().Get("user_id")
	if userID == "" {
		http.Error(w, "user_id required", http.StatusBadRequest)
		return
	}

	rows, err := store.DB.Query(
		`SELECT pts, sender_id, receiver_id, content FROM messages 
		 WHERE pts > $1 AND receiver_id = $2 ORDER BY pts ASC`,
		localPTS, userID,
	)
	if err != nil && err != sql.ErrNoRows {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var messages []Message
	for rows.Next() {
		var m Message
		var pts int64
		if err := rows.Scan(&pts, &m.SenderID, &m.ReceiverID, &m.Content); err != nil {
			continue
		}
		messages = append(messages, m)
	}

	if messages == nil {
		messages = []Message{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(messages)
}
