package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
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
	closed      atomic.Bool
}

// ---------- Global state ----------

var (
	appConfig   *Config
	rooms       = make(map[string]map[*Client]bool)
	clientsById = make(map[string]*Client)
	globalMu    sync.RWMutex
	upgrader    websocket.Upgrader
)

func initServerState(cfg *Config) http.Handler {
	appConfig = cfg

	globalMu.Lock()
	rooms = make(map[string]map[*Client]bool)
	clientsById = make(map[string]*Client)
	globalMu.Unlock()

	metrics = &ServerMetrics{
		startTime: time.Now(),
	}

	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			if len(appConfig.AllowedOrigins) == 0 {
				return true // dev mode: allow all
			}
			origin := r.Header.Get("Origin")
			for _, allowed := range appConfig.AllowedOrigins {
				if allowed == "*" || strings.EqualFold(allowed, origin) {
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
	return mux
}

func main() {
	cfg := LoadConfig()

	// Initialize structured logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	handler := initServerState(cfg)

	server := &http.Server{
		Addr:              appConfig.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
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

	// Enforce message read limit and pong deadlines
	conn.SetReadLimit(appConfig.ReadLimitBytes)
	if appConfig.PongWait > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(appConfig.PongWait))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(appConfig.PongWait))
		})
	}

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

	done := make(chan struct{})
	defer func() {
		close(done)
		handleDisconnect(client)
	}()

	// Periodic ping heartbeat to detect dead TCP connections
	if appConfig.PingInterval > 0 {
		go func() {
			ticker := time.NewTicker(appConfig.PingInterval)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-ticker.C:
					if client.closed.Load() {
						return
					}
					client.mu.Lock()
					_ = client.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
					err := client.conn.WriteMessage(websocket.PingMessage, nil)
					client.mu.Unlock()
					if err != nil {
						handleDisconnect(client)
						return
					}
				}
			}
		}()
	}

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		if appConfig.PongWait > 0 {
			_ = conn.SetReadDeadline(time.Now().Add(appConfig.PongWait))
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
			sendJSON(client, map[string]string{
				"type":  "error",
				"error": "Invalid JSON message format",
			})
			continue
		}

		msgType, _ := msg["type"].(string)

		switch msgType {
		case "join":
			room, _ := msg["room"].(string)
			room = strings.TrimSpace(room)
			if room == "" {
				sendJSON(client, map[string]string{
					"type":  "error",
					"error": "Room name is required",
				})
				continue
			}

			// Synchronize client ID if provided in the join handshake
			requestedID, _ := msg["from"].(string)
			requestedID = strings.TrimSpace(requestedID)
			if requestedID != "" && requestedID != client.id {
				globalMu.Lock()
				if existing, exists := clientsById[requestedID]; !exists || existing == client {
					delete(clientsById, client.id)
					client.id = requestedID
					clientsById[client.id] = client
				}
				globalMu.Unlock()
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

			if rooms[room] != nil && !rooms[room][client] && len(rooms[room]) >= appConfig.MaxClientsPerRoom {
				globalMu.Unlock()
				sendJSON(client, map[string]string{
					"type":  "error",
					"error": "Room is full",
				})
				continue
			}
			globalMu.Unlock()

			joinRoom(client, room)

		case "offer", "answer", "ice-candidate":
			target, _ := msg["target"].(string)
			msg["from"] = client.id
			enriched, err := json.Marshal(msg)
			if err != nil {
				continue
			}

			if target == "" {
				broadcastToRoom(client.room, enriched, client)
				continue
			}

			sendToTarget(target, enriched)
		}
	}
}

// ---------- Room Management ----------

func leaveRoomLocked(client *Client) ([]*Client, string) {
	oldRoom := client.room
	if oldRoom == "" || rooms[oldRoom] == nil {
		client.room = ""
		return nil, ""
	}

	delete(rooms[oldRoom], client)
	peersToNotify := make([]*Client, 0, len(rooms[oldRoom]))
	for c := range rooms[oldRoom] {
		peersToNotify = append(peersToNotify, c)
	}

	if len(rooms[oldRoom]) == 0 {
		delete(rooms, oldRoom)
	}

	client.room = ""
	return peersToNotify, oldRoom
}

func joinRoom(client *Client, room string) {
	globalMu.Lock()

	var oldPeersToNotify []*Client
	var oldRoom string
	alreadyInSameRoom := client.room == room && rooms[room] != nil && rooms[room][client]

	if client.room != "" && client.room != room {
		oldPeersToNotify, oldRoom = leaveRoomLocked(client)
	}

	if rooms[room] == nil {
		rooms[room] = make(map[*Client]bool)
	}

	existingPeers := make([]string, 0, len(rooms[room]))
	peersInNewRoom := make([]*Client, 0, len(rooms[room]))
	for c := range rooms[room] {
		if c != client {
			existingPeers = append(existingPeers, c.id)
			peersInNewRoom = append(peersInNewRoom, c)
		}
	}

	rooms[room][client] = true
	client.room = room
	globalMu.Unlock()

	// Notify peers in previous room if client switched rooms
	if len(oldPeersToNotify) > 0 && oldRoom != "" {
		leaveMsg, _ := json.Marshal(map[string]string{
			"type": "peer-left",
			"id":   client.id,
		})
		for _, c := range oldPeersToNotify {
			rawWrite(c, leaveMsg)
		}
	}

	slog.Info("Client joined room", "client_id", client.id, "room", room, "peers_count", len(existingPeers))

	sendJSON(client, map[string]interface{}{
		"type":  "room-peers",
		"peers": existingPeers,
	})

	if !alreadyInSameRoom {
		peerJoinedMsg, _ := json.Marshal(map[string]string{
			"type": "peer-joined",
			"id":   client.id,
		})
		for _, c := range peersInNewRoom {
			writeMessage(c, peerJoinedMsg)
		}
	}
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
	if room == "" {
		return
	}

	globalMu.RLock()
	recipients := make([]*Client, 0, len(rooms[room]))
	for c := range rooms[room] {
		if c != sender {
			recipients = append(recipients, c)
		}
	}
	globalMu.RUnlock()

	for _, c := range recipients {
		writeMessage(c, message)
	}
}

func writeMessage(c *Client, message []byte) {
	if c.closed.Load() {
		return
	}

	c.mu.Lock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
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
	if c.closed.Load() {
		return
	}

	c.mu.Lock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
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
	if !client.closed.CompareAndSwap(false, true) {
		return
	}

	globalMu.Lock()
	if existing, ok := clientsById[client.id]; ok && existing == client {
		delete(clientsById, client.id)
	}
	peersToNotify, room := leaveRoomLocked(client)
	globalMu.Unlock()

	_ = client.conn.Close()

	if room != "" {
		slog.Info("Client disconnected", "client_id", client.id, "room", room)
		leaveMsg, _ := json.Marshal(map[string]string{
			"type": "peer-left",
			"id":   client.id,
		})
		for _, c := range peersToNotify {
			rawWrite(c, leaveMsg)
		}
	}
}
