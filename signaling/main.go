package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// ---------- Types ----------

type Client struct {
	id          string
	conn        *websocket.Conn
	room        string
	rateLimiter *RateLimiter
	mu          sync.Mutex
}

// ---------- Global state ----------

var (
	appConfig   *Config
	rooms       = make(map[string]map[*Client]bool)
	clientsById = make(map[string]*Client)
	globalMu    sync.RWMutex
	upgrader    websocket.Upgrader
)

func main() {
	appConfig = LoadConfig()

	// Initialize structured logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	// Configure WebSocket upgrader with origin checking
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			if len(appConfig.AllowedOrigins) == 0 {
				return true // dev mode: allow all
			}
			origin := r.Header.Get("Origin")
			for _, allowed := range appConfig.AllowedOrigins {
				if allowed == "*" || allowed == origin {
					return true
				}
			}
			slog.Warn("WebSocket origin rejected", "origin", origin)
			return false
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/ready", handleReady)
	mux.HandleFunc("/metrics", handleMetrics)
	mux.HandleFunc("/ws", handleWebSocket)

	server := &http.Server{
		Addr:         appConfig.Port,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Setup graceful shutdown
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("Signaling server listening", "port", appConfig.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Server error", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("Shutting down signaling server gracefully...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("Server shutdown failed", "error", err)
	}

	slog.Info("Signaling server stopped")
}

// ---------- WebSocket Handler ----------

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Check optional Auth Token header or query param
	if appConfig.AuthToken != "" {
		token := r.Header.Get("X-Auth-Token")
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if token != appConfig.AuthToken {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("WebSocket upgrade error", "error", err)
		return
	}
	defer conn.Close()

	// Enforce message read limit
	conn.SetReadLimit(appConfig.ReadLimitBytes)

	client := &Client{
		id:          uuid.New().String(),
		conn:        conn,
		rateLimiter: NewRateLimiter(appConfig.RateLimitPerSec),
	}

	atomic.AddUint64(&metrics.totalConnections, 1)
	atomic.AddInt64(&metrics.activeConnections, 1)
	defer atomic.AddInt64(&metrics.activeConnections, -1)

	globalMu.Lock()
	clientsById[client.id] = client
	globalMu.Unlock()

	slog.Debug("Client connected", "client_id", client.id)

	sendJSON(client, map[string]string{
		"type": "self-id",
		"id":   client.id,
	})

	defer func() {
		globalMu.Lock()
		delete(clientsById, client.id)
		globalMu.Unlock()
		handleDisconnect(client)
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		atomic.AddUint64(&metrics.totalMessagesIn, 1)

		// Rate limit incoming messages per client
		if !client.rateLimiter.Allow() {
			atomic.AddUint64(&metrics.totalRateLimitHits, 1)
			slog.Warn("Rate limit exceeded for client", "client_id", client.id)
			sendJSON(client, map[string]string{
				"type":  "error",
				"error": "Rate limit exceeded. Slow down message frequency.",
			})
			continue
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		msgType, _ := msg["type"].(string)

		switch msgType {
		case "join":
			room, _ := msg["room"].(string)
			if room == "" {
				continue
			}

			// Validate room capacity limits
			globalMu.Lock()
			if len(rooms) >= appConfig.MaxRooms && rooms[room] == nil {
				globalMu.Unlock()
				sendJSON(client, map[string]string{
					"type":  "error",
					"error": "Server maximum room capacity reached",
				})
				continue
			}

			if rooms[room] != nil && len(rooms[room]) >= appConfig.MaxClientsPerRoom {
				globalMu.Unlock()
				sendJSON(client, map[string]string{
					"type":  "error",
					"error": "Room is full",
				})
				continue
			}
			globalMu.Unlock()

			client.room = room
			joinRoom(client, room)

		case "offer", "answer", "ice-candidate":
			target, _ := msg["target"].(string)
			if target == "" {
				broadcastToRoom(client.room, message, client)
				continue
			}

			msg["from"] = client.id
			enriched, err := json.Marshal(msg)
			if err != nil {
				continue
			}
			sendToTarget(target, enriched)
		}
	}
}

// ---------- Room Management ----------

func joinRoom(client *Client, room string) {
	globalMu.Lock()

	if rooms[room] == nil {
		rooms[room] = make(map[*Client]bool)
	}

	existingPeers := make([]string, 0, len(rooms[room]))
	for c := range rooms[room] {
		existingPeers = append(existingPeers, c.id)
	}

	rooms[room][client] = true
	globalMu.Unlock()

	slog.Info("Client joined room", "client_id", client.id, "room", room, "peers_count", len(existingPeers))

	sendJSON(client, map[string]interface{}{
		"type":  "room-peers",
		"peers": existingPeers,
	})

	peerJoinedMsg, _ := json.Marshal(map[string]string{
		"type": "peer-joined",
		"id":   client.id,
	})

	globalMu.RLock()
	for c := range rooms[room] {
		if c != client {
			writeMessage(c, peerJoinedMsg)
		}
	}
	globalMu.RUnlock()
}

func sendToTarget(targetID string, message []byte) {
	globalMu.RLock()
	target, ok := clientsById[targetID]
	globalMu.RUnlock()

	if !ok {
		return
	}
	writeMessage(target, message)
}

func broadcastToRoom(room string, message []byte, sender *Client) {
	globalMu.RLock()
	defer globalMu.RUnlock()

	for c := range rooms[room] {
		if c != sender {
			writeMessage(c, message)
		}
	}
}

func writeMessage(c *Client, message []byte) {
	c.mu.Lock()
	err := c.conn.WriteMessage(websocket.TextMessage, message)
	c.mu.Unlock()

	if err != nil {
		slog.Debug("writeMessage failed, disconnecting", "client_id", c.id, "error", err)
		go handleDisconnect(c)
	} else {
		atomic.AddUint64(&metrics.totalMessagesOut, 1)
	}
}

func rawWrite(c *Client, message []byte) {
	c.mu.Lock()
	err := c.conn.WriteMessage(websocket.TextMessage, message)
	c.mu.Unlock()

	if err == nil {
		atomic.AddUint64(&metrics.totalMessagesOut, 1)
	}
}

func sendJSON(c *Client, v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	writeMessage(c, data)
}

func handleDisconnect(client *Client) {
	globalMu.Lock()

	if client.room == "" {
		globalMu.Unlock()
		return
	}

	room := client.room
	delete(rooms[room], client)

	peersToNotify := make([]*Client, 0, len(rooms[room]))
	for c := range rooms[room] {
		peersToNotify = append(peersToNotify, c)
	}

	if len(rooms[room]) == 0 {
		delete(rooms, room)
	}

	client.room = ""
	globalMu.Unlock()

	slog.Info("Client disconnected", "client_id", client.id, "room", room)

	leaveMsg, _ := json.Marshal(map[string]string{
		"type": "peer-left",
		"id":   client.id,
	})
	for _, c := range peersToNotify {
		rawWrite(c, leaveMsg)
	}
}
