package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeTimeout      = 5 * time.Second
	outboundQueueSize = 128
	maxNameBytes      = 128
)

type Client struct {
	id       string
	room     string
	conn     *websocket.Conn
	outbound chan []byte
	done     chan struct{}
}

type SignalingServer struct {
	config   Config
	upgrader websocket.Upgrader
	mux      *http.ServeMux
	metrics  ServerMetrics

	mu      sync.Mutex
	rooms   map[string]map[*Client]struct{}
	clients map[string]*Client
	closing bool
}

type signalMessage struct {
	Type      string              `json:"type"`
	Room      string              `json:"room,omitempty"`
	From      string              `json:"from,omitempty"`
	Target    string              `json:"target,omitempty"`
	SDP       *sessionDescription `json:"sdp,omitempty"`
	Candidate *iceCandidate       `json:"candidate,omitempty"`
}

type sessionDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type iceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

func newSignalingServer(cfg *Config) *SignalingServer {
	s := &SignalingServer{
		config:  *cfg,
		mux:     http.NewServeMux(),
		metrics: ServerMetrics{startTime: time.Now()},
		rooms:   make(map[string]map[*Client]struct{}),
		clients: make(map[string]*Client),
	}
	s.upgrader = websocket.Upgrader{HandshakeTimeout: writeTimeout}
	if len(s.config.AllowedOrigins) > 0 {
		s.upgrader.CheckOrigin = func(r *http.Request) bool {
			for _, allowed := range s.config.AllowedOrigins {
				if allowed == "*" || strings.EqualFold(allowed, r.Header.Get("Origin")) {
					return true
				}
			}
			return false
		}
	}
	s.mux.HandleFunc("/healthz", handleHealthz)
	s.mux.HandleFunc("/ready", s.handleReady)
	s.mux.HandleFunc("/metrics", s.handleMetrics)
	s.mux.HandleFunc("/ws", s.handleWebSocket)
	return s
}

func (s *SignalingServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := LoadConfig()
	handler := newSignalingServer(cfg)
	server := &http.Server{
		Addr:              cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	listenErr := make(chan error, 1)
	go func() {
		slog.Info("Signaling server listening", "address", cfg.Port)
		listenErr <- server.ListenAndServe()
	}()
	select {
	case err := <-listenErr:
		if !errors.Is(err, http.ErrServerClosed) {
			slog.Error("Signaling server failed", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		handler.close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Error("Server shutdown failed", "error", err)
		}
	}
}

func (s *SignalingServer) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if s.config.AuthToken != "" {
		token := r.Header.Get("X-Auth-Token")
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(s.config.AuthToken)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(s.config.ReadLimitBytes)
	if s.config.PongWait > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(s.config.PongWait))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(s.config.PongWait))
		})
	}
	client := &Client{
		id:       uuid.NewString(),
		conn:     conn,
		outbound: make(chan []byte, outboundQueueSize),
		done:     make(chan struct{}),
	}

	s.mu.Lock()
	if s.closing || (s.config.MaxConnections > 0 && len(s.clients) >= s.config.MaxConnections) {
		s.mu.Unlock()
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "Server unavailable"),
			time.Now().Add(writeTimeout))
		return
	}
	s.clients[client.id] = client
	s.metrics.totalConnections.Add(1)
	s.enqueueJSON(client, map[string]string{"type": "self-id", "id": client.id})
	s.mu.Unlock()

	defer s.disconnect(client)
	go s.writeLoop(client)
	limiter := NewRateLimiter(s.config.RateLimitPerSec)
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		s.metrics.totalMessagesIn.Add(1)
		if !limiter.Allow() {
			s.metrics.totalRateLimitHits.Add(1)
			s.sendError(client, "Rate limit exceeded")
			continue
		}
		var msg signalMessage
		if kind != websocket.TextMessage || json.Unmarshal(data, &msg) != nil || msg.Type == "" {
			s.sendError(client, "Invalid signaling message")
			continue
		}
		switch msg.Type {
		case "join":
			s.join(client, strings.TrimSpace(msg.Room), strings.TrimSpace(msg.From))
		case "offer", "answer", "ice-candidate":
			s.relay(client, msg)
		default:
			s.sendError(client, "Unsupported signaling message")
		}
	}
}

