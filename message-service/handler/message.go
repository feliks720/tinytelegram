package handler

import (
	"encoding/json"
	"net/http"

	"tinytelegram/message-service/store"
)

func RedisOnlyHandler(w http.ResponseWriter, r *http.Request) {
	pts, err := store.NextUserPTS("benchmark-user")
	if err != nil {
		http.Error(w, "redis error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int64{"pts": pts})
}