func (s *SignalingServer) writeLoop(client *Client) {
	defer client.conn.Close()
	var ticks <-chan time.Time
	if s.config.PingInterval > 0 {
		ticker := time.NewTicker(s.config.PingInterval)
		defer ticker.Stop()
		ticks = ticker.C
	}
	for {
		select {
		case <-client.done:
			return
		case msg := <-client.outbound:
			_ = client.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := client.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
			s.metrics.totalMessagesOut.Add(1)
		case <-ticks:
			if err := client.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)); err != nil {
				return
			}
		}
	}
}

func (s *SignalingServer) enqueue(client *Client, message []byte) {
	select {
	case client.outbound <- message:
	default:
		// Closing the connection unblocks its reader and writer, even during a slow write.
		_ = client.conn.Close()
	}
}

func (s *SignalingServer) enqueueJSON(client *Client, message any) {
	if data, err := json.Marshal(message); err == nil {
		s.enqueue(client, data)
	}
}

func (s *SignalingServer) sendError(client *Client, message string) {
	s.enqueueJSON(client, map[string]string{"type": "error", "error": message})
}

// Room membership and enqueue order share one lock. A room acknowledgment is
// queued before any peer can relay signaling to its new member.
func (s *SignalingServer) join(client *Client, room, requestedID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return
	}
	if room == "" || len(room) > maxNameBytes || len(requestedID) > maxNameBytes {
		s.sendError(client, "Invalid room or peer ID")
		return
	}
	if client.room != "" && requestedID != "" && requestedID != client.id {
		s.sendError(client, "Peer ID cannot change after joining")
		return
	}
	if owner := s.clients[requestedID]; owner != nil && owner != client {
		s.sendError(client, "Peer ID is already in use")
		return
	}
	members := s.rooms[room]
	roomCount := len(s.rooms)
	if client.room != room && len(s.rooms[client.room]) == 1 {
		roomCount--
	}
	if members == nil && roomCount >= s.config.MaxRooms {
		s.sendError(client, "Server maximum room capacity reached")
		return
	}
	if client.room != room && len(members) >= s.config.MaxClientsPerRoom {
		s.sendError(client, "Room is full")
		return
	}

	newMember := client.room != room
	if newMember {
		s.leaveLocked(client)
		if requestedID != "" && requestedID != client.id {
			delete(s.clients, client.id)
			client.id = requestedID
			s.clients[client.id] = client
		}
		if members == nil {
			members = make(map[*Client]struct{})
			s.rooms[room] = members
		}
		members[client] = struct{}{}
		client.room = room
	}

	peers := make([]string, 0, len(members)-1)
	for peer := range members {
		if peer != client {
			peers = append(peers, peer.id)
		}
	}
	s.enqueueJSON(client, map[string]any{"type": "room-peers", "id": client.id, "room": room, "peers": peers})
	if newMember {
		s.notifyPeersLocked(client, "peer-joined")
	}
}

func (s *SignalingServer) relay(client *Client, msg signalMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return
	}
	if client.room == "" {
		s.sendError(client, "Join a room before signaling")
		return
	}
	if msg.Type == "ice-candidate" && msg.Candidate == nil ||
		msg.Type != "ice-candidate" && (msg.SDP == nil || msg.SDP.Type != msg.Type || msg.SDP.SDP == "") {
		s.sendError(client, "Invalid WebRTC signaling payload")
		return
	}
	msg.From = client.id
	msg.Room = client.room
	if msg.Target != "" {
		peer := s.clients[msg.Target]
		if peer == nil || peer == client || peer.room != client.room {
			s.sendError(client, "Target is unavailable in this room")
			return
		}
		s.enqueueJSON(peer, msg)
		return
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for peer := range s.rooms[client.room] {
		if peer != client {
			s.enqueue(peer, data)
		}
	}
}

func (s *SignalingServer) notifyPeersLocked(client *Client, kind string) {
	msg, _ := json.Marshal(map[string]string{"type": kind, "id": client.id})
	for peer := range s.rooms[client.room] {
		if peer != client {
			s.enqueue(peer, msg)
		}
	}
}

func (s *SignalingServer) leaveLocked(client *Client) {
	room := client.room
	if room == "" {
		return
	}
	delete(s.rooms[room], client)
	if len(s.rooms[room]) == 0 {
		delete(s.rooms, room)
	} else if !s.closing {
		s.notifyPeersLocked(client, "peer-left")
	}
	client.room = ""
}

func (s *SignalingServer) disconnect(client *Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.clients, client.id)
	s.leaveLocked(client)
	close(client.done)
}

func (s *SignalingServer) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closing = true
	for _, client := range s.clients {
		_ = client.conn.Close()
	}
}
